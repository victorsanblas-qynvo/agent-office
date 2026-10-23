import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isInside, realPath } from './floors';
import type { GitRunner } from './git';
import type { OfficeBus } from './office-bus';
import type { OrderRow, OrderStore } from './order-store';
import { absolutePath, gitOps, orderBranch, run, validRef, validSha, zList } from './repo-ops';
import { runShell } from './shell';
import { setupOf } from './profiles';
import type { HubText, OfficeConfig, WorktreeState, WorktreeView } from './types';

const DAY_MS = 86_400_000;
const SIZE_CACHE_MS = 10 * 60_000;
const SIZE_TIMEOUT_MS = 60_000;
const MARKER = 'office-hub';
const EXCLUDE_LINE = '/.claude/worktrees/';
const ACTIVE_STATUSES = new Set(['pendiente', 'en-curso', 'revision']);
const BUILDING = new Set<WorktreeState>(['creando', 'preparando', 'listo']);
const REMOTE = 'origin/';
const PATCH_BYTES = 16 * 1024 * 1024;
const LANDED_CACHE = 500;
const PATHSPEC_BYTES = 256 * 1024;
const SQUASH_CANDIDATES = 5;

export type CreateFailure = 'floor' | 'limit' | 'base' | 'exists' | 'git';

export type CreateResult =
  | { ok: true; order: OrderRow; ready: Promise<OrderRow> }
  | { ok: false; error: CreateFailure; detail: string };

export type RemoveResult = 'ok' | 'not-found' | 'busy' | 'dirty' | 'unmerged' | 'branch-moved' | 'failed';

export type WorktreeSummary = { worktrees: WorktreeView[]; totalKb: number; warnKb: number };

// own: commits of the branch that were not in the base it started from. known: every git call the facts rest on
// answered, the branch tip resolved and the folder (if any) is on that tip; without it nothing is decided.
type Facts = { ahead: number; behind: number; own: number; dirty: boolean; merged: boolean; known: boolean; tip: string | null };

export type WorktreeDeskOpts = {
  store: OrderStore;
  git: GitRunner;
  now: () => number;
  bus: OfficeBus;
  config: () => OfficeConfig;
  hubId: string;
  // A live session works with its folder inside this one.
  inside: (path: string) => boolean;
  changed: (order: OrderRow) => void;
  sizeOf?: (path: string) => Promise<number | null>;
  shell?: typeof runShell;
};

export class WorktreeDesk {
  private readonly sizes = new Map<string, { kb: number | null; at: number }>();
  private readonly creating = new Set<string>();
  private readonly landedAt = new Map<string, boolean>();
  private index: { path: string; real: string; id: number }[] = [];

  constructor(private readonly opts: WorktreeDeskOpts) {
    this.reindex();
  }

  reindex(): void {
    this.index = this.opts.store
      .withWorktree()
      .filter((row): row is OrderRow & { worktree_path: string } => row.worktree_path !== null)
      .map((row) => ({ path: row.worktree_path, real: realPath(row.worktree_path), id: row.id }));
  }

  // The order whose folder contains cwd: a string comparison, because every hook event asks.
  byPath(cwd: string | null | undefined): OrderRow | null {
    if (!cwd) return null;
    for (const entry of this.index) {
      if (isUnder(cwd, entry.path) || isUnder(cwd, entry.real)) return this.opts.store.get(entry.id);
    }
    return null;
  }

  folderOf(floor: string, slug: string): string | null {
    const config = this.opts.config().floors[floor];
    return config ? join(realPath(config.path), '.claude', 'worktrees', `office-${slug}`) : null;
  }

