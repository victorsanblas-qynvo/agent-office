import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BOARD_MAX_LINES, boardData, boardSignature, type BoardInput } from '../src/boards';
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
  byPlan: [],
};

const input = (extra: Partial<BoardInput> = {}): BoardInput => ({
  floor: floor('mobile'),
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
    expect(lines.lines.slice(4).map((line) => line.text)).toEqual(['mobile · 90,0 K', 'backend · 30,0 K']);
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
