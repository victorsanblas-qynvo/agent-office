import type { ApiResult } from './api';
import { INBOX_MAX_TEXT } from '../../shared/review-message';
import type { AgentView, SessionView } from './types';

export type Tally = { ok: number; busy: number; failed: number; skipped: number };

export const BROADCAST_MAX_TEXT = INBOX_MAX_TEXT;
export const RECENT_ASK_MS = 2 * 60_000;

const BUSY = 409;

let running = false;

export function broadcastRunning(): boolean {
  return running;
}

// The newest open lead session of each floor that can be written to; the ones asked within the last two minutes wait.
export function leadTargets(sessions: ReadonlyMap<string, SessionView>, agents: Iterable<AgentView>, now: number, lastAsked: ReadonlyMap<string, number> = new Map()): string[] {
  const byFloor = new Map<string, AgentView>();
  for (const agent of agents) {
    if (agent.roleKind !== 'lead' || agent.away || agent.endedAt !== null || agent.key !== agent.sessionId) continue;
    const session = sessions.get(agent.sessionId);
    if (!session?.office || !session.canReceive || session.endedAt !== null) continue;
    const asked = lastAsked.get(agent.sessionId);
    if (asked !== undefined && now - asked < RECENT_ASK_MS) continue;
    const current = byFloor.get(agent.floor);
    if (!current || agent.updatedAt >= current.updatedAt) byFloor.set(agent.floor, agent);
  }
  return [...byFloor.values()].map((agent) => agent.sessionId);
}

export function broadcastTextValid(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && trimmed.length <= BROADCAST_MAX_TEXT;
}

// One at a time and in order; an id that no longer qualifies by its turn is skipped, and a call that throws counts as failed.
export async function runSequential(ids: readonly string[], call: (id: string) => Promise<ApiResult>, still: (id: string) => boolean = () => true): Promise<Tally> {
  const tally: Tally = { ok: 0, busy: 0, failed: 0, skipped: 0 };
  for (const id of ids) {
    if (!still(id)) {
      tally.skipped += 1;
      continue;
    }
    try {
      const result = await call(id);
      if (result.ok) tally.ok += 1;
      else if (result.status === BUSY) tally.busy += 1;
      else tally.failed += 1;
    } catch {
      tally.failed += 1;
    }
  }
  return tally;
}

// Null while another broadcast is going.
export async function broadcast(ids: readonly string[], call: (id: string) => Promise<ApiResult>, still?: (id: string) => boolean): Promise<Tally | null> {
  if (running) return null;
  running = true;
  try {
    return await runSequential(ids, call, still);
  } finally {
    running = false;
  }
}
