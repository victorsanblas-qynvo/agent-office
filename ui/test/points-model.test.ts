import { describe, expect, test } from 'bun:test';
import { canRestore, newestFirst, pointNumbers, restoreBlock, restoreNeedsForce } from '../src/board/points-model';
import { previewLines } from '../src/board/restore-preview';
import { applyLang } from '../src/i18n';
import type { CheckpointView, OrderView, SafetyRefView } from '../src/types';
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

describe('restoreBlock', () => {
  test('an open PR stops a restore before the folder is looked at', () => {
    const pr = { url: 'https://example.test/pr/1', state: 'open' };
    expect(restoreBlock(order('a', { worktree: folder('listo'), pr }))).toBe('pr');
    expect(canRestore(order('a', { worktree: folder('listo'), pr }))).toBe(false);
    expect(restoreBlock(order('a', { worktree: folder('preparando') }))).toBe('folder');
    expect(restoreBlock(order('a', { worktree: folder('listo') }))).toBeNull();
  });
});

describe('restoreNeedsForce', () => {
  test('only an order already done asks to be confirmed again', () => {
    expect(restoreNeedsForce(order('a', { status: 'hecho' }))).toBe(true);
    expect(restoreNeedsForce(order('a', { status: 'revision' }))).toBe(false);
  });
});

describe('newestFirst', () => {
  test('sorts the safety refs from the newest', () => {
    const ref = (at: number): SafetyRefView => ({ ref: `refs/office/a/before-reset-${at}`, sha: 'a'.repeat(40), at });
    expect(newestFirst([ref(5), ref(30), ref(12)]).map((entry) => entry.at)).toEqual([30, 12, 5]);
  });
});

describe('previewLines', () => {
  const none = { dropped: [], droppedTotal: 0, stat: { files: 0, adds: 0, dels: 0 }, dirty: [], blocked: null };

  test('counts the commits beyond the ones listed and cuts the dirty files', () => {
    const dirty = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    const lines = previewLines({ ...none, dropped: ['a', 'b'], droppedTotal: 60, dirty });
    expect(lines).toMatchObject({ blocked: null, dropped: ['a', 'b'], more: 58, dirtyMore: 2 });
    expect(lines.dirty).toHaveLength(10);
  });

  test('turns the blocking reason into text', () => {
    applyLang('es');
    expect(previewLines({ ...none, blocked: { key: 'hub.api.restorePrOpen' } }).blocked).toContain('PR abierta');
  });
});
