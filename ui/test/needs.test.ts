import { describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { clockMinutes } from '../src/time';
import { collectNeeds, NeedCursor, needLabel, needToast, type Need, type NeedSources } from '../src/needs';
import type { UsageForecast, UsageView, UsageWindow } from '../src/types';
import { agent, doc, order, question } from './fixtures';

applyLang('es');

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

function sources(extra: Partial<NeedSources> & { agents?: ReturnType<typeof agent>[] } = {}): NeedSources {
  return { agents: [], questions: [], documents: [], orders: [], usage: null, now: NOW, stateOf: (a) => a.state, ...extra };
}

const kinds = (needs: Need[]): string[] => needs.map((need) => `${need.kind}:${need.agentKey ?? need.docPath ?? need.orderSlug}`);

describe('collectNeeds', () => {
  test('orders by urgency: permission, question, blocked, stalled, plan, checks', () => {
    const agents = [
      agent('stalled', { stalledSince: 10 }),
      agent('blocked', { state: 'blocked', stateSince: 20 }),
      agent('asker'),
      agent('permit'),
    ];
    const needs = collectNeeds(
      sources({
        agents,
        questions: [question('q1', 'asker', 30), question('q2', 'permit', 40, { kind: 'permission' })],
        documents: [doc('plans/a.md')],
        orders: [order('o1', { checks: { status: 'passed', passed: 1, total: 1, sha: 'abc', touched: ['package.json'], forced: false } })],
      }),
    );
    expect(kinds(needs)).toEqual(['permission:permit', 'question:asker', 'blocked:blocked', 'stalled:stalled', 'plan:plans/a.md', 'checks:o1']);
  });

  test('an agent counts once, under its most urgent kind', () => {
    const busy = agent('busy', { state: 'blocked', stalledSince: 5 });
    const needs = collectNeeds(sources({ agents: [busy], questions: [question('q', 'busy', 50), question('p', 'busy', 90, { kind: 'permission' })] }));
    expect(kinds(needs)).toEqual(['permission:busy']);
    expect(needs[0].since).toBe(90);
  });

  test('the oldest comes first inside a kind, and two questions of one agent keep the older', () => {
    const needs = collectNeeds(
      sources({
        agents: [agent('a'), agent('b')],
        questions: [question('q1', 'b', 200), question('q2', 'a', 300), question('q3', 'a', 100)],
      }),
    );
    expect(needs.map((need) => [need.agentKey, need.since])).toEqual([
      ['a', 100],
      ['b', 200],
    ]);
  });

  test('agents that went home do not count, with or without a question', () => {
    const needs = collectNeeds(
      sources({
        agents: [agent('home', { away: true, stalledSince: 1 }), agent('gone', { endedAt: 5, state: 'blocked' }), agent('here')],
        questions: [question('q', 'home', 10), question('r', 'here', 20)],
      }),
    );
    expect(kinds(needs)).toEqual(['question:here']);
  });

  test('a question of an agent the store does not know still counts, named by its key', () => {
    const needs = collectNeeds(sources({ questions: [question('q', 'abcdef123456', 10)] }));
    expect(needs).toHaveLength(1);
    expect(needs[0].name).toBe('abcdef12');
  });

  test('uses the shown state for blocked', () => {
    const lead = agent('lead', { state: 'blocked' });
    expect(collectNeeds(sources({ agents: [lead], stateOf: () => 'working' }))).toEqual([]);
    expect(kinds(collectNeeds(sources({ agents: [lead], stateOf: () => 'blocked' })))).toEqual(['blocked:lead']);
  });

  test('only delivered plans and orders with unconfirmed check changes wait', () => {
    const touched = { status: 'passed' as const, passed: 1, total: 1, sha: 'a', touched: ['scripts'] };
    const needs = collectNeeds(
      sources({
        documents: [doc('p1.md'), doc('p2.md', { status: 'aparcado' }), doc('s.md', { kind: 'skill' })],
        orders: [
          order('open', { checks: { ...touched, forced: false } }),
          order('confirmed', { checks: { ...touched, forced: true } }),
          order('clean', { checks: { ...touched, touched: [], forced: false } }),
          order('done', { status: 'hecho', checks: { ...touched, forced: false } }),
          order('none'),
        ],
      }),
    );
    expect(kinds(needs)).toEqual(['plan:p1.md', 'checks:open']);
  });

  test('labels and toast name the kind and the thing', () => {
    const [need] = collectNeeds(sources({ agents: [agent('lead-mobile')], questions: [question('q', 'lead-mobile', 1, { kind: 'permission' })] }));
    expect(needLabel(need)).toBe('Permiso de lead-mobile');
    expect(needToast(2, 5, need)).toBe('2/5 · Permiso de lead-mobile');
  });
});

describe('usage limits', () => {
  const unsafe = (exhaustsAt: number): UsageForecast => ({ rate: 12, exhaustsAt, safe: false, basis: 'fit' });
  const win = (usedPct: number, resetsAt: number, forecast?: UsageForecast): UsageWindow => ({ usedPct, resetsAt, ...(forecast ? { forecast } : {}) });
  const usage = (fiveHour: UsageWindow | null, sevenDay: UsageWindow | null = null): UsageView => ({ fiveHour, sevenDay, at: NOW });
  const limits = (view: UsageView, extra: Parameters<typeof sources>[0] = {}): Need[] => collectNeeds(sources({ usage: view, ...extra }));

  test('a safe or thin forecast below 90 % adds nothing', () => {
    expect(limits(usage(win(50, NOW + 2 * HOUR, { rate: 1, exhaustsAt: null, safe: true, basis: 'fit' })))).toEqual([]);
    expect(limits(usage(win(50, NOW + 2 * HOUR, { ...unsafe(NOW + HOUR), basis: 'thin' })))).toEqual([]);
    expect(limits(usage(win(50, NOW + 2 * HOUR)))).toEqual([]);
  });

  test('an unsafe forecast that runs out before the reset adds one, naming the window and the time', () => {
    const needs = limits(usage(win(60, NOW + 3 * HOUR, unsafe(NOW + HOUR))));
    expect(needs.map((need) => need.id)).toEqual(['limit:five']);
    expect(needLabel(needs[0])).toBe(`Límite de uso: 5 h, se agota ~${clockMinutes(NOW + HOUR)}`);
  });

  test('90 % or more adds one whatever the forecast says', () => {
    const needs = limits(usage(null, win(93, NOW + 5 * HOUR, { rate: 1, exhaustsAt: null, safe: true, basis: 'fit' })));
    expect(needs.map((need) => need.id)).toEqual(['limit:seven']);
    expect(needLabel(needs[0])).toBe('Límite de uso: Semana al 93 %');
    expect(limits(usage(win(89, NOW + HOUR)))).toEqual([]);
  });

  test('a run-out at or after the reset adds nothing, and a window already reset is ignored', () => {
    expect(limits(usage(win(60, NOW + HOUR, unsafe(NOW + HOUR))))).toEqual([]);
    expect(limits(usage(win(60, NOW + HOUR, unsafe(NOW + 2 * HOUR))))).toEqual([]);
    expect(limits(usage(win(95, NOW - 1)))).toEqual([]);
  });

  test('goes last, unless it runs out within 30 minutes: then right after the permissions', () => {
    const base = {
      agents: [agent('permit'), agent('asker')],
      questions: [question('p', 'permit', 40, { kind: 'permission' }), question('q', 'asker', 30)],
      documents: [doc('plans/a.md')],
    };
    expect(kinds(limits(usage(win(60, NOW + 3 * HOUR, unsafe(NOW + HOUR))), base))).toEqual(['permission:permit', 'question:asker', 'plan:plans/a.md', 'limit:null']);
    expect(kinds(limits(usage(win(60, NOW + 3 * HOUR, unsafe(NOW + 29 * 60_000))), base))).toEqual(['permission:permit', 'limit:null', 'question:asker', 'plan:plans/a.md']);
  });

  test('both windows at once give two entries', () => {
    const needs = limits(usage(win(60, NOW + 3 * HOUR, unsafe(NOW + HOUR)), win(91, NOW + 24 * HOUR)));
    expect(needs.map((need) => need.id).sort()).toEqual(['limit:five', 'limit:seven']);
  });
});

describe('NeedCursor', () => {
  const list = (...ids: string[]): Need[] =>
    ids.map((id) => ({ id, kind: 'question', since: 0, name: id, agentKey: id, floor: null, docPath: null, orderSlug: null }));

  test('walks forward and wraps around', () => {
    const cursor = new NeedCursor();
    const needs = list('a', 'b', 'c');
    expect([1, 1, 1, 1].map(() => cursor.step(needs, 1)?.need.id)).toEqual(['a', 'b', 'c', 'a']);
  });

  test('walks backward from the last and wraps around', () => {
    const cursor = new NeedCursor();
    const needs = list('a', 'b', 'c');
    expect([-1, -1, -1, -1].map(() => cursor.step(needs, -1)?.need.id)).toEqual(['c', 'b', 'a', 'c']);
  });

  test('reports position and total', () => {
    const cursor = new NeedCursor();
    const step = cursor.step(list('a', 'b'), 1);
    expect([step?.position, step?.total]).toEqual([1, 2]);
  });

  test('starts over when the need it stood on is gone', () => {
    const cursor = new NeedCursor();
    cursor.step(list('a', 'b', 'c'), 1);
    cursor.step(list('a', 'b', 'c'), 1);
    expect(cursor.step(list('x', 'y'), 1)?.need.id).toBe('x');
    cursor.step(list('x', 'y'), 1);
    expect(cursor.step(list('z', 'w'), -1)?.need.id).toBe('w');
  });

  test('an empty queue gives nothing and resets the cursor', () => {
    const cursor = new NeedCursor();
    cursor.step(list('a', 'b'), 1);
    expect(cursor.step([], 1)).toBeNull();
    expect(cursor.step(list('a', 'b'), 1)?.need.id).toBe('a');
  });

  test('reset sends it back to the first', () => {
    const cursor = new NeedCursor();
    cursor.step(list('a', 'b'), 1);
    cursor.reset();
    expect(cursor.step(list('a', 'b'), 1)?.need.id).toBe('a');
  });
});
