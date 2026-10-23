import type { Database } from 'bun:sqlite';
import type { DeliveryMetrics, FloorDeliveryMetrics } from './types';

export const METRIC_DAYS = [7, 14, 30] as const;
export const DEFAULT_METRIC_DAYS = 14;

const DAY_MS = 86_400_000;
const CHUNK = 400;

// null when days is not one of METRIC_DAYS; no text means the default.
export function parseMetricDays(text: string | undefined): number | null {
  if (text === undefined || text === '') return DEFAULT_METRIC_DAYS;
  const days = /^\d+$/.test(text) ? Number(text) : NaN;
  return (METRIC_DAYS as readonly number[]).includes(days) ? days : null;
}

// Pure: the median of a sorted list (mean of the two middle values when even), null when empty.
export function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// Pure: the nearest-rank percentile (0 < p <= 1) of a sorted list, null when empty.
export function percentile(sorted: number[], p: number): number | null {
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

type Delivered = { id: number; floor: string; created_at: number; cycle: number; first_fin: number };
type Run = { order_id: number; status: string };

type Acc = { leads: number[]; reopened: number; delivered: number; firstGreen: number; firstKnown: number; runs: number };

function summarize(acc: Acc): Omit<FloorDeliveryMetrics, 'floor'> {
  const leads = [...acc.leads].sort((a, b) => a - b);
  return {
    delivered: acc.delivered,
    medianLeadMs: median(leads),
    p90LeadMs: percentile(leads, 0.9),
    reopenRate: acc.delivered > 0 ? acc.reopened / acc.delivered : 0,
    firstPassGreen: acc.firstKnown > 0 ? acc.firstGreen / acc.firstKnown : null,
    avgRunsPerOrder: acc.delivered > 0 ? acc.runs / acc.delivered : 0,
  };
}

// Delivery per floor over the last `days`: the orders that are done and got a 'fin' alert in the window (the digest's
// rule), with the time from creation to their first 'fin' alert, how many were reopened and what their finished check
// runs say. Floors with no delivery are left out. Bounded by the window, the order ids and check_runs_order.
export function deliveryMetrics(db: Database, days: number, now: number): DeliveryMetrics {
  const since = now - days * DAY_MS;
  const orders = db
    .query<Delivered, [number, number]>(
      `SELECT o.id, o.floor, o.created_at, o.cycle,
              (SELECT MIN(f.ts) FROM alerts f WHERE f.level = 'fin' AND ((f.ref = 'order:' || o.slug AND f.floor = o.floor) OR (f.ref = 'plan:' || o.plan_slug))) AS first_fin
         FROM orders o
        WHERE o.status = 'hecho' AND o.removed_at IS NULL AND o.id IN (
          SELECT o2.id FROM alerts a JOIN orders o2 ON (a.ref = 'order:' || o2.slug AND a.floor = o2.floor) OR (a.ref = 'plan:' || o2.plan_slug AND o2.status <> 'descartado')
           WHERE a.level = 'fin' AND a.ts >= ? AND a.ts <= ?)`,
    )
    .all(since, now);

  const runsByOrder = new Map<number, string[]>();
  for (let i = 0; i < orders.length; i += CHUNK) {
    const ids = orders.slice(i, i + CHUNK).map((o) => o.id);
    const rows = db
      .query<Run, number[]>(
        `SELECT order_id, status FROM check_runs WHERE order_id IN (${ids.map(() => '?').join(',')}) AND status IN ('passed', 'failed', 'timeout') ORDER BY ended_at, id`,
      )
      .all(...ids);
    for (const row of rows) {
      const list = runsByOrder.get(row.order_id);
      if (list) list.push(row.status);
      else runsByOrder.set(row.order_id, [row.status]);
    }
  }

  const floors = new Map<string, Acc>();
  const total: Acc = { leads: [], reopened: 0, delivered: 0, firstGreen: 0, firstKnown: 0, runs: 0 };
  for (const order of orders) {
    let acc = floors.get(order.floor);
    if (!acc) {
      acc = { leads: [], reopened: 0, delivered: 0, firstGreen: 0, firstKnown: 0, runs: 0 };
      floors.set(order.floor, acc);
    }
    const runs = runsByOrder.get(order.id) ?? [];
    for (const into of [acc, total]) {
      into.delivered += 1;
      into.leads.push(Math.max(0, order.first_fin - order.created_at));
      if (order.cycle > 1) into.reopened += 1;
      into.runs += runs.length;
      if (runs.length > 0) {
        into.firstKnown += 1;
        if (runs[0] === 'passed') into.firstGreen += 1;
      }
    }
  }
  return {
    days,
    floors: [...floors].map(([floor, acc]) => ({ floor, ...summarize(acc) })).sort((a, b) => a.floor.localeCompare(b.floor)),
    totals: summarize(total),
  };
}
