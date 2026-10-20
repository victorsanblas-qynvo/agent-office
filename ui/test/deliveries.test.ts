import { describe, expect, test } from 'bun:test';
import { deliveryFloors, isBlockedMessage, isTracked, leadDeliveryFloor } from '../src/deliveries';
import type { FinishedView, MessageView, ServerMessage } from '../src/types';
import { agent, order } from './fixtures';

Object.assign(globalThis, {
  window: { setInterval: () => 0, setTimeout: () => 0 },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { documentElement: { lang: 'es' } },
});

const { Store } = await import('../src/store');

const text = (value: string | null, extra: Partial<MessageView> = {}): MessageView =>
  ({ id: 1, ts: 1, fromKey: 'lead-1', toKey: null, text: value, ...extra }) as MessageView;

const finished = (id: number, floors: string[]): FinishedView =>
  ({ id, ts: id, kind: 'order', slug: `o-${id}`, title: `T${id}`, floors, branch: null, summary: '', cycle: 1, manual: false, checks: null, touched: [], prUrl: null, orderSlugs: [] }) as FinishedView;

function seeded() {
  const store = new Store();
  store.apply({
    type: 'snapshot',
    data: { now: 1, floors: [], agents: [agent('lead-1', { roleKind: 'lead', floor: 'mobile' }), agent('dev-1', { roleKind: 'dev' })], sessions: [], questions: [], messages: [], activity: [] },
  } as unknown as ServerMessage);
  return store;
}

describe('what counts as a delivery', () => {
  test('a HECHO of a lead whose floor has no orders delivers to its floor', () => {
    const store = seeded();
    expect(leadDeliveryFloor(store, text('HECHO: listo'))).toBe('mobile');
    expect(leadDeliveryFloor(store, text('  hecho : listo'))).toBe('mobile');
    expect(leadDeliveryFloor(store, text('ESPERO: el resultado'))).toBeNull();
    expect(leadDeliveryFloor(store, text(null))).toBeNull();
    expect(leadDeliveryFloor(store, text('HECHO: listo', { fromKey: 'dev-1' }))).toBeNull();
    expect(leadDeliveryFloor(store, text('HECHO: listo', { fromKey: 'ghost' }))).toBeNull();
  });

  test('a floor that works with orders says it through the end popup instead', () => {
    const store = seeded();
    store.orders = [order('x', { floor: 'mobile', worktree: { path: '/w', state: 'listo', error: null, stale: false } })];
    expect(isTracked(store, 'lead-1')).toBe(true);
    expect(leadDeliveryFloor(store, text('HECHO: listo'))).toBeNull();
    expect(deliveryFloors(store, { type: 'finished', data: finished(1, ['mobile', 'backend']) })).toEqual(['mobile', 'backend']);
  });

  test('BLOQUEADO is not a delivery', () => {
    expect(isBlockedMessage(text('BLOQUEADO: falta la clave'))).toBe(true);
    expect(isBlockedMessage(text('HECHO: x'))).toBe(false);
    expect(deliveryFloors(seeded(), { type: 'message', data: text('BLOQUEADO: x') })).toEqual([]);
  });
});

describe('the store announces deliveries to the printers', () => {
  test('each one bumps the sequence with its floors; a repeated popup, history and other messages do not', () => {
    const store = seeded();
    expect(store.delivery).toEqual({ seq: 0, floors: [] });
    store.apply({ type: 'message', data: text('seguimos') });
    store.apply({ type: 'message', data: text('HECHO: login', { id: 2 }) });
    expect(store.delivery).toEqual({ seq: 1, floors: ['mobile'] });
    store.apply({ type: 'finished', data: finished(3, ['backend']) });
    expect(store.delivery).toEqual({ seq: 2, floors: ['backend'] });
    store.apply({ type: 'finished', data: finished(3, ['backend']) });
    expect(store.delivery.seq).toBe(2);
    store.apply({ type: 'snapshot', data: { now: 1, floors: [], agents: [], sessions: [], questions: [], messages: [text('HECHO: viejo')], activity: [] } } as unknown as ServerMessage);
    expect(store.delivery.seq).toBe(2);
  });
});
