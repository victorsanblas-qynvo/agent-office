import { describe, expect, test } from 'bun:test';
import { parseDiff, splitRows } from '../src/board/diff-parse';

const modified = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function main() {
 one
-two
+TWO
 three
 four
`;

describe('parseDiff', () => {
  test('empty input yields no files', () => {
    expect(parseDiff('')).toEqual([]);
  });

  test('a modified file with numbered lines and a section', () => {
    const [file] = parseDiff(modified);
    expect(file).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', status: 'modified', binary: false, adds: 1, dels: 1 });
    const hunk = file!.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, section: 'function main() {' });
    expect(hunk.lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ['context', 'one', 1, 1],
      ['del', 'two', 2, null],
      ['add', 'TWO', null, 2],
      ['context', 'three', 3, 3],
      ['context', 'four', 4, 4],
    ]);
  });

  test('an added file has no old path', () => {
    const [file] = parseDiff(`diff --git a/n.txt b/n.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,2 @@
+a
+b
`);
    expect(file).toMatchObject({ status: 'added', oldPath: null, newPath: 'n.txt', adds: 2, dels: 0 });
    expect(file!.hunks[0]!.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  test('a deleted file has no new path', () => {
    const [file] = parseDiff(`diff --git a/o.txt b/o.txt
deleted file mode 100644
index 3333333..0000000
--- a/o.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`);
    expect(file).toMatchObject({ status: 'deleted', oldPath: 'o.txt', newPath: null, adds: 0, dels: 2 });
  });

  test('a pure rename has paths and no hunks', () => {
    const [file] = parseDiff(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`);
    expect(file).toMatchObject({ status: 'renamed', oldPath: 'old.ts', newPath: 'new.ts', hunks: [] });
  });

  test('a rename with edits keeps its hunks', () => {
    const [file] = parseDiff(`diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
index 1111111..2222222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
 keep
-x
+y
`);
    expect(file).toMatchObject({ status: 'renamed', oldPath: 'old.ts', newPath: 'new.ts', adds: 1, dels: 1 });
    expect(file!.hunks).toHaveLength(1);
  });

  test('a binary file has no hunks', () => {
    const [file] = parseDiff(`diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`);
    expect(file).toMatchObject({ binary: true, hunks: [], oldPath: 'img.png', newPath: 'img.png' });
  });

  test('several hunks restart the numbering from their header', () => {
    const [file] = parseDiff(`diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -10,2 +11,2 @@ section
 x
-y
+z
`);
    expect(file!.hunks).toHaveLength(2);
    const second = file!.hunks[1]!;
    expect(second.section).toBe('section');
    expect(second.lines.map((l) => [l.oldNo, l.newNo])).toEqual([[10, 11], [11, null], [null, 12]]);
    expect(file).toMatchObject({ adds: 2, dels: 1 });
  });

  test('several files are split on diff --git', () => {
    const files = parseDiff(`${modified}diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-p
+q
`);
    expect(files.map((f) => f.newPath)).toEqual(['src/a.ts', 'b.ts']);
    expect(files[1]!.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 });
  });

  test('the no-newline marker becomes a note without numbers', () => {
    const [file] = parseDiff(`diff --git a/n b/n
--- a/n
+++ b/n
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`);
    const lines = file!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['del', 'note', 'add', 'note']);
    expect(lines[1]).toEqual({ kind: 'note', text: 'No newline at end of file', oldNo: null, newNo: null });
    expect(file).toMatchObject({ adds: 1, dels: 1 });
  });

  test('omitted counts default to 1', () => {
    const [file] = parseDiff('--- a/x\n+++ b/x\n@@ -3 +4 @@\n-a\n+b\n');
    expect(file!.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 4, newLines: 1 });
    expect(file!.hunks[0]!.lines.map((l) => [l.oldNo, l.newNo])).toEqual([[3, null], [null, 4]]);
  });

  test('a truncated last hunk returns what was parsed', () => {
    const cut = `diff --git a/t b/t
--- a/t
+++ b/t
@@ -1,10 +1,10 @@
 a
-b
+c
 d`;
    const [file] = parseDiff(cut);
    expect(file!.hunks[0]!.lines).toHaveLength(4);
    expect(parseDiff(`${cut}\ndiff --git a/u b/u\nBinary files a/u and b/u differ\n`)).toHaveLength(2);
  });

  test('CRLF line endings are accepted', () => {
    const [file] = parseDiff(modified.replace(/\n/g, '\r\n'));
    expect(file!.newPath).toBe('src/a.ts');
    expect(file!.hunks[0]!.section).toBe('function main() {');
    expect(file!.hunks[0]!.lines.map((l) => l.text)).toEqual(['one', 'two', 'TWO', 'three', 'four']);
  });

  test('a patch without diff --git still yields one file', () => {
    const files = parseDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: 'x.ts', newPath: 'x.ts', adds: 1, dels: 1 });
    expect(parseDiff('@@ -1 +1 @@\n-a\n+b\n')).toHaveLength(1);
  });

  test('a removed line that looks like a header stays a line', () => {
    const [file] = parseDiff('diff --git a/s b/s\n--- a/s\n+++ b/s\n@@ -1,2 +1,1 @@\n--- not a header\n keep\n');
    expect(file!.hunks[0]!.lines[0]).toMatchObject({ kind: 'del', text: '-- not a header' });
  });

  test('paths with spaces, plain and quoted', () => {
    const [plain] = parseDiff('diff --git a/with space.txt b/with space.txt\n--- a/with space.txt\t\n+++ b/with space.txt\t\n@@ -1 +1 @@\n-a\n+b\n');
    expect(plain).toMatchObject({ oldPath: 'with space.txt', newPath: 'with space.txt' });
    const [quoted] = parseDiff('diff --git "a/with space" "b/with space"\nindex 1..2 100644\n--- "a/with space"\n+++ "b/with space"\n@@ -1 +1 @@\n-a\n+b\n');
    expect(quoted).toMatchObject({ oldPath: 'with space', newPath: 'with space' });
    const [escaped] = parseDiff('diff --git "a/t\\303\\241b\\t.txt" "b/t\\303\\241b\\t.txt"\nBinary files differ\n');
    expect(escaped!.newPath).toBe('táb\t.txt');
  });
});

describe('splitRows', () => {
  const hunkOf = (body: string) => parseDiff(`--- a/f\n+++ b/f\n@@ -1,9 +1,9 @@\n${body}`)[0]!.hunks[0]!;

  test('context goes on both sides', () => {
    const rows = splitRows(hunkOf(' a\n b\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.left).toBe(rows[0]!.right!);
  });

  test('a del run pairs with the following add run row by row', () => {
    const rows = splitRows(hunkOf(' k\n-a\n-b\n-c\n+x\n+y\n z\n'));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['k', 'k'],
      ['a', 'x'],
      ['b', 'y'],
      ['c', null],
      ['z', 'z'],
    ]);
  });

  test('more adds than dels leaves the left side empty', () => {
    const rows = splitRows(hunkOf('-a\n+x\n+y\n+z\n'));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'x'],
      [null, 'y'],
      [null, 'z'],
    ]);
  });

  test('a pure add or del has the other side empty and notes stay on their side', () => {
    const rows = splitRows(hunkOf('+n\n\\ No newline at end of file\n'));
    expect(rows[0]).toMatchObject({ left: null });
    expect(rows[1]!.left).toBeNull();
    expect(rows[1]!.right!.kind).toBe('note');
  });
});
