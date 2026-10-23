import type { ApiResult } from './api';
import { runSequential } from './broadcast';
import type { Tally } from './broadcast';
import { relaunchable } from './panel/orderable';
import type { SessionView } from './types';

export type RelaunchTally = Tally;

let running = false;

export function relaunchRunning(): boolean {
  return running;
}

// The office sessions whose launcher changed and are still open; the hub refuses the busy ones with a 409.
// A relaunch respawns the tmux window of the session's name, so one window is relaunched once: by its newest session.
export function relaunchCandidates(sessions: Iterable<SessionView>): string[] {
  const byWindow = new Map<string, string>();
  for (const session of sessions) {
    if (!relaunchable(session)) continue;
    const window = session.name ?? `\0${session.sessionId}`;
    byWindow.delete(window);
    byWindow.set(window, session.sessionId);
  }
  return [...byWindow.values()];
}

// One at a time and in order: a relaunch closes a whole team, so none starts before the previous one is over.
// Null while another run is going; an id that ended or no longer needs it by its turn is skipped.
export async function relaunchAll(
  ids: readonly string[],
  call: (sessionId: string) => Promise<ApiResult>,
  still: (sessionId: string) => boolean = () => true,
): Promise<RelaunchTally | null> {
  if (running) return null;
  running = true;
  try {
    return await runSequential(ids, call, still);
  } finally {
    running = false;
  }
}
