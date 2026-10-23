import { STATE_COLORS, stateLabel } from '../labels';
import { clockMinutes, duration } from '../time';
import type { AgentState, TimelineSegment } from '../types';

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
