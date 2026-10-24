import { t } from '../i18n';
import { formatTokens } from '../labels';
import { relativeTime } from '../time';
import type { OrderDiff, OrderSpend, OrderView } from '../types';

export type CompareSide = { order: OrderView; diff: OrderDiff | null; spend: OrderSpend | null };

export type CompareRow = { key: 'status' | 'cycle' | 'diff' | 'checks' | 'spend' | 'age'; label: string; a: string; b: string };

export type FileSets = { onlyA: string[]; onlyB: string[]; both: string[] };

const NONE = '—';

function diffCell(diff: OrderDiff | null): string {
  if (!diff) return NONE;
  return t('board.compare.diff', { files: diff.totals.files, adds: diff.totals.adds, dels: diff.totals.dels });
}

function checksCell(order: OrderView): string {
  const checks = order.checks;
  if (!checks || checks.status === 'none') return NONE;
  return checks.status === 'running' ? t('board.compare.checks.running') : t(`board.compare.checks.${checks.status}`, { passed: checks.passed, total: checks.total });
}

function spendCell(spend: OrderSpend | null): string {
  return spend && spend.tokens > 0 ? `≈ ${formatTokens(spend.tokens)}` : NONE;
}

// Pure: the facts both orders are compared by, one row each.
export function compareOrders(a: CompareSide, b: CompareSide, now: number): CompareRow[] {
  const row = (key: CompareRow['key'], left: string, right: string): CompareRow => ({ key, label: t(`board.compare.${key}`), a: left, b: right });
  return [
    row('status', t(`board.col.${a.order.status}`), t(`board.col.${b.order.status}`)),
    row('cycle', String(a.order.cycle), String(b.order.cycle)),
    row('diff', diffCell(a.diff), diffCell(b.diff)),
    row('checks', checksCell(a.order), checksCell(b.order)),
    row('spend', spendCell(a.spend), spendCell(b.spend)),
    row('age', relativeTime(a.order.createdAt, now), relativeTime(b.order.createdAt, now)),
  ];
}

// Pure: which files only one list has and which both have, each sorted and without repeats.
export function fileSets(aFiles: readonly string[], bFiles: readonly string[]): FileSets {
  const a = new Set(aFiles);
  const b = new Set(bFiles);
  const sorted = (paths: Iterable<string>): string[] => [...paths].sort();
  return {
    onlyA: sorted([...a].filter((path) => !b.has(path))),
    onlyB: sorted([...b].filter((path) => !a.has(path))),
    both: sorted([...a].filter((path) => b.has(path))),
  };
}
