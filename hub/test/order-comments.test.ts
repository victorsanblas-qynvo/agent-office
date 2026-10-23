import { afterEach, describe, expect, test } from 'bun:test';
import { INBOX_MAX_TEXT, reviewMessage, type ReviewComment } from '../../shared/review-message';
import { renderHubText } from '../src/render-text';
import { parseReview } from '../src/review-desk';
import { createApp } from '../src/server';
import { commitAll, deliveryRig, leadMessages, newOrder, orderOf, textOf, write, type Rig } from './delivery-rig';

const KEY = 'k'.repeat(64);
const PORT = 4747;
const HEADER = '[Agent Office] REVISIÓN: encargo/';
let rig: Rig | undefined;
afterEach(async () => {
  const closing = rig?.h.close();
  rig = undefined;
  await closing;
});

function api(r: Rig) {
  const app = createApp({ office: r.h.office, port: PORT, key: () => KEY, publicDir: r.h.root }, () => {});
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'x-office-key': KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
}

// An order whose branch changed two files, so its diff has paths to comment on.
async function reviewable(r: Rig): Promise<{ id: number; slug: string; head: string }> {
  const card = await newOrder(r);
  const folder = card.worktree?.path ?? '';
  write(folder, 'lib/login.dart', 'uno\ndos\ntres\n');
  write(folder, 'lib/otro.dart', 'otro\n');
  const head = commitAll(folder, 'login');
  return { id: card.id, slug: card.slug, head };
}

const reviews = (r: Rig): string[] => leadMessages(r).filter((text) => text.startsWith(HEADER));
const count = (r: Rig): number => (r.h.db.query('SELECT COUNT(*) AS n FROM order_comments').get() as { n: number }).n;