  async create(order: OrderRow): Promise<CreateResult> {
    const { store, config } = this.opts;
    const floor = config().floors[order.floor];
    if (!floor?.managed) return { ok: false, error: 'floor', detail: order.floor };
    const repo = realPath(floor.path);
    const active = store.inFloor(order.floor).filter((row) => row.id !== order.id && ACTIVE_STATUSES.has(row.status) && row.worktree_state && BUILDING.has(row.worktree_state));
    if (active.length >= config().worktrees.maxActivePerFloor) return { ok: false, error: 'limit', detail: String(config().worktrees.maxActivePerFloor) };
    const base = order.base_ref ?? floor.baseBranch;
    if (!validRef(base)) return { ok: false, error: 'base', detail: base };
    const path = join(repo, '.claude', 'worktrees', `office-${order.slug}`);
    const branch = orderBranch(order.slug);
    if (this.creating.has(order.slug) || existsSync(path)) return { ok: false, error: 'exists', detail: path };
    this.creating.add(order.slug);
    try {
      return await this.build(order, repo, base, path, branch);
    } finally {
      this.creating.delete(order.slug);
    }
  }

  private async build(order: OrderRow, repo: string, base: string, path: string, branch: string): Promise<CreateResult> {
    const { git, store } = this.opts;
    let stale = !(await this.fetchBase(repo, base));
    let baseRef = `origin/${base}`;
    let sha = await this.resolve(repo, baseRef);
    if (stale || !sha) {
      const local = await this.resolve(repo, base);
      if (local) {
        sha = local;
        baseRef = base;
        stale = true;
      }
    }
    if (!sha) return { ok: false, error: 'base', detail: base };
    // A fork leaves from a checkpoint of another order, not from the tip of its base.
    const start = order.base_sha ?? sha;
    if (start !== sha && (await run(git, repo, () => gitOps.commitExists(start))).code !== 0) return { ok: false, error: 'base', detail: start };
    if ((await run(git, repo, () => gitOps.branchExists(branch))).code === 0) return { ok: false, error: 'exists', detail: branch };
    mkdirSync(dirname(path), { recursive: true });
    const added = await run(git, repo, () => gitOps.worktreeAdd(branch, path, start));
    if (added.code !== 0) return { ok: false, error: 'git', detail: added.stderr.trim() };
    await this.markAndExclude(repo, path);
    await this.copyIncludes(repo, path);
    this.linkDirs(repo, path, this.opts.config().floors[order.floor]?.linkDirs ?? []);
    const setup = setupOf(this.opts.config().floors[order.floor] ?? { path: repo, stack: 'generic' });
    const state: WorktreeState = setup ? 'preparando' : 'listo';
    const row = store.update(order.id, {
      branch,
      base_ref: baseRef,
      base_sha: start,
      base_stale: stale ? 1 : 0,
      worktree_path: path,
      worktree_state: state,
      setup_error: null,
      updated_at: this.opts.now(),
    }) as OrderRow;
    this.reindex();
    this.opts.changed(row);
    const ready = setup ? this.prepare(row, setup) : Promise.resolve(row);
    this.opts.bus.background(ready);
    return { ok: true, order: row, ready };
  }

  private async fetchBase(repo: string, base: string): Promise<boolean> {
    return (await run(this.opts.git, repo, () => gitOps.fetch(base))).code === 0;
  }

  private async resolve(repo: string, name: string): Promise<string | null> {
    const result = await run(this.opts.git, repo, () => gitOps.verify(name));
    const sha = result.stdout.trim();
    return result.code === 0 && sha ? sha : null;
  }

