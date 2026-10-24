import { describe, expect, test } from 'bun:test';
import type { ApiResult } from '../src/api';
import { relaunchable } from '../src/panel/orderable';
import { relaunchAll, relaunchCandidates, relaunchRunning } from '../src/relaunch-all';
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
  cwd: null,
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

  test('sessions that share a tmux window collapse into the newest one', () => {
    const sessions = [session('old', { name: 'mobile-lead' }), session('other', { name: 'mobile-dev' }), session('new', { name: 'mobile-lead' }), session('a')];
    expect(relaunchCandidates(sessions)).toEqual(['other', 'new', 'a']);
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
    expect(tally).toEqual({ ok: 2, busy: 1, failed: 2, skipped: 0 });
  });

  test('a failure does not stop the rest, and no ids means no calls', async () => {
    const seen: string[] = [];
    const tally = await relaunchAll(['x', 'y'], async (id) => {
      seen.push(id);
      return { ok: false, status: 500, message: 'no' };
    });
    expect(seen).toEqual(['x', 'y']);
    expect(tally).toEqual({ ok: 0, busy: 0, failed: 2, skipped: 0 });
    expect(await relaunchAll([], async () => ({ ok: true }))).toEqual({ ok: 0, busy: 0, failed: 0, skipped: 0 });
  });

  test('a second run while one is going is a no-op', async () => {
    let release: () => void = () => {};
    const seen: string[] = [];
    const first = relaunchAll(['a', 'b'], async (id) => {
      seen.push(id);
      if (id === 'a') await new Promise<void>((resolve) => (release = resolve));
      return { ok: true };
    });
    expect(relaunchRunning()).toBe(true);
    expect(await relaunchAll(['a', 'b'], async (id) => (seen.push(`again-${id}`), { ok: true }))).toBeNull();
    release();
    expect(await first).toEqual({ ok: 2, busy: 0, failed: 0, skipped: 0 });
    expect(seen).toEqual(['a', 'b']);
    expect(relaunchRunning()).toBe(false);
  });

  test('an id that ended or no longer needs it by its turn is skipped', async () => {
    const sessions = new Map([
      ['a', session('a')],
      ['b', session('b')],
      ['c', session('c')],
    ]);
    const seen: string[] = [];
    const tally = await relaunchAll(
      ['a', 'b', 'c'],
      async (id) => {
        seen.push(id);
        if (id === 'a') {
          sessions.set('b', session('b', { endedAt: 5 }));
          sessions.set('c', session('c', { needsRelaunch: false }));
        }
        return { ok: true };
      },
      (id) => relaunchable(sessions.get(id)),
    );
    expect(seen).toEqual(['a']);
    expect(tally).toEqual({ ok: 1, busy: 0, failed: 0, skipped: 2 });
  });

  test('a call that throws still frees the guard', async () => {
    expect(await relaunchAll(['x'], async () => Promise.reject(new Error('down')))).toEqual({ ok: 0, busy: 0, failed: 1, skipped: 0 });
    expect(relaunchRunning()).toBe(false);
  });
});
