import type { TranscriptEntry } from '../types';

export const TAIL_THROTTLE_MS = 5000;
export const TAIL_LIMIT = 20;

export type TailMark = { key: string; stateSince: number; at: number };

const ROLE_ICONS: Record<TranscriptEntry['role'], string> = { assistant: '💬', tool: '⚙', user: '👤' };

export function tailIcon(role: TranscriptEntry['role']): string {
  return ROLE_ICONS[role];
}

// A new agent is read at once; the same one again when its state changed, at most once every 5 s.
export function tailDue(mark: TailMark | null, key: string, stateSince: number, now: number): boolean {
  if (!mark || mark.key !== key) return true;
  return mark.stateSince !== stateSince && now - mark.at >= TAIL_THROTTLE_MS;
}
