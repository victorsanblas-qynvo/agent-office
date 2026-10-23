import type { Database } from 'bun:sqlite';
import { localDay } from './tokens';
import type { DigestCounts, DigestFloor, OfficeDigest } from './types';

type FloorCount = { floor: string; n: number };

const DAY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

// Pure: the local-day [start, end) in milliseconds of a YYYY-MM-DD day, null when it is not a calendar date.
export function dayRange(day: string): [number, number] | null {
  const match = DAY_FORMAT.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const start = new Date(year, month, date);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== date) return null;
  return [start.getTime(), new Date(year, month, date + 1).getTime()];
}

function emptyCounts(): DigestCounts {
  return { blocked: 0, redRuns: 0, greenRuns: 0, tokens: 0, plans: { approved: 0, noAgreement: 0 }, lessons: 0 };
}

// What the office did on one local day, per floor, with floors that did nothing left out. Every query is bounded by
// the day; lessons have no index on their time column, so that one scans its table.
export function digest(db: Database, day: string, now: number): OfficeDigest | 'bad-day' | 'future-day' {
  const range = dayRange(day);
  if (!range) return 'bad-day';
  if (day > localDay(now)) return 'future-day';
  const [start, end] = range;
  const floors = new Map<string, DigestFloor>();
  const floorOf = (slug: string): DigestFloor => {
    let floor = floors.get(slug);
    if (!floor) {
      floor = { floor: slug, delivered: [], ...emptyCounts() };
      floors.set(slug, floor);
    }
    return floor;
  };
  const each = (sql: string, params: (string | number)[], apply: (floor: DigestFloor, n: number) => void): void => {
    for (const row of db.query<FloorCount, (string | number)[]>(sql).all(...params)) apply(floorOf(row.floor), row.n);
  };

  for (const order of db
    .query<{ floor: string; slug: string; title: string }, [number, number]>(
      `SELECT o.floor, o.slug, o.title FROM alerts a
         JOIN orders o ON (a.ref = 'order:' || o.slug AND a.floor = o.floor) OR (a.ref = 'plan:' || o.plan_slug AND o.status <> 'descartado')
        WHERE a.level = 'fin' AND a.ts >= ? AND a.ts < ? AND o.status = 'hecho' AND o.removed_at IS NULL
        GROUP BY o.id ORDER BY MIN(a.ts), o.id`,
    )
    .all(start, end)) {
    floorOf(order.floor).delivered.push({ slug: order.slug, title: order.title });
  }
  each(
    "SELECT floor, COUNT(*) AS n FROM activity_log WHERE ts >= ? AND ts < ? AND state = 'blocked' AND tool = 'SendMessage' AND floor IS NOT NULL GROUP BY floor",
    [start, end],
    (floor, n) => (floor.blocked = n),
  );
  each(
    "SELECT floor, COUNT(*) AS n FROM check_runs WHERE ended_at >= ? AND ended_at < ? AND status = 'failed' GROUP BY floor",
    [start, end],
    (floor, n) => (floor.redRuns = n),
  );
  each(
    "SELECT floor, COUNT(*) AS n FROM check_runs WHERE ended_at >= ? AND ended_at < ? AND status = 'passed' GROUP BY floor",
    [start, end],
    (floor, n) => (floor.greenRuns = n),
  );
  each(
    'SELECT floor, SUM(input + cache_read + cache_create + output) AS n FROM token_usage WHERE day = ? GROUP BY floor',
    [day],
    (floor, n) => (floor.tokens = n),
  );
  each(
    "SELECT floor, COUNT(*) AS n FROM verdicts WHERE kind = 'approved' AND ts >= ? AND ts < ? GROUP BY floor",
    [start, end],
    (floor, n) => (floor.plans.approved = n),
  );
  each(
    "SELECT floor, COUNT(*) AS n FROM verdicts WHERE kind = 'no-agreement' AND ts >= ? AND ts < ? GROUP BY floor",
    [start, end],
    (floor, n) => (floor.plans.noAgreement = n),
  );
  each('SELECT floor, COUNT(*) AS n FROM lessons WHERE created_at >= ? AND created_at < ? GROUP BY floor', [start, end], (floor, n) => (floor.lessons = n));

  const active = [...floors.values()]
    .filter((f) => f.delivered.length + f.blocked + f.redRuns + f.greenRuns + f.tokens + f.plans.approved + f.plans.noAgreement + f.lessons > 0)
    .sort((a, b) => a.floor.localeCompare(b.floor));
  const totals = { delivered: 0, ...emptyCounts() };
  for (const f of active) {
    totals.delivered += f.delivered.length;
    totals.blocked += f.blocked;
    totals.redRuns += f.redRuns;
    totals.greenRuns += f.greenRuns;
    totals.tokens += f.tokens;
    totals.plans.approved += f.plans.approved;
    totals.plans.noAgreement += f.plans.noAgreement;
    totals.lessons += f.lessons;
  }
  return { day, floors: active, totals };
}
