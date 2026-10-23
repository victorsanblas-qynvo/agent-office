import { describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { clockMinutes } from '../src/time';
import { activeNeeds, canSnooze, collectNeeds, loadSnoozes, menuStart, menuStep, NEEDS_TOPICS, needSignature, pruneSnoozes, saveSnoozes, shouldPersistSnoozes, shouldPruneSnoozes, snoozedNeeds, snoozeNeed, triggerSignature, wakeNeed, NeedCursor, needLabel, needToast, type Need, type NeedSources } from '../src/needs';
import { SNOOZE_KEY, type Snoozes } from '../src/prefs';
import type { Collision } from '../src/chat/claims';
import type { UsageForecast, UsageView, UsageWindow } from '../src/types';
import { agent, doc, order, question } from './fixtures';

applyLang('es');

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

function sources(extra: Partial<NeedSources> & { agents?: ReturnType<typeof agent>[] } = {}): NeedSources {
  return { agents: [], questions: [], documents: [], orders: [], usage: null, claims: [], now: NOW, hungAfterMinutes: 10, stateOf: (a) => a.state, ...extra };
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

  test('the queue watches usage, chat and the tick', () => {
    for (const topic of ['agents', 'questions', 'documents', 'orders', 'usage', 'chat', 'lang', 'tick'] as const) expect(NEEDS_TOPICS).toContain(topic);
  });

  test('a forecast already in the past reads as out, with no clock time', () => {
    const needs = limits(usage(win(60, NOW + 3 * HOUR, unsafe(NOW - 20 * 60_000))));
    expect(needLabel(needs[0])).toBe('Límite de uso: 5 h agotado');
    expect(needLabel(needs[0])).not.toContain(clockMinutes(NOW - 20 * 60_000));
    expect(needs[0].imminent).toBe(true);
  });

  test('a window at 100 % is out and imminent', () => {
    const needs = limits(usage(win(100, NOW + 3 * HOUR)));
    expect(needLabel(needs[0])).toBe('Límite de uso: 5 h agotado');
    expect(needs[0].imminent).toBe(true);
  });

  test('a sample over ten minutes old keeps only the 90 % rule', () => {
    const old = (window: UsageWindow): UsageView => ({ fiveHour: window, sevenDay: null, at: NOW - 2 * HOUR });
    expect(limits(old(win(60, NOW + 3 * HOUR, unsafe(NOW + HOUR))))).toEqual([]);
    const needs = limits(old(win(95, NOW + 3 * HOUR, unsafe(NOW + HOUR))));
    expect(needLabel(needs[0])).toBe('Límite de uso: 5 h al 95 %');
    expect(needs[0].imminent).toBeUndefined();
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

describe('hung tools', () => {
  const MIN = 60_000;
  const busy = (extra: Partial<ReturnType<typeof agent>> = {}) => agent('lead', { tool: 'Bash', detail: 'bun test', updatedAt: NOW - 12 * MIN, ...extra });

  test('below the threshold nothing is flagged', () => {
    expect(collectNeeds(sources({ agents: [busy({ updatedAt: NOW - 9 * MIN })] }))).toEqual([]);
  });

  test('above it, one need with the tool and the detail', () => {
    const needs = collectNeeds(sources({ agents: [busy()] }));
    expect(needs.map((need) => need.id)).toEqual(['hung:lead']);
    expect(needLabel(needs[0])).toBe('lead lleva rato en Bash: bun test');
    expect(needs[0].agentKey).toBe('lead');
  });

  test('without detail the label names only the tool', () => {
    const needs = collectNeeds(sources({ agents: [busy({ detail: '' })] }));
    expect(needLabel(needs[0])).toBe('lead lleva rato en Bash');
  });

  test('a long detail is cut to 60 characters', () => {
    const needs = collectNeeds(sources({ agents: [busy({ detail: 'x'.repeat(100) })] }));
    expect(needLabel(needs[0])).toBe(`lead lleva rato en Bash: ${'x'.repeat(59)}…`);
  });

  test('off, nothing is flagged', () => {
    expect(collectNeeds(sources({ agents: [busy()], hungAfterMinutes: 0 }))).toEqual([]);
  });

  test('waiting, asking and patient tools are left out', () => {
    const agents = [
      busy({ key: 'idle', state: 'idle' }),
      busy({ key: 'asking', state: 'asking' }),
      busy({ key: 'waits', waiting: { who: 'x', what: 'y', since: 1 } }),
      busy({ key: 'asker', tool: 'AskUserQuestion' }),
      busy({ key: 'spawner', tool: 'Task' }),
      busy({ key: 'away', away: true }),
      busy({ key: 'question' }),
      busy({ key: 'toolless', tool: null }),
    ];
    const needs = collectNeeds(sources({ agents, questions: [question('q', 'question', 5)] }));
    expect(kinds(needs)).toEqual(['question:question']);
  });

  test('the label does not change with the minutes, so neither does the signature', () => {
    const at = (now: number): Need => collectNeeds(sources({ agents: [busy()], now }))[0];
    expect(needLabel(at(NOW))).toBe(needLabel(at(NOW + 7 * MIN)));
    expect(needSignature(at(NOW))).toBe(needSignature(at(NOW + 7 * MIN)));
    const snoozes = snoozeNeed({}, at(NOW), NOW + 15 * MIN);
    expect(activeNeeds([at(NOW + 5 * MIN)], snoozes, NOW + 5 * MIN)).toEqual([]);
  });

  test('a stalled agent with a hung tool appears once, as hung', () => {
    const needs = collectNeeds(sources({ agents: [busy({ stalledSince: 5 })] }));
    expect(kinds(needs)).toEqual(['hung:lead']);
  });

  test('ranks after blocked and before stalled', () => {
    const agents = [agent('stalled', { stalledSince: 10 }), busy({ key: 'hung' }), agent('blocked', { state: 'blocked' })];
    expect(kinds(collectNeeds(sources({ agents })))).toEqual(['blocked:blocked', 'hung:hung', 'stalled:stalled']);
  });
});

describe('NeedCursor', () => {
  const list = (...ids: string[]): Need[] =>
    ids.map((id) => ({ id, kind: 'question', since: 0, name: id, instance: id, agentKey: id, floor: null, docPath: null, orderSlug: null }));

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

describe('file claim collisions', () => {
  const clash = (path: string, since: number, names: string[] = ['dev-1', 'dev-2']): Collision => ({
    path,
    channel: 'mobile',
    since,
    holders: names.map((name) => ({ key: name, name, floor: 'mobile', since })),
  });

  test('one entry per colliding path, labelled with both holders', () => {
    const needs = collectNeeds(sources({ claims: [clash('lib/a.dart', 5), clash('lib/b.dart', 9, ['x', 'y', 'z', 'w'])] }));
    expect(needs.map((need) => [need.id, need.kind, need.channel])).toEqual([
      ['claim:mobile:lib/a.dart', 'claim', 'mobile'],
      ['claim:mobile:lib/b.dart', 'claim', 'mobile'],
    ]);
    expect(needs[0].name).toBe('lib/a.dart: dev-1 y dev-2');
    expect(needs[1].name).toBe('lib/b.dart: x, y y 2 más');
    expect(needLabel(needs[0])).toBe('Colisión de ficheros: lib/a.dart: dev-1 y dev-2');
  });

  test('ranks after stalled and before plan', () => {
    const needs = collectNeeds(sources({ agents: [agent('stalled', { stalledSince: 10 })], documents: [doc('plans/a.md')], claims: [clash('a.dart', 1)] }));
    expect(needs.map((need) => need.kind)).toEqual(['stalled', 'claim', 'plan']);
  });
});

describe('snoozing', () => {
  const plan = (name: string, id = 'plan:a', instance = '1'): Need => ({ id, kind: 'plan', since: 1, name, instance, agentKey: null, floor: null, docPath: id, orderSlug: null });
  const permit: Need = { id: 'agent:p', kind: 'permission', since: 1, name: 'p', instance: 'q', agentKey: 'p', floor: null, docPath: null, orderSlug: null };
  const ids = (needs: Need[]): string[] => needs.map((need) => need.id);

  test('a timed snooze hides the entry until `until` and wakes it after', () => {
    const need = plan('Plan A');
    const snoozes = snoozeNeed({}, need, NOW + 15 * 60_000);
    expect(ids(activeNeeds([need], snoozes, NOW))).toEqual([]);
    expect(ids(snoozedNeeds([need], snoozes, NOW))).toEqual(['plan:a']);
    expect(ids(activeNeeds([need], snoozes, NOW + 15 * 60_000 - 1))).toEqual([]);
    expect(ids(activeNeeds([need], snoozes, NOW + 15 * 60_000))).toEqual(['plan:a']);
  });

  test('"until it changes" wakes when the label changes', () => {
    const snoozes = snoozeNeed({}, plan('Plan A'), null);
    expect(ids(activeNeeds([plan('Plan A')], snoozes, NOW + 99 * HOUR))).toEqual([]);
    expect(ids(activeNeeds([plan('Plan A v2')], snoozes, NOW))).toEqual(['plan:a']);
    expect(needSignature(plan('Plan A'))).not.toBe(needSignature(plan('Plan A v2')));
  });

  test('a permission is never hidden, even if a snooze is stored for it', () => {
    const stored: Snoozes = { [permit.id]: { until: null, sig: needSignature(permit) } };
    expect(canSnooze(permit)).toBe(false);
    expect(ids(activeNeeds([permit], stored, NOW))).toEqual(['agent:p']);
    expect(snoozeNeed({}, permit, null)).toEqual({});
  });

  test('pruneSnoozes drops expired, changed and vanished ids', () => {
    const keep = plan('Keep', 'plan:keep');
    const expired = plan('Old', 'plan:old');
    const changed = plan('New', 'plan:changed');
    const snoozes: Snoozes = {
      'plan:keep': { until: NOW + HOUR, sig: needSignature(keep) },
      'plan:old': { until: NOW - 1, sig: needSignature(expired) },
      'plan:changed': { until: null, sig: needSignature(plan('Before', 'plan:changed')) },
      'plan:gone': { until: null, sig: 'plan:x' },
    };
    expect(Object.keys(pruneSnoozes(snoozes, [keep, expired, changed], NOW))).toEqual(['plan:keep']);
  });

  test('wakeNeed removes one entry', () => {
    const snoozes = snoozeNeed(snoozeNeed({}, plan('A', 'plan:a'), null), plan('B', 'plan:b'), null);
    expect(Object.keys(wakeNeed(snoozes, 'plan:a'))).toEqual(['plan:b']);
  });

  test('the cursor and the count walk only the active needs', () => {
    const a = plan('A', 'plan:a');
    const b = plan('B', 'plan:b');
    const c = plan('C', 'plan:c');
    const active = activeNeeds([a, b, c], snoozeNeed({}, b, null), NOW);
    expect(active.length).toBe(2);
    const cursor = new NeedCursor();
    expect(cursor.step(active, 1)?.need.id).toBe('plan:a');
    expect(cursor.step(active, 1)?.need.id).toBe('plan:c');
    expect(cursor.step(active, 1)).toMatchObject({ position: 1, total: 2 });
  });
});

describe('snoozes and new occurrences', () => {
  const MIN = 60_000;
  const ask = (id: string, createdAt: number): Need => collectNeeds(sources({ agents: [agent('a')], questions: [question(id, 'a', createdAt)] }))[0];
  const limit = (usedPct: number, resetsAt: number): Need =>
    collectNeeds(sources({ usage: { fiveHour: { usedPct, resetsAt }, sevenDay: null, at: NOW } }))[0];

  test('a second question of the same agent is not hidden by a snooze of the first', () => {
    const first = ask('q1', 10);
    const second = ask('q2', 20);
    expect(second.id).toBe(first.id);
    expect(activeNeeds([second], snoozeNeed({}, first, null), NOW)).toEqual([second]);
    expect(activeNeeds([second], snoozeNeed({}, first, NOW + HOUR), NOW)).toEqual([second]);
    expect(activeNeeds([ask('q1', 10)], snoozeNeed({}, first, null), NOW)).toEqual([]);
  });

  test('a new limit window is not hidden by a snooze of the last one', () => {
    const out = limit(100, NOW + 2 * HOUR);
    const snoozes = snoozeNeed({}, out, null);
    expect(activeNeeds([limit(100, NOW + 2 * HOUR + MIN)], snoozes, NOW)).toEqual([]);
    const next = limit(100, NOW + 7 * HOUR);
    expect(activeNeeds([next], snoozes, NOW)).toEqual([next]);
  });

  test('a timed snooze survives a label change; "until it changes" does not', () => {
    const before = limit(91, NOW + 2 * HOUR);
    const after = limit(95, NOW + 2 * HOUR);
    expect(needLabel(before)).not.toBe(needLabel(after));
    expect(activeNeeds([after], snoozeNeed({}, before, NOW + 15 * MIN), NOW)).toEqual([]);
    expect(activeNeeds([after], snoozeNeed({}, before, null), NOW)).toEqual([after]);
  });

  test('a new blocking, stall, claim, delivery or check run is a new occurrence', () => {
    const blocked = (since: number): Need => collectNeeds(sources({ agents: [agent('b', { state: 'blocked', stateSince: since })] }))[0];
    const stalled = (since: number): Need => collectNeeds(sources({ agents: [agent('s', { stalledSince: since })] }))[0];
    const claim = (holders: string[]): Need =>
      collectNeeds(sources({ claims: [{ path: 'a.dart', channel: 'mobile', since: 1, holders: holders.map((key) => ({ key, name: 'x', floor: 'mobile', since: 1 })) }] }))[0];
    const plan = (deliveredAt: number): Need => collectNeeds(sources({ documents: [doc('p.md', { deliveredAt })] }))[0];
    const checks = (sha: string): Need =>
      collectNeeds(sources({ orders: [order('o', { checks: { status: 'passed', passed: 1, total: 1, sha, touched: ['x'], forced: false } })] }))[0];
    expect(needSignature(blocked(1))).not.toBe(needSignature(blocked(2)));
    expect(needSignature(stalled(1))).not.toBe(needSignature(stalled(2)));
    expect(needSignature(claim(['a', 'b']))).toBe(needSignature(claim(['b', 'a'])));
    expect(needSignature(claim(['a', 'b']))).not.toBe(needSignature(claim(['a', 'c'])));
    expect(needSignature(plan(1))).not.toBe(needSignature(plan(2)));
    expect(needSignature(checks('abc'))).not.toBe(needSignature(checks('def')));
  });
});

describe('where snoozes are kept', () => {
  test('a replay never persists them, and only a live snapshot prunes them', () => {
    expect(shouldPersistSnoozes({ replay: true, connection: 'replay' })).toBe(false);
    expect(shouldPersistSnoozes({ replay: false, connection: 'replay' })).toBe(false);
    expect(shouldPersistSnoozes({ replay: false, connection: 'offline' })).toBe(true);
    expect(shouldPruneSnoozes({ replay: false, connection: 'online' })).toBe(true);
    expect(shouldPruneSnoozes({ replay: true, connection: 'online' })).toBe(false);
    for (const connection of ['connecting', 'offline', 'nokey', 'denied'] as const) expect(shouldPruneSnoozes({ replay: false, connection })).toBe(false);
  });

  test('a live snapshot with an empty queue drops every snooze', () => {
    expect(pruneSnoozes({ 'agent:a': { until: null, sig: 'question:x:y' } }, [], NOW)).toEqual({});
  });

  test('a replay keeps its snoozes in the page and leaves the stored ones alone', () => {
    const kept = new Map<string, string>();
    const original = globalThis.localStorage;
    const fake = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    try {
      const stored: Snoozes = { 'plan:a': { until: null, sig: 'plan:1:2' } };
      kept.set(SNOOZE_KEY, JSON.stringify(stored));
      const replay = { replay: true, connection: 'replay' } as const;
      expect(loadSnoozes(replay)).toEqual(stored);
      saveSnoozes(replay, {});
      expect(loadSnoozes(replay)).toEqual({});
      expect(JSON.parse(kept.get(SNOOZE_KEY) ?? 'null')).toEqual(stored);
      const live = { replay: false, connection: 'online' } as const;
      kept.set(SNOOZE_KEY, JSON.stringify({}));
      expect(loadSnoozes(live)).toEqual({});
      saveSnoozes(live, stored);
      expect(JSON.parse(kept.get(SNOOZE_KEY) ?? 'null')).toEqual(stored);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});

describe('the menu', () => {
  test('opens on the first entry, on the postponed ones when all are, and not at all when empty', () => {
    expect(menuStart(2, 1)).toBe('entry');
    expect(menuStart(0, 3)).toBe('snoozed');
    expect(menuStart(0, 0)).toBeNull();
  });

  test('the arrows wrap around and do nothing without stops', () => {
    expect(menuStep(-1, 1, 0)).toBeNull();
    expect(menuStep(-1, 1, 3)).toBe(0);
    expect(menuStep(-1, -1, 3)).toBe(2);
    expect(menuStep(2, 1, 3)).toBe(0);
    expect(menuStep(0, -1, 3)).toBe(2);
  });

  test('the trigger signature changes only with the count, the language or an empty queue', () => {
    expect(triggerSignature('es', 2, 3)).toBe(triggerSignature('es', 2, 5));
    expect(triggerSignature('es', 2, 3)).not.toBe(triggerSignature('es', 1, 3));
    expect(triggerSignature('es', 0, 1)).not.toBe(triggerSignature('es', 0, 0));
    expect(triggerSignature('es', 2, 3)).not.toBe(triggerSignature('en', 2, 3));
  });
});
