import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { MAX_DESCRIPTION, MAX_TITLE, type CreateOrderRequest, type CreateOrderResult } from './board-desk';
import { statusPaths, type CheckpointDesk } from './checkpoints';
import type { GitRunner } from './git';
import type { OfficeBus } from './office-bus';
import type { OrderRow, OrderStore } from './order-store';
import { gitOps, run, safetyRef, validSafetyRef, validSha } from './repo-ops';
import type { HubText } from './types';

const REMOTE = 'origin/';
const SAFETY_TRIES = 1000;
const LEFTOVERS_SHOWN = 10;

export type RestoreFailure = { ok: false; status: 400 | 404 | 409 | 500; error: HubText };

export type ResetResult = { ok: true; safetyRef: string; head: string } | RestoreFailure;

export type ForkRequest = { title?: string; via?: 'lead' | 'director' };

export type RestoreDeskOpts = {
  db: Database;
  store: OrderStore;
  git: GitRunner;
  now: () => number;
  bus: OfficeBus;
  checkpoints: Pick<CheckpointDesk, 'commit'>;
  // The turn of the order's checks: a restore never runs while a start commits in the same folder.
  exclusive: <T>(orderId: number, task: () => Promise<T>) => Promise<T>;
  running: (orderId: number) => boolean;
  // Who has an open turn inside a folder.
  busy: (path: string) => string[];
  tellLead: (order: OrderRow, text: string) => Promise<void>;
  changed: (order: OrderRow) => void;
  create: (request: CreateOrderRequest) => Promise<CreateOrderResult>;
};

// n: the place of the checkpoint among the ones of its order, from 1.
export type PointRow = { id: number; sha: string; label: string; n: number };

type Target = { kind: 'checkpoint'; id: number } | { kind: 'safety'; ref: string };

type Ready = { order: OrderRow; path: string; sha: string; point: PointRow | null; ref: string | null };

const fail = (status: RestoreFailure['status'], error: HubText): RestoreFailure => ({ ok: false, status, error });

// Takes the folder of an order back to one of its checkpoints, keeping the HEAD it had under a ref so the reset
// can be undone, or starts a new order from a checkpoint without touching the first one.
export class RestoreDesk {
  constructor(private readonly opts: RestoreDeskOpts) {}

  reset(orderId: number, checkpointId: number): Promise<ResetResult> {
    return this.restore(orderId, { kind: 'checkpoint', id: checkpointId });
  }

  async undo(orderId: number, ref: unknown): Promise<ResetResult> {
    if (typeof ref !== 'string') return fail(400, { key: 'hub.api.safetyRefInvalid' });
    return this.restore(orderId, { kind: 'safety', ref });
  }

  async fork(orderId: number, checkpointId: number, request: ForkRequest): Promise<CreateOrderResult | RestoreFailure> {
    const order = this.opts.store.get(orderId);
    if (!order) return fail(404, { key: 'hub.api.orderNotFound' });
    const point = this.point(order.id, checkpointId);
    if (!point) return fail(404, { key: 'hub.api.checkpointNotFound' });
    const short = point.sha.slice(0, 7);
    const title = request.title?.trim() || `${order.title.slice(0, MAX_TITLE - short.length - 2).trim()} @${short}`;
    const origin = `Bifurcación de encargo/${order.slug} en el punto ${point.n} (${short} ${point.label}).`;
    const description = (order.description ? `${origin}\n\n${order.description}` : origin).slice(0, MAX_DESCRIPTION);
    const base = order.base_ref?.startsWith(REMOTE) ? order.base_ref.slice(REMOTE.length) : (order.base_ref ?? undefined);
    return this.opts.create({ floor: order.floor, title, description, base, via: request.via ?? 'lead', parentId: order.id, startSha: point.sha });
  }

  // Checked once to answer at once, and again inside the turn, where nothing else can change the folder.
  private async restore(orderId: number, target: Target): Promise<ResetResult> {
    const early = await this.ready(orderId, target);
    if (!early.ok) return early;
    return this.opts.exclusive(orderId, async () => {
      const checked = await this.ready(orderId, target);
      return checked.ok ? this.restoreNow(checked.ready) : checked;
    });
  }

