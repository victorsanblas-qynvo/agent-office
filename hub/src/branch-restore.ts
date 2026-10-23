import type { Database, Statement } from 'bun:sqlite';
import { realPath } from './floors';
import type { GitRunner } from './git';
import type { OfficeBus } from './office-bus';
import { gitOps, ORDER_BRANCH_PREFIX, run, validOrderBranch } from './repo-ops';
import type { DeletedBranchBlock, DeletedBranchView, OfficeConfig } from './types';

const WINDOW_MS = 30 * 86_400_000;
const MAX_LISTED = 100;
const MAX_SCANNED = 1000;
const GIT_TIMEOUT_MS = 15_000;
const CHECKS_AT_ONCE = 8;
const BLOCK_TTL_MS = 30_000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DELETED_KEY = 'hub.act.branchDeleted';

export type BranchRestoreResult = 'ok' | 'bad' | 'floor' | 'not-found' | 'exists' | 'gone' | 'git';

type Deletion = { floor: string; branch: string; sha: string; at: number; superseded: boolean };

export type BranchRestoreDeskOpts = {
  db: Database;
  git: GitRunner;
  now: () => number;
  bus: OfficeBus;
  config: () => OfficeConfig;
};

// The order branches the worktree desk deleted: each deletion left an activity line with the branch and its tip,
// and while git keeps that commit the branch can be created again where it was.
export class BranchRestoreDesk {
  private readonly lines: Statement<{ ts: number; summary: string }, [number, string]>;
  private readonly floorOfSlug: Statement<{ floor: string }, [string]>;
  private readonly blocks = new Map<string, { at: number; reason: DeletedBranchBlock | null }>();

  constructor(private readonly opts: BranchRestoreDeskOpts) {
    this.lines = opts.db.query(
      `SELECT ts, summary FROM activity_log WHERE agent_key = 'panel' AND ts >= ?1 AND summary LIKE ?2 ORDER BY ts DESC, id DESC LIMIT ${MAX_SCANNED}`,
    );
    this.floorOfSlug = opts.db.query('SELECT floor FROM orders WHERE slug = ?');
  }

  managed(floor: string): boolean {
    return this.opts.config().floors[floor]?.managed === true;
  }

  async list(floor?: string): Promise<DeletedBranchView[]> {
    const deletions = this.deletions(floor).slice(0, MAX_LISTED);
    const views: DeletedBranchView[] = [];
    for (let i = 0; i < deletions.length; i += CHECKS_AT_ONCE) {
      views.push(...(await Promise.all(deletions.slice(i, i + CHECKS_AT_ONCE).map((deletion) => this.view(deletion)))));
    }
    return views;
  }

  async restore(floor: string, branch: unknown, sha: unknown): Promise<BranchRestoreResult> {
    if (!validOrderBranch(branch) || typeof sha !== 'string' || !FULL_SHA.test(sha)) return 'bad';
    const repo = this.repoOf(floor);
    if (!repo) return 'floor';
    if (!this.deletions(floor).some((d) => d.branch === branch && d.sha === sha && !d.superseded)) return 'not-found';
    const block = await this.block(repo, branch, sha);
    if (block === 'exists') return 'exists';
    if (block === 'gone') return 'gone';
    if (block === 'unknown') return 'git';
    const created = await run(this.opts.git, repo, () => gitOps.branchCreateAt(branch, sha), GIT_TIMEOUT_MS);
    if (created.code !== 0) return (await this.refState(repo, branch)) === 'present' ? 'exists' : 'git';
    this.forget(branch);
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: 'panel', event: 'Worktrees', tool: null, state: null, summary: { key: 'hub.act.branchRestored', params: { branch, sha } } });
    this.opts.bus.emit({ type: 'worktrees', floor });
    return 'ok';
  }

  // Newest first, one per branch and commit; an older deletion of a branch that was deleted again is superseded; a line whose order (and so its floor) the office forgot is left out.
  private deletions(floor?: string): Deletion[] {
    const since = this.opts.now() - WINDOW_MS;
    const seen = new Set<string>();
    const latest = new Set<string>();
    const floors = new Map<string, string | null>();
    const out: Deletion[] = [];
    for (const row of this.lines.all(since, `%"${DELETED_KEY}"%`)) {
      const parsed = parseDeletion(row.summary);
      if (!parsed) continue;
      const slug = parsed.branch.slice(ORDER_BRANCH_PREFIX.length);
      if (!floors.has(slug)) floors.set(slug, this.floorOfSlug.get(slug)?.floor ?? null);
      const owner = floors.get(slug);
      if (!owner || (floor !== undefined && owner !== floor) || !this.managed(owner)) continue;
      const key = `${parsed.branch}\0${parsed.sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ floor: owner, branch: parsed.branch, sha: parsed.sha, at: row.ts, superseded: latest.has(parsed.branch) });
      latest.add(parsed.branch);
    }
    return out;
  }

  private async view(deletion: Deletion): Promise<DeletedBranchView> {
    const { superseded, ...base } = deletion;
    if (superseded) return { ...base, restorable: false, reason: 'superseded' };
    const repo = this.repoOf(deletion.floor);
    const reason = repo ? await this.cachedBlock(repo, deletion.branch, deletion.sha) : 'unknown';
    return { ...base, restorable: reason === null, reason };
  }

  private async cachedBlock(repo: string, branch: string, sha: string): Promise<DeletedBranchBlock | null> {
    const key = `${repo}\0${branch}\0${sha}`;
    const now = this.opts.now();
    const hit = this.blocks.get(key);
    if (hit && now - hit.at < BLOCK_TTL_MS) return hit.reason;
    const reason = await this.block(repo, branch, sha);
    this.blocks.set(key, { at: now, reason });
    return reason;
  }

  private forget(branch: string): void {
    for (const key of this.blocks.keys()) if (key.split('\0')[1] === branch) this.blocks.delete(key);
  }

  // Why the branch cannot come back now, or null when it can: the name is free and git still has the commit.
  private async block(repo: string, branch: string, sha: string): Promise<DeletedBranchBlock | null> {
    const ref = await this.refState(repo, branch);
    if (ref === 'present') return 'exists';
    if (ref === 'unknown') return 'unknown';
    const commit = await run(this.opts.git, repo, () => gitOps.commitExists(sha), GIT_TIMEOUT_MS);
    if (commit.code === 0) return null;
    return commit.code === 1 ? 'gone' : 'unknown';
  }

  private async refState(repo: string, branch: string): Promise<'present' | 'absent' | 'unknown'> {
    const result = await run(this.opts.git, repo, () => gitOps.branchExists(branch), GIT_TIMEOUT_MS);
    return result.code === 0 ? 'present' : result.code === 1 ? 'absent' : 'unknown';
  }

  private repoOf(floor: string): string | null {
    const config = this.opts.config().floors[floor];
    return config?.managed ? realPath(config.path) : null;
  }
}

function parseDeletion(summary: string): { branch: string; sha: string } | null {
  try {
    const parsed = JSON.parse(summary) as { key?: unknown; params?: { branch?: unknown; sha?: unknown } };
    const branch = parsed.params?.branch;
    const sha = parsed.params?.sha;
    if (parsed.key !== DELETED_KEY || !validOrderBranch(branch) || typeof sha !== 'string' || !FULL_SHA.test(sha)) return null;
    return { branch, sha };
  } catch {
    return null;
  }
}
