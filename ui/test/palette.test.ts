import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { buildEntries, EMPTY_LIMIT, searchEntries, type PaletteContext } from '../src/palette/entries';
import { agent, doc, floor } from './fixtures';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const context = (extra: Partial<PaletteContext> = {}): PaletteContext => ({
  agents: [agent('lead-mobile', { roleKind: 'lead' }), agent('tester-mobile', { roleKind: 'tester' })],
  floors: [floor('mobile'), floor('direccion', { kind: 'direccion', label: 'Dirección' })],
  documents: [doc('plans/login.md', { title: 'Login con huella' }), doc('skills/x.md', { kind: 'skill', title: 'Skill X' })],
  tabs: ['Oficina', 'Tabla', 'Tablero', 'Planes', 'Chat', 'Ajustes'],
  live: true,
  reply: { name: 'lead-mobile' },
  status: { sessionId: 'lead-mobile', name: 'lead-mobile' },
  relaunch: { sessionId: 'lead-mobile', name: 'lead-mobile' },
  newOrder: true,
  mute: true,
  muteSound: true,
  ...extra,
});

const ids = (entries: { id: string }[]): string[] => entries.map((entry) => entry.id);

describe('buildEntries', () => {
  test('live, it offers every action, tab, floor, agent and plan', () => {
    const entries = buildEntries(context());
    const actions = entries.filter((entry) => entry.group === 'action').map((entry) => entry.target.type);
    expect(actions).toEqual(['reply', 'status', 'relaunch', 'newOrder', 'lang', 'history', 'mute', 'muteSound']);
    expect(entries.filter((entry) => entry.group === 'tab')).toHaveLength(6);
    expect(entries.filter((entry) => entry.group === 'floor')).toHaveLength(2);
    expect(entries.filter((entry) => entry.group === 'agent')).toHaveLength(2);
    expect(ids(entries.filter((entry) => entry.group === 'plan'))).toEqual(['plan:plans/login.md']);
  });

  test('in a replay, the actions that write are left out and the rest stay', () => {
    const entries = buildEntries(context({ live: false }));
    const actions = entries.filter((entry) => entry.group === 'action').map((entry) => entry.target.type);
    expect(actions).toEqual(['lang', 'history', 'mute', 'muteSound']);
    expect(entries.some((entry) => entry.write)).toBe(false);
    expect(entries.filter((entry) => entry.group !== 'action')).toHaveLength(6 + 2 + 2 + 1);
  });

  test('an action with nothing to act on is not offered', () => {
    const entries = buildEntries(context({ reply: null, status: null, relaunch: null, newOrder: false, mute: false, muteSound: false }));
    expect(entries.filter((entry) => entry.group === 'action').map((entry) => entry.target.type)).toEqual(['lang', 'history']);
  });

  test('the language action names the other language', () => {
    const labelOf = () => buildEntries(context()).find((entry) => entry.target.type === 'lang')?.label;
    expect(labelOf()).toBe('Cambiar idioma a English');
    applyLang('en');
    expect(labelOf()).toBe('Switch language to Spanish');
  });

  test('the actions name their agent and the tabs their number', () => {
    const entries = buildEntries(context());
    expect(entries.find((entry) => entry.id === 'action:reply')?.label).toBe('Responder a lead-mobile');
    expect(entries.find((entry) => entry.id === 'tab:2')).toMatchObject({ label: 'Tablero', hint: '3' });
  });
});

describe('searchEntries', () => {
  const entries = buildEntries(context());

  test('with no query, the first entries in order, capped', () => {
    const results = searchEntries(entries, '');
    expect(results[0].entry.group).toBe('action');
    expect(results.length).toBeLessThanOrEqual(EMPTY_LIMIT);
    expect(results.every((result) => result.indices.length === 0)).toBe(true);
  });

  test('finds an agent by a few letters and marks them', () => {
    const [first] = searchEntries(entries, 'tstm');
    expect(first.entry.id).toBe('agent:tester-mobile');
    expect(first.indices).toEqual([0, 2, 3, 7]);
  });

  test('finds a floor and a tab through accents', () => {
    expect(searchEntries(entries, 'direccion')[0].entry.id).toBe('floor:direccion');
    expect(searchEntries(entries, 'tablero')[0].entry.id).toBe('tab:2');
  });

  test('finds a plan by its title and an action by its verb', () => {
    expect(searchEntries(entries, 'huella')[0].entry.id).toBe('plan:plans/login.md');
    expect(searchEntries(entries, 'relanz')[0].entry.id).toBe('action:relaunch');
    expect(searchEntries(entries, 'nuevo enc')[0].entry.id).toBe('action:newOrder');
  });

  test('the letters marked are only the ones of the name, not of the hint', () => {
    const [first] = searchEntries(entries, 'lead');
    expect(first.entry.label).toBe('lead-mobile');
    expect(first.indices.every((index) => index < first.entry.label.length)).toBe(true);
  });

  test('in a replay, a write action cannot be reached even by its exact name', () => {
    const replay = buildEntries(context({ live: false }));
    expect(searchEntries(replay, 'relanzar').some((result) => result.entry.target.type === 'relaunch')).toBe(false);
    expect(searchEntries(replay, 'nuevo encargo').some((result) => result.entry.target.type === 'newOrder')).toBe(false);
    expect(searchEntries(replay, 'historial')[0].entry.target.type).toBe('history');
  });

  test('nothing fits an impossible query', () => {
    expect(searchEntries(entries, 'zzzzq')).toEqual([]);
  });
});
