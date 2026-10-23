import { describe, expect, test } from 'bun:test';
import type { ApiResult } from '../src/api';
import { relaunchAll, relaunchCandidates } from '../src/relaunch-all';
import type { SessionView } from '../src/types';

const session = (sessionId: string, extra: Partial<SessionView> = {}): SessionView => ({
  sessionId,
  agentKey: sessionId,
  name: null,
  role: null,
  floor: 'mobile',
  canReceive: true,
  endedAt: null,
  needsRelaunch: true,
  rulesPending: false,
  canRelaunch: true,
  relaunchResumes: true,
  office: true,
  ...extra,
});

describe('relaunchCandidates', () => {
  test('flagged, open sessions of the office, busy ones included', () => {
    const sessions = [
      session('a'),
      session('busy', { canRelaunch: false }),
      session('clean', { needsRelaunch: false }),
      session('ended', { endedAt: 1 }),
      session('outside', { office: false }),
      session('b'),
    ];
    expect(relaunchCandidates(sessions)).toEqual(['a', 'busy', 'b']);
  });

  test('none flagged, none to relaunch', () => {
    expect(relaunchCandidates([session('a', { needsRelaunch: false })])).toEqual([]);
    expect(relaunchCandidates([])).toEqual([]);
  });
});

describe('relaunchAll', () => {
  test('runs in order, never two at a time, and counts ok, busy and failed', async () => {
    const outcomes: Record<string, ApiResult | 'throw'> = {
      a: { ok: true },
      b: { ok: false, status: 409, message: 'busy' },
      c: { ok: false, status: 502, message: 'failed' },
      d: 'throw',
      e: { ok: true },
    };
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const call = async (id: string): Promise<ApiResult> => {
      started.push(id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const outcome = outcomes[id]!;
      if (outcome === 'throw') throw new Error('network');
      return outcome;
    };
    const tally = await relaunchAll(['a', 'b', 'c', 'd', 'e'], call);
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(1);
    expect(tally).toEqual({ ok: 2, busy: 1, failed: 2 });
  });

  test('a failure does not stop the rest, and no ids means no calls', async () => {
    const seen: string[] = [];
    const tally = await relaunchAll(['x', 'y'], async (id) => {
      seen.push(id);
      return { ok: false, status: 500, message: 'no' };
    });
    expect(seen).toEqual(['x', 'y']);
    expect(tally).toEqual({ ok: 0, busy: 0, failed: 2 });
    expect(await relaunchAll([], async () => ({ ok: true }))).toEqual({ ok: 0, busy: 0, failed: 0 });
  });
});
