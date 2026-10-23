import { beforeEach, describe, expect, test } from 'bun:test';
import { diffStale, diffSummary, latestSha, orderSignature, patchRows, shouldReloadForChecks, statRows } from '../src/board/diff-model';
import { parseDiff } from '../src/board/diff-parse';
import { applyLang } from '../src/i18n/index';
import type { CheckRunView, OrderDiff } from '../src/types';
import { order } from './fixtures';

beforeEach(() => applyLang('es'));

const diff: OrderDiff = {
  base: 'aaaaaaa',
  head: 'bbbbbbb',
  files: [
    { path: 'src/a.ts', oldPath: null, adds: 3, dels: 1, binary: false },
    { path: 'src/new.ts', oldPath: 'src/old.ts', adds: 0, dels: 0, binary: false },
    { path: 'logo.png', oldPath: null, adds: null, dels: null, binary: true },
  ],
  totals: { files: 3, adds: 3, dels: 1 },
  truncated: false,
};

describe('statRows', () => {
  test('shows counts, renames and binaries', () => {
    const rows = statRows(diff);
    expect(rows[0]).toMatchObject({ path: 'src/a.ts', label: 'src/a.ts', adds: '+3', dels: '−1', binary: false, className: 'diff-file' });
    expect(rows[1]!.label).toBe('src/old.ts → src/new.ts');
    expect(rows[2]).toMatchObject({ adds: '', dels: '', binary: true, className: 'diff-file diff-file-binary' });
  });

  test('no files yields no rows', () => {
    expect(statRows({ ...diff, files: [], totals: { files: 0, adds: 0, dels: 0 } })).toEqual([]);
  });
});

describe('diffSummary', () => {
  test('pluralises the files', () => {
    expect(diffSummary(diff)).toBe('3 ficheros · +3 −1');
    expect(diffSummary({ ...diff, totals: { files: 1, adds: 2, dels: 0 } })).toBe('1 fichero · +2 −0');
  });
});

describe('patchRows', () => {
  const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@ main
 one
-two
+TWO
\\ No newline at end of file
`;

  test('numbers lines and tags hunks, changes and notes', () => {
    const rows = patchRows(parseDiff(patch)[0]!);
    expect(rows.map((r) => r.className)).toEqual(['diff-line diff-hunk', 'diff-line diff-context', 'diff-line diff-del', 'diff-line diff-add', 'diff-line diff-note']);
    expect(rows[0]).toMatchObject({ text: '@@ -1,3 +1,3 @@ main', oldNo: '', newNo: '' });
    expect(rows[1]).toMatchObject({ oldNo: '1', newNo: '1', marker: ' ', text: 'one' });
    expect(rows[2]).toMatchObject({ oldNo: '2', newNo: '', marker: '-', text: 'two' });
    expect(rows[3]).toMatchObject({ oldNo: '', newNo: '2', marker: '+', text: 'TWO' });
    expect(rows[4]!.marker).toBe('\\');
  });

  test('a file without hunks has no rows', () => {
    expect(patchRows(parseDiff('diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n')[0]!)).toEqual([]);
  });
});

describe('orderSignature', () => {
  const mine = order('mine', { id: 1, branch: 'feat' });

  test('ignores other orders, clock and bookkeeping fields', () => {
    const base = orderSignature(mine, ['es']);
    expect(orderSignature({ ...mine, updatedAt: 9999, lastActivity: 5 }, ['es'])).toBe(base);
  });

  test('changes with this order status, checks or extra state', () => {
    const base = orderSignature(mine, ['es']);
    expect(orderSignature({ ...mine, status: 'hecho' }, ['es'])).not.toBe(base);
    const checks = { status: 'running' as const, passed: 0, total: 2, sha: 'abc', touched: [], forced: false };
    expect(orderSignature({ ...mine, checks }, ['es'])).not.toBe(base);
    expect(orderSignature(mine, ['en'])).not.toBe(base);
  });
});

describe('diffStale', () => {
  const o = order('o', { branch: 'feat' });

  test('same sha, prefix either way and no known sha are fresh', () => {
    expect(diffStale(diff, o, 'bbbbbbb')).toBe(false);
    expect(diffStale(diff, o, 'bbbbbbbcccc')).toBe(false);
    expect(diffStale({ ...diff, head: 'bbbbbbbcccc' }, o, 'bbbbbbb')).toBe(false);
    expect(diffStale(diff, o, null)).toBe(false);
  });

  test('a different newest sha is stale', () => {
    expect(diffStale(diff, o, 'ddddddd')).toBe(true);
  });

  test('latestSha picks the newest of runs and checkpoints', () => {
    const run: CheckRunView = { id: 1, orderId: 1, sha: 'r1', trigger: 'panel', status: 'passed', startedAt: 10, endedAt: 11, checks: [] };
    const point = { id: 1, sha: 'p1', reason: 'x', label: 'x', createdAt: 20 };
    expect(latestSha(o, [run], [point])).toBe('p1');
    expect(latestSha(o, [{ ...run, startedAt: 30 }], [point])).toBe('r1');
    expect(latestSha(o, [], [])).toBeNull();
  });
});

describe('drawer reload filter', () => {
  const run: CheckRunView = { id: 3, orderId: 1, sha: 'abc', trigger: 'panel', status: 'running', startedAt: 10, endedAt: null, checks: [] };

  test('ignores a missing run and an unchanged id and status', () => {
    expect(shouldReloadForChecks(undefined, null)).toBe(false);
    expect(shouldReloadForChecks(run, { id: 3, status: 'running' })).toBe(false);
  });

  test('accepts a first sight, a new run or a status change', () => {
    expect(shouldReloadForChecks(run, null)).toBe(true);
    expect(shouldReloadForChecks({ ...run, id: 4 }, { id: 3, status: 'running' })).toBe(true);
    expect(shouldReloadForChecks({ ...run, status: 'passed' }, { id: 3, status: 'running' })).toBe(true);
  });

  test('orderSignature stays the same for a reload with identical runs', () => {
    const o = order('a');
    expect(orderSignature(o, [[run]])).toBe(orderSignature(o, [[{ ...run }]]));
  });
});
