import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { CheckpointDesk } from './checkpoints';
import { checksTouched, type RunFacts } from './gate';
import { GitQueue, gitSync as realGitSync, type GitResult, type GitRunner } from './git';
import type { OfficeBus } from './office-bus';
import type { OrderRow, OrderStore } from './order-store';
import { checkFilesOf, checksOf, type Profiles } from './profiles';
import { gitOps, run, zList } from './repo-ops';
import { lastLines, runShell } from './shell';
import type {
  CheckRunStatus,
  CheckRunView,
  CheckSpec,
  CheckStatus,
  CheckTrigger,
  CheckView,
  OfficeConfig,
  OrderChecksView,
} from './types';

const LISTO_DELAY_MS = 20_000;
const SPECS_CACHE_MS = 10_000;
const RED_LINES = 40;
const HISTORY = 10;

type RunRow = { id: number; order_id: number; sha: string; trigger: string; status: string; started_at: number; ended_at: number | null };
type CheckRow = { id: number; run_id: number; name: string; command: string; status: string; exit_code: number | null; duration_ms: number | null; output_tail: string | null };

export type StartResult =
  | { ok: true; run: CheckRunView; done: Promise<CheckRunView> }
  | { ok: false; reason: 'no-folder' | 'no-checks' };

export type ChecksDeskOpts = {
  db: Database;
  store: OrderStore;
  git: GitRunner;
  gitSync?: (cwd: string, args: string[]) => GitResult;
  now: () => number;
  bus: OfficeBus;
  config: () => OfficeConfig;
  profiles: () => Profiles;
  checkpoints: Pick<CheckpointDesk, 'commit' | 'dirtyFiles'>;
  shell?: typeof runShell;
  // The lead is told when a run ends: green, or the first red.
  notify: (order: OrderRow, text: string) => void;
  changed: (order: OrderRow) => void;
  listoDelayMs?: number;
};

type Active = { runId: number; sha: string; controller: AbortController; done: Promise<CheckRunView> };

export type GateReading = {
  head: string | null;
  dirty: string[];
  run: RunFacts | null;
  touched: string[];
  forcedSha: string | null;
  hasChecks: boolean;
};

// At most limit() commands at once across the hub; the limit is read each time, so a new config applies at once.
class Semaphore {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: () => number) {}

  async acquire(): Promise<void> {
    while (this.running >= Math.max(1, this.limit())) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
  }

  release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

// The checks of an order, run by the hub in its folder: after a checkpoint, so the result is about a sha.
export class ChecksDesk {
  private readonly active = new Map<number, Active>();
  private readonly listoTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly touchedCache = new Map<string, string[]>();
  private readonly memo = new Map<string, string[]>();
  private readonly specsCache = new Map<string, { at: number; specs: CheckSpec[] }>();
  private readonly slots: Semaphore;
  private readonly starts = new GitQueue();

  constructor(private readonly opts: ChecksDeskOpts) {
    this.slots = new Semaphore(() => opts.config().checksConfig.maxParallel);
  }

  get activeRuns(): number {
    return this.active.size;
  }

  private sync(cwd: string, args: string[]): GitResult {
    return (this.opts.gitSync ?? realGitSync)(cwd, args);
  }

  // The checks of a floor; a node floor reads its package.json, so the answer is kept a few seconds.
  specs(order: OrderRow): CheckSpec[] {
    const floor = this.opts.config().floors[order.floor];
    if (!floor) return [];
    const now = this.opts.now();
    const key = `${order.floor}:${floor.path}:${floor.stack}:${JSON.stringify(floor.checks ?? null)}`;
    const known = this.specsCache.get(key);
    if (known && now - known.at < SPECS_CACHE_MS) return known.specs;
    const specs = checksOf(floor);
    this.specsCache.set(key, { at: now, specs });
    if (this.specsCache.size > 100) this.specsCache.delete(this.specsCache.keys().next().value as string);
    return specs;
  }

