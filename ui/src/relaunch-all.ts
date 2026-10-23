import type { ApiResult } from './api';
import { relaunchable } from './panel/orderable';
import type { SessionView } from './types';

export type RelaunchTally = { ok: number; busy: number; failed: number };

const BUSY = 409;

// The office sessions whose launcher changed and are still open; the hub refuses the busy ones with a 409.
export function relaunchCandidates(sessions: Iterable<SessionView>): string[] {
  return [...sessions].filter((session) => relaunchable(session)).map((session) => session.sessionId);
}

// One at a time and in order: a relaunch closes a whole team, so none starts before the previous one is over.
export async function relaunchAll(ids: readonly string[], call: (sessionId: string) => Promise<ApiResult>): Promise<RelaunchTally> {
  const tally: RelaunchTally = { ok: 0, busy: 0, failed: 0 };
  for (const id of ids) {
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