  private async markAndExclude(repo: string, path: string): Promise<void> {
    const dir = await run(this.opts.git, path, () => gitOps.gitDir());
    const adminDir = dir.stdout.trim();
    if (dir.code === 0 && adminDir) {
      try {
        writeFileSync(join(adminDir, MARKER), `${this.opts.hubId}\n`);
      } catch {
        // Without a marker the folder is "foreign" for the cleanup: it is only reported, never removed.
      }
    }
    const common = await run(this.opts.git, repo, () => gitOps.commonDir());
    const commonDir = common.stdout.trim();
    if (common.code !== 0 || !commonDir) return;
    const exclude = join(commonDir, 'info', 'exclude');
    try {
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return;
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`);
    } catch {
      // The folder shows as untracked in the main copy; nothing breaks.
    }
  }

  // Literal entries of .worktreeinclude that git confirms are ignored: the local files (.env, keys) a worktree
  // needs and a checkout does not bring.
  private async copyIncludes(repo: string, path: string): Promise<void> {
    const file = join(repo, '.worktreeinclude');
    if (!existsSync(file)) return;
    const wanted = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim().replace(/\/+$/, ''))
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('/') && !/[*?[\\]/.test(line) && !line.split('/').includes('..'));
    if (wanted.length === 0) return;
    const ignored = await run(this.opts.git, repo, () => gitOps.checkIgnore(), 30_000, `${wanted.join('\0')}\0`);
    const confirmed = new Set(ignored.stdout.split('\0').filter((name) => name !== ''));
    for (const entry of wanted) {
      const source = join(repo, entry);
      const target = join(path, entry);
      if (!confirmed.has(entry) || !existsSync(source) || existsSync(target)) continue;
      try {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true, dereference: false });
      } catch {
        // A file that cannot be copied is the dependencies' problem, not the folder's.
      }
    }
  }

  private linkDirs(repo: string, path: string, dirs: readonly string[]): void {
    for (const dir of dirs) {
      const source = join(repo, dir);
      const target = join(path, dir);
      if (!existsSync(source) || existsSync(target)) continue;
      try {
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target, 'dir');
      } catch {
        // The setup (or the lead) deals with a missing link.
      }
    }
  }

  private async prepare(order: OrderRow, command: string): Promise<OrderRow> {
    const { store, config } = this.opts;
    const shell = this.opts.shell ?? runShell;
    const result = await shell(command, {
      cwd: order.worktree_path ?? '/',
      timeoutMs: config().checksConfig.timeoutMinutes * 60_000,
      tailBytes: 2000,
    });
    const failed = result.code !== 0;
    const reason = result.timedOut ? 'timeout' : result.tail.trim().split('\n').slice(-6).join('\n') || `exit ${result.code}`;
    const next = store.update(order.id, {
      worktree_state: failed ? 'error' : 'listo',
      setup_error: failed ? reason : null,
      updated_at: this.opts.now(),
    }) as OrderRow;
    this.opts.changed(next);
    return next;
  }

  async list(floor?: string): Promise<WorktreeSummary> {
    const rows = this.opts.store.withWorktree().filter((row) => !floor || row.floor === floor);
    const worktrees = await Promise.all(rows.map((row) => this.view(row)));
    const totalKb = worktrees.reduce((sum, view) => sum + (view.sizeKb ?? 0), 0);
    return { worktrees, totalKb, warnKb: this.opts.config().worktrees.warnTotalGb * 1024 * 1024 };
  }

  private async view(row: OrderRow): Promise<WorktreeView> {
    const path = row.worktree_path ?? '';
    const branch = row.branch ?? '';
    const facts = await this.facts(row);
    const size = await this.size(path);
    const cutoff = this.opts.now() - this.opts.config().worktrees.retentionDays * DAY_MS;
    return {
      orderId: row.id,
      slug: row.slug,
      floor: row.floor,
      title: row.title,
      branch,
      base: row.base_ref ?? '',
      baseSha: row.base_sha ?? '',
      path,
      state: row.worktree_state ?? 'listo',
      setupError: row.setup_error,
      ahead: facts.ahead,
      behind: facts.behind,
      sizeKb: size.kb,
      sizeAt: size.at,
      lastActivity: row.last_activity,
      dirty: facts.dirty,
      merged: facts.merged,
      orderStatus: row.status,
      pending: row.status === 'hecho' && undecided(facts) && row.kept_at === null && row.updated_at < cutoff,
      kept: row.kept_at !== null,
    };
  }

  private async facts(row: OrderRow): Promise<Facts> {
    const facts: Facts = { ahead: 0, behind: 0, own: 0, dirty: false, merged: false, known: false, tip: null };
    const path = row.worktree_path;
    const branch = row.branch;
    const repo = this.repoOf(row);
    if (!path || !branch || !repo) return facts;
    const { git } = this.opts;
    const present = existsSync(path);
    let known = row.base_sha !== null;
    if (present) {
      const status = await run(git, path, () => gitOps.status());
      facts.dirty = status.code !== 0 || status.stdout.length > 0;
      if (status.code !== 0) known = false;
    }
    facts.tip = await this.branchTip(repo, branch);
    if (!facts.tip) return facts;
    if (present) {
      const head = await run(git, path, () => gitOps.head());
      if (head.code !== 0 || head.stdout.trim() !== facts.tip) known = false;
    }
    const baseName = row.base_ref ?? '';
    const baseTip = (baseName ? await this.resolve(repo, baseName) : null) ?? row.base_sha ?? '';
    const counted = baseTip ? await this.counts(repo, baseTip, facts.tip) : null;
    if (counted) [facts.behind, facts.ahead] = counted;
    const own = !row.base_sha ? null : row.base_sha === baseTip ? counted : await this.counts(repo, row.base_sha, facts.tip);
    if (!counted || !own) known = false;
    facts.own = own?.[1] ?? 0;
    facts.known = known;
    facts.merged = known && facts.own > 0 && baseName !== '' && row.base_sha !== null && (await this.landed(repo, row.base_sha, facts.tip, baseName, baseTip));
    return facts;
  }

  private async branchTip(repo: string, branch: string): Promise<string | null> {
    const result = await run(this.opts.git, repo, () => gitOps.branchTip(branch));
    const tip = result.stdout.trim();
    return result.code === 0 && validSha(tip) ? tip : null;
  }

  // rev-list --left-right --count: the commits only in from, then the ones only in to; anything else is no answer.
  private async counts(repo: string, from: string, to: string): Promise<[number, number] | null> {
    const result = await run(this.opts.git, repo, () => gitOps.aheadBehind(from, to));
    const match = /^(\d+)\s+(\d+)$/.exec(result.stdout.trim());
    return result.code === 0 && match ? [Number(match[1]), Number(match[2])] : null;
  }

  // The tip is in the base: merged as it is, or replayed as commits with the same patches (rebase) or as one
  // commit with the change of the whole branch (squash). A check git could not finish is not cached.
  private async landed(repo: string, baseSha: string, tip: string, baseName: string, baseTip: string): Promise<boolean> {
    const { git } = this.opts;
    if ((await run(git, repo, () => gitOps.isAncestor(tip, baseName))).code === 0) return true;
    if (!baseTip || baseTip === baseSha) return false;
    const key = `${baseSha}:${tip}:${baseTip}`;
    const known = this.landedAt.get(key);
    if (known !== undefined) return known;
    const replayed = await this.replayed(repo, baseSha, tip, baseTip);
    const squashed = replayed === true ? true : await this.squashed(repo, baseSha, tip, baseTip);
    if (squashed !== true && (replayed === null || squashed === null)) return false;
    const result = squashed;
    if (this.landedAt.size >= LANDED_CACHE) this.landedAt.clear();
    this.landedAt.set(key, result);
    return result;
  }

  private async replayed(repo: string, baseSha: string, tip: string, baseTip: string): Promise<boolean | null> {
    const cherry = await run(this.opts.git, repo, () => gitOps.cherry(baseTip, tip, baseSha));
    if (cherry.code !== 0) return null;
    const lines = cherry.stdout.split('\n').filter((line) => line !== '');
    return lines.length > 0 && lines.every((line) => line.startsWith('-'));
  }

  // patch-id only finds the candidates: it ignores whitespace and, before git 2.39, binary content. A candidate
  // counts when its own diff, over the paths of the branch, is the same text as the branch's (full blob ids).
  private async squashed(repo: string, baseSha: string, tip: string, baseTip: string): Promise<boolean | null> {
    const { git } = this.opts;
    const limits = { maxStdoutBytes: PATCH_BYTES };
    const names = await run(git, repo, () => gitOps.diffNames(baseSha, tip));
    if (names.code !== 0) return null;
    const paths = zList(names.stdout);
    if (paths.length === 0 || paths.some((name) => name.includes('\uFFFD')) || paths.reduce((n, name) => n + name.length + 12, 0) > PATHSPEC_BYTES) return false;
    const whole = await run(git, repo, () => gitOps.diffPatch(baseSha, tip, paths), undefined, undefined, limits);
    if (whole.code !== 0) return null;
    if (whole.cut || whole.stdout === '') return false;
    const [wanted] = (await this.patchIds(repo, whole.stdout)) ?? [];
    if (!wanted) return null;
    const log = await run(git, repo, () => gitOps.logPatches(baseSha, baseTip, paths), undefined, undefined, limits);
    if (log.code !== 0) return null;
    if (log.cut) return false;
    const found = await this.patchIds(repo, log.stdout);
    if (!found) return null;
    let answered = true;
    for (const { commit } of found.filter((entry) => entry.id === wanted.id).slice(0, SQUASH_CANDIDATES)) {
      const own = await run(git, repo, () => gitOps.commitPatch(commit, paths), undefined, undefined, limits);
      if (own.code !== 0) answered = false;
      else if (!own.cut && own.stdout === whole.stdout) return true;
    }
    return answered ? false : null;
  }

  private async patchIds(repo: string, patch: string): Promise<{ id: string; commit: string }[] | null> {
    if (patch === '') return [];
    const result = await run(this.opts.git, repo, () => gitOps.patchIds(), undefined, patch);
    if (result.code !== 0) return null;
    return result.stdout
      .split('\n')
      .map((line) => line.split(' '))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '' && validSha(parts[1]))
      .map(([id, commit]) => ({ id, commit }));
  }

  // One fetch of the base of every folder about to be judged, so a merge done on the remote counts; the floors
  // fetch at the same time, the bases of one floor one after another. A fetch that fails leaves the last known base.
  private async refreshBases(rows: OrderRow[]): Promise<void> {
    const byRepo = new Map<string, Set<string>>();
    for (const row of rows) {
      const repo = this.repoOf(row);
      const base = row.base_ref?.startsWith(REMOTE) ? row.base_ref.slice(REMOTE.length) : null;
      if (!repo || !base || !row.worktree_path || !existsSync(row.worktree_path)) continue;
      byRepo.set(repo, (byRepo.get(repo) ?? new Set<string>()).add(base));
    }
    await Promise.all(
      [...byRepo].map(async ([repo, bases]) => {
        for (const base of bases) await this.fetchBase(repo, base);
      }),
    );
  }

  private repoOf(row: OrderRow): string | null {
    const floor = this.opts.config().floors[row.floor];
    return floor ? realPath(floor.path) : null;
  }

  private async size(path: string): Promise<{ kb: number | null; at: number | null }> {
    const cached = this.sizes.get(path);
    const now = this.opts.now();
    if (cached && now - cached.at < SIZE_CACHE_MS) return cached;
    const kb = await (this.opts.sizeOf ?? duKb)(path);
    const entry = { kb, at: now };
    this.sizes.set(path, entry);
    return entry;
  }

  keep(orderId: number): OrderRow | null {
    const row = this.opts.store.get(orderId);
    if (!row?.worktree_path) return null;
    const next = this.opts.store.update(orderId, { kept_at: this.opts.now() }) as OrderRow;
    this.opts.changed(next);
    return next;
  }

  // Slugs of the live folders of a floor with changes nobody committed.
  async dirtyIn(floor: string): Promise<string[]> {
    const dirty: string[] = [];
    for (const row of this.opts.store.withWorktree().filter((r) => r.floor === floor)) {
      if (!row.worktree_path || !existsSync(row.worktree_path)) continue;
      const status = await run(this.opts.git, row.worktree_path, () => gitOps.status());
      if (status.code !== 0 || status.stdout.length > 0) dirty.push(row.slug);
    }
    return dirty;
  }

  async removeAll(floor: string, force: boolean): Promise<number> {
    let removed = 0;
    for (const row of this.opts.store.withWorktree().filter((r) => r.floor === floor)) {
      if ((await this.remove(row.id, { deleteBranch: false, force })) === 'ok') removed += 1;
    }
    return removed;
  }

  async remove(orderId: number, opts: { deleteBranch: boolean; force: boolean }): Promise<RemoveResult> {
    const row = this.opts.store.get(orderId);
    const path = row?.worktree_path;
    if (!row || !path || row.worktree_state === 'retirado') return 'not-found';
    if (this.opts.inside(path)) return 'busy';
    const repo = this.repoOf(row);
    if (!repo) return 'failed';
    const present = existsSync(path);
    const facts = present ? await this.facts(row) : null;
    if (facts?.dirty && !opts.force) return 'dirty';
    // A folder whose HEAD may hold commits the branch does not, or a branch git could not judge, needs force.
    if (facts && undecided(facts) && !opts.force && (opts.deleteBranch || !facts.known)) return 'unmerged';
    const branch = opts.deleteBranch ? row.branch : null;
    const tip = branch ? (facts?.tip ?? (await this.branchTip(repo, branch))) : null;
    if (branch && !tip) return 'failed';
    if (present) {
      const removed = await run(this.opts.git, repo, () => gitOps.worktreeRemove(path, opts.force));
      if (removed.code !== 0) return 'failed';
    } else await run(this.opts.git, repo, () => gitOps.worktreePrune());
    if (branch && tip) {
      const judged = present || opts.force;
      // Without its folder nothing was judged: git deletes it only if it is merged into the main copy.
      const deleted = await run(this.opts.git, repo, () => (judged ? gitOps.branchDeleteAt(branch, tip) : gitOps.branchDelete(branch, false)));
      if (deleted.code !== 0) {
        if (!judged) return 'failed';
        // The branch took a commit after it was judged: the folder is gone either way, the branch stays where it went.
        const current = await this.branchTip(repo, branch);
        if (current === tip) return 'failed';
        this.retire(orderId, path);
        if (!current) return 'ok';
        this.note({ key: 'hub.act.branchMoved', params: { branch, sha: current } });
        return 'branch-moved';
      }
      this.note({ key: 'hub.act.branchDeleted', params: { branch, sha: tip } });
    }
    this.retire(orderId, path);
    return 'ok';
  }

  private retire(orderId: number, path: string): void {
    const next = this.opts.store.update(orderId, { worktree_state: 'retirado', updated_at: this.opts.now() }) as OrderRow;
    this.reindex();
    this.sizes.delete(path);
    this.opts.changed(next);
  }

  // The setup of a folder that failed or was cut short, again: the state goes back to preparando and ends in listo or error.
  async resetup(orderId: number): Promise<OrderRow | null> {
    const row = this.opts.store.get(orderId);
    const floor = row ? this.opts.config().floors[row.floor] : undefined;
    if (!row?.worktree_path || !floor || !existsSync(row.worktree_path) || row.worktree_state === 'retirado') return null;
    const setup = setupOf(floor);
    if (!setup) {
      const ready = this.opts.store.update(orderId, { worktree_state: 'listo', setup_error: null, updated_at: this.opts.now() }) as OrderRow;
      this.opts.changed(ready);
      return ready;
    }
    const busy = this.opts.store.update(orderId, { worktree_state: 'preparando', setup_error: null, updated_at: this.opts.now() }) as OrderRow;
    this.opts.changed(busy);
    return this.prepare(busy, setup);
  }

  // Folders of this hub that no order owns any more are removed if clean; dirty or foreign ones are reported.
  async cleanup(): Promise<void> {
    // A setup the hub was in the middle of when it went down never finishes: it is marked so it can be retried.
    for (const row of this.opts.store.withWorktree()) {
      if (row.worktree_state !== 'preparando') continue;
      this.opts.changed(this.opts.store.update(row.id, { worktree_state: 'error', setup_error: 'interrupted', updated_at: this.opts.now() }) as OrderRow);
    }
    const owned = new Set(this.opts.store.withWorktree().map((row) => row.worktree_path));
    const warned: string[] = [];
    for (const floor of Object.values(this.opts.config().floors)) {
      if (!floor.managed || !existsSync(floor.path)) continue;
      const repo = realPath(floor.path);
      const root = join(repo, '.claude', 'worktrees');
      const listed = await run(this.opts.git, repo, () => gitOps.worktreeList());
      if (listed.code !== 0) continue;
      for (const path of worktreePaths(listed.stdout)) {
        if (!isInside(path, root) || !/^office-/.test(path.slice(root.length + 1))) continue;
        if (owned.has(path)) continue;
        const marker = markerOf(path);
        if (marker !== this.opts.hubId) {
          warned.push(path);
          continue;
        }
        const status = await run(this.opts.git, path, () => gitOps.status());
        if (status.code !== 0 || status.stdout.length > 0) {
          warned.push(path);
          continue;
        }
        await run(this.opts.git, repo, () => gitOps.worktreeRemove(path, false));
      }
      await run(this.opts.git, repo, () => gitOps.worktreePrune());
    }
    if (warned.length > 0) this.note({ key: 'hub.act.worktreesOrphan', params: { n: warned.length, paths: warned.join(', ') } });
  }

  // Daily: finished, merged or discarded folders past the retention go; the rest is only counted.
  async expire(): Promise<{ removed: number; pending: number; totalKb: number }> {
    const cfg = this.opts.config().worktrees;
    const cutoff = this.opts.now() - cfg.retentionDays * DAY_MS;
    let removed = 0;
    let pending = 0;
    let pendingKb = 0;
    let totalKb = 0;
    const unknown: string[] = [];
    const rows = this.opts.store.withWorktree();
    const due = (row: OrderRow) => row.updated_at < cutoff && (row.status === 'hecho' || row.status === 'descartado');
    await this.refreshBases(rows.filter(due));
    for (const row of rows) {
      const path = row.worktree_path ?? '';
      const size = await this.size(path);
      totalKb += size.kb ?? 0;
      if (!due(row)) continue;
      const facts = await this.facts(row);
      if (!facts.known) {
        unknown.push(row.slug);
        continue;
      }
      if (row.status === 'hecho' && undecided(facts)) {
        if (row.kept_at === null) {
          pending += 1;
          pendingKb += size.kb ?? 0;
        }
        continue;
      }
      if (facts.dirty) continue;
      const outcome = await this.remove(row.id, { deleteBranch: !undecided(facts), force: false });
      if (outcome === 'ok' || outcome === 'branch-moved') removed += 1;
    }
    if (pending > 0) this.note({ key: 'hub.act.worktreesPending', params: { n: pending, sizeKb: pendingKb } });
    if (unknown.length > 0) this.note({ key: 'hub.act.worktreesUnknown', params: { n: unknown.length, slugs: unknown.join(', ') } });
    if (totalKb > cfg.warnTotalGb * 1024 * 1024) {
      this.note({ key: 'hub.act.worktreesHeavy', params: { gb: Math.round((totalKb / 1024 / 1024) * 10) / 10, max: cfg.warnTotalGb } });
    }
    return { removed, pending, totalKb };
  }

  private note(summary: HubText): void {
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: 'panel', event: 'Worktrees', tool: null, state: null, summary });
  }
}

// Commits of its own that are not in the base, or facts git could not confirm: somebody has to decide.
function undecided(facts: Facts): boolean {
  return !facts.known || (facts.own > 0 && !facts.merged);
}

function isUnder(cwd: string, folder: string): boolean {
  return cwd === folder || cwd.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((path) => path !== '');
}

function markerOf(path: string): string | null {
  try {
    const pointer = readFileSync(join(path, '.git'), 'utf8').trim();
    const dir = pointer.startsWith('gitdir:') ? pointer.slice('gitdir:'.length).trim() : null;
    if (!dir) return null;
    return readFileSync(join(dir, MARKER), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function duKb(path: string): Promise<number | null> {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['du', '-sk', absolutePath(path)], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  } catch {
    return null;
  }
  const timer = setTimeout(() => proc.kill(), SIZE_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    const kb = Number(out.split(/\s+/)[0]);
    return code === 0 && Number.isFinite(kb) ? kb : null;
  } finally {
    clearTimeout(timer);
  }
}