  private async ready(orderId: number, target: Target): Promise<{ ok: true; ready: Ready } | RestoreFailure> {
    const { git } = this.opts;
    const order = this.opts.store.get(orderId);
    if (!order) return fail(404, { key: 'hub.api.orderNotFound' });
    const point = target.kind === 'checkpoint' ? this.point(order.id, target.id) : null;
    if (target.kind === 'checkpoint' && !point) return fail(404, { key: 'hub.api.checkpointNotFound' });
    if (target.kind === 'safety' && !validSafetyRef(target.ref, order.slug)) return fail(400, { key: 'hub.api.safetyRefInvalid' });
    const path = order.worktree_path;
    const branch = order.branch;
    if (!path || !branch || !existsSync(path) || (order.worktree_state !== 'listo' && order.worktree_state !== 'error')) {
      return fail(409, { key: 'hub.api.restoreNoFolder' });
    }
    if (this.opts.running(order.id)) return fail(409, { key: 'hub.api.restoreChecksRunning' });
    const busy = this.opts.busy(path);
    if (busy.length > 0) return fail(409, { key: 'hub.api.restoreBusy', params: { who: busy.join(', ') } });
    const head = await run(git, path, () => gitOps.symbolicHead());
    if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${branch}`) return fail(409, { key: 'hub.api.restoreOffBranch' });
    if (target.kind === 'safety') {
      const tip = await run(git, path, () => gitOps.refTip(target.ref));
      const sha = tip.stdout.trim();
      if (tip.code !== 0 || !validSha(sha)) return fail(404, { key: 'hub.api.safetyRefNotFound' });
      return { ok: true, ready: { order, path, sha, point: null, ref: target.ref } };
    }
    const ancestor = point ? await run(git, path, () => gitOps.isAncestor(point.sha, branch)) : null;
    if (!point || ancestor?.code !== 0) return fail(409, { key: 'hub.api.checkpointNotOnBranch' });
    return { ok: true, ready: { order, path, sha: point.sha, point, ref: null } };
  }

  // What is not committed becomes a checkpoint first; a file the checkpoints leave out would be lost, so it stops the reset.
  private async restoreNow({ order, path, sha, point, ref: from }: Ready): Promise<ResetResult> {
    const { git } = this.opts;
    const saved = await this.opts.checkpoints.commit(order, 'restaurar', 'antes de restaurar');
    if (saved.failed) return fail(409, { key: 'hub.api.restoreCheckpointFailed' });
    const status = await run(git, path, () => gitOps.status());
    if (status.code !== 0) return fail(500, { key: 'hub.api.restoreFailed' });
    const left = statusPaths(status.stdout);
    if (left.length > 0) {
      const files = left.slice(0, LEFTOVERS_SHOWN).join(', ') + (left.length > LEFTOVERS_SHOWN ? ', …' : '');
      return fail(409, { key: 'hub.api.restoreLeftovers', params: { files } });
    }
    const head = saved.sha ?? (await this.head(path));
    const ref = head ? await this.keep(path, order.slug, head) : null;
    if (!ref) return fail(500, { key: 'hub.api.restoreFailed' });
    const reset = await run(git, path, () => gitOps.resetHard(sha));
    const clean = reset.code === 0 ? await run(git, path, () => gitOps.cleanUntracked()) : null;
    const fresh = this.opts.store.get(order.id) ?? order;
    if (!clean || clean.code !== 0) {
      this.note({ key: 'hub.act.checkpointResetFailed', params: { slug: order.slug, ref } });
      this.opts.changed(fresh);
      return fail(500, { key: 'hub.api.restoreFailed' });
    }
    if (point) {
      this.note({ key: 'hub.act.checkpointReset', params: { slug: order.slug, n: point.n, ref } });
      await this.opts.tellLead(fresh, resetText(fresh, point, ref));
    } else {
      this.note({ key: 'hub.act.checkpointResetUndone', params: { slug: order.slug, target: from ?? sha, ref } });
      await this.opts.tellLead(fresh, undoText(fresh, sha, ref));
    }
    this.opts.changed(fresh);
    return { ok: true, safetyRef: ref, head: sha };
  }

  // A ref nobody has yet, at the HEAD about to be replaced.
  private async keep(path: string, slug: string, head: string): Promise<string | null> {
    const { git } = this.opts;
    const now = this.opts.now();
    for (let i = 0; i < SAFETY_TRIES; i += 1) {
      const ref = safetyRef(slug, now + i);
      if ((await run(git, path, () => gitOps.refTip(ref))).code === 0) continue;
      return (await run(git, path, () => gitOps.refCreate(ref, head))).code === 0 ? ref : null;
    }
    return null;
  }

  private async head(path: string): Promise<string | null> {
    const result = await run(this.opts.git, path, () => gitOps.head());
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  private point(orderId: number, id: number): PointRow | null {
    return this.opts.db
      .query<PointRow, [number, number, number]>(
        'SELECT id, sha, label, (SELECT COUNT(*) FROM checkpoints AS c WHERE c.order_id = ? AND c.id <= checkpoints.id) AS n FROM checkpoints WHERE id = ? AND order_id = ?',
      )
      .get(orderId, id, orderId);
  }

  private note(summary: HubText): void {
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: 'panel', event: 'Checkpoint', tool: null, state: null, summary });
  }
}

export function resetText(order: OrderRow, point: PointRow, ref: string): string {
  return `[Agent Office] RESTAURADO encargo/${order.slug}: la carpeta ${order.worktree_path ?? ''} vuelve al punto ${point.n} (${point.sha.slice(0, 7)} ${point.label}); vuelve a leer los ficheros antes de seguir. Lo que había queda en ${ref}; para deshacer: git reset --hard ${ref}`;
}

export function undoText(order: OrderRow, sha: string, ref: string): string {
  return `[Agent Office] RESTAURADO encargo/${order.slug}: se deshace la restauración y la carpeta ${order.worktree_path ?? ''} vuelve a ${sha.slice(0, 7)}; vuelve a leer los ficheros antes de seguir. Lo de antes queda en ${ref}`;
}
