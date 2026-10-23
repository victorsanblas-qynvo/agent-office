import type { CheckpointView, OrderView } from '../types';

// The place of each checkpoint among the ones of its order, from 1, whatever order the list comes in.
export function pointNumbers(points: readonly CheckpointView[]): Map<number, number> {
  return new Map([...points].sort((a, b) => a.id - b.id).map((point, index) => [point.id, index + 1]));
}

// What the panel can tell before asking: a ready folder and no checks running. The hub also refuses while an
// agent works inside it or when the checkpoint is no longer on the branch.
export function canRestore(order: OrderView): boolean {
  const state = order.worktree?.state;
  return (state === 'listo' || state === 'error') && order.checks?.status !== 'running';
}
