import { existsSync } from 'node:fs';
import { prDraft } from './delivery-text';
import { realPath } from './floors';
import type { GitRunner } from './git';
import type { OrderRow, OrderStore } from './order-store';
import type { TextLang } from './render-text';
import { RepoOpError, gitOps, numstatPath, parseNumstat, repoPath, run, validSha, type NumstatEntry } from './repo-ops';
import type { CheckRunView, HubText, OfficeConfig, OrderDiff, OrderDiffFile } from './types';

const GIT_TIMEOUT_MS = 30_000;
export const MAX_DIFF_FILES = 300;
export const MAX_PATCH_BYTES = 400 * 1024;
const MAX_PR_COMMITS = 500;

export type DeliveryDeskOpts = {
  store: OrderStore;
  git: GitRunner;
  config: () => OfficeConfig;
  latestChecks: (orderId: number) => CheckRunView | null;
  timeoutMs?: number;
};

export type DeliveryFailure = { ok: false; status: 400 | 404 | 409 | 500; error: HubText };

export type DiffResult = { ok: true; diff: OrderDiff } | DeliveryFailure;

export type PrDraftResult = { ok: true; draft: { title: string; body: string } } | DeliveryFailure;

export type DiffFileResult = { ok: true; file: OrderDiffFile } | DeliveryFailure;

type Compared = { ok: true; cwd: string; base: string; head: string; entries: NumstatEntry[] };

const failure = (status: DeliveryFailure['status'], error: HubText): DeliveryFailure => ({ ok: false, status, error });

function totalsOf(entries: NumstatEntry[]): OrderDiff['totals'] {
  const totals = { files: entries.length, adds: 0, dels: 0 };
  for (const entry of entries) {
    totals.adds += entry.adds ?? 0;
    totals.dels += entry.dels ?? 0;
  }
  return totals;
}

// A patch cut to max bytes at the end of a line, so the panel never draws half a line.
export function capPatch(patch: string, max = MAX_PATCH_BYTES): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= max) return { patch, truncated: false };
  const cut = new TextDecoder().decode(new TextEncoder().encode(patch).subarray(0, max));
  return { patch: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true };
}

// What the commits of an order's branch changed since it left its base, read only.
export class DeliveryDesk {
  constructor(private readonly opts: DeliveryDeskOpts) {}

  async diff(orderId: number): Promise<DiffResult> {
    const compared = await this.compare(orderId);
    if (!compared.ok) return compared;
    const { base, head, entries } = compared;
    return { ok: true, diff: { base, head, files: entries.slice(0, MAX_DIFF_FILES), totals: totalsOf(entries), truncated: entries.length > MAX_DIFF_FILES } };
  }

  async prDraft(orderId: number, lang: TextLang): Promise<PrDraftResult> {
    const compared = await this.compare(orderId);
    if (!compared.ok) return compared;
    const { cwd, base, head, entries } = compared;
    const row = this.opts.store.get(orderId);
    if (!row?.branch) return failure(409, { key: 'hub.api.orderNoBranch' });
    const log = await run(this.opts.git, cwd, () => gitOps.logSubjects(base, head, MAX_PR_COMMITS), this.timeout());
    if (log.code !== 0) return failure(500, { key: 'hub.api.logFailed' });
    const checks = this.opts.latestChecks(orderId)?.checks ?? [];
    const draft = prDraft({
      title: row.title,
      brief: row.description,
      branch: row.branch,
      base: row.base_ref ?? base.slice(0, 7),
      commits: log.stdout.split('\n'),
      checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
      totals: totalsOf(entries),
      lang,
    });
    return { ok: true, draft };
  }

  async diffFile(orderId: number, path: string): Promise<DiffFileResult> {
    const compared = await this.compare(orderId);
    if (!compared.ok) return compared;
    const { cwd, base, head, entries } = compared;
    const entry = entries.find((item) => item.path === path);
    if (!entry) return failure(400, { key: 'hub.api.diffPath' });
    try {
      numstatPath(entry.path, new Set(entries.map((item) => item.path)));
      if (entry.oldPath !== null) repoPath(entry.oldPath);
    } catch (error) {
      if (error instanceof RepoOpError) return failure(400, { key: 'hub.api.diffPath' });
      throw error;
    }
    const result = await run(this.opts.git, cwd, () => gitOps.diffFile(base, head, entry.path, entry.oldPath), this.timeout());
    if (result.code !== 0) return failure(500, { key: 'hub.api.diffFailed' });
    const capped = capPatch(result.stdout);
    return { ok: true, file: { path: entry.path, patch: capped.patch, truncated: capped.truncated, binary: entry.binary } };
  }

  private async compare(orderId: number): Promise<Compared | DeliveryFailure> {
    const row = this.opts.store.get(orderId);
    if (!row) return failure(404, { key: 'hub.api.orderNotFound' });
    const cwd = this.cwdOf(row);
    if (!row.branch || !row.worktree_path || !cwd) return failure(409, { key: 'hub.api.orderNoBranch' });
    const head = await this.resolve(cwd, row.branch);
    const base = head ? await this.baseOf(cwd, row, head) : null;
    if (!head || !base) return failure(409, { key: 'hub.api.orderNoBranch' });
    const numstat = await run(this.opts.git, cwd, () => gitOps.diffNumstat(base, head), this.timeout());
    if (numstat.code !== 0) return failure(500, { key: 'hub.api.diffFailed' });
    return { ok: true, cwd, base, head, entries: parseNumstat(numstat.stdout) };
  }

  // The base the folder list counts ahead and behind against: the tip of the base branch, or the commit the
  // folder left from. Once the branch is in the base, the commit it left from, so a merged order still shows its work.
  private async baseOf(cwd: string, row: OrderRow, head: string): Promise<string | null> {
    const left = validSha(row.base_sha) ? row.base_sha : null;
    const tip = row.base_ref ? await this.resolve(cwd, row.base_ref) : null;
    if (!tip) return left;
    if (left && row.base_ref && (await run(this.opts.git, cwd, () => gitOps.isAncestor(head, row.base_ref ?? ''), this.timeout())).code === 0) return left;
    return tip;
  }

  private async resolve(cwd: string, name: string): Promise<string | null> {
    const result = await run(this.opts.git, cwd, () => gitOps.verify(name), this.timeout());
    const sha = result.stdout.trim();
    return result.code === 0 && validSha(sha) ? sha : null;
  }

  private cwdOf(row: OrderRow): string | null {
    if (row.worktree_path && existsSync(row.worktree_path)) return row.worktree_path;
    const floor = this.opts.config().floors[row.floor];
    return floor && existsSync(floor.path) ? realPath(floor.path) : null;
  }

  private timeout(): number {
    return this.opts.timeoutMs ?? GIT_TIMEOUT_MS;
  }
}
