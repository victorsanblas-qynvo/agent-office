import { plural, t } from '../i18n';
import type { CheckRunView, CheckpointView, DiffFileStat, OrderDiff, OrderView } from '../types';
import type { FileDiff } from './diff-parse';

export type StatRow = { path: string; label: string; adds: string; dels: string; binary: boolean; className: string };
export type PatchRow = { className: string; oldNo: string; newNo: string; newLine: number | null; oldLine: number | null; marker: string; text: string };

const MARKERS = { add: '+', del: '-', context: ' ', note: '\\' } as const;

export function diffSummary(diff: OrderDiff): string {
  const { files, adds, dels } = diff.totals;
  return t('board.diff.summary', { files: plural('board.diff.files', files), adds, dels });
}

export function statRows(diff: OrderDiff): StatRow[] {
  return diff.files.map((file: DiffFileStat) => ({
    path: file.path,
    label: file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path,
    adds: file.binary || file.adds === null ? '' : `+${file.adds}`,
    dels: file.binary || file.dels === null ? '' : `−${file.dels}`,
    binary: file.binary,
    className: `diff-file${file.binary ? ' diff-file-binary' : ''}`,
  }));
}

export function patchRows(file: FileDiff): PatchRow[] {
  const rows: PatchRow[] = [];
  for (const hunk of file.hunks) {
    rows.push({ className: 'diff-line diff-hunk', oldNo: '', newNo: '', newLine: null, oldLine: null, marker: '', text: hunk.header });
    for (const line of hunk.lines) {
      rows.push({
        className: `diff-line diff-${line.kind}`,
        oldNo: line.oldNo === null ? '' : String(line.oldNo),
        newNo: line.newNo === null ? '' : String(line.newNo),
        newLine: line.kind === 'add' || line.kind === 'context' ? line.newNo : null,
        oldLine: line.kind === 'del' ? line.oldNo : null,
        marker: MARKERS[line.kind],
        text: line.text,
      });
    }
  }
  return rows;
}

// The first changed line of the new side, or where the first hunk starts when it only removes lines.
export function firstChangedLine(files: readonly FileDiff[]): number {
  const hunk = files[0]?.hunks[0];
  if (!hunk) return 1;
  const added = hunk.lines.find((line) => line.kind === 'add' && line.newNo !== null);
  return added?.newNo ?? Math.max(hunk.newStart, 1);
}

export function latestSha(order: OrderView, runs: CheckRunView[], points: CheckpointView[]): string | null {
  let sha = order.checks?.sha ?? null;
  let at = -1;
  for (const run of runs) if (run.startedAt > at) [sha, at] = [run.sha, run.startedAt];
  for (const point of points) if (point.createdAt >= at) [sha, at] = [point.sha, point.createdAt];
  return sha;
}

export function diffStale(diff: OrderDiff, order: OrderView, newest: string | null): boolean {
  const sha = newest ?? order.checks?.sha ?? null;
  if (!sha || !diff.head) return false;
  return !(sha.startsWith(diff.head) || diff.head.startsWith(sha));
}

export function orderSignature(order: OrderView, extra: unknown): string {
  return JSON.stringify([
    order.id,
    order.title,
    order.description,
    order.status,
    order.floor,
    order.cycle,
    order.lead,
    order.branch,
    order.base,
    order.baseSha,
    order.worktree,
    order.checks,
    order.planSlug,
    extra,
  ]);
}

export type RunMark = { id: number; status: string };

export function shouldReloadForChecks(run: CheckRunView | undefined, lastSeen: RunMark | null): boolean {
  if (!run) return false;
  return lastSeen === null || lastSeen.id !== run.id || lastSeen.status !== run.status;
}
