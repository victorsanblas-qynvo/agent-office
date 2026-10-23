import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { columnsOf, filterOrders } from '../src/board/columns';
import { applyFocus, focusable, liveFocus, needsFilterAfter } from '../src/focus';
import { applyLang } from '../src/i18n/index';
import { filterByFloor } from '../src/needs';
import { buildEntries, type PaletteContext } from '../src/palette/entries';
import { agent, floor, order } from './fixtures';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const floors = [floor('mobile'), floor('backend'), floor('direccion', { kind: 'direccion', label: 'Dirección' }), floor('ext', { kind: 'observed' })];

describe('focusable and liveFocus', () => {
  test('only managed and observed floors can be focused', () => {
    expect(focusable(floors)).toEqual(['mobile', 'backend', 'ext']);
  });

  test('a focus on a floor that is gone lapses, and is kept while no floors are known', () => {
    expect(liveFocus('mobile', floors)).toBe('mobile');
    expect(liveFocus('gone', floors)).toBeNull();
    expect(liveFocus('direccion', floors)).toBeNull();
    expect(liveFocus('mobile', [])).toBe('mobile');
    expect(liveFocus(null, floors)).toBeNull();
  });
});

describe('applyFocus', () => {
  const orders = [order('login-a', { floor: 'mobile', title: 'Login con huella' }), order('login-b', { floor: 'backend', title: 'Login API' }), order('perfil', { floor: 'mobile', title: 'Perfil' })];
  const shownSlugs = (query: string, floorFilter: string | null, focus: string | null): string[] => {
    const filters = applyFocus({ query, floor: floorFilter }, focus);
    return columnsOf(filterOrders(orders, filters.query), filters.floor).flatMap((column) => column.orders.map((item) => item.slug)).sort();
  };

  test('with no focus the filters are untouched', () => {
    const filters = { query: 'x', floor: 'backend' };
    expect(applyFocus(filters, null)).toBe(filters);
  });

  test('the focused floor overrides the floor filter', () => {
    expect(applyFocus({ query: '', floor: 'backend' }, 'mobile')).toEqual({ query: '', floor: 'mobile' });
  });

  test('the board predicate composes with the text filter', () => {
    expect(shownSlugs('', null, null)).toEqual(['login-a', 'login-b', 'perfil']);
    expect(shownSlugs('', null, 'mobile')).toEqual(['login-a', 'perfil']);
    expect(shownSlugs('login', null, 'mobile')).toEqual(['login-a']);
    expect(shownSlugs('login', 'backend', 'mobile')).toEqual(['login-a']);
    expect(shownSlugs('api', null, 'mobile')).toEqual([]);
  });
});

describe('needsFilterAfter', () => {
  test('focusing sets the queue filter to the floor', () => {
    expect(needsFilterAfter(null, null, 'mobile')).toBe('mobile');
    expect(needsFilterAfter('backend', null, 'mobile')).toBe('mobile');
    expect(filterByFloor([], needsFilterAfter(null, null, 'mobile'))).toEqual([]);
  });

  test('clearing the focus clears the chip it set, and keeps one chosen since', () => {
    expect(needsFilterAfter('mobile', 'mobile', null)).toBeNull();
    expect(needsFilterAfter('backend', 'mobile', null)).toBe('backend');
    expect(needsFilterAfter(null, 'mobile', null)).toBeNull();
  });
});

describe('palette focus entries', () => {
  const context = (extra: Partial<PaletteContext> = {}): PaletteContext => ({
    agents: [agent('lead-mobile')],
    floors,
    recent: [],
    documents: [],
    orders: [],
    tabs: [],
    live: true,
    reply: null,
    status: null,
    relaunch: null,
    relaunchAll: 0,
    statusAll: 0,
    messageAll: 0,
    pins: [],
    newOrder: false,
    focus: null,
    mute: false,
    muteSound: false,
    searches: [],
    ...extra,
  });
  const focusEntries = (extra: Partial<PaletteContext> = {}) => buildEntries(context(extra)).filter((entry) => entry.target.type === 'focus');

  test('one entry per managed or observed floor, and no clear entry while unfocused', () => {
    const entries = focusEntries();
    expect(entries.map((entry) => entry.id)).toEqual(['action:focus:mobile', 'action:focus:backend', 'action:focus:ext']);
    expect(entries.map((entry) => entry.target)).toEqual([
      { type: 'focus', floor: 'mobile' },
      { type: 'focus', floor: 'backend' },
      { type: 'focus', floor: 'ext' },
    ]);
    expect(entries[0]?.label).toBe('Enfocar planta mobile');
  });

  test('focused, the floor leaves the list and "Quitar enfoque" appears', () => {
    const entries = focusEntries({ focus: 'mobile' });
    expect(entries.map((entry) => entry.id)).toEqual(['action:focus:backend', 'action:focus:ext', 'action:focusClear']);
    expect(entries.at(-1)?.target).toEqual({ type: 'focus', floor: null });
    expect(entries.at(-1)?.label).toBe('Quitar enfoque');
  });

  test('they do not write, so a replay keeps them', () => {
    expect(focusEntries({ live: false }).length).toBe(3);
  });
});