  // Runs a hub that went down left as running never finish: at start they are cancelled.
  sweepStale(): void {
    const { db, now } = this.opts;
    db.query("UPDATE checks SET status = 'cancelled' WHERE status IN ('pending', 'running') AND run_id IN (SELECT id FROM check_runs WHERE status = 'running')").run();
    db.query("UPDATE check_runs SET status = 'cancelled', ended_at = ? WHERE status = 'running'").run(now());
  }

  // ---- running --------------------------------------------------------------------------------------------

  // One start of an order at a time: two at once would commit in the same folder and race for its index.
  start(orderId: number, trigger: CheckTrigger): Promise<StartResult> {
    return this.starts.run(orderId.toString(), () => this.startNow(orderId, trigger));
  }

  private async startNow(orderId: number, trigger: CheckTrigger): Promise<StartResult> {
    const order = this.opts.store.get(orderId);
    const cwd = order?.worktree_path;
    if (!order || !cwd || !existsSync(cwd) || order.worktree_state === 'retirado') return { ok: false, reason: 'no-folder' };
    const specs = this.specs(order);
    if (specs.length === 0) return { ok: false, reason: 'no-checks' };
    const checkpoint = await this.opts.checkpoints.commit(order, trigger, trigger === 'listo' ? 'listo' : `comprobación (${trigger})`);
    const head = checkpoint.sha ?? (await this.head(cwd));
    if (!head) return { ok: false, reason: 'no-folder' };
    this.touchedAt(order, head);
    // A commit that failed leaves changes HEAD does not have: the run is about HEAD-dirty, which never satisfies the gate.
    const sha = checkpoint.failed ? `${head}-dirty` : head;
    const running = this.active.get(orderId);
    if (running && running.sha === sha) {
      const view = this.latest(orderId) as CheckRunView;
      return { ok: true, run: view, done: running.done };
    }
    if (running) running.controller.abort();
    return this.launch(order, cwd, specs, sha, trigger);
  }

