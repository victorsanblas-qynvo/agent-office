import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
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
type UnsentRow = Pick<CommentRow, 'id' | 'path' | 'line' | 'side' | 'text'>;

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
  private readonly unsent;
  // One send or resend of an order at a time, so two of them never store or mark the same rows.
  private readonly locks = new Map<number, Promise<void>>();

  constructor(private readonly opts: ReviewDeskOpts) {
    this.insert = opts.db.query('INSERT INTO order_comments (order_id, path, line, side, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.markSent = opts.db.query('UPDATE order_comments SET sent_at = ? WHERE order_id = ? AND sent_at IS NULL AND id IN (SELECT value FROM json_each(?))');
    this.unsent = opts.db.query<UnsentRow, [number]>('SELECT id, path, line, side, text FROM order_comments WHERE order_id = ? AND sent_at IS NULL ORDER BY id');
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

  send(orderId: number, request: ReviewRequest): Promise<ReviewResult> {
    return this.serial(orderId, async () => {
      const diff = await this.opts.diff(orderId);
      if (!diff.ok) return diff;
      const order = this.opts.store.get(orderId);
      if (!order) return { ok: false, status: 404, error: { key: 'hub.api.orderNotFound' } };
      const refused = this.refusal(order);
      if (refused) return refused;
      const paths = new Set(diff.diff.files.map((file) => file.path));
      if (request.comments.some((item) => !paths.has(item.path))) return { ok: false, status: 400, error: { key: 'hub.api.diffPath' } };
      const ids = this.keep(order, request.comments, diff.diff.head);
      return this.deliver(order, request.comments, request.summary, request.lang, ids);
    });
  }

  // The comments the lead never got, oldest first, again in one message; a review holds at most REVIEW_MAX_COMMENTS.
  resend(orderId: number, lang: TextLang): Promise<ReviewResult> {
    return this.serial(orderId, async () => {
      const order = this.opts.store.get(orderId);
      if (!order) return { ok: false, status: 404, error: { key: 'hub.api.orderNotFound' } };
      const refused = this.refusal(order);
      if (refused) return refused;
      const rows = this.unsent.all(orderId).slice(0, REVIEW_MAX_COMMENTS);
      if (rows.length === 0) return { ok: false, status: 409, error: { key: 'hub.api.reviewNothingUnsent' } };
      const comments = rows.map((row): ReviewComment => {
        const line = row.line > 0 ? row.line : null;
        return { path: row.path, line, side: line !== null && row.side === 'old' ? 'old' : 'new', body: storedText(row.text).body };
      });
      return this.deliver(order, comments, '', lang, rows.map((row) => row.id));
    });
  }

  private refusal(order: OrderRow): ReviewResult | null {
    if (order.status === 'descartado') return { ok: false, status: 409, error: { key: 'hub.api.orderBadState' } };
    // The lead is told to fix it in the folder of the order: without one there is nowhere to do it.
    if (!order.worktree_path || order.worktree_state === 'retirado' || !existsSync(order.worktree_path)) {
      return { ok: false, status: 409, error: { key: 'hub.api.orderNoFolder' } };
    }
    return null;
  }

  private async deliver(order: OrderRow, comments: readonly ReviewComment[], summary: string, lang: TextLang, ids: readonly number[]): Promise<ReviewResult> {
    const content = reviewMessage({ slug: order.slug, summary, comments }, (text) => renderHubText(text, lang));
    const count = comments.length;
    if (!(await this.opts.toLead(order, content))) {
      this.note({ key: 'hub.act.reviewUnsent', params: { slug: order.slug } });
      return { ok: true, delivered: false, count, reason: { key: 'hub.api.reviewUnsent' } };
    }
    this.markSent.run(this.opts.now(), order.id, JSON.stringify(ids));
    this.note({ key: 'hub.act.reviewSent', params: { floor: order.floor, title: order.title, n: count } });
    const fresh = this.opts.store.get(order.id);
    if (fresh && (fresh.status === 'revision' || fresh.status === 'hecho')) this.opts.reopen(order.id);
    return { ok: true, delivered: true, count };
  }

  // A comment that is already stored and unsent (a retry of a review the lead did not get) keeps its row.
  private keep(order: OrderRow, comments: readonly ReviewComment[], sha: string): number[] {
    const now = this.opts.now();
    const text = (body: string) => JSON.stringify({ body, cycle: order.cycle, sha } satisfies StoredText);
    return this.opts.db.transaction(() => {
      const waiting = this.unsent.all(order.id);
      return comments.map((item) => {
        const line = item.line ?? 0;
        const at = waiting.findIndex((row) => row.path === item.path && row.line === line && row.side === item.side && storedText(row.text).body === item.body);
        if (at >= 0) return (waiting.splice(at, 1)[0] as UnsentRow).id;
        return Number(this.insert.run(order.id, item.path, line, item.side, text(item.body), now).lastInsertRowid);
      });
    })();
  }

  private serial(orderId: number, task: () => Promise<ReviewResult>): Promise<ReviewResult> {
    const result = (this.locks.get(orderId) ?? Promise.resolve()).then(task);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(orderId, done);
    void done.then(() => {
      if (this.locks.get(orderId) === done) this.locks.delete(orderId);
    });
    return result;
  }

  private note(summary: HubText): void {
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: 'panel', event: 'Order', tool: null, state: null, summary });
  }
}
