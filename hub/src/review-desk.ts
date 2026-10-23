import type { Database } from 'bun:sqlite';
import { REVIEW_MAX_BODY, REVIEW_MAX_COMMENTS, REVIEW_MAX_SUMMARY, reviewMessage, type ReviewComment } from '../../shared/review-message';
import type { DiffResult } from './delivery-desk';
import type { OfficeBus } from './office-bus';
import type { OrderRow, OrderStore } from './order-store';
import { renderHubText, type TextLang } from './render-text';
import { record } from './state-machine';
import type { HubText, OrderCommentView } from './types';

const MAX_PATH = 4096;
const MAX_LINE = 10_000_000;

export type ReviewRequest = { comments: ReviewComment[]; summary: string; lang: TextLang };

export type ReviewResult =
  | { ok: true; delivered: true; count: number }
  | { ok: true; delivered: false; count: number; reason: HubText }
  | { ok: false; status: 400 | 404 | 409 | 500; error: HubText };

export type ReviewDeskOpts = {
  db: Database;
  store: OrderStore;
  now: () => number;
  bus: OfficeBus;
  diff: (orderId: number) => Promise<DiffResult>;
  toLead: (order: OrderRow, content: string) => Promise<boolean>;
  // The manual move back to en-curso, with what it does to the cycle.
  reopen: (orderId: number) => void;
};

type CommentRow = { id: number; path: string; line: number; side: string; text: string; created_at: number; sent_at: number | null };

// What a row keeps in text besides the body: the table has no column for the cycle or the commit it was about.
type StoredText = { body: string; cycle: number | null; sha: string | null };

function comment(raw: unknown): ReviewComment | null {
  const value = record(raw);
  const { path, body } = value;
  if (typeof path !== 'string' || path === '' || path.length > MAX_PATH) return null;
  if (typeof body !== 'string' || body.trim() === '' || body.trim().length > REVIEW_MAX_BODY) return null;
  const line = value.line ?? null;
  if (line !== null && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || line > MAX_LINE)) return null;
  const side = value.side ?? 'new';
  if (side !== 'new' && side !== 'old') return null;
  return { path, line, side: line === null ? 'new' : side, body: body.trim() };
}

// Pure: the body of POST /api/board/orders/:id/comments, or null when any part of it is out of bounds.
export function parseReview(raw: unknown): ReviewRequest | null {
  const value = record(raw);
  if (!Array.isArray(value.comments) || value.comments.length === 0 || value.comments.length > REVIEW_MAX_COMMENTS) return null;
  const summary = value.summary ?? '';
  if (typeof summary !== 'string' || summary.trim().length > REVIEW_MAX_SUMMARY) return null;
  const comments: ReviewComment[] = [];
  for (const item of value.comments) {
    const parsed = comment(item);
    if (!parsed) return null;
    comments.push(parsed);
  }
  return { comments, summary: summary.trim(), lang: value.lang === 'en' ? 'en' : 'es' };
}

function storedText(raw: string): StoredText {
  try {
    const value = record(JSON.parse(raw));
    if (typeof value.body === 'string') {
      return { body: value.body, cycle: typeof value.cycle === 'number' ? value.cycle : null, sha: typeof value.sha === 'string' ? value.sha : null };
    }
  } catch {
    // Plain text, as a row written by hand.
  }
  return { body: raw, cycle: null, sha: null };
}

// The comments of the user on the diff of an order: kept in order_comments and sent to the lead in one message.
export class ReviewDesk {
  private readonly insert;
  private readonly markSent;
  private readonly byOrder;

  constructor(private readonly opts: ReviewDeskOpts) {
    this.insert = opts.db.query('INSERT INTO order_comments (order_id, path, line, side, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.markSent = opts.db.query('UPDATE order_comments SET sent_at = ? WHERE order_id = ? AND id >= ? AND id <= ?');
    this.byOrder = opts.db.query<CommentRow, [number]>(
      'SELECT id, path, line, side, text, created_at, sent_at FROM order_comments WHERE order_id = ? ORDER BY created_at DESC, id DESC',
    );
  }

  list(orderId: number): OrderCommentView[] | null {
    if (!this.opts.store.get(orderId)) return null;
    return this.byOrder.all(orderId).map((row) => {
      const stored = storedText(row.text);
      return {
        id: row.id,
        path: row.path,
        line: row.line > 0 ? row.line : null,
        side: row.side === 'old' ? 'old' : 'new',
        body: stored.body,
        cycle: stored.cycle,
        sha: stored.sha,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      };
    });
  }

  async send(orderId: number, request: ReviewRequest): Promise<ReviewResult> {
    const diff = await this.opts.diff(orderId);
    if (!diff.ok) return diff;
    const order = this.opts.store.get(orderId);
    if (!order) return { ok: false, status: 404, error: { key: 'hub.api.orderNotFound' } };
    if (order.status === 'descartado') return { ok: false, status: 409, error: { key: 'hub.api.orderBadState' } };
    const paths = new Set(diff.diff.files.map((file) => file.path));
    if (request.comments.some((item) => !paths.has(item.path))) return { ok: false, status: 400, error: { key: 'hub.api.diffPath' } };
    const ids = this.keep(order, request.comments, diff.diff.head);
    const content = reviewMessage({ slug: order.slug, summary: request.summary, comments: request.comments }, (text) => renderHubText(text, request.lang));
    const count = request.comments.length;
    if (!(await this.opts.toLead(order, content))) {
      this.note({ key: 'hub.act.reviewUnsent', params: { slug: order.slug } });
      return { ok: true, delivered: false, count, reason: { key: 'hub.api.reviewUnsent' } };
    }
    this.markSent.run(this.opts.now(), orderId, ids.first, ids.last);
    this.note({ key: 'hub.act.reviewSent', params: { floor: order.floor, title: order.title, n: count } });
    const fresh = this.opts.store.get(orderId);
    if (fresh && (fresh.status === 'revision' || fresh.status === 'hecho')) this.opts.reopen(orderId);
    return { ok: true, delivered: true, count };
  }

  private keep(order: OrderRow, comments: readonly ReviewComment[], sha: string): { first: number; last: number } {
    const now = this.opts.now();
    const text = (body: string) => JSON.stringify({ body, cycle: order.cycle, sha } satisfies StoredText);
    return this.opts.db.transaction(() => {
      const ids = comments.map((item) => Number(this.insert.run(order.id, item.path, item.line ?? 0, item.side, text(item.body), now).lastInsertRowid));
      return { first: Math.min(...ids), last: Math.max(...ids) };
    })();
  }

  private note(summary: HubText): void {
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: 'panel', event: 'Order', tool: null, state: null, summary });
  }
}
