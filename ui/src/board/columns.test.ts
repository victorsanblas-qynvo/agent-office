import { describe, expect, test } from 'bun:test';
import type { OrderChecksView, OrderStatus, OrderView } from '../types';
import { COLUMNS, activeOrder, checksBadge, columnsOf, deliveryFloors, folderBusy, neighbours, orderFloors } from './columns';

function order(id: number, status: OrderStatus, over: Partial<OrderView> = {}): OrderView {
  return {
    id,
    slug: `o-${id}`,
    floor: 'mobile',
    title: `Encargo ${id}`,
    description: '',
    status,
    source: 'director',
    planSlug: null,
    parentId: null,
    parentSlug: null,
    lead: 'lead-mobile',
    branch: `encargo/o-${id}`,
    base: 'origin/develop',
    baseSha: 'abcdef1',
    worktree: { path: `/r/.claude/worktrees/office-o-${id}`, state: 'listo', error: null, stale: false },
    checks: null,
    review: { state: 'none' },
    pr: null,
    mergedAt: null,
    tokens: null,
    cycle: 1,
    createdAt: 1,
    updatedAt: id,
    lastActivity: null,
    ...over,
  };
}

const checks = (over: Partial<OrderChecksView> = {}): OrderChecksView => ({ status: 'passed', passed: 2, total: 2, sha: 'abc', touched: [], forced: false, ...over });

describe('columnsOf', () => {
  test('four columns in order, a discarded card has none', () => {
    const columns = columnsOf([order(1, 'pendiente'), order(2, 'en-curso'), order(3, 'revision'), order(4, 'hecho'), order(5, 'descartado')], null);
    expect(columns.map((c) => c.status)).toEqual([...COLUMNS]);
    expect(columns.map((c) => c.orders.map((o) => o.id))).toEqual([[1], [2], [3], [4]]);
  });

  test('the most recently touched card goes first', () => {
    const columns = columnsOf([order(1, 'en-curso', { updatedAt: 10 }), order(2, 'en-curso', { updatedAt: 5, lastActivity: 50 }), order(3, 'en-curso', { updatedAt: 20 })], null);
    expect(columns[1]?.orders.map((o) => o.id)).toEqual([2, 3, 1]);
  });

  test('a floor filter keeps only its cards', () => {
    const orders = [order(1, 'pendiente'), order(2, 'pendiente', { floor: 'backend' })];
    expect(columnsOf(orders, 'backend')[0]?.orders.map((o) => o.id)).toEqual([2]);
    expect(columnsOf(orders, 'nada').every((c) => c.orders.length === 0)).toBe(true);
    expect(columnsOf(orders, null)[0]?.orders).toHaveLength(2);
  });
});

describe('neighbours', () => {
  test('the arrows go to the next column on each side and stop at the ends', () => {
    expect(neighbours('pendiente')).toEqual({ back: null, next: 'en-curso' });
    expect(neighbours('en-curso')).toEqual({ back: 'pendiente', next: 'revision' });
    expect(neighbours('revision')).toEqual({ back: 'en-curso', next: 'hecho' });
    expect(neighbours('hecho')).toEqual({ back: 'revision', next: null });
    expect(neighbours('descartado')).toEqual({ back: null, next: null });
  });
});

describe('checksBadge', () => {
  test('nothing without checks, the counts with them', () => {
    expect(checksBadge(order(1, 'pendiente'))).toBeNull();
    expect(checksBadge(order(1, 'pendiente', { checks: checks({ total: 0, passed: 0, status: 'none' }) }))).toBeNull();
    expect(checksBadge(order(1, 'pendiente', { checks: checks() }))).toEqual({ kind: 'passed', passed: 2, total: 2 });
    expect(checksBadge(order(1, 'pendiente', { checks: checks({ status: 'running', passed: 1 }) }))).toEqual({ kind: 'running', passed: 1, total: 2 });
    expect(checksBadge(order(1, 'pendiente', { checks: checks({ status: 'failed', passed: 1 }) }))).toEqual({ kind: 'failed', passed: 1, total: 2 });
  });
});

describe('activeOrder', () => {
  test('the open order with checks the floor touched last, none for a floor without open orders', () => {
    const orders = [
      order(1, 'en-curso', { updatedAt: 10 }),
      order(2, 'en-curso', { updatedAt: 5, checks: checks() }),
      order(3, 'hecho', { updatedAt: 99, checks: checks() }),
      order(4, 'en-curso', { floor: 'backend' }),
    ];
    expect(activeOrder(orders, 'mobile')?.id).toBe(2);
    expect(activeOrder(orders, 'backend')?.id).toBe(4);
    expect(activeOrder(orders, 'web')).toBeNull();
    expect(activeOrder([order(1, 'hecho')], 'mobile')).toBeNull();
    expect(activeOrder([order(1, 'en-curso')], 'mobile')?.id).toBe(1);
  });
});

describe('small helpers', () => {
  test('only managed floors take an order', () => {
    expect(orderFloors([{ slug: 'mobile', kind: 'managed' }, { slug: 'direccion', kind: 'direccion' }, { slug: 'x', kind: 'observed' }])).toEqual(['mobile']);
  });

  test('only managed floors with delivery take a new order, and the others stay in the filter', () => {
    const floors = [
      { slug: 'mobile', kind: 'managed', delivery: true },
      { slug: 'backend', kind: 'managed' },
      { slug: 'web', kind: 'managed', delivery: false },
      { slug: 'x', kind: 'observed', delivery: true },
    ];
    expect(deliveryFloors(floors)).toEqual(['mobile']);
    expect(orderFloors(floors)).toEqual(['mobile', 'backend', 'web']);
    expect(deliveryFloors([{ slug: 'backend', kind: 'managed' }])).toEqual([]);
  });

  test('a folder being built is busy', () => {
    const state = (s: 'creando' | 'preparando' | 'listo' | 'error') => order(1, 'pendiente', { worktree: { path: '/x', state: s, error: null, stale: false } });
    expect(folderBusy(state('creando'))).toBe(true);
    expect(folderBusy(state('preparando'))).toBe(true);
    expect(folderBusy(state('listo'))).toBe(false);
    expect(folderBusy(state('error'))).toBe(false);
    expect(folderBusy(order(1, 'pendiente', { worktree: null }))).toBe(false);
  });
});
