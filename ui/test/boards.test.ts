import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BOARD_MAX_LINES, boardData, floorScores, boardSignature, type BoardInput } from '../src/boards';
import { applyLang } from '../src/i18n/index';
import type { UsageSummary } from '../src/types';
import { agent, doc, floor, order } from './fixtures';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const NOW = 1_000_000;
const tokens = (input: number) => ({ turns: 4, input, cacheRead: 0, cacheCreate: 0, output: 0 });

const today: UsageSummary = {
  range: 'today',
  from: '2026-10-17',
  to: '2026-10-17',
  total: { tokens: tokens(120_000), agents: 3 },
  byRole: [],
  byModel: [],
  byFloor: [
    { key: 'mobile', tokens: tokens(90_000), agents: 2 },
    { key: 'backend', tokens: tokens(30_000), agents: 1 },
  ],
  byDay: [],
  byPlan: [],
};

const input = (extra: Partial<BoardInput> = {}): BoardInput => ({
  floor: floor('mobile'),
  floors: [],
  everyone: [],
  orders: [],
  documents: [],
  usage: null,
  today: null,
  now: NOW,
  stateOf: (a) => a.state,
  ...extra,
});

const texts = (extra: Partial<BoardInput>): string[] => boardData(input(extra)).lines.map((line) => line.text);

