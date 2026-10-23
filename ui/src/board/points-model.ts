import type { CheckpointView, OrderView, SafetyRefView } from '../types';

// The place of each checkpoint among the ones of its order, from 1, whatever order the list comes in.
export function pointNumbers(points: readonly CheckpointView[]): Map<number, number> {
  return new Map([...points].sort((a, b) => a.id - b.id).map((point, index) => [point.id, index + 1]));
}

// Why the panel would not offer a restore: an open PR, or a folder that is not ready or has checks running. The
// hub also refuses while an agent works inside it or when the checkpoint is no longer on the branch.
export function restoreBlock(order: OrderView): 'pr' | 'folder' | null {
  if (order.pr) return 'pr';
  const state = order.worktree?.state;
  return (state === 'listo' || state === 'error') && order.checks?.status !== 'running' ? null : 'folder';
}

export function canRestore(order: OrderView): boolean {
  return restoreBlock(order) === null;
}

// An order already done is restored only after the user confirms it again.
export function restoreNeedsForce(order: OrderView): boolean {
  return order.status === 'hecho';
}

export function newestFirst(refs: readonly SafetyRefView[]): SafetyRefView[] {
  return [...refs].sort((a, b) => b.at - a.at || b.ref.localeCompare(a.ref));
}
