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

// What each agent was doing in the last `hours`: consecutive activity rows with the same state become one segment,
// the last one runs to `now`. Rows without a state do not change it.
export function timeline(db: Database, hours: number, now: number): AgentTimeline[] {
  const from = now - hours * HOUR_MS;
  const rows = db
    .query<Row, [number, number, number]>(
      'SELECT ts, agent_key, floor, state FROM activity_log WHERE ts >= ?1 AND ts <= ?2 AND state IS NOT NULL ORDER BY ts, id LIMIT ?3',
    )
    .all(from, now, MAX_ROWS);
  const byAgent = new Map<string, { agent: string; floor: string; points: { ts: number; state: string }[] }>();
  for (const row of rows) {
    const key = `${row.floor ?? ''}\u0000${row.agent_key}`;
    let entry = byAgent.get(key);
    if (!entry) {
      entry = { agent: row.agent_key, floor: row.floor ?? '', points: [] };
      byAgent.set(key, entry);
    }
    entry.points.push({ ts: row.ts, state: row.state });
  }
  return [...byAgent.values()]
    .sort((a, b) => a.floor.localeCompare(b.floor) || a.agent.localeCompare(b.agent))
    .slice(0, MAX_TIMELINE_AGENTS)
    .map(({ agent, floor, points }) => {
      const raw = points.map((point, i) => ({ from: point.ts, to: points[i + 1]?.ts ?? now, state: point.state }));
      return { agent, floor, segments: capSegments(mergeSame(raw)) };
    });
}
