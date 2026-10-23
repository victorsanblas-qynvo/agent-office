import type { HubText } from '../hub/src/types';

export const REVIEW_MAX_COMMENTS = 50;
export const REVIEW_MAX_BODY = 2000;
export const REVIEW_MAX_SUMMARY = 2000;
// The longest text the panel may put in a session's inbox (the orders of POST /api/orders).
export const INBOX_MAX_TEXT = 4000;

export type ReviewSide = 'new' | 'old';

// line null: about the whole file.
export type ReviewComment = { path: string; line: number | null; side: ReviewSide; body: string };

export type ReviewInput = { slug: string; summary: string; comments: readonly ReviewComment[] };

export function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The summary keeps its line breaks as ' / ' so it stays one line of the message.
function summaryLine(text: string): string {
  return text
    .split(/\r\n?|[\n\v\f\u0085\u2028\u2029]/)
    .map(oneLine)
    .filter((line) => line !== '')
    .join(' / ');
}

function commentText(comment: ReviewComment): HubText {
  const body = oneLine(comment.body);
  const path = oneLine(comment.path);
  if (comment.line === null) return { key: 'hub.review.file', params: { path, body } };
  return { key: comment.side === 'old' ? 'hub.review.oldLine' : 'hub.review.line', params: { path, line: comment.line, body } };
}

function cut(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, Math.max(max - 1, 0)).trimEnd()}…`;
}

// The longest a comment line may be so that all of them fit in room: the short ones whole, the long ones cut
// to the same length.
function lineCap(lengths: number[], room: number): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = room;
  for (let i = 0; i < sorted.length; i += 1) {
    const share = Math.floor(left / (sorted.length - i));
    const length = sorted[i] ?? 0;
    if (length > share) return share;
    left -= length;
  }
  return Number.POSITIVE_INFINITY;
}

// Pure: the one message a review of the diff sends to the lead. Every comment gets a line with its body on one
// line; when they do not fit in max, the longest bodies are cut, never a comment left out.
export function reviewMessage(input: ReviewInput, render: (text: HubText) => string, max = INBOX_MAX_TEXT): string {
  const head = [render({ key: 'hub.review.header', params: { slug: input.slug } }), render({ key: 'hub.review.intro' })];
  const summary = summaryLine(input.summary);
  if (summary) head.push(render({ key: 'hub.review.summary', params: { text: summary } }));
  const lines = input.comments.map((comment) => render(commentText(comment)));
  const room = max - head.join('\n').length - lines.length;
  const cap = lineCap(lines.map((line) => line.length), room);
  const text = [...head, ...lines.map((line) => cut(line, cap))].join('\n');
  return text.length <= max ? text : cut(text, max);
}
