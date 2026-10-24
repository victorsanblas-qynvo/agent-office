import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { buildEntries, type PaletteContext } from '../src/palette/entries';
import { applySaved, EMPTY_FILTERS, parseSaved, SAVED_MAX, SAVED_NAME_MAX, upsertSaved, type SavedSearch } from '../src/table/history';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const saved = (name: string, q = ''): SavedSearch => ({ name, filters: { ...EMPTY_FILTERS, q } });

describe('parseSaved', () => {
  test('keeps valid entries and fills missing fields', () => {
    expect(parseSaved([{ name: ' Bloqueos ', filters: { q: 'bloqueado', kind: 'chat', floor: 'mobile' } }])).toEqual([
      { name: 'Bloqueos', filters: { ...EMPTY_FILTERS, q: 'bloqueado', kind: 'chat', floor: 'mobile' } },
    ]);
  });

  test('drops what is not a saved search', () => {
    expect(parseSaved('x')).toEqual([]);
    expect(parseSaved(null)).toEqual([]);
    const raw = [null, 3, { name: 4, filters: {} }, { name: '', filters: {} }, { name: 'a'.repeat(SAVED_NAME_MAX + 1), filters: {} }, { name: 'sin filtros' }, { name: 'ok', filters: {} }];
    expect(parseSaved(raw).map((item) => item.name)).toEqual(['ok']);
  });

  test('cleans a bad kind or date and a repeated name', () => {
    const [first, ...rest] = parseSaved([
      { name: 'x', filters: { kind: 'otra', from: '2026-02-31', to: '2026-10-02' } },
      { name: 'x', filters: { q: 'repetida' } },
    ]);
    expect(first?.filters).toEqual({ ...EMPTY_FILTERS, to: '2026-10-02' });
    expect(rest).toEqual([]);
  });

  test('keeps at most 20', () => {
    const raw = Array.from({ length: 30 }, (_, index) => ({ name: `n${index}`, filters: {} }));
    expect(parseSaved(raw)).toHaveLength(SAVED_MAX);
  });
});

describe('upsertSaved', () => {
  test('adds a new name at the end and trims it', () => {
    expect(upsertSaved([saved('a')], '  b ', { ...EMPTY_FILTERS, q: 'x' }).map((item) => item.name)).toEqual(['a', 'b']);
  });

  test('replaces the filters of an existing name in place', () => {
    const next = upsertSaved([saved('a', '1'), saved('b')], 'a', { ...EMPTY_FILTERS, q: '2' });
    expect(next.map((item) => item.name)).toEqual(['a', 'b']);
    expect(next[0]?.filters.q).toBe('2');
  });

  test('refuses an empty or too long name and a new one when full', () => {
    const list = Array.from({ length: SAVED_MAX }, (_, index) => saved(`n${index}`));
    expect(upsertSaved([saved('a')], '   ', EMPTY_FILTERS)).toHaveLength(1);
    expect(upsertSaved([saved('a')], 'a'.repeat(SAVED_NAME_MAX + 1), EMPTY_FILTERS)).toHaveLength(1);
    expect(upsertSaved(list, 'nuevo', EMPTY_FILTERS)).toHaveLength(SAVED_MAX);
    expect(upsertSaved(list, 'n3', { ...EMPTY_FILTERS, q: 'z' })[3]?.filters.q).toBe('z');
  });
});

describe('applySaved', () => {
  test('puts the saved filters on the form', () => {
    const current = { ...EMPTY_FILTERS, q: 'viejo', agent: 'dev-1' };
    const search: SavedSearch = { name: 's', filters: { ...EMPTY_FILTERS, q: 'nuevo', kind: 'message', from: '2026-10-01' } };
    expect(applySaved(current, search)).toEqual({ q: 'nuevo', floor: '', agent: '', kind: 'message', from: '2026-10-01', to: '' });
  });
});

describe('palette entries for saved searches', () => {
  const context = (extra: Partial<PaletteContext>): PaletteContext => ({
    agents: [],
    floors: [],
    documents: [],
    orders: [],
    tabs: [],
    live: true,
    statusAll: 0,
    messageAll: 0,
    reply: null,
    status: null,
    relaunch: null,
    relaunchAll: 0,
    pins: [],
    notes: {},
    newOrder: false,
    focus: null,
    mute: false,
    muteSound: false,
    searches: [saved('Bloqueos', 'bloqueado')],
    recent: [],
    ...extra,
  });

  test('each one is offered as «Buscar: name»', () => {
    const entry = buildEntries(context({})).find((item) => item.group === 'search');
    expect(entry?.label).toBe('Buscar: Bloqueos');
    expect(entry?.target).toEqual({ type: 'search', name: 'Bloqueos' });
  });

  test('in a replay, which has no history, none is offered', () => {
    expect(buildEntries(context({ live: false })).some((item) => item.group === 'search')).toBe(false);
  });
});
