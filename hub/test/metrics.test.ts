import { afterEach, describe, expect, test } from 'bun:test';
import { median, parseMetricDays, percentile } from '../src/metrics';
import { createApp } from '../src/server';
import type { DeliveryMetrics } from '../src/types';
import { harness, type Harness } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 23, 10).getTime();
let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function office(): Harness {
  h = harness();
  h.clock.now = NOW;
  return h;
}

// A done order created `lead` before its first fin alert at `finAt`, with the finished runs in order.
function delivered(db: Harness['db'], floor: string, slug: string, finAt: number, lead: number, runs: string[] = [], cycle = 1): void {
  db.run('INSERT INTO orders (slug, floor, title, status, source, cycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [slug, floor, slug, 'hecho', 'director', cycle, finAt - lead, finAt]);
  const id = db.query<{ id: number }, [string]>('SELECT id FROM orders WHERE slug = ?').get(slug)!.id;
  db.run("INSERT INTO alerts (ts, level, floor, agent_key, files, ref, cycle) VALUES (?, 'fin', ?, 'a', '[]', ?, 1)", [finAt, floor, `order:${slug}`]);
  runs.forEach((status, i) =>
    db.run('INSERT INTO check_runs (order_id, floor, slug, sha, trigger, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, floor, slug, 'abc', 'listo', status, finAt - 1000 * (10 - i), finAt - 1000 * (10 - i)]),
  );
}

describe('median and percentile', () => {
  test('median of odd and even counts', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 2, 9])).toBe(2);
    expect(median([1, 2, 4, 9])).toBe(3);
  });

  test('nearest-rank p90', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(5);
  });

  test('days are 7, 14 or 30, 14 by default', () => {
    expect(parseMetricDays(undefined)).toBe(14);
    expect(parseMetricDays('30')).toBe(30);
    for (const bad of ['1', '15', 'x', '7.5', '-7']) expect(parseMetricDays(bad)).toBeNull();
  });
});

describe('deliveryMetrics', () => {
  test('summarizes lead time, reopen rate, first-pass green and runs per floor', () => {
    const { db, office: o } = office();
    delivered(db, 'mobile', 'a', NOW - DAY, HOUR, ['passed']);
    delivered(db, 'mobile', 'b', NOW - 2 * DAY, 3 * HOUR, ['failed', 'passed'], 2);
    delivered(db, 'mobile', 'c', NOW - 3 * DAY, 5 * HOUR, []);
    delivered(db, 'backend', 'd', NOW - DAY, 2 * HOUR, ['passed', 'failed']);
    delivered(db, 'backend', 'e', NOW - DAY, 4 * HOUR, ['timeout']);
    const m = o.deliveryMetrics(14);
    expect(m.days).toBe(14);
    expect(m.floors.map((f) => f.floor)).toEqual(['backend', 'mobile']);
    const mobile = m.floors.find((f) => f.floor === 'mobile')!;
    expect(mobile).toEqual({ floor: 'mobile', delivered: 3, medianLeadMs: 3 * HOUR, p90LeadMs: 5 * HOUR, reopenRate: 1 / 3, firstPassGreen: 0.5, avgRunsPerOrder: 1 });
    const backend = m.floors.find((f) => f.floor === 'backend')!;
    expect(backend.medianLeadMs).toBe(3 * HOUR);
    expect(backend.p90LeadMs).toBe(4 * HOUR);
    expect(backend.firstPassGreen).toBe(0.5);
    expect(backend.avgRunsPerOrder).toBe(1.5);
    expect(m.totals.delivered).toBe(5);
    expect(m.totals.medianLeadMs).toBe(3 * HOUR);
    expect(m.totals.reopenRate).toBe(0.2);
  });

  test('ignores running and cancelled runs, orders outside the window, open and removed orders', () => {
    const { db, office: o } = office();
    delivered(db, 'mobile', 'in', NOW - DAY, HOUR, ['cancelled', 'passed', 'running']);
    delivered(db, 'mobile', 'old', NOW - 20 * DAY, HOUR, ['passed']);
    delivered(db, 'mobile', 'gone', NOW - DAY, HOUR);
    db.run("UPDATE orders SET removed_at = ? WHERE slug = 'gone'", [NOW]);
    delivered(db, 'mobile', 'wip', NOW - DAY, HOUR);
    db.run("UPDATE orders SET status = 'en-curso' WHERE slug = 'wip'");
    const week = o.deliveryMetrics(7);
    expect(week.totals.delivered).toBe(1);
    expect(week.floors[0]!.avgRunsPerOrder).toBe(1);
    expect(o.deliveryMetrics(30).totals.delivered).toBe(2);
  });

  test('leaves out floors with no deliveries and returns nulls for an empty office', () => {
    const { office: o } = office();
    expect(o.deliveryMetrics(14)).toEqual({
      days: 14,
      floors: [],
      totals: { delivered: 0, medianLeadMs: null, p90LeadMs: null, reopenRate: 0, firstPassGreen: null, avgRunsPerOrder: 0 },
    });
  });

  test('measures a reopened order from its first fin alert', () => {
    const { db, office: o } = office();
    delivered(db, 'mobile', 'r', NOW - HOUR, 2 * HOUR, ['passed'], 2);
    db.run("INSERT INTO alerts (ts, level, floor, agent_key, files, ref, cycle) VALUES (?, 'fin', 'mobile', 'a', '[]', 'order:r', 2)", [NOW - 10 * DAY]);
    db.run("UPDATE orders SET created_at = ? WHERE slug = 'r'", [NOW - 10 * DAY - 3 * HOUR]);
    const m = o.deliveryMetrics(14);
    expect(m.totals.medianLeadMs).toBe(3 * HOUR);
    expect(m.totals.reopenRate).toBe(1);
  });
});

describe('GET /api/metrics/delivery', () => {
  const get = async (path: string, key: string | null = KEY) => {
    const app = createApp({ office: h!.office, port: PORT, key: () => KEY, publicDir: h!.root }, () => {});
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      headers: { host: `127.0.0.1:${PORT}`, ...(key ? { 'x-office-key': key } : {}) },
    });
    return { status: response.status, body: (response.status === 401 ? {} : await response.json()) as Record<string, any> };
  };

  test('answers 200 with 14 days by default and for 7 and 30', async () => {
    const { db } = office();
    delivered(db, 'mobile', 'a', NOW - 10 * DAY, HOUR, ['passed']);
    const def = await get('/api/metrics/delivery');
    expect(def.status).toBe(200);
    expect((def.body as DeliveryMetrics).days).toBe(14);
    expect((def.body as DeliveryMetrics).totals.delivered).toBe(1);
    expect((await get('/api/metrics/delivery?days=7')).body.totals.delivered).toBe(0);
    expect((await get('/api/metrics/delivery?days=30')).body.days).toBe(30);
  });

  test('answers 400 for other days', async () => {
    office();
    for (const days of ['0', '10', 'x', '60']) {
      const bad = await get(`/api/metrics/delivery?days=${days}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error.key).toBe('hub.api.metricsDays');
    }
  });

  test('needs the panel credential', async () => {
    office();
    expect((await get('/api/metrics/delivery', null)).status).toBe(401);
  });
});
