import { beforeAll, describe, expect, test } from 'bun:test';
import { boardMarkdown } from '../src/board/board-markdown';
import { columnsOf, laneLayout, nextCardInLanes } from '../src/board/columns';
import { applyLang } from '../src/i18n/index';
import { resolveKey, type KeyLike } from '../src/keys';
import { BOARD_LANES_KEY, normalizeBoardLanes } from '../src/prefs';
import { TRANSFER_KEYS, planImport } from '../src/settings/prefs-transfer';
import { order } from './fixtures';

beforeAll(() => applyLang('es'));

const NOW = new Date(2026, 9, 24, 9, 30, 0).getTime();

const orders = [
  order('m1', { id: 1, floor: 'mobile', status: 'pendiente', updatedAt: NOW - 3000 }),
  order('m2', { id: 2, floor: 'mobile', status: 'pendiente', updatedAt: NOW - 1000 }),
  order('m3', { id: 3, floor: 'mobile', status: 'hecho', updatedAt: NOW }),
  order('b1', { id: 4, floor: 'backend', status: 'pendiente', updatedAt: NOW }),
  order('b2', { id: 5, floor: 'backend', status: 'revision', updatedAt: NOW }),
  order('z1', { id: 6, floor: 'zeta', status: 'hecho', updatedAt: NOW }),
];

const ids = (lane: { columns: { orders: { id: number }[] }[] }): number[][] => lane.columns.map((column) => column.orders.map((o) => o.id));

describe('laneLayout', () => {
  test('one lane per floor with the four columns, the given floor order first and the rest alphabetical', () => {
    const lanes = laneLayout(orders, { floor: null, floors: ['mobile', 'backend'] });
    expect(lanes.map((lane) => lane.floor)).toEqual(['mobile', 'backend', 'zeta']);
    expect(lanes[0]!.columns.map((column) => column.status)).toEqual(['pendiente', 'en-curso', 'revision', 'hecho']);
    expect(laneLayout(orders, { floor: null }).map((lane) => lane.floor)).toEqual(['backend', 'mobile', 'zeta']);
  });

  test('hides floors with no visible card and honours the floor filter', () => {
    expect(laneLayout(orders.filter((o) => o.floor !== 'zeta'), { floor: null }).map((lane) => lane.floor)).toEqual(['backend', 'mobile']);
    expect(laneLayout(orders, { floor: 'backend' }).map((lane) => lane.floor)).toEqual(['backend']);
    expect(laneLayout(orders, { floor: 'nada' })).toEqual([]);
    expect(laneLayout([], { floor: null })).toEqual([]);
  });

  test('orders inside a lane column as the plain board does', () => {
    const lane = laneLayout(orders, { floor: null }).find((entry) => entry.floor === 'mobile')!;
    expect(ids(lane)).toEqual([[2, 1], [], [], [3]]);
    expect(lane.columns).toEqual(columnsOf(orders, 'mobile'));
  });
});

