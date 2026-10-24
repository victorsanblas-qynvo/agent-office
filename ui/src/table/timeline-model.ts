import { fileStamp } from '../download';
import { t } from '../i18n';
import { STATE_COLORS, stateLabel } from '../labels';
import { clockMinutes, duration } from '../time';
import type { AgentState, AgentTimeline, TimelineSegment } from '../types';
import { EMPTY_FILTERS, type HistoryFilters } from './history';
import { isoLocal, toCsv } from './history-export';

export const TIMELINE_HOURS = [1, 4, 8, 24] as const;
export const DEFAULT_TIMELINE_HOURS = 4;
export const PX_PER_HOUR = 120;
const HOUR_MS = 3_600_000;

export type PlacedSegment = { left: number; width: number; state: string; title: string };

export function readTimelineHours(raw: unknown): number {
  return TIMELINE_HOURS.find((hours) => hours === raw) ?? DEFAULT_TIMELINE_HOURS;
}

export function segmentColor(state: string): string {
  return STATE_COLORS[state as AgentState] ?? STATE_COLORS.idle;
}

// Pure: segments clipped to [from, to] and placed on a strip `widthPx` wide; at least 1 px wide, whole pixels.
export function layoutSegments(segments: readonly TimelineSegment[], from: number, to: number, widthPx: number): PlacedSegment[] {
  const span = to - from;
  if (span <= 0) return [];
  const placed: PlacedSegment[] = [];
  for (const segment of segments) {
    const start = Math.max(segment.from, from);
    const end = Math.min(segment.to, to);
    if (end <= start) continue;
    const left = Math.round(((start - from) / span) * widthPx);
    const width = Math.max(1, Math.round(((end - start) / span) * widthPx));
    const label = STATE_COLORS[segment.state as AgentState] ? stateLabel(segment.state as AgentState) : segment.state;
    placed.push({ left, width, state: segment.state, title: `${label} · ${clockMinutes(start)}–${clockMinutes(end)} · ${duration(end - start)}` });
  }
  return placed;
}

// Pure: the full local hours inside [from, to] with their position on the strip.
export function hourTicks(from: number, to: number, widthPx: number): { left: number; label: string }[] {
  const span = to - from;
  if (span <= 0) return [];
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  const ticks: { left: number; label: string }[] = [];
  for (let at = first.getTime(); at <= to; at += HOUR_MS) {
    if (at < from) continue;
    ticks.push({ left: Math.round(((at - from) / span) * widthPx), label: clockMinutes(at) });
  }
  return ticks;
}

function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Pure: the history filters for the agent of a bar and the local days its segment starts and ends on.
export function segmentFilters(agentKey: string, segment: Pick<TimelineSegment, 'from' | 'to'>): HistoryFilters {
  return { ...EMPTY_FILTERS, agent: agentKey, from: localDay(segment.from), to: localDay(segment.to) };
}

const NOT_WORKING: ReadonlySet<string> = new Set(['idle', 'done', 'failed', 'blocked']);

export type StateTotal = { state: string; ms: number };

function clippedMs(segment: TimelineSegment, from: number, to: number): number {
  return Math.max(0, Math.min(segment.to, to) - Math.max(segment.from, from));
}

function addTotals(totals: Map<string, number>, segments: readonly TimelineSegment[], from: number, to: number): void {
  for (const segment of segments) {
    const ms = clippedMs(segment, from, to);
    if (ms > 0) totals.set(segment.state, (totals.get(segment.state) ?? 0) + ms);
  }
}

function sortedTotals(totals: Map<string, number>): StateTotal[] {
  return [...totals].map(([state, ms]) => ({ state, ms })).sort((a, b) => b.ms - a.ms || a.state.localeCompare(b.state));
}

// Pure: the time of every state across all agents inside [from, to], the longest first.
export function stateTotals(agents: readonly AgentTimeline[], from: number, to: number): StateTotal[] {
  const totals = new Map<string, number>();
  for (const agent of agents) addTotals(totals, agent.segments, from, to);
  return sortedTotals(totals);
}

// Pure: the share (whole percent) of [from, to] an agent spent in working-like states, and its time per state.
export function utilisation(segments: readonly TimelineSegment[], from: number, to: number): { percent: number; byState: StateTotal[] } {
  const totals = new Map<string, number>();
  addTotals(totals, segments, from, to);
  const span = to - from;
  let active = 0;
  for (const [state, ms] of totals) if (!NOT_WORKING.has(state)) active += ms;
  return { percent: span > 0 ? Math.round((active / span) * 100) : 0, byState: sortedTotals(totals) };
}

export const TIMELINE_CSV_COLUMNS = ['agent', 'floor', 'state', 'from', 'to', 'seconds'] as const;

// Pure: one CSV row per segment, in the order of the strip. name gives the label of an agent key.
export function timelineCsv(agents: readonly AgentTimeline[], name: (key: string) => string): string {
  const rows = agents.flatMap((agent) =>
    agent.segments.map((segment) => [name(agent.agent), agent.floor, segment.state, isoLocal(segment.from), isoLocal(segment.to), String(Math.round((segment.to - segment.from) / 1000))]),
  );
  return toCsv(TIMELINE_CSV_COLUMNS, rows);
}

// Pure: linea-de-tiempo-YYYYMMDD-HHMM.csv in local time.
export function timelineFilename(now: Date): string {
  return `${t('timeline.file.name')}-${fileStamp(now)}.csv`;
}
