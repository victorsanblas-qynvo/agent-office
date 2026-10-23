import type { Database } from 'bun:sqlite';
import { flakyHits, type FlakyRun } from '../../shared/flaky';
import type { FlakyCheckView } from './types';

export const FLAKY_DEFAULT_DAYS = 14;
export const FLAKY_MAX_DAYS = 60;

const DAY_MS = 86_400_000;

type Row = { run_id: number; order_id: number; floor: string; sha: string; started_at: number; name: string; status: string };

// null when days is not a whole number from 1 to FLAKY_MAX_DAYS; no text means the default.
export function parseFlakyDays(text: string | undefined): number | null {
  if (text === undefined || text === '') return FLAKY_DEFAULT_DAYS;
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 && days <= FLAKY_MAX_DAYS ? days : null;
}

// Checks that failed and later passed on the same commit within one order, counted per floor and check over the runs of the last days.
export function flakyReport(db: Database, now: number, days: number, floor?: string): FlakyCheckView[] {
  const since = now - days * DAY_MS;
  const rows = db
    .query<Row, (string | number)[]>(
      `SELECT r.id AS run_id, r.order_id, r.floor, r.sha, r.started_at, c.name, c.status
       FROM check_runs r JOIN checks c ON c.run_id = r.id
       WHERE r.started_at >= ? AND r.status != 'cancelled'${floor ? ' AND r.floor = ?' : ''}
       ORDER BY r.id, c.id`,
    )
    .all(...(floor ? [since, floor] : [since]));
  const byOrder = new Map<string, { floor: string; orderId: number; runs: Map<number, FlakyRun & { checks: { name: string; status: string }[] }> }>();
  for (const row of rows) {
    const key = `${row.floor}\n${row.order_id}`;
    let order = byOrder.get(key);
    if (!order) {
      order = { floor: row.floor, orderId: row.order_id, runs: new Map() };
      byOrder.set(key, order);
    }
    let run = order.runs.get(row.run_id);
    if (!run) {
      run = { id: row.run_id, sha: row.sha, startedAt: row.started_at, checks: [] };
      order.runs.set(row.run_id, run);
    }
    run.checks.push({ name: row.name, status: row.status });
  }
  const report = new Map<string, { floor: string; check: string; flakyCount: number; lastAt: number; orders: Set<number> }>();
  for (const order of byOrder.values()) {
    for (const hit of flakyHits([...order.runs.values()])) {
      const key = `${order.floor}\n${hit.name}`;
      const entry = report.get(key) ?? { floor: order.floor, check: hit.name, flakyCount: 0, lastAt: 0, orders: new Set<number>() };
      entry.flakyCount += 1;
      entry.lastAt = Math.max(entry.lastAt, hit.at);
      entry.orders.add(order.orderId);
      report.set(key, entry);
    }
  }
  return [...report.values()]
    .map((entry): FlakyCheckView => ({ floor: entry.floor, check: entry.check, flakyCount: entry.flakyCount, lastAt: entry.lastAt, orders: entry.orders.size }))
    .sort((a, b) => b.flakyCount - a.flakyCount || b.lastAt - a.lastAt || a.floor.localeCompare(b.floor) || a.check.localeCompare(b.check));
}
