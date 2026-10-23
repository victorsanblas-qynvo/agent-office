import { beforeEach, describe, expect, test } from 'bun:test';
import { diffSummary, patchRows, statRows } from '../src/board/diff-model';
import { parseDiff } from '../src/board/diff-parse';
import { applyLang } from '../src/i18n/index';
import type { OrderDiff } from '../src/types';

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
