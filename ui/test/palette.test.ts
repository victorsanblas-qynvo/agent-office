import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { buildEntries, EMPTY_LIMIT, searchEntries, type PaletteContext } from '../src/palette/entries';
import { agent, doc, floor, order } from './fixtures';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const context = (extra: Partial<PaletteContext> = {}): PaletteContext => ({
  agents: [agent('lead-mobile', { roleKind: 'lead' }), agent('tester-mobile', { roleKind: 'tester' })],
  floors: [floor('mobile'), floor('direccion', { kind: 'direccion', label: 'Dirección' })],
  documents: [doc('plans/login.md', { title: 'Login con huella' }), doc('skills/x.md', { kind: 'skill', title: 'Skill X' })],
  orders: [],
  tabs: ['Oficina', 'Tabla', 'Tablero', 'Planes', 'Chat', 'Ajustes'],
  live: true,
  reply: { name: 'lead-mobile' },
  status: { sessionId: 'lead-mobile', name: 'lead-mobile' },
  relaunch: { sessionId: 'lead-mobile', name: 'lead-mobile' },
  relaunchAll: 0,
  statusAll: 0,
  messageAll: 0,
  pins: [],
  newOrder: true,
  focus: null,
  mute: true,
  muteSound: true,
  searches: [],
  ...extra,
});

const ids = (entries: { id: string }[]): string[] => entries.map((entry) => entry.id);

