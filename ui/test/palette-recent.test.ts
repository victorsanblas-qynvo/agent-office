import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { buildEntries, EMPTY_LIMIT, RECENT_SHOWN, searchEntries, withRecent, type PaletteContext } from '../src/palette/entries';
import { parseRecent, recordRecent, RECENT_MAX } from '../src/palette/recent';
import { agent, doc, floor, order } from './fixtures';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const context = (extra: Partial<PaletteContext> = {}): PaletteContext => ({
  agents: [agent('lead-mobile', { roleKind: 'lead' }), agent('tester-mobile', { roleKind: 'tester' })],
  floors: [floor('mobile')],
  focus: null,
  documents: [doc('plans/login.md', { title: 'Login con huella' })],
  orders: [order('login-huella', { title: 'Login con huella' })],
  tabs: ['Oficina', 'Tabla', 'Tablero'],
  live: true,
  reply: null,
  status: null,
  relaunch: null,
  relaunchAll: 0,
  statusAll: 0,
  messageAll: 0,
  pins: [],
  notes: {},
  newOrder: false,
  mute: false,
  muteSound: false,
  searches: [],
  recent: [],
  ...extra,
});

const ids = (results: { entry: { id: string } }[]): string[] => results.map((result) => result.entry.id);

describe('parseRecent', () => {
  test('keeps the ids, dropping what is not one and the repeats', () => {
    expect(parseRecent(['a', 3, '', 'b', 'a', null])).toEqual(['a', 'b']);
  });

  test('anything but a list is empty', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent({ a: 1 })).toEqual([]);
    expect(parseRecent('a')).toEqual([]);
  });

  test('stops at the limit', () => {
    expect(parseRecent(Array.from({ length: 40 }, (_, index) => `id-${index}`))).toHaveLength(RECENT_MAX);
  });
});

describe('recordRecent', () => {
  test('puts the entry first and moves a repeated one', () => {
    expect(recordRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(recordRecent([], 'a')).toEqual(['a']);
  });

  test('drops the oldest past the limit', () => {
    const full = Array.from({ length: RECENT_MAX }, (_, index) => `id-${index}`);
    const next = recordRecent(full, 'new');
    expect(next).toHaveLength(RECENT_MAX);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`id-${RECENT_MAX - 1}`);
  });

  test('ignores an empty id and leaves the list as it was', () => {
    expect(recordRecent(['a'], '')).toEqual(['a']);
  });
});

describe('entry ids', () => {
  test('every entry has a distinct id that is built from its target, not its position in the list', () => {
    const all = buildEntries(context({ reply: { name: 'x' }, searches: [{ name: 'Bloqueos', filters: { q: 'b', floor: '', agent: '', kind: '', from: '', to: '' } }] }));
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
    const byGroup = (group: string) => all.filter((entry) => entry.group === group).map((entry) => entry.id);
    expect(byGroup('agent')).toEqual(['agent:lead-mobile', 'agent:tester-mobile']);
    expect(byGroup('floor')).toEqual(['floor:mobile']);
    expect(byGroup('plan')).toEqual(['plan:plans/login.md']);
    expect(byGroup('order')).toEqual(['order:login-huella']);
    expect(byGroup('search')).toEqual(['search:Bloqueos']);
    expect(byGroup('action')).toContain('action:reply');
  });
});

describe('withRecent', () => {
  const entries = buildEntries(context());

  test('with no query, the recent ones that still exist lead, newest first, the others are not repeated', () => {
    const out = withRecent(entries, ['agent:tester-mobile', 'agent:gone', 'order:login-huella'], '');
    expect(out.slice(0, 2).map((entry) => entry.id)).toEqual(['agent:tester-mobile', 'order:login-huella']);
    expect(out).toHaveLength(entries.length);
    expect(new Set(out).size).toBe(out.length);
  });

  test('with no query, at most RECENT_SHOWN lead', () => {
    const many = entries.slice(0, 12).map((entry) => entry.id);
    expect(withRecent(entries, many, '').slice(0, RECENT_SHOWN).map((entry) => entry.id)).toEqual(many.slice(0, RECENT_SHOWN));
  });

  test('with a query, the recent ones go ahead of the others and nothing is lost', () => {
    const out = withRecent(entries, ['floor:mobile'], 'mob');
    expect(out[0].id).toBe('floor:mobile');
    expect(out).toHaveLength(entries.length);
  });

  test('without recent ones it is the same list', () => {
    expect(withRecent(entries, [], '')).toEqual(entries);
    expect(withRecent(entries, ['nope'], 'x')).toEqual(entries);
  });
});

describe('searchEntries with recent', () => {
  test('with no query, a Recientes block comes first, flagged, and the rest does not repeat it', () => {
    const entries = buildEntries(context());
    const results = searchEntries(entries, '', ['agent:tester-mobile', 'plan:plans/login.md']);
    expect(ids(results).slice(0, 2)).toEqual(['agent:tester-mobile', 'plan:plans/login.md']);
    expect(results.map((result) => result.recent === true)).toEqual(results.map((_, index) => index < 2));
    expect(new Set(ids(results)).size).toBe(results.length);
  });

  test('with no query and nothing recent, nothing is flagged and the list is capped as before', () => {
    const results = searchEntries(buildEntries(context()), '');
    expect(results.some((result) => result.recent)).toBe(false);
    expect(results.length).toBeLessThanOrEqual(EMPTY_LIMIT);
  });

  test('a recent entry wins a tie of equal scores', () => {
    const entries = buildEntries(context({ orders: [order('uno', { title: 'Cobros' }), order('dos', { id: 2, title: 'Cobros' })] }));
    expect(ids(searchEntries(entries, 'cobros'))[0]).toBe('order:dos');
    expect(ids(searchEntries(entries, 'cobros', ['order:uno']))[0]).toBe('order:uno');
  });

  test('a recent entry never outranks a clearly better match', () => {
    const entries = buildEntries(context());
    expect(ids(searchEntries(entries, 'tester-mobile', ['floor:mobile']))[0]).toBe('agent:tester-mobile');
  });

  test('the clear action only exists with something recent', () => {
    const has = (recent: string[]) => buildEntries(context({ recent })).some((entry) => entry.target.type === 'clearRecent');
    expect(has([])).toBe(false);
    expect(has(['agent:lead-mobile'])).toBe(true);
  });
});
