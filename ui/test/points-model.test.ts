import { describe, expect, test } from 'bun:test';
import { canRestore, pointNumbers } from '../src/board/points-model';
import type { CheckpointView, OrderView } from '../src/types';
import { order } from './fixtures';

const point = (id: number): CheckpointView => ({ id, sha: `${id}`.repeat(40).slice(0, 40), reason: 'listo', label: 'listo', createdAt: id });
const folder = (state: NonNullable<OrderView['worktree']>['state']): OrderView['worktree'] => ({ path: '/repo/.claude/worktrees/office-a', state, error: null, stale: false });

describe('pointNumbers', () => {
  test('numbers the checkpoints from the oldest, whatever order they come in', () => {
    expect([...pointNumbers([point(9), point(4), point(7)])]).toEqual([[4, 1], [7, 2], [9, 3]]);
    expect(pointNumbers([]).size).toBe(0);
  });
});

describe('canRestore', () => {
  test('needs a ready folder and no checks running', () => {
    expect(canRestore(order('a', { worktree: folder('listo') }))).toBe(true);
    expect(canRestore(order('a', { worktree: folder('error') }))).toBe(true);
    expect(canRestore(order('a', { worktree: folder('preparando') }))).toBe(false);
    expect(canRestore(order('a', { worktree: folder('retirado') }))).toBe(false);
    expect(canRestore(order('a'))).toBe(false);
    expect(canRestore(order('a', { worktree: folder('listo'), checks: { status: 'running', passed: 0, total: 1, sha: null, touched: [], forced: false } }))).toBe(false);
    expect(canRestore(order('a', { worktree: folder('listo'), checks: { status: 'failed', passed: 0, total: 1, sha: null, touched: [], forced: false } }))).toBe(true);
  });
});