describe('buildEntries', () => {
  test('live, it offers every action, tab, floor, agent and plan', () => {
    const entries = buildEntries(context());
    const actions = entries.filter((entry) => entry.group === 'action').map((entry) => entry.target.type);
    expect(actions).toEqual(['reply', 'status', 'relaunch', 'newOrder', 'focus', 'lang', 'history', 'mute', 'muteSound', 'theme', 'theme', 'theme', 'pin', 'pin']);
    expect(entries.filter((entry) => entry.group === 'tab')).toHaveLength(6);
    expect(entries.filter((entry) => entry.group === 'floor')).toHaveLength(2);
    expect(entries.filter((entry) => entry.group === 'agent')).toHaveLength(2);
    expect(ids(entries.filter((entry) => entry.group === 'plan'))).toEqual(['plan:plans/login.md']);
  });

  test('in a replay, the actions that write are left out and the rest stay', () => {
    const entries = buildEntries(context({ live: false }));
    const actions = entries.filter((entry) => entry.group === 'action').map((entry) => entry.target.type);
    expect(actions).toEqual(['focus', 'lang', 'history', 'mute', 'muteSound', 'theme', 'theme', 'theme']);
    expect(entries.some((entry) => entry.write)).toBe(false);
    expect(entries.filter((entry) => entry.group !== 'action')).toHaveLength(6 + 2 + 2 + 1);
  });

  test('an action with nothing to act on is not offered', () => {
    const entries = buildEntries(context({ reply: null, status: null, relaunch: null, newOrder: false, mute: false, muteSound: false }));
    expect(entries.filter((entry) => entry.group === 'action').map((entry) => entry.target.type)).toEqual(['focus', 'lang', 'history', 'theme', 'theme', 'theme', 'pin', 'pin']);
  });

  test('every agent can be pinned, and a pinned one can be unpinned', () => {
    const entries = buildEntries(context({ pins: ['tester-mobile'] }));
    const pins = entries.filter((entry) => entry.target.type === 'pin');
    expect(pins.map((entry) => [entry.id, entry.label, entry.write])).toEqual([
      ['action:pin:lead-mobile', 'Fijar agente lead-mobile', true],
      ['action:pin:tester-mobile', 'Soltar agente tester-mobile', true],
    ]);
    expect(pins[0].target).toEqual({ type: 'pin', key: 'lead-mobile' });
    applyLang('en');
    expect(buildEntries(context()).find((entry) => entry.id === 'action:pin:lead-mobile')?.label).toBe('Pin agent lead-mobile');
  });

  test('with four pinned, only those can be unpinned; in a replay none is offered', () => {
    const agents = ['a', 'b', 'c', 'd', 'e'].map((key) => agent(key));
    const full = buildEntries(context({ agents, pins: ['a', 'b', 'c', 'd'] })).filter((entry) => entry.target.type === 'pin');
    expect(full.map((entry) => entry.id)).toEqual(['action:pin:a', 'action:pin:b', 'action:pin:c', 'action:pin:d']);
    expect(buildEntries(context({ live: false })).some((entry) => entry.target.type === 'pin')).toBe(false);
  });

  test('relaunch all flagged is offered only with candidates, and only live', () => {
    const find = (extra: Partial<PaletteContext>) => buildEntries(context(extra)).find((entry) => entry.target.type === 'relaunchAll');
    expect(find({ relaunchAll: 0 })).toBeUndefined();
    expect(find({ relaunchAll: 3 })).toMatchObject({ id: 'action:relaunchAll', label: 'Relanzar los marcados', hint: '3 sesiones', write: true });
    expect(find({ relaunchAll: 1 })?.hint).toBe('1 sesión');
    expect(find({ relaunchAll: 3, live: false })).toBeUndefined();
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

describe('order entries', () => {
  const orderIds = (extra: Partial<PaletteContext>) => ids(buildEntries(context(extra)).filter((entry) => entry.group === 'order'));

  test('each order is listed with its title, floor, status and slug', () => {
    const entries = buildEntries(context({ orders: [order('login-huella', { title: 'Login con huella', status: 'revision' })] }));
    const found = entries.find((entry) => entry.group === 'order');
    expect(found).toMatchObject({
      id: 'order:login-huella',
      label: 'Login con huella',
      hint: 'mobile · Revisión · login-huella',
      target: { type: 'order', slug: 'login-huella', floor: 'mobile' },
      write: false,
    });
  });

  test('without orders there are no entries of the group', () => {
    expect(orderIds({ orders: [] })).toEqual([]);
  });

  test('the open ones come first by last activity, then the finished ones', () => {
    const orders = [
      order('old-done', { id: 1, status: 'hecho', updatedAt: 9000 }),
      order('quiet', { id: 2, status: 'pendiente', updatedAt: 1000 }),
      order('busy', { id: 3, status: 'en-curso', updatedAt: 1000, lastActivity: 5000 }),
      order('dropped', { id: 4, status: 'descartado', updatedAt: 8000 }),
    ];
    expect(orderIds({ orders })).toEqual(['order:busy', 'order:quiet', 'order:old-done', 'order:dropped']);
  });

  test('with no query only the first entries are shown, the newest orders among them', () => {
    const orders = Array.from({ length: 60 }, (_, index) => order(`o-${index}`, { id: index + 1, updatedAt: index }));
    const shown = searchEntries(buildEntries(context({ orders })), '').map((result) => result.entry.id);
    expect(shown).toHaveLength(EMPTY_LIMIT);
    expect(shown).not.toContain('order:o-0');
  });

  test('the 60th oldest order is still found by its slug', () => {
    const orders = Array.from({ length: 60 }, (_, index) => order(`o-${index}-zeta`, { id: index + 1, updatedAt: index }));
    expect(orderIds({ orders })).toHaveLength(60);
    expect(searchEntries(buildEntries(context({ orders })), 'o-0-zeta')[0].entry.id).toBe('order:o-0-zeta');
  });

  test('fuzzy search finds an order by slug and by branch', () => {
    const entries = buildEntries(context({ orders: [order('pago-tarjeta', { title: 'Cobros', branch: 'office/qr-checkout' }), order('otro', { id: 2 })] }));
    expect(searchEntries(entries, 'pagotarj')[0].entry.id).toBe('order:pago-tarjeta');
    expect(searchEntries(entries, 'qr-checkout')[0].entry.id).toBe('order:pago-tarjeta');
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
