import { describe, expect, test } from 'bun:test';
import { editorLink } from '../src/board/editor-link';
import { firstChangedLine } from '../src/board/diff-model';
import { parseDiff } from '../src/board/diff-parse';

const root = '/Users/me/wt/order-1';

describe('editorLink', () => {
  test('builds each editor scheme with the line', () => {
    expect(editorLink('vscode', root, 'src/a.ts', 12)).toBe('vscode://file/Users/me/wt/order-1/src/a.ts:12');
    expect(editorLink('cursor', root, 'src/a.ts', 12)).toBe('cursor://file/Users/me/wt/order-1/src/a.ts:12');
    expect(editorLink('zed', root, 'src/a.ts', 12)).toBe('zed://file/Users/me/wt/order-1/src/a.ts:12');
  });

  test('omits the line when none is given', () => {
    expect(editorLink('vscode', root, 'a.ts')).toBe('vscode://file/Users/me/wt/order-1/a.ts');
    expect(editorLink('vscode', root, 'a.ts', 0)).toBe('vscode://file/Users/me/wt/order-1/a.ts');
  });

  test('percent-encodes every segment but keeps the slashes', () => {
    expect(editorLink('vscode', root, 'my dir/a#b?c%d ñ.ts', 3)).toBe('vscode://file/Users/me/wt/order-1/my%20dir/a%23b%3Fc%25d%20%C3%B1.ts:3');
    expect(editorLink('zed', '/Users/me/mi proyecto', 'a.ts')).toBe('zed://file/Users/me/mi%20proyecto/a.ts');
  });

  test('joins a root with a trailing slash without doubling it', () => {
    expect(editorLink('vscode', `${root}/`, 'a.ts', 1)).toBe('vscode://file/Users/me/wt/order-1/a.ts:1');
  });

  test('rejects parent segments and absolute paths', () => {
    expect(editorLink('vscode', root, '../secret')).toBeNull();
    expect(editorLink('vscode', root, 'a/../../b')).toBeNull();
    expect(editorLink('vscode', root, '/etc/passwd')).toBeNull();
    expect(editorLink('vscode', root, '')).toBeNull();
  });

  test('has no link without a root or with the none editor', () => {
    expect(editorLink('vscode', null, 'a.ts')).toBeNull();
    expect(editorLink('vscode', undefined, 'a.ts')).toBeNull();
    expect(editorLink('vscode', '', 'a.ts')).toBeNull();
    expect(editorLink('none', root, 'a.ts')).toBeNull();
  });
});

describe('firstChangedLine', () => {
  test('points at the first added line of the first hunk', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,4 @@\n keep\n keep\n+new\n keep\n';
    expect(firstChangedLine(parseDiff(patch))).toBe(12);
  });

  test('falls back to the hunk start and to line 1', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -5,2 +5,1 @@\n keep\n-gone\n';
    expect(firstChangedLine(parseDiff(patch))).toBe(5);
    expect(firstChangedLine([])).toBe(1);
  });
});
