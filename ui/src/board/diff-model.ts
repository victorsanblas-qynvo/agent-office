import { plural, t } from '../i18n';
import type { DiffFileStat, OrderDiff } from '../types';
import type { FileDiff } from './diff-parse';

export type StatRow = { path: string; label: string; adds: string; dels: string; binary: boolean; className: string };
export type PatchRow = { className: string; oldNo: string; newNo: string; marker: string; text: string };

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
    rows.push({ className: 'diff-line diff-hunk', oldNo: '', newNo: '', marker: '', text: hunk.header });
    for (const line of hunk.lines) {
      rows.push({
        className: `diff-line diff-${line.kind}`,
        oldNo: line.oldNo === null ? '' : String(line.oldNo),
        newNo: line.newNo === null ? '' : String(line.newNo),
        marker: MARKERS[line.kind],
        text: line.text,
      });
    }
  }
  return rows;
}