  private launch(order: OrderRow, cwd: string, specs: CheckSpec[], sha: string, trigger: CheckTrigger): StartResult {
    const { db, now } = this.opts;
    const runId = Number(
      db
        .query("INSERT INTO check_runs (order_id, floor, slug, sha, trigger, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
        .run(order.id, order.floor, order.slug, sha, trigger, now()).lastInsertRowid,
    );
    const insert = db.query("INSERT INTO checks (run_id, floor, slug, name, command, status) VALUES (?, ?, ?, ?, ?, 'pending')");
    for (const spec of specs) insert.run(runId, order.floor, order.slug, spec.name, spec.command);
    const controller = new AbortController();
    const done = this.execute(order, runId, cwd, controller);
    this.active.set(order.id, { runId, sha, controller, done });
    this.opts.bus.background(done);
    const view = this.runView(this.runRow(runId) as RunRow);
    this.publish(order, view);
    return { ok: true, run: view, done };
  }

  private async execute(order: OrderRow, runId: number, cwd: string, controller: AbortController): Promise<CheckRunView> {
    const { db, now } = this.opts;
    const shell = this.opts.shell ?? runShell;
    const cfg = this.opts.config().checksConfig;
    const rows = db.query<CheckRow, [number]>('SELECT * FROM checks WHERE run_id = ? ORDER BY id').all(runId);
    const setCheck = db.query('UPDATE checks SET status = ?, exit_code = ?, duration_ms = ?, output_tail = ? WHERE id = ?');
    await Promise.all(
      rows.map(async (row) => {
        await this.slots.acquire();
        try {
          if (controller.signal.aborted) {
            setCheck.run('cancelled', null, null, null, row.id);
            return;
          }
          setCheck.run('running', null, null, null, row.id);
          this.publishRun(order, runId);
          const result = await shell(row.command, { cwd, timeoutMs: cfg.timeoutMinutes * 60_000, tailBytes: cfg.tailBytes, signal: controller.signal });
          const status: CheckStatus = result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : result.code === 0 ? 'passed' : 'failed';
          setCheck.run(status, result.code, result.durationMs, result.tail, row.id);
        } finally {
          this.slots.release();
        }
        this.publishRun(order, runId);
      }),
    );
    const results = db.query<{ status: string }, [number]>('SELECT status FROM checks WHERE run_id = ?').all(runId).map((row) => row.status);
    const superseded = this.active.get(order.id)?.runId !== runId;
    const status: CheckRunStatus = controller.signal.aborted ? 'cancelled' : results.every((value) => value === 'passed') ? 'passed' : 'failed';
    db.query('UPDATE check_runs SET status = ?, ended_at = ? WHERE id = ?').run(status, now(), runId);
    if (!superseded) this.active.delete(order.id);
    const fresh = this.opts.store.get(order.id) ?? order;
    const view = this.runView(this.runRow(runId) as RunRow);
    this.publish(fresh, view);
    if (status !== 'cancelled') this.opts.notify(fresh, resultText(fresh, view));
    return view;
  }

  cancel(orderId: number): boolean {
    const running = this.active.get(orderId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  // The dev announces the files are theirs no more (listo): a run, a little later, once more files may be coming.
  scheduleListo(order: OrderRow): void {
    const pending = this.listoTimers.get(order.id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.listoTimers.delete(order.id);
      this.opts.bus.background(this.start(order.id, 'listo').then(() => undefined));
    }, this.opts.listoDelayMs ?? LISTO_DELAY_MS);
    timer.unref?.();
    this.listoTimers.set(order.id, timer);
  }

  stop(): void {
    for (const timer of this.listoTimers.values()) clearTimeout(timer);
    this.listoTimers.clear();
    for (const running of this.active.values()) running.controller.abort();
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((running) => running.done));
  }

  // ---- reading --------------------------------------------------------------------------------------------

  private runRow(runId: number): RunRow | null {
    return this.opts.db.query<RunRow, [number]>('SELECT id, order_id, sha, trigger, status, started_at, ended_at FROM check_runs WHERE id = ?').get(runId);
  }

  private runView(row: RunRow): CheckRunView {
    const checks = this.opts.db.query<CheckRow, [number]>('SELECT * FROM checks WHERE run_id = ? ORDER BY id').all(row.id).map(checkView);
    return {
      id: row.id,
      orderId: row.order_id,
      sha: row.sha,
      trigger: row.trigger as CheckTrigger,
      status: row.status as CheckRunStatus,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      checks,
    };
  }

  latest(orderId: number): CheckRunView | null {
    const row = this.opts.db
      .query<RunRow, [number]>('SELECT id, order_id, sha, trigger, status, started_at, ended_at FROM check_runs WHERE order_id = ? ORDER BY id DESC LIMIT 1')
      .get(orderId);
    return row ? this.runView(row) : null;
  }

  history(orderId: number): CheckRunView[] {
    return this.opts.db
      .query<RunRow, [number, number]>('SELECT id, order_id, sha, trigger, status, started_at, ended_at FROM check_runs WHERE order_id = ? ORDER BY id DESC LIMIT ?')
      .all(orderId, HISTORY)
      .map((row) => this.runView(row));
  }

  // What the card shows: the last run, and the definition files the order changed if there are any.
  summary(order: OrderRow): OrderChecksView | null {
    const last = this.latest(order.id);
    const touched = this.touchedCache.get(order.id.toString()) ?? [];
    if (!last && this.specs(order).length === 0) return null;
    const live = last && last.status !== 'cancelled' ? last : null;
    return {
      status: live ? (live.status as Exclude<CheckRunStatus, 'cancelled'>) : 'none',
      passed: live ? live.checks.filter((check) => check.status === 'passed').length : 0,
      total: live ? live.checks.length : this.specs(order).length,
      sha: live ? live.sha : null,
      touched,
      forced: order.checks_forced_sha !== null && touched.length > 0,
    };
  }

  private publishRun(order: OrderRow, runId: number): void {
    const row = this.runRow(runId);
    if (row) this.opts.bus.emit({ type: 'checks', orderId: order.id, data: this.runView(row) });
  }

  private publish(order: OrderRow, view: CheckRunView): void {
    this.opts.bus.emit({ type: 'checks', orderId: order.id, data: view });
    this.opts.changed(order);
  }

  private async head(cwd: string): Promise<string | null> {
    const result = await run(this.opts.git, cwd, () => gitOps.head());
    return result.code === 0 ? result.stdout.trim() : null;
  }

  // ---- the gate ---------------------------------------------------------------------------------------------

  // Everything the gate of a HECHO needs, read now: the hook waits for the answer.
  gateReading(order: OrderRow): GateReading {
    const path = order.worktree_path;
    const hasChecks = this.specs(order).length > 0;
    if (!path || !existsSync(path)) return { head: null, dirty: [], run: null, touched: [], forcedSha: order.checks_forced_sha, hasChecks };
    const headResult = this.sync(path, gitOps.head());
    const head = headResult.code === 0 ? headResult.stdout.trim() || null : null;
    const dirty = this.opts.checkpoints.dirtyFiles(order) ?? [];
    const last = this.latest(order.id);
    const failed = last?.checks.find((check) => check.status === 'failed' || check.status === 'timeout') ?? null;
    return {
      head,
      dirty,
      run: last
        ? { sha: last.sha, status: last.status, failed: failed ? { name: failed.name, exitCode: failed.exitCode, timedOut: failed.status === 'timeout' } : null }
        : null,
      touched: head ? this.touchedAt(order, head) : [],
      forcedSha: order.checks_forced_sha,
      hasChecks,
    };
  }

  // Files of the diff against the base that redefine how the floor is checked, for the HEAD given.
  touchedAt(order: OrderRow, head: string): string[] {
    const path = order.worktree_path;
    const floor = this.opts.config().floors[order.floor];
    const cacheKey = order.id.toString();
    if (!path || !floor || !order.base_sha) return [];
    const memo = `${order.id}:${order.base_sha}:${head}:${JSON.stringify(floor.checkFiles ?? [])}`;
    const known = this.memo.get(memo);
    if (known) {
      this.touchedCache.set(cacheKey, known);
      return known;
    }
    const diff = this.sync(path, gitOps.diffNames(order.base_sha, head));
    const files = diff.code === 0 ? zList(diff.stdout) : [];
    const patterns = checkFilesOf(this.opts.profiles(), floor);
    const touched = checksTouched(files, patterns, (file, side) => {
      const shown = this.sync(path, gitOps.show(side === 'base' ? (order.base_sha as string) : head, file));
      return shown.code === 0 ? shown.stdout : null;
    });
    this.memo.set(memo, touched);
    if (this.memo.size > 200) this.memo.delete(this.memo.keys().next().value as string);
    this.touchedCache.set(cacheKey, touched);
    return touched;
  }

  // The user accepts that this order changes how it is checked: valid for the HEAD it has now.
  force(order: OrderRow): string | null {
    const path = order.worktree_path;
    if (!path) return null;
    const result = this.sync(path, gitOps.head());
    const head = result.code === 0 ? result.stdout.trim() : '';
    if (!head) return null;
    this.opts.store.update(order.id, { checks_forced_sha: head });
    return head;
  }
}

function checkView(row: CheckRow): CheckView {
  return {
    name: row.name,
    command: row.command,
    status: row.status as CheckStatus,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    outputTail: row.output_tail,
  };
}

// What the lead reads: green with the sha to repeat the HECHO on, or the first red with the end of its output.
export function resultText(order: OrderRow, view: CheckRunView): string {
  const sha = view.sha.slice(0, 7);
  if (view.status === 'passed') return `[Agent Office] COMPROBACIONES encargo/${order.slug} en verde @${sha}: repite el HECHO`;
  const red = view.checks.find((check) => check.status === 'failed' || check.status === 'timeout');
  if (!red) return `[Agent Office] COMPROBACIONES encargo/${order.slug} sin resultado @${sha}`;
  const how = red.status === 'timeout' ? 'se pasó del tiempo' : `terminó con código ${red.exitCode ?? '?'}`;
  const tail = lastLines(red.outputTail ?? '', RED_LINES);
  return `[Agent Office] COMPROBACIONES encargo/${order.slug} en rojo @${sha}: ${red.name} ${how}${tail ? `\n${tail}` : ''}`;
}