describe('boardData by floor kind', () => {
  test('direction: spend of today, the two limits and the busiest floors', () => {
    const lines = boardData(
      input({
        floor: floor('direccion', { kind: 'direccion', label: 'Dirección' }),
        everyone: [agent('a'), agent('b', { state: 'idle' })],
        today,
        usage: { fiveHour: { usedPct: 93, resetsAt: NOW + 3_600_000 }, sevenDay: { usedPct: 40, resetsAt: NOW + 86_400_000 }, at: NOW },
      }),
    );
    expect(lines.title).toBe('Dirección');
    expect(lines.tab).toBe('table');
    expect(lines.lines[0].text).toBe('Hoy: 120 K');
    expect(lines.lines[1]).toMatchObject({ tone: 'danger', bar: 93 });
    expect(lines.lines[1].text).toContain('93 %');
    expect(lines.lines[2]).toMatchObject({ tone: 'ok', bar: 40 });
    expect(lines.lines[3].text).toBe('1 de 2 trabajando');
    expect(lines.lines).toHaveLength(4);
  });

  test('direction without the spend of today shows a dash, as in a replay', () => {
    const data = boardData(input({ floor: floor('direccion', { kind: 'direccion' }), today: null }));
    expect(data.lines[0]).toMatchObject({ text: 'Hoy: —', tone: 'muted' });
    expect(data.lines[1].text).toBe('5 h —');
    expect(data.lines).toHaveLength(4);
  });

  test('a limit that already reset counts as no data', () => {
    const data = boardData(input({ floor: floor('direccion', { kind: 'direccion' }), usage: { fiveHour: { usedPct: 50, resetsAt: NOW - 1 }, sevenDay: null, at: NOW } }));
    expect(data.lines[1].text).toBe('5 h —');
  });

  test('a floor: the lead task, then its agents with their state, then the active card', () => {
    const data = boardData(
      input({
        everyone: [
          agent('lead-mobile', { roleKind: 'lead', task: 'Login con huella' }),
          agent('dev-1', { state: 'blocked' }),
          agent('other', { floor: 'backend' }),
          agent('home', { away: true }),
        ],
        orders: [order('o1', { title: 'Huella' })],
      }),
    );
    expect(data.lines.map((line) => line.text)).toEqual(['Encargo: Login con huella', 'lead-mobile · Trabajando', 'dev-1 · Bloqueado', 'Tarjeta: Huella']);
    expect(data.lines[2].tone).toBe('danger');
    expect(data.lines[1].dot).toBeDefined();
    expect(data.tab).toBe('board');
  });

  test('a floor with many agents keeps within the lines and counts the rest', () => {
    const everyone = Array.from({ length: 9 }, (_, index) => agent(`dev-${index}`));
    const data = boardData(input({ everyone, orders: [order('o1')] }));
    expect(data.lines.length).toBeLessThanOrEqual(BOARD_MAX_LINES);
    expect(data.lines.some((line) => line.text === '+5 más')).toBe(true);
  });

  test('an empty floor says so and links to the Tabla when it has no card', () => {
    const data = boardData(input());
    expect(data.lines.map((line) => line.text)).toEqual(['Encargo: —', 'Nadie en la planta.']);
    expect(data.tab).toBe('table');
  });

  test('drafting: plans by state and the three latest, linking to Planes', () => {
    const data = boardData(
      input({
        floor: floor('redaccion', { kind: 'redaccion' }),
        documents: [
          doc('a.md', { title: 'A', status: 'entregado', updatedAt: 4 }),
          doc('b.md', { title: 'B', status: 'ejecutando', updatedAt: 3 }),
          doc('c.md', { title: 'C', status: 'borrador', updatedAt: 2 }),
          doc('d.md', { title: 'D', status: 'revision', updatedAt: 1 }),
          doc('e.md', { title: 'E', status: 'cerrado', updatedAt: 9 }),
          doc('s.md', { kind: 'skill', title: 'S' }),
        ],
      }),
    );
    expect(data.tab).toBe('plans');
    expect(data.lines.map((line) => line.text)).toEqual([
      '1 plan por decidir',
      '1 plan en ejecución',
      '2 planes en redacción',
      'A · Pendiente de decisión',
      'B · En ejecución',
      'C · Borrador',
    ]);
  });

  test('drafting with no plans', () => {
    expect(texts({ floor: floor('redaccion', { kind: 'redaccion' }) })).toEqual(['Sin planes.']);
  });

  test('maintenance: skills of the workshop', () => {
    const data = boardData(
      input({
        floor: floor('mantenimiento', { kind: 'mantenimiento' }),
        documents: [doc('a.md', { kind: 'skill', title: 'Skill A', status: 'aprobado' }), doc('b.md', { kind: 'skill', title: 'Skill B', status: 'borrador' }), doc('p.md')],
      }),
    );
    expect(data.lines.slice(0, 2).map((line) => line.text)).toEqual(['2 skills en el taller', '1 aprobada']);
    expect(data.lines).toHaveLength(4);
    expect(data.tab).toBe('table');
  });

  test('every board stays within the line budget', () => {
    const everyone = Array.from({ length: 20 }, (_, index) => agent(`a-${index}`));
    const documents = Array.from({ length: 20 }, (_, index) => doc(`p${index}.md`, { updatedAt: index }));
    for (const kind of ['direccion', 'managed', 'observed', 'redaccion', 'mantenimiento'] as const) {
      const data = boardData(input({ floor: floor('x', { kind }), everyone, documents, today, orders: [order('o')] }));
      expect(data.lines.length).toBeLessThanOrEqual(BOARD_MAX_LINES);
    }
  });
});

describe('boardSignature', () => {
  test('is the same for the same data and moves with what the board says', () => {
    const base = () => input({ everyone: [agent('dev-1')] });
    expect(boardSignature(boardData(base()))).toBe(boardSignature(boardData(base())));
    const changed = input({ everyone: [agent('dev-1', { state: 'testing' })] });
    expect(boardSignature(boardData(changed))).not.toBe(boardSignature(boardData(base())));
  });

  test('does not move with what the board does not show', () => {
    const a = boardData(input({ everyone: [agent('dev-1', { updatedAt: 1 })], now: NOW }));
    const b = boardData(input({ everyone: [agent('dev-1', { updatedAt: 99 })], now: NOW + 5000 }));
    expect(boardSignature(a)).toBe(boardSignature(b));
  });

  test('moves with the language', () => {
    const es = boardSignature(boardData(input({ everyone: [agent('dev-1')] })));
    applyLang('en');
    expect(boardSignature(boardData(input({ everyone: [agent('dev-1')] })))).not.toBe(es);
  });
});

