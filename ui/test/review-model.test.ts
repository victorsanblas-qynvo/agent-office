import { beforeEach, describe, expect, test } from 'bun:test';
import { REVIEW_MAX_BODY, REVIEW_MAX_COMMENTS } from '../../shared/review-message';
import { patchRows } from '../src/board/diff-model';
import { parseDiff } from '../src/board/diff-parse';
import {
  addDraft,
  commentsAt,
  draftsAt,
  draftsFull,
  draftsIn,
  fileComments,
  fileTarget,
  removeDraft,
  reviewPreview,
  reviewRequest,
  rowTarget,
  targetKey,
  targetLabel,
  type ReviewDraft,
} from '../src/board/review-model';
import { applyLang } from '../src/i18n/index';
import type { OrderCommentView } from '../src/types';

beforeEach(() => applyLang('es'));

const line = (n: number, side: 'new' | 'old' = 'new') => ({ path: 'lib/a.dart', line: n, side });

const past = (id: number, path: string, n: number | null, side: 'new' | 'old' = 'new'): OrderCommentView => ({
  id,
  path,
  line: n,
  side,
  body: `c${id}`,
  cycle: 1,
  sha: 'abc',
  createdAt: id,
  sentAt: id,
});

describe('drafts', () => {
  test('add trims, numbers and keeps the order; empty text adds nothing', () => {
    let drafts: ReviewDraft[] = [];
    drafts = addDraft(drafts, line(3), '  primero  ');
    drafts = addDraft(drafts, fileTarget('lib/b.dart'), 'segundo');
    drafts = addDraft(drafts, line(4), '   ');
    expect(drafts).toEqual([
      { path: 'lib/a.dart', line: 3, side: 'new', id: 1, body: 'primero' },
      { path: 'lib/b.dart', line: null, side: 'new', id: 2, body: 'segundo' },
    ]);
  });

  test('remove drops one by id and new ids never repeat a live one', () => {
    let drafts = addDraft(addDraft(addDraft([], line(1), 'a'), line(2), 'b'), line(3), 'c');
    drafts = removeDraft(drafts, 2);
    expect(drafts.map((d) => d.body)).toEqual(['a', 'c']);
    drafts = addDraft(drafts, line(4), 'd');
    expect(drafts.map((d) => d.id)).toEqual([1, 3, 4]);
  });

  test('a review is full at the hub limit and a long body is cut to it', () => {
    let drafts: ReviewDraft[] = [];
    for (let i = 0; i < REVIEW_MAX_COMMENTS + 2; i += 1) drafts = addDraft(drafts, line(i + 1), 'x');
    expect(drafts).toHaveLength(REVIEW_MAX_COMMENTS);
    expect(draftsFull(drafts)).toBe(true);
    expect(addDraft([], line(1), 'y'.repeat(REVIEW_MAX_BODY + 10))[0]?.body).toHaveLength(REVIEW_MAX_BODY);
  });

  test('drafts and past comments are found by their line and side, and counted by file', () => {
    const drafts = addDraft(addDraft(addDraft([], line(3), 'nuevo'), line(3, 'old'), 'viejo'), fileTarget('lib/a.dart'), 'todo');
    expect(draftsAt(drafts, line(3)).map((d) => d.body)).toEqual(['nuevo']);
    expect(draftsAt(drafts, line(3, 'old')).map((d) => d.body)).toEqual(['viejo']);
    expect(draftsAt(drafts, fileTarget('lib/a.dart')).map((d) => d.body)).toEqual(['todo']);
    expect(draftsIn(drafts, 'lib/a.dart')).toBe(3);
    expect(draftsIn(drafts, 'lib/b.dart')).toBe(0);
    const comments = [past(1, 'lib/a.dart', 3), past(2, 'lib/a.dart', 3, 'old'), past(3, 'lib/a.dart', null), past(4, 'lib/a.dart', 90), past(5, 'lib/b.dart', 3)];
    expect(commentsAt(comments, line(3)).map((c) => c.id)).toEqual([1]);
    const shown = new Set([targetKey(line(3)), targetKey(line(3, 'old'))]);
    expect(fileComments(comments, 'lib/a.dart', shown).map((c) => c.id)).toEqual([3, 4]);
  });
});

describe('targets', () => {
  test('a patch row is commented on its new line, a removed one on its old line, a hunk header on none', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n';
    const rows = patchRows(parseDiff(patch)[0]!);
    expect(rows.map((row) => rowTarget('a.ts', row))).toEqual([
      null,
      { path: 'a.ts', line: 1, side: 'new' },
      { path: 'a.ts', line: 2, side: 'old' },
      { path: 'a.ts', line: 2, side: 'new' },
    ]);
  });

  test('labels name the line, the old side or the whole file', () => {
    expect(targetLabel(line(7))).toBe('lib/a.dart:7');
    expect(targetLabel(line(7, 'old'))).toBe('lib/a.dart:7 (versión anterior)');
    expect(targetLabel(fileTarget('lib/a.dart'))).toBe('lib/a.dart · fichero entero');
    applyLang('en');
    expect(targetLabel(fileTarget('lib/a.dart'))).toBe('lib/a.dart · whole file');
  });
});

describe('sending', () => {
  const drafts = addDraft(addDraft([], line(2), 'Esto\nfalla'), fileTarget('lib/b.dart'), 'Sobra');

  test('the request carries the drafts without their ids, the trimmed summary and the language', () => {
    expect(reviewRequest(drafts, '  ojo  ', 'es')).toEqual({
      comments: [
        { path: 'lib/a.dart', line: 2, side: 'new', body: 'Esto\nfalla' },
        { path: 'lib/b.dart', line: null, side: 'new', body: 'Sobra' },
      ],
      summary: 'ojo',
      lang: 'es',
    });
  });

  test('the preview is the message the lead gets, in the language of the panel', () => {
    const lines = reviewPreview('login-ab12', 'ojo', drafts).split('\n');
    expect(lines[0]).toBe('[Agent Office] REVISIÓN: encargo/login-ab12');
    expect(lines.slice(2)).toEqual(['Resumen: ojo', '- lib/a.dart:2 — Esto falla', '- lib/b.dart — Sobra']);
    applyLang('en');
    expect(reviewPreview('login-ab12', '', drafts).split('\n')[0]).toBe('[Agent Office] REVIEW: encargo/login-ab12');
  });
});
