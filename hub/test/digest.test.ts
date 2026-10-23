import { afterEach, describe, expect, test } from 'bun:test';
import { dayRange, daysBetween } from '../src/digest';
import { createApp } from '../src/server';
import type { OfficeDigest, WeekDigest } from '../src/types';
import { harness, type Harness } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
const D1 = new Date(2026, 9, 21).getTime();
const D2 = new Date(2026, 9, 22).getTime();
const D3 = new Date(2026, 9, 23).getTime();
const HOUR = 3_600_000;
let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function office(): Harness {
  h = harness();
  h.clock.now = D3 + 10 * HOUR;
  return h;
}

function order(db: Harness['db'], slug: string, floor: string, status: string, at: number, removed: number | null = null): void {
  db.run(
    'INSERT INTO orders (slug, floor, title, status, source, created_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [slug, floor, `Title ${slug}`, status, 'director', at, at, removed],
  );
}

function fin(db: Harness['db'], floor: string, slug: string, at: number, ref = `order:${slug}`): void {
  db.run("INSERT INTO alerts (ts, level, floor, agent_key, files, ref, cycle) VALUES (?, 'fin', ?, 'a', '[]', ?, 1)", [at, floor, ref]);
}

function run(db: Harness['db'], floor: string, status: string, at: number): void {
  db.run('INSERT INTO check_runs (order_id, floor, slug, sha, trigger, status, started_at, ended_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)', [floor, 's', 'abc', 'listo', status, at, at]);
}

function blocked(db: Harness['db'], floor: string, at: number, state = 'blocked'): void {
  db.run('INSERT INTO activity_log (ts, agent_key, floor, event, tool, state, summary) VALUES (?, ?, ?, ?, ?, ?, ?)', [at, 'a', floor, 'PreToolUse', 'SendMessage', state, '{}']);
}

function verdict(db: Harness['db'], floor: string, kind: string, at: number): void {
  db.run('INSERT INTO verdicts (ts, agent_key, floor, kind, ok) VALUES (?, ?, ?, ?, ?)', [at, 'a', floor, kind, kind === 'approved' ? 1 : 0]);
}