const failing = { status: 'failed' as const, passed: 1, total: 3 };
const checked = (slug: string, floorSlug: string, extra: Parameters<typeof order>[1] = {}) => order(slug, { floor: floorSlug, ...extra });

describe('floorScores', () => {
  const floors = [floor('mobile'), floor('backend'), floor('seen', { kind: 'observed' }), floor('direccion', { kind: 'direccion' })];

  test('counts open orders, red checks, blocked and working agents per managed floor', () => {
    const scores = floorScores(
      floors,
      [agent('a', { floor: 'mobile', state: 'working' }), agent('b', { floor: 'mobile', state: 'blocked' }), agent('c', { floor: 'mobile', state: 'idle' }), agent('d', { floor: 'backend', state: 'working' })],
      [
        checked('o1', 'mobile', { checks: { ...failing } as never }),
        checked('o2', 'mobile', { status: 'pendiente' }),
        checked('o3', 'mobile', { status: 'hecho', checks: { ...failing } as never }),
        checked('o4', 'mobile', { status: 'descartado' }),
      ],
      (a) => a.state,
    );
    expect(scores.map(({ slug, open, red, blocked, working }) => ({ slug, open, red, blocked, working }))).toEqual([
      { slug: 'mobile', open: 2, red: 1, blocked: 1, working: 1 },
      { slug: 'backend', open: 0, red: 0, blocked: 0, working: 1 },
    ]);
  });

  test('skips observed floors', () => {
    expect(floorScores(floors, [agent('x', { floor: 'seen' })], [checked('o', 'seen')], (a) => a.state).map((s) => s.slug)).not.toContain('seen');
  });

  test('red or blocked first, then open orders, then name', () => {
    const list = [floor('a'), floor('b'), floor('c'), floor('d')];
    const scores = floorScores(
      list,
      [agent('x', { floor: 'd', state: 'blocked' })],
      [checked('1', 'a'), checked('2', 'b'), checked('3', 'b'), checked('4', 'c', { checks: { ...failing } as never })],
      (a) => a.state,
    );
    expect(scores.map((s) => s.slug)).toEqual(['c', 'd', 'b', 'a']);
  });
});

describe('direction scoreboard rows', () => {
  const direction = floor('direccion', { kind: 'direccion', label: 'Dirección' });
  const rows = (extra: Partial<BoardInput>): string[] => boardData(input({ floor: direction, ...extra })).lines.slice(4).map((line) => line.text);

  test('omits zero parts and says al día when nothing is open', () => {
    expect(
      rows({
        floors: [floor('mobile'), floor('backend')],
        everyone: [agent('a', { floor: 'mobile', state: 'working' }), agent('b', { floor: 'mobile', state: 'blocked' })],
        orders: [checked('1', 'mobile', { checks: { ...failing } as never }), checked('2', 'mobile'), checked('3', 'mobile', { status: 'revision' })],
      }),
    ).toEqual(['mobile  3 enc · 1 rojo · 1 bloq · 1 trab', 'backend  al día']);
  });

  test('truncates to the line budget with +N plantas', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug) => floor(slug));
    const lines = boardData(input({ floor: direction, floors: many })).lines;
    expect(lines).toHaveLength(BOARD_MAX_LINES);
    expect(lines.at(-1)?.text).toBe('+3 plantas');
    expect(lines.slice(4, -1).map((line) => line.text)).toEqual(['a  al día', 'b  al día', 'c  al día']);
  });

  test('exactly the room left shows every floor without a +N line', () => {
    const four = ['a', 'b', 'c', 'd'].map((slug) => floor(slug));
    expect(rows({ floors: four })).toHaveLength(4);
    expect(rows({ floors: four }).some((text) => text.startsWith('+'))).toBe(false);
  });
});
