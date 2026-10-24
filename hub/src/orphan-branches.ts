import type { Database, Statement } from 'bun:sqlite';
import { validBranch } from './config';
import { realPath } from './floors';
import type { GitRunner } from './git';
import { gitOps, ORDER_BRANCH_PREFIX, run } from './repo-ops';
import type { OfficeConfig, OrderStatus, OrphanBranchView } from './types';

const MAX_LISTED = 100;
const GIT_TIMEOUT_MS = 15_000;
const CHECKS_AT_ONCE = 8;
const CACHE_TTL_MS = 30_000;
const HEADS = 'refs/heads/';
const FIELD = '\x1f';
const LIST_FORMAT = ['%(refname)', '%(objectname)', '%(committerdate:unix)'].join(FIELD);

type OwnerRow = { slug: string; status: OrderStatus; worktree_state: string | null; worktree_path: string | null; removed_at: number | null };

// The order branches in a floor's repository that no live order owns: a read-only list, the user deletes them by hand.
export class OrphanBranchDesk {
  private readonly owner: Statement<OwnerRow, [string, string]>;
  private readonly cache = new Map<string, { at: number; views: OrphanBranchView[] }>();

  constructor(
    private readonly opts: { db: Database; git: GitRunner; now: () => number; config: () => OfficeConfig },
  ) {
    this.owner = opts.db.query('SELECT slug, status, worktree_state, worktree_path, removed_at FROM orders WHERE branch = ?1 OR slug = ?2 ORDER BY branch = ?1 DESC LIMIT 1');
  }

  managed(floor: string): boolean {
    return this.opts.config().floors[floor]?.managed === true;
  }

  // null: the floor does not exist or is not managed.
  async list(floor: string): Promise<OrphanBranchView[] | null> {
    const config = this.opts.config().floors[floor];
    if (!config?.managed) return null;
    const now = this.opts.now();
    const hit = this.cache.get(floor);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.views;
    const views = await this.scan(realPath(config.path), config.baseBranch);
    this.cache.set(floor, { at: this.opts.now(), views });
    return views;
  }

  private async scan(repo: string, base: string): Promise<OrphanBranchView[]> {
    const listed = await run(this.opts.git, repo, () => gitOps.listOrderBranches(LIST_FORMAT), GIT_TIMEOUT_MS);
    if (listed.code !== 0) return [];
    const found: Omit<OrphanBranchView, 'ahead' | 'behind'>[] = [];
    for (const line of listed.stdout.split('\n')) {
      const [refname, sha, date] = line.split(FIELD);
      const branch = refname?.startsWith(HEADS) ? refname.slice(HEADS.length) : undefined;
      if (!branch || !sha || !validBranch(branch) || !branch.startsWith(ORDER_BRANCH_PREFIX) || !/^[0-9a-f]{40}$/.test(sha)) continue;
      const order = this.owner.get(branch, branch.slice(ORDER_BRANCH_PREFIX.length));
      if (order && live(order)) continue;
      found.push({ branch, sha, committedAt: Number(date) * 1000 || 0, order: order ? { slug: order.slug, status: order.status } : null });
    }
    found.sort((a, b) => b.committedAt - a.committedAt || (a.branch < b.branch ? -1 : 1));
    const picked = found.slice(0, MAX_LISTED);
    const baseSha = await this.baseTip(repo, base);
    const views: OrphanBranchView[] = [];
    for (let i = 0; i < picked.length; i += CHECKS_AT_ONCE) {
      views.push(...(await Promise.all(picked.slice(i, i + CHECKS_AT_ONCE).map(async (item) => ({ ...item, ...(await this.counts(repo, baseSha, item.sha)) })))));
    }
    return views;
  }

  // The remote base when it exists, else the local one; null when neither answers.
  private async baseTip(repo: string, base: string): Promise<string | null> {
    for (const name of [`origin/${base}`, base]) {
      const result = await run(this.opts.git, repo, () => gitOps.verify(name), GIT_TIMEOUT_MS);
      const sha = result.stdout.trim();
      if (result.code === 0 && sha) return sha;
    }
    return null;
  }

  private async counts(repo: string, baseSha: string | null, sha: string): Promise<{ ahead: number | null; behind: number | null }> {
    if (!baseSha) return { ahead: null, behind: null };
    const result = await run(this.opts.git, repo, () => gitOps.aheadBehind(baseSha, sha), GIT_TIMEOUT_MS);
    const match = /^(\d+)\s+(\d+)$/.exec(result.stdout.trim());
    return result.code === 0 && match ? { behind: Number(match[1]), ahead: Number(match[2]) } : { ahead: null, behind: null };
  }
}

// A discarded order that never got its folder (a fork claimed, then discarded) owns its branch no more.
function live(order: OwnerRow): boolean {
  if (order.status === 'descartado' && order.worktree_path === null) return false;
  return order.removed_at === null && order.worktree_state !== 'retirado';
}