describe('nextCardInLanes', () => {
  const lanes = laneLayout(orders, { floor: null, floors: ['mobile', 'backend', 'zeta'] });

  test('j and k stay in the column of the lane and clamp at its ends', () => {
    expect(nextCardInLanes(lanes, '2', 'down')).toBe('1');
    expect(nextCardInLanes(lanes, '1', 'down')).toBe('1');
    expect(nextCardInLanes(lanes, '1', 'up')).toBe('2');
    expect(nextCardInLanes(lanes, '2', 'up')).toBe('2');
  });

  test('h and l cross the columns of the same lane only', () => {
    expect(nextCardInLanes(lanes, '2', 'right')).toBe('3');
    expect(nextCardInLanes(lanes, '3', 'left')).toBe('2');
    expect(nextCardInLanes(lanes, '3', 'right')).toBe('3');
    expect(nextCardInLanes(lanes, '4', 'right')).toBe('5');
    expect(nextCardInLanes(lanes, '4', 'left')).toBe('4');
  });

  test('J and K jump to the same column of the nearest lane that has a card there, clamping the row', () => {
    expect(nextCardInLanes(lanes, '2', 'laneDown')).toBe('4');
    expect(nextCardInLanes(lanes, '1', 'laneDown')).toBe('4');
    expect(nextCardInLanes(lanes, '4', 'laneUp')).toBe('2');
    expect(nextCardInLanes(lanes, '3', 'laneDown')).toBe('6');
    expect(nextCardInLanes(lanes, '6', 'laneUp')).toBe('3');
    expect(nextCardInLanes(lanes, '5', 'laneDown')).toBe('5');
    expect(nextCardInLanes(lanes, '2', 'laneUp')).toBe('2');
    expect(nextCardInLanes(lanes, '6', 'laneDown')).toBe('6');
  });

  test('starts at the first card when nothing is highlighted or the highlight is gone', () => {
    expect(nextCardInLanes(lanes, null, 'down')).toBe('2');
    expect(nextCardInLanes(lanes, '99', 'laneDown')).toBe('2');
    expect(nextCardInLanes([], null, 'down')).toBeNull();
  });

  test('a collapsed lane (empty columns) is skipped', () => {
    const collapsed = lanes.map((lane) => (lane.floor === 'backend' ? { floor: lane.floor, columns: lane.columns.map((c) => ({ status: c.status, orders: [] })) } : lane));
    expect(nextCardInLanes(collapsed, '1', 'laneDown')).toBe('1');
    expect(nextCardInLanes(collapsed, '3', 'laneDown')).toBe('6');
  });
});

describe('J and K bindings', () => {
  const press = (key: string, shiftKey: boolean): KeyLike => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey });

  test('shift+j and shift+k are the lane moves, plain j and k are untouched', () => {
    expect(resolveKey(press('J', true))).toEqual({ type: 'board', move: 'laneDown' });
    expect(resolveKey(press('K', true))).toEqual({ type: 'board', move: 'laneUp' });
    expect(resolveKey(press('j', false))).toEqual({ type: 'board', move: 'down' });
  });
});

describe('boardMarkdown with lanes', () => {
  test('a section per floor holding a subsection per column', () => {
    const lanes = laneLayout(orders, { floor: null, floors: ['mobile', 'backend'] });
    const md = boardMarkdown(columnsOf(orders, null), NOW, lanes);
    expect(md).toContain('## mobile (3)\n\n### Pendiente (2)\n\n- ');
    expect(md).toContain('## backend (2)\n\n### Pendiente (1)');
    expect(md).toContain('### Revisión (1)\n\n- b2');
    expect(md.indexOf('## mobile')).toBeLessThan(md.indexOf('## backend'));
    expect(md).not.toContain('\n## Pendiente');
  });

  test('without lanes it keeps the flat layout', () => {
    const md = boardMarkdown(columnsOf(orders, null), NOW);
    expect(md).toContain('\n## Pendiente (3)');
    expect(md).not.toContain('###');
  });
});

describe('boardLanes pref', () => {
  test('only true turns the lanes on', () => {
    expect(normalizeBoardLanes(true)).toBe(true);
    for (const raw of [false, null, 'true', 1, undefined]) expect(normalizeBoardLanes(raw)).toBe(false);
  });

  test('travels with the preferences, valid booleans only', () => {
    expect(TRANSFER_KEYS).toContain(BOARD_LANES_KEY);
    const doc = (value: unknown): string => JSON.stringify({ format: 'agent-office-prefs', version: 1, exportedAt: 'x', prefs: { [BOARD_LANES_KEY]: value } });
    const storage = { getItem: () => null, setItem: () => {} };
    expect(planImport(doc(true), storage).apply.map((item) => item.value)).toEqual([true]);
    expect(planImport(doc(false), storage).apply.map((item) => item.value)).toEqual([false]);
    expect(planImport(doc('yes'), storage).skipped).toEqual([{ key: BOARD_LANES_KEY, reason: 'invalid' }]);
  });
});
