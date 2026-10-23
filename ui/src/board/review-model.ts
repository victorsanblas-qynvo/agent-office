import { REVIEW_MAX_BODY, REVIEW_MAX_COMMENTS, reviewMessage, type ReviewSide } from '../../../shared/review-message';
import type { ReviewRequest } from '../api';
import { type Lang, t } from '../i18n';
import { renderHubText } from '../i18n/hub';
import type { OrderCommentView } from '../types';
import type { PatchRow } from './diff-model';

// Where a comment goes: a line of one side of the patch, or the whole file (line null, always the new side).
export type ReviewTarget = { path: string; line: number | null; side: ReviewSide };

export type ReviewDraft = ReviewTarget & { id: number; body: string };

export function fileTarget(path: string): ReviewTarget {
  return { path, line: null, side: 'new' };
}

// A line added or kept is commented on its new number, a removed line on its old one; hunk headers take none.
export function rowTarget(path: string, row: PatchRow): ReviewTarget | null {
  if (row.newLine !== null) return { path, line: row.newLine, side: 'new' };
  if (row.oldLine !== null) return { path, line: row.oldLine, side: 'old' };
  return null;
}

export function targetKey(target: ReviewTarget): string {
  return `${target.path}\n${target.line === null ? 'file' : `${target.side}:${target.line}`}`;
}

export function sameTarget(a: ReviewTarget, b: ReviewTarget): boolean {
  return targetKey(a) === targetKey(b);
}

export function draftsFull(drafts: readonly ReviewDraft[]): boolean {
  return drafts.length >= REVIEW_MAX_COMMENTS;
}

// A new draft at the end; an empty text or a full review leave the list as it was.
export function addDraft(drafts: readonly ReviewDraft[], target: ReviewTarget, body: string): ReviewDraft[] {
  const text = body.trim().slice(0, REVIEW_MAX_BODY);
  if (text === '' || draftsFull(drafts)) return [...drafts];
  const id = drafts.reduce((max, draft) => Math.max(max, draft.id), 0) + 1;
  return [...drafts, { path: target.path, line: target.line, side: target.line === null ? 'new' : target.side, id, body: text }];
}

export function removeDraft(drafts: readonly ReviewDraft[], id: number): ReviewDraft[] {
  return drafts.filter((draft) => draft.id !== id);
}

export function draftsAt(drafts: readonly ReviewDraft[], target: ReviewTarget): ReviewDraft[] {
  return drafts.filter((draft) => sameTarget(draft, target));
}

export function draftsIn(drafts: readonly ReviewDraft[], path: string): number {
  return drafts.filter((draft) => draft.path === path).length;
}

export function commentsAt(comments: readonly OrderCommentView[], target: ReviewTarget): OrderCommentView[] {
  return comments.filter((comment) => sameTarget(comment, target));
}

// The comments of a file that have no row in the patch shown now (the lines moved since), and those of the whole file.
export function fileComments(comments: readonly OrderCommentView[], path: string, shown: ReadonlySet<string>): OrderCommentView[] {
  return comments.filter((comment) => comment.path === path && (comment.line === null || !shown.has(targetKey(comment))));
}

export function targetLabel(target: ReviewTarget): string {
  if (target.line === null) return `${target.path} · ${t('board.review.wholeFile')}`;
  return target.side === 'old' ? `${target.path}:${target.line} (${t('board.review.oldSide')})` : `${target.path}:${target.line}`;
}

export function reviewRequest(drafts: readonly ReviewDraft[], summary: string, lang: Lang): ReviewRequest {
  return { comments: drafts.map(({ path, line, side, body }) => ({ path, line, side, body })), summary: summary.trim(), lang };
}

// The message the lead will get, in the language of the panel: the same text the hub builds.
export function reviewPreview(slug: string, summary: string, drafts: readonly ReviewDraft[]): string {
  return reviewMessage({ slug, summary, comments: drafts }, (text) => renderHubText(t, text));
}
