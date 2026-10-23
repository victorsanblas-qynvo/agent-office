import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createApp } from '../src/server';
import { checksConfig, deliveryRig, newOrder, write, type Rig } from './delivery-rig';

const KEY = 'k'.repeat(64);
const PORT = 4747;
let rig: Rig | undefined;
afterEach(() => {
  rig?.h.cleanup();
  rig = undefined;
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

describe('board routes', () => {
  test('every route needs the panel credential', async () => {
    rig = deliveryRig();
    const app = createApp({ office: rig.h.office, port: PORT, key: () => KEY, publicDir: rig.h.root }, () => {});
    for (const [method, path] of [
      ['GET', '/api/board'],
      ['POST', '/api/board/orders'],
      ['POST', '/api/board/orders/1/move'],
      ['POST', '/api/board/orders/1/discard'],
      ['POST', '/api/board/orders/1/folder'],
      ['POST', '/api/board/orders/1/confirm-checks'],
      ['GET', '/api/board/orders/1/checks'],
      ['POST', '/api/board/orders/1/checks'],
      ['DELETE', '/api/board/orders/1/checks'],
      ['GET', '/api/board/orders/1/checkpoints'],
      ['GET', '/api/board/orders/1/diff'],
      ['GET', '/api/board/orders/1/diff/file?path=a.txt'],
      ['POST', '/api/alerts/1/seen'],
      ['GET', '/api/worktrees'],
      ['POST', '/api/worktrees/prune'],
      ['POST', '/api/worktrees/1/keep'],
      ['DELETE', '/api/worktrees/1'],
    ] as const) {
      const response = await app.request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}` } });
      expect(response.status).toBe(401);
    }
  });

  test('a new order for a floor without delivery is a 409 with deliveryOff', async () => {
    rig = deliveryRig({ delivery: false });
    const call = api(rig);
    expect(await call('POST', '/api/board/orders', { floor: 'mobile', title: 'Arreglar el logout', via: 'lead' })).toMatchObject({
      status: 409,
      body: { error: { key: 'hub.api.deliveryOff', params: { floor: 'mobile' } } },
    });
    expect((await call('GET', '/api/board')).body.orders).toEqual([]);
  });

  test('create, list, move, finish alert, seen and discard', async () => {
    rig = deliveryRig();
    const call = api(rig);
    expect(await call('POST', '/api/board/orders', { floor: 'mobile' })).toMatchObject({ status: 400, body: { error: { key: 'hub.api.boardFields' } } });
    const made = await call('POST', '/api/board/orders', { floor: 'mobile', title: 'Arreglar el logout', via: 'lead' });
    expect(made.status).toBe(200);
    const id = made.body.order.id as number;
    await rig.h.office.idle();
    const board = await call('GET', '/api/board');
    expect(board.body.orders).toEqual([expect.objectContaining({ id, status: 'pendiente', worktree: expect.objectContaining({ state: 'listo' }) })]);

    expect(await call('POST', `/api/board/orders/${id}/move`, { to: 'nope' })).toMatchObject({ status: 400 });
    expect((await call('POST', `/api/board/orders/${id}/move`, { to: 'en-curso' })).body.order.status).toBe('en-curso');
    expect(await call('POST', `/api/board/orders/${id}/move`, { to: 'en-curso' })).toMatchObject({ status: 409, body: { error: { key: 'hub.api.orderBadState' } } });
    expect(await call('POST', '/api/board/orders/9999/move', { to: 'hecho' })).toMatchObject({ status: 404 });
    expect((await call('POST', `/api/board/orders/${id}/move`, { to: 'hecho' })).body.order.status).toBe('hecho');

    const state = rig.h.office.snapshot();
    expect(state.finished).toHaveLength(1);
    const alertId = state.finished[0]?.id as number;
    expect((await call('POST', `/api/alerts/${alertId}/seen`)).status).toBe(200);
    expect(await call('POST', `/api/alerts/${alertId}/seen`)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.alertNotFound' } } });
    expect(rig.h.office.snapshot().finished).toEqual([]);

    expect((await call('POST', `/api/board/orders/${id}/discard`)).body.order.status).toBe('descartado');
    expect((await call('POST', `/api/board/orders/${id}/discard`)).status).toBe(409);
  });
});

describe('folder retry route', () => {
  test('a card with a healthy folder cannot be retried', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const card = await newOrder(rig);
    expect(await call('POST', `/api/board/orders/${card.id}/folder`)).toMatchObject({
      status: 409,
      body: { error: { key: 'hub.api.orderBadState' } },
    });
  });

  test('an interrupted setup is redone from the panel', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const card = await newOrder(rig);
    rig.h.db.query("UPDATE orders SET worktree_state = 'error', setup_error = 'interrupted' WHERE id = ?").run(card.id);

    const retried = await call('POST', `/api/board/orders/${card.id}/folder`);
    expect(retried.status).toBe(200);
    expect(retried.body.order.worktree).toMatchObject({ state: 'listo', error: null });
  });

  test('bad and unknown ids answer 400 and 404', async () => {
    rig = deliveryRig();
    const call = api(rig);
    expect(await call('POST', '/api/board/orders/abc/folder')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.badId' } } });
    expect(await call('POST', '/api/board/orders/9999/folder')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
  });
});

describe('checks and checkpoints routes', () => {
  test('run, read, cancel, list the checkpoints, confirm the definition', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    const call = api(rig);
    const card = await newOrder(rig);
    write(card.worktree?.path ?? '', 'a.txt', 'a');
    expect(await call('GET', '/api/board/orders/999/checks')).toMatchObject({ status: 404 });
    expect((await call('GET', `/api/board/orders/${card.id}/checks`)).body).toEqual({ latest: null, runs: [] });

    const started = await call('POST', `/api/board/orders/${card.id}/checks`);
    expect(started.status).toBe(200);
    expect(started.body.run).toMatchObject({ orderId: card.id, trigger: 'panel', status: 'running', checks: [expect.objectContaining({ name: 'uno' })] });
    await rig.h.office.idle();
    const read = await call('GET', `/api/board/orders/${card.id}/checks`);
    expect(read.body.latest).toMatchObject({ status: 'passed', checks: [expect.objectContaining({ status: 'passed' })] });
    expect(read.body.runs).toHaveLength(1);

    const points = await call('GET', `/api/board/orders/${card.id}/checkpoints`);
    expect(points.body.checkpoints).toEqual([expect.objectContaining({ reason: 'panel', label: 'comprobación (panel)' })]);
    expect(points.body.skipped).toEqual([]);
    expect(await call('GET', '/api/board/orders/999/checkpoints')).toMatchObject({ status: 404 });

    expect((await call('DELETE', `/api/board/orders/${card.id}/checks`)).body).toEqual({ ok: true, cancelled: false });
    expect((await call('POST', `/api/board/orders/${card.id}/confirm-checks`)).status).toBe(200);
    expect((await call('POST', '/api/board/orders/999/confirm-checks')).status).toBe(404);
    expect((await call('POST', '/api/board/orders/999/checks')).status).toBe(404);
  });

  test('a floor without checks answers 409 and a card without a folder too', async () => {
    rig = deliveryRig({ configure: (config) => (config.floors.mobile!.checks = []) });
    const call = api(rig);
    const card = await newOrder(rig);
    expect(await call('POST', `/api/board/orders/${card.id}/checks`)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.noChecks' } } });
  });
});

describe('worktree routes', () => {
  test('list, keep, refuse a dirty folder, delete with branch', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const card = await newOrder(rig);
    const path = card.worktree?.path ?? '';
    const listed = await call('GET', '/api/worktrees?floor=mobile');
    expect(listed.body.worktrees).toEqual([expect.objectContaining({ orderId: card.id, slug: card.slug, state: 'listo', dirty: false })]);
    expect((await call('GET', '/api/worktrees?floor=otra')).body.worktrees).toEqual([]);

    await Bun.write(`${path}/sin-guardar.txt`, 'x');
    expect(await call('DELETE', `/api/worktrees/${card.id}`)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.worktreeDirty' } } });
    expect(existsSync(path)).toBe(true);
    expect(await call('POST', `/api/worktrees/${card.id}/keep`)).toMatchObject({ status: 200 });
    expect(await call('POST', '/api/worktrees/999/keep')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.worktreeNotFound' } } });
    expect(await call('DELETE', `/api/worktrees/${card.id}?branch=1&force=1`)).toMatchObject({ status: 200 });
    expect(existsSync(path)).toBe(false);
    expect(await call('DELETE', `/api/worktrees/${card.id}`)).toMatchObject({ status: 404 });
    expect(await call('DELETE', '/api/worktrees/abc')).toMatchObject({ status: 400 });
    expect((await call('POST', '/api/worktrees/prune')).status).toBe(200);
  });
});