describe('review comments on the diff of an order', () => {
  test('stores one row per comment and sends the lead one message with all of them', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, slug, head } = await reviewable(rig);
    const sent = await call('POST', `/api/board/orders/${id}/comments`, {
      summary: 'Faltan dos cosas',
      comments: [
        { path: 'lib/login.dart', line: 2, body: 'Esto\nno compila' },
        { path: 'lib/login.dart', line: 1, side: 'old', body: 'Vuelve a ponerlo' },
        { path: 'lib/otro.dart', line: null, body: 'Sobra el fichero' },
      ],
    });
    expect(sent).toEqual({ status: 200, body: { delivered: true, count: 3 } });

    const messages = reviews(rig);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.split('\n')).toEqual([
      `${HEADER}${slug}`,
      expect.stringContaining('HECHO'),
      'Resumen: Faltan dos cosas',
      '- lib/login.dart:2 — Esto no compila',
      '- lib/login.dart:1 (versión anterior) — Vuelve a ponerlo',
      '- lib/otro.dart — Sobra el fichero',
    ]);

    const listed = await call('GET', `/api/board/orders/${id}/comments`);
    expect(listed.status).toBe(200);
    const comments = listed.body.comments as Record<string, unknown>[];
    expect(comments.map((c) => [c.path, c.line, c.side, c.body])).toEqual([
      ['lib/otro.dart', null, 'new', 'Sobra el fichero'],
      ['lib/login.dart', 1, 'old', 'Vuelve a ponerlo'],
      ['lib/login.dart', 2, 'new', 'Esto\nno compila'],
    ]);
    for (const c of comments) expect(c).toMatchObject({ cycle: 1, sha: head, createdAt: rig.h.clock.now, sentAt: rig.h.clock.now });
  });

  test('newest first across reviews', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id } = await reviewable(rig);
    await call('POST', `/api/board/orders/${id}/comments`, { comments: [{ path: 'lib/login.dart', line: 1, body: 'primero' }] });
    rig.h.clock.now += 1000;
    await call('POST', `/api/board/orders/${id}/comments`, { comments: [{ path: 'lib/login.dart', line: 1, body: 'segundo' }] });
    const listed = await call('GET', `/api/board/orders/${id}/comments`);
    expect((listed.body.comments as { body: string }[]).map((c) => c.body)).toEqual(['segundo', 'primero']);
  });

  test('an order in revision goes back to en-curso through the manual move, which keeps its cycle', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, slug } = await reviewable(rig);
    expect(rig.h.office.moveOrder(id, 'revision')).toMatchObject({ ok: true, order: { status: 'revision', cycle: 1 } });
    await call('POST', `/api/board/orders/${id}/comments`, { comments: [{ path: 'lib/login.dart', line: 1, body: 'x' }] });
    expect(orderOf(rig, slug)).toMatchObject({ status: 'en-curso', cycle: 1 });
  });

  test('an order in hecho goes back to en-curso and opens exactly one new cycle', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, slug } = await reviewable(rig);
    expect(rig.h.office.moveOrder(id, 'hecho')).toMatchObject({ ok: true, order: { status: 'hecho', cycle: 1 } });
    await call('POST', `/api/board/orders/${id}/comments`, { comments: [{ path: 'lib/login.dart', line: 1, body: 'x' }] });
    expect(orderOf(rig, slug)).toMatchObject({ status: 'en-curso', cycle: 2 });
    await call('POST', `/api/board/orders/${id}/comments`, { comments: [{ path: 'lib/login.dart', line: 2, body: 'y' }] });
    expect(orderOf(rig, slug)).toMatchObject({ status: 'en-curso', cycle: 2 });
    const listed = await call('GET', `/api/board/orders/${id}/comments`);
    expect((listed.body.comments as { cycle: number }[]).map((c) => c.cycle)).toEqual([2, 1]);
    expect(reviews(rig)).toHaveLength(2);
  });

  test('a path that is not in the diff is refused and nothing is stored or sent', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id } = await reviewable(rig);
    const refused = await call('POST', `/api/board/orders/${id}/comments`, {
      comments: [
        { path: 'lib/login.dart', line: 1, body: 'bien' },
        { path: 'lib/nada.dart', line: 1, body: 'mal' },
      ],
    });
    expect(refused).toEqual({ status: 400, body: { error: { key: 'hub.api.diffPath' } } });
    expect(count(rig)).toBe(0);
    expect(reviews(rig)).toEqual([]);
  });

  test('too many comments, a body or summary too long and a bad line are refused', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id } = await reviewable(rig);
    const one = { path: 'lib/login.dart', line: 1, body: 'x' };
    for (const body of [
      { comments: [] },
      { comments: Array.from({ length: 51 }, () => one) },
      { comments: [{ ...one, body: 'x'.repeat(2001) }] },
      { comments: [{ ...one, body: '   ' }] },
      { comments: [one], summary: 'x'.repeat(2001) },
      { comments: [{ ...one, line: 0 }] },
      { comments: [{ ...one, line: 1.5 }] },
      { comments: [{ ...one, side: 'both' }] },
      { comments: [{ line: 1, body: 'x' }] },
    ]) {
      expect(await call('POST', `/api/board/orders/${id}/comments`, body)).toEqual({ status: 400, body: { error: { key: 'hub.api.reviewFields' } } });
    }
    expect(await call('POST', '/api/board/orders/x/comments', { comments: [one] })).toEqual({ status: 400, body: { error: { key: 'hub.api.badId' } } });
    expect(count(rig)).toBe(0);
    const fifty = await call('POST', `/api/board/orders/${id}/comments`, { comments: Array.from({ length: 50 }, () => ({ ...one, body: 'y'.repeat(2000) })), summary: 's'.repeat(2000) });
    expect(fifty).toEqual({ status: 200, body: { delivered: true, count: 50 } });
    expect(reviews(rig)[0]?.length).toBeLessThanOrEqual(INBOX_MAX_TEXT);
    expect(count(rig)).toBe(50);
  });

  test('an unknown order is 404 and an order with no branch is 409', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const one = { comments: [{ path: 'a.txt', line: 1, body: 'x' }] };
    expect(await call('POST', '/api/board/orders/999/comments', one)).toEqual({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
    expect(await call('GET', '/api/board/orders/999/comments')).toEqual({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
    const created = await rig.h.office.createOrder({ floor: 'mobile', title: 'Sin carpeta', via: 'director' });
    if (!created.ok) throw new Error('no card');
    expect(await call('POST', `/api/board/orders/${created.order.id}/comments`, one)).toEqual({ status: 409, body: { error: { key: 'hub.api.orderNoBranch' } } });
    expect(await call('GET', `/api/board/orders/${created.order.id}/comments`)).toEqual({ status: 200, body: { comments: [] } });
  });

  test('with the lead unreachable the comments are kept unsent and the card does not move', async () => {
    let down = false;
    rig = deliveryRig({
      office: {
        deliverFn: async (socket, payload) => {
          if (down && socket.endsWith('lead.sock')) throw new Error('gone');
          rig?.sent.push({ socket, payload, text: textOf(payload) });
        },
      },
    });
    const call = api(rig);
    const { id, slug } = await reviewable(rig);
    rig.h.office.moveOrder(id, 'revision');
    down = true;
    const sent = await call('POST', `/api/board/orders/${id}/comments`, { comments: [{ path: 'lib/login.dart', line: 3, body: 'x' }] });
    expect(sent).toEqual({ status: 200, body: { delivered: false, count: 1, reason: { key: 'hub.api.reviewUnsent' } } });
    expect(reviews(rig)).toEqual([]);
    expect(orderOf(rig, slug).status).toBe('revision');
    const listed = await call('GET', `/api/board/orders/${id}/comments`);
    expect(listed.body.comments).toEqual([expect.objectContaining({ path: 'lib/login.dart', line: 3, body: 'x', sentAt: null })]);
    expect(rig.h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.reviewUnsent', params: { slug } });
  });
});

describe('parseReview', () => {
  test('defaults the side to new, keeps file comments on new and trims bodies and summary', () => {
    expect(parseReview({ comments: [{ path: 'a', line: 3, body: ' x ' }, { path: 'b', line: null, side: 'old', body: 'y' }, { path: 'c', body: 'z' }], summary: ' s ', lang: 'en' })).toEqual({
      comments: [
        { path: 'a', line: 3, side: 'new', body: 'x' },
        { path: 'b', line: null, side: 'new', body: 'y' },
        { path: 'c', line: null, side: 'new', body: 'z' },
      ],
      summary: 's',
      lang: 'en',
    });
    expect(parseReview(null)).toBeNull();
    expect(parseReview({ comments: [{ path: 'a', line: 1, body: 'x' }], summary: 3 })).toBeNull();
  });
});

describe('reviewMessage', () => {
  const es = (text: Parameters<typeof renderHubText>[0]) => renderHubText(text, 'es');
  const long = (path: string, n: number): ReviewComment => ({ path, line: n, side: 'new', body: `${'palabra '.repeat(250)}fin` });

  test('fits every comment under the limit, cutting only the long bodies', () => {
    const comments = [long('a.ts', 1), { path: 'b.ts', line: 2, side: 'new' as const, body: 'corto' }, long('c.ts', 3)];
    const text = reviewMessage({ slug: 's', summary: '', comments }, es, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    const lines = text.split('\n');
    expect(lines).toContain('- b.ts:2 — corto');
    expect(lines.find((line) => line.startsWith('- a.ts:1 — palabra'))?.endsWith('…')).toBe(true);
    expect(lines.find((line) => line.startsWith('- c.ts:3 — palabra'))?.endsWith('…')).toBe(true);
  });

  test('leaves short messages whole and renders in English when asked', () => {
    const comments: ReviewComment[] = [{ path: 'a.ts', line: 4, side: 'old', body: 'uno\n  dos' }];
    expect(reviewMessage({ slug: 's', summary: '', comments }, es).split('\n').at(-1)).toBe('- a.ts:4 (versión anterior) — uno dos');
    const en = reviewMessage({ slug: 's', summary: 'ok', comments }, (text) => renderHubText(text, 'en')).split('\n');
    expect(en[0]).toBe('[Agent Office] REVIEW: encargo/s');
    expect(en.slice(2)).toEqual(['Summary: ok', '- a.ts:4 (old version) — uno dos']);
  });
});
