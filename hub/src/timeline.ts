import type { Database } from 'bun:sqlite';
import type { AgentTimeline, TimelineSegment } from './types';

export const MAX_TIMELINE_HOURS = 24;
export const MAX_TIMELINE_AGENTS = 200;
export const MAX_TIMELINE_SEGMENTS = 2000;
export const TINY_SEGMENT_MS = 30_000;
const MAX_ROWS = 200_000;
const HOUR_MS = 3_600_000;

type Row = { ts: number; agent_key: string; floor: string | null; state: string };

// Pure: the hours of a request, an integer in 1..24 (4 when absent), null when it is anything else.
export function parseTimelineHours(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 4;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const hours = Number(raw);
  return hours >= 1 && hours <= MAX_TIMELINE_HOURS ? hours : null;
}

function mergeSame(segments: TimelineSegment[]): TimelineSegment[] {
  const merged: TimelineSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.state === segment.state) last.to = segment.to;
    else merged.push({ ...segment });
  }
  return merged;
}

// Pure: past MAX_TIMELINE_SEGMENTS, segments shorter than 30 s are absorbed by the one before them; if that is not
// enough, the oldest ones are dropped.
export function capSegments(segments: TimelineSegment[]): TimelineSegment[] {
  if (segments.length <= MAX_TIMELINE_SEGMENTS) return segments;
  const kept: TimelineSegment[] = [];
  for (const segment of segments) {
    const last = kept[kept.length - 1];
    if (last && segment.to - segment.from < TINY_SEGMENT_MS) last.to = segment.to;
    else kept.push({ ...segment });
  }
  return mergeSame(kept).slice(-MAX_TIMELINE_SEGMENTS);
}

const WINDOW_SQL = `
WITH win AS (
  SELECT id, ts, agent_key, floor, state FROM activity_log WHERE ts >= ?1 AND ts <= ?2 AND state IS NOT NULL
), recent AS (
  SELECT agent_key, COALESCE(floor, '') AS f, MAX(ts) AS last FROM win GROUP BY agent_key, COALESCE(floor, '') ORDER BY last DESC, agent_key LIMIT ?3
), marked AS (
  SELECT w.id, w.ts, w.agent_key, w.floor, w.state, LAG(w.state) OVER (PARTITION BY w.agent_key, COALESCE(w.floor, '') ORDER BY w.ts, w.id) AS prev
  FROM win w JOIN recent r ON r.agent_key = w.agent_key AND r.f = COALESCE(w.floor, '')
)
SELECT ts, agent_key, floor, state FROM marked WHERE prev IS NULL OR prev <> state ORDER BY ts DESC, id DESC LIMIT ?4`;

// What each agent was doing in the last `hours`: only the rows that change an agent's state are read (the busiest
// `MAX_TIMELINE_AGENTS` by latest activity), the newest `maxRows` of them; each agent starts from the state of its last
// row before the window and consecutive equal states become one segment, the last one running to `now`. Rows without a
// state do not change it.
export function timeline(db: Database, hours: number, now: number, maxRows: number = MAX_ROWS): AgentTimeline[] {
  const from = now - hours * HOUR_MS;
  const found = db.query<Row, [number, number, number, number]>(WINDOW_SQL).all(from, now, MAX_TIMELINE_AGENTS, maxRows);
  const rows = found.reverse();
  const seed = db.query<{ state: string }, [string, string, number]>(
    "SELECT state FROM activity_log WHERE agent_key = ?1 AND COALESCE(floor, '') = ?2 AND ts < ?3 AND state IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1",
  );
  const byAgent = new Map<string, { agent: string; floor: string; points: { ts: number; state: string }[] }>();
  for (const row of rows) {
    const key = `${row.floor ?? ''}\u0000${row.agent_key}`;
    let entry = byAgent.get(key);
    if (!entry) {
      entry = { agent: row.agent_key, floor: row.floor ?? '', points: [] };
      const before = found.length < maxRows ? seed.get(row.agent_key, row.floor ?? '', from) : null;
      if (before && row.ts > from) entry.points.push({ ts: from, state: before.state });
      byAgent.set(key, entry);
    }
    entry.points.push({ ts: row.ts, state: row.state });
  }
  return [...byAgent.values()]
    .sort((a, b) => a.floor.localeCompare(b.floor) || a.agent.localeCompare(b.agent))
    .map(({ agent, floor, points }) => {
      const raw = points.map((point, i) => ({ from: point.ts, to: points[i + 1]?.ts ?? now, state: point.state }));
      return { agent, floor, segments: capSegments(mergeSame(raw)) };
    });
}
