import type { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isInside, realPath } from './floors';
import { remainingDirty } from './gate';
import { matchesAny } from './glob';
import { gitSync as realGitSync, type GitResult, type GitRunner } from './git';
import type { OfficeBus } from './office-bus';
import type { OrderRow, OrderStore } from './order-store';
import { gitOps, run, zList } from './repo-ops';
import type { CheckpointView, HubText, OfficeConfig, SkippedFile } from './types';

const COMMIT_TIMEOUT_MS = 120_000;

export type CheckpointResult = {
  // HEAD after the checkpoint, null when git could not say.
  sha: string | null;
  committed: boolean;
  // The commit failed (a hook, an identity): the working tree has changes HEAD does not.
  failed: boolean;
  skipped: SkippedFile[];
};

export type CheckpointDeskOpts = {
  db: Database;
  store: OrderStore;
  git: GitRunner;
  gitSync?: (cwd: string, args: string[]) => GitResult;
  now: () => number;
  bus: OfficeBus;
  config: () => OfficeConfig;
  commitTimeoutMs?: number;
};

type CheckpointRow = { id: number; sha: string; reason: string; label: string; created_at: number };

// Status entries of git status -z: "XY path", one per NUL.
export function statusPaths(stdout: string): string[] {
  return zList(stdout)
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
}

export function parseSkipped(raw: string | null): SkippedFile[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is SkippedFile =>
        !!item && typeof item === 'object' && typeof item.path === 'string' && typeof item.size === 'number' && typeof item.mtime === 'number',
    );
  } catch {
    return [];
  }
}

// A checkpoint is a commit the hub makes on the branch of an order, so a check has a sha to be about and the
// work can be gone back to. Files that are too big or look like logs stay out and are remembered.
export class CheckpointDesk {
  constructor(private readonly opts: CheckpointDeskOpts) {}

  private sync(cwd: string, args: string[]): GitResult {
    return (this.opts.gitSync ?? realGitSync)(cwd, args);
  }

  async commit(order: OrderRow, reason: string, label: string): Promise<CheckpointResult> {
    const path = order.worktree_path;
    const empty: CheckpointResult = { sha: null, committed: false, failed: false, skipped: [] };
    if (!path || !existsSync(path)) return empty;
    const { git } = this.opts;
    const head = async (): Promise<string | null> => {
      const result = await run(git, path, () => gitOps.head());
      return result.code === 0 ? result.stdout.trim() : null;
    };
    const status = await run(git, path, () => gitOps.status());
    if (status.code !== 0) return { ...empty, sha: await head(), failed: true };
    const changed = statusPaths(status.stdout);
    if (changed.length === 0) {
      this.rememberSkipped(order, []);
      return { ...empty, sha: await head() };
    }
    const { maxFileKb, skipGlobs } = this.opts.config().checkpoints;
    const skipped: SkippedFile[] = [];
    const add: string[] = [];
    for (const file of changed) {
      const left = leftOut(path, file, maxFileKb * 1024, skipGlobs);
      if (left) skipped.push(left);
      else add.push(file);
    }
    this.rememberSkipped(order, skipped);
    if (skipped.length > 0) this.note({ key: 'hub.act.checkpointSkipped', params: { slug: order.slug, files: skipped.map((file) => file.path).join(', ') } });
    if (add.length > 0) {
      const staged = await run(git, path, () => gitOps.addFromStdin(), COMMIT_TIMEOUT_MS, `${add.join('\0')}\0`);
      if (staged.code !== 0) return this.failure(order, skipped, await head());
    }
    const cached = await run(git, path, () => gitOps.stagedNames());
    if (cached.code !== 0) return this.failure(order, skipped, await head());
    if (zList(cached.stdout).length === 0) return { sha: await head(), committed: false, failed: false, skipped };
    const committed = await run(git, path, () => gitOps.commit(`encargo(${order.slug}): ${label}`), this.opts.commitTimeoutMs ?? COMMIT_TIMEOUT_MS);
    if (committed.code !== 0) return this.failure(order, skipped, await head());
    const sha = await head();
    if (sha) {
      this.opts.db
        .query('INSERT INTO checkpoints (order_id, sha, reason, label, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, sha, reason, label, this.opts.now());
    }
    return { sha, committed: sha !== null, failed: false, skipped };
  }

  private failure(order: OrderRow, skipped: SkippedFile[], sha: string | null): CheckpointResult {
    this.note({ key: 'hub.act.checkpointFailed', params: { slug: order.slug } });
    return { sha, committed: false, failed: true, skipped };
  }

  private rememberSkipped(order: OrderRow, skipped: SkippedFile[]): void {
    const next = skipped.length > 0 ? JSON.stringify(skipped) : null;
    if (next !== order.skipped_files) this.opts.store.update(order.id, { skipped_files: next });
  }

  private note(summary: HubText): void {
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: 'panel', event: 'Checkpoint', tool: null, state: null, summary });
  }

  list(orderId: number): CheckpointView[] {
    return this.opts.db
      .query<CheckpointRow, [number]>('SELECT id, sha, reason, label, created_at FROM checkpoints WHERE order_id = ? ORDER BY id DESC')
      .all(orderId)
      .map((row) => ({ id: row.id, sha: row.sha, reason: row.reason, label: row.label, createdAt: row.created_at }));
  }

  skipped(order: OrderRow): SkippedFile[] {
    return parseSkipped(this.opts.store.get(order.id)?.skipped_files ?? null);
  }

  // The files with changes nobody committed, without the ones a checkpoint skipped that are still as they were.
  // Synchronous: the gate of a HECHO answers inside the hook.
  dirtyFiles(order: OrderRow): string[] | null {
    const path = order.worktree_path;
    if (!path || !existsSync(path)) return null;
    const status = this.sync(path, gitOps.status());
    if (status.code !== 0) return null;
    const fresh = this.opts.store.get(order.id);
    return remainingDirty(statusPaths(status.stdout), parseSkipped(fresh?.skipped_files ?? null), (file) => {
      try {
        const stat = lstatSync(join(path, file));
        return { size: stat.size, mtime: Math.floor(stat.mtimeMs) };
      } catch {
        return null;
      }
    });
  }
}

function leftOut(root: string, file: string, maxBytes: number, globs: readonly string[]): SkippedFile | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(join(root, file));
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() && pointsOutside(root, file)) return { path: file, size: stat.size, mtime: Math.floor(stat.mtimeMs) };
  if (!stat.isFile()) return null;
  if (stat.size <= maxBytes && !matchesAny(globs, file)) return null;
  return { path: file, size: stat.size, mtime: Math.floor(stat.mtimeMs) };
}

function pointsOutside(root: string, file: string): boolean {
  const link = join(root, file);
  let target: string;
  try {
    target = resolve(dirname(link), readlinkSync(link));
  } catch {
    return false;
  }
  return !isInside(target, root) && !isInside(target, realPath(root));
}