function seed(db: Harness['db']): void {
  order(db, 'login', 'mobile', 'hecho', D2 + 9 * HOUR);
  order(db, 'logout', 'mobile', 'hecho', D2 + 11 * HOUR);
  order(db, 'old', 'mobile', 'hecho', D1 + HOUR);
  order(db, 'wip', 'mobile', 'en-curso', D2 + HOUR);
  order(db, 'gone', 'mobile', 'hecho', D2 + HOUR, D2 + 2 * HOUR);
  order(db, 'api', 'backend', 'hecho', D2 + 2 * HOUR);
  fin(db, 'mobile', 'login', D2 + 9 * HOUR);
  fin(db, 'mobile', 'logout', D2 + 11 * HOUR);
  fin(db, 'mobile', 'old', D1 + HOUR);
  fin(db, 'mobile', 'gone', D2 + HOUR);
  fin(db, 'backend', 'api', D2 + 2 * HOUR);
  blocked(db, 'mobile', D2 + HOUR);
  blocked(db, 'mobile', D2 + 2 * HOUR);
  blocked(db, 'mobile', D2 + 3 * HOUR, 'talking');
  blocked(db, 'backend', D1 + HOUR);
  run(db, 'mobile', 'failed', D2 + HOUR);
  run(db, 'mobile', 'failed', D2 + 2 * HOUR);
  run(db, 'mobile', 'passed', D2 + 3 * HOUR);
  run(db, 'backend', 'passed', D2 + 3 * HOUR);
  run(db, 'backend', 'passed', D1 + 3 * HOUR);
  run(db, 'backend', 'cancelled', D2 + 3 * HOUR);
  for (const [day, floor, tokens] of [['2026-10-22', 'mobile', 100], ['2026-10-22', 'backend', 50], ['2026-10-21', 'mobile', 999]] as const) {
    db.run(
      'INSERT INTO token_usage (day, agent_key, session_id, floor, input, cache_read, cache_create, output, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [day, `${floor}-${day}`, 's', floor, tokens / 2, 10, 5, tokens - 15 - tokens / 2 + 0, D2],
    );
  }
  verdict(db, 'redaccion', 'approved', D2 + HOUR);
  verdict(db, 'redaccion', 'no-agreement', D2 + 2 * HOUR);
  verdict(db, 'redaccion', 'improve', D2 + 3 * HOUR);
  verdict(db, 'redaccion', 'approved', D1 + HOUR);
  db.run('INSERT INTO lessons (floor, role, text, norm, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['mobile', 'dev', 'x', 'x', 'user', D2 + HOUR]);
  db.run('INSERT INTO lessons (floor, role, text, norm, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['mobile', 'dev', 'y', 'y', 'user', D1 + HOUR]);
}

describe('digest', () => {
  test('counts each floor for one local day and leaves out the others', () => {
    const { office: o, db } = office();
    seed(db);
    const result = o.dayDigest('2026-10-22') as OfficeDigest;
    expect(result.day).toBe('2026-10-22');
    expect(result.floors.map((f) => f.floor)).toEqual(['backend', 'mobile', 'redaccion']);
    const [backend, mobile, redaccion] = result.floors;
    expect(backend).toEqual({ floor: 'backend', delivered: [{ slug: 'api', title: 'Title api' }], blocked: 0, redRuns: 0, greenRuns: 1, tokens: 50, plans: { approved: 0, noAgreement: 0 }, lessons: 0 });
    expect(mobile).toEqual({
      floor: 'mobile',
      delivered: [
        { slug: 'login', title: 'Title login' },
        { slug: 'logout', title: 'Title logout' },
      ],
      blocked: 2,
      redRuns: 2,
      greenRuns: 1,
      tokens: 100,
      plans: { approved: 0, noAgreement: 0 },
      lessons: 1,
    });
    expect(redaccion).toMatchObject({ delivered: [], plans: { approved: 1, noAgreement: 1 } });
    expect(result.totals).toEqual({ delivered: 3, blocked: 2, redRuns: 2, greenRuns: 2, tokens: 150, plans: { approved: 1, noAgreement: 1 }, lessons: 1 });
  });

  test('delivered follows the end alert, not later updates of the order', () => {
    const { office: o, db } = office();
    order(db, 'late', 'mobile', 'hecho', D3 + HOUR);
    fin(db, 'mobile', 'late', D2 + HOUR);
    order(db, 'p1', 'mobile', 'hecho', D3);
    order(db, 'p2', 'backend', 'hecho', D3);
    db.run("UPDATE orders SET plan_slug = 'plan-x' WHERE slug IN ('p1', 'p2')");
    fin(db, 'mobile', 'p1', D2 + 2 * HOUR, 'plan:plan-x');
    const result = o.dayDigest('2026-10-22') as OfficeDigest;
    expect(result.floors.flatMap((f) => f.delivered.map((d) => d.slug)).sort()).toEqual(['late', 'p1', 'p2']);
    expect((o.dayDigest('2026-10-23') as OfficeDigest).totals.delivered).toBe(0);
  });

  test('a day with nothing has no floors', () => {
    const { office: o, db } = office();
    seed(db);
    const result = o.dayDigest('2026-10-20') as OfficeDigest;
    expect(result.floors).toEqual([]);
    expect(result.totals.delivered).toBe(0);
  });

  test('the day starts and ends at local midnight', () => {
    const { office: o, db } = office();
    for (const [slug, at] of [['first', D2], ['last', D3 - 1], ['next', D3]] as const) {
      order(db, slug, 'mobile', 'hecho', at);
      fin(db, 'mobile', slug, at);
    }
    const result = o.dayDigest('2026-10-22') as OfficeDigest;
    expect(result.floors[0]?.delivered.map((d) => d.slug)).toEqual(['first', 'last']);
    expect((o.dayDigest('2026-10-23') as OfficeDigest).floors[0]?.delivered.map((d) => d.slug)).toEqual(['next']);
    expect(dayRange('2026-10-22')).toEqual([D2, D3]);
  });

  test('rejects what is not a calendar day and days to come, and defaults to today', () => {
    const { office: o, db } = office();
    order(db, 'today', 'mobile', 'hecho', D3 + HOUR);
    fin(db, 'mobile', 'today', D3 + HOUR);
    expect(o.dayDigest('2026-02-30')).toBe('bad-day');
    expect(o.dayDigest('ayer')).toBe('bad-day');
    expect(o.dayDigest('2026-10-24')).toBe('future-day');
    expect((o.dayDigest(null) as OfficeDigest).day).toBe('2026-10-23');
    expect((o.dayDigest('2026-10-23') as OfficeDigest).totals.delivered).toBe(1);
  });
});

describe('weekly digest', () => {
  test('daysBetween lists the days in order and caps at 7', () => {
    expect(daysBetween('2026-10-22', '2026-10-22')).toEqual(['2026-10-22']);
    expect(daysBetween('2026-10-29', '2026-11-04')).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(daysBetween('2026-10-28', '2026-11-04')).toBeNull();
    expect(daysBetween('2026-10-23', '2026-10-22')).toBeNull();
    expect(daysBetween('2026-02-30', '2026-03-02')).toBeNull();
  });

  test('sums the days per floor and in total, in order', () => {
    const { office: o, db } = office();
    seed(db);
    order(db, 'today', 'mobile', 'hecho', D3 + HOUR);
    fin(db, 'mobile', 'today', D3 + HOUR);
    const week = o.rangeDigest('2026-10-21', '2026-10-23') as WeekDigest;
    expect(week.days.map((d) => d.day)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(week.from).toBe('2026-10-21');
    expect(week.to).toBe('2026-10-23');
    const sum = (pick: (d: OfficeDigest) => number): number => week.days.reduce((n, d) => n + pick(d), 0);
    expect(week.totals.delivered).toBe(sum((d) => d.totals.delivered));
    expect(week.totals.blocked).toBe(sum((d) => d.totals.blocked));
    expect(week.totals.tokens).toBe(sum((d) => d.totals.tokens));
    expect(week.totals.plans.approved).toBe(sum((d) => d.totals.plans.approved));
    expect(week.floors.map((f) => f.floor)).toEqual(['backend', 'mobile', 'redaccion']);
    const mobile = week.floors.find((f) => f.floor === 'mobile')!;
    expect(mobile.delivered.map((d) => d.slug)).toEqual(['old', 'login', 'logout', 'today']);
    expect(week.floors.reduce((n, f) => n + f.delivered.length, 0)).toBe(week.totals.delivered);
  });

  test('rejects future ends, long and inverted ranges', () => {
    const { office: o } = office();
    expect(o.rangeDigest('2026-10-23', '2026-10-24')).toBe('bad-range');
    expect(o.rangeDigest('2026-10-15', '2026-10-23')).toBe('bad-range');
    expect(o.rangeDigest('2026-10-23', '2026-10-22')).toBe('bad-range');
    expect(o.rangeDigest('x', '2026-10-22')).toBe('bad-range');
    expect((o.rangeDigest('2026-10-17', '2026-10-23') as WeekDigest).days).toHaveLength(7);
  });
});

describe('GET /api/digest', () => {
  const get = async (path: string, key: string | null = KEY) => {
    const app = createApp({ office: h!.office, port: PORT, key: () => KEY, publicDir: h!.root }, () => {});
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      headers: { host: `127.0.0.1:${PORT}`, ...(key ? { 'x-office-key': key } : {}) },
    });
    return { status: response.status, body: (response.status === 401 ? {} : await response.json()) as Record<string, any> };
  };

  test('answers the day, today by default, and 400 for a bad or future day', async () => {
    const { db } = office();
    seed(db);
    const ok = await get('/api/digest?day=2026-10-22');
    expect(ok.status).toBe(200);
    expect(ok.body.totals.delivered).toBe(3);
    expect((await get('/api/digest')).body.day).toBe('2026-10-23');
    for (const day of ['x', '2026-13-01', '2026-10-24']) {
      const bad = await get(`/api/digest?day=${day}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error.key).toBe('hub.api.digestDay');
    }
  });

  test('answers a range and 400 for a bad one or one mixed with day', async () => {
    const { db } = office();
    seed(db);
    const ok = await get('/api/digest?from=2026-10-21&to=2026-10-23');
    expect(ok.status).toBe(200);
    expect(ok.body.days).toHaveLength(3);
    expect(ok.body.totals.delivered).toBe(4);
    for (const query of ['from=2026-10-21', 'to=2026-10-23', 'from=2026-10-15&to=2026-10-23', 'from=2026-10-23&to=2026-10-22', 'from=2026-10-23&to=2026-10-24', 'day=2026-10-22&from=2026-10-21&to=2026-10-23']) {
      const bad = await get(`/api/digest?${query}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error.key).toBe('hub.api.digestRange');
    }
  });

  test('needs the panel credential', async () => {
    office();
    expect((await get('/api/digest', null)).status).toBe(401);
  });
});
