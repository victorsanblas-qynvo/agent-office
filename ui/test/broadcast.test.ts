import { describe, expect, test } from 'bun:test';
import type { ApiResult } from '../src/api';
import { BROADCAST_MAX_TEXT, RECENT_ASK_MS, broadcast, broadcastRunning, broadcastTextValid, leadTargets, runSequential } from '../src/broadcast';
import type { AgentView, SessionView } from '../src/types';

const agent = (sessionId: string, floor: string, extra: Partial<AgentView> = {}): AgentView =>
  ({ key: sessionId, sessionId, floor, roleKind: 'lead', away: false, endedAt: null, updatedAt: 1, ...extra }) as AgentView;

const session = (sessionId: string, extra: Partial<SessionView> = {}): SessionView =>
  ({ sessionId, agentKey: sessionId, floor: 'x', canReceive: true, endedAt: null, office: true, ...extra }) as SessionView;

const sessionsOf = (...list: SessionView[]): Map<string, SessionView> => new Map(list.map((item) => [item.sessionId, item]));

describe('leadTargets', () => {
  test('one lead per floor, the newest, leaving out devs and sub-agents', () => {
    const agents = [agent('a', 'mobile', { updatedAt: 1 }), agent('b', 'mobile', { updatedAt: 5 }), agent('c', 'backend'), agent('d', 'backend', { roleKind: 'dev' }), agent('e', 'backend', { key: 'sub' })];
    const sessions = sessionsOf(...['a', 'b', 'c', 'd', 'e'].map((id) => session(id)));
    expect(leadTargets(sessions, agents, 1000).sort()).toEqual(['b', 'c']);
  });

  test('ended, away, outside the office and unreachable leads are left out', () => {
    const agents = [agent('a', 'f1', { endedAt: 3 }), agent('b', 'f2', { away: true }), agent('c', 'f3'), agent('d', 'f4'), agent('e', 'f5'), agent('f', 'f6')];
    const sessions = sessionsOf(session('a'), session('b'), session('c', { office: false }), session('d', { canReceive: false }), session('e', { endedAt: 2 }), session('f'));
    expect(leadTargets(sessions, agents, 1000)).toEqual(['f']);
  });

  test('a lead asked within two minutes waits, then comes back', () => {
    const agents = [agent('a', 'f1'), agent('b', 'f2')];
    const sessions = sessionsOf(session('a'), session('b'));
    const asked = new Map([['a', 10_000]]);
    expect(leadTargets(sessions, agents, 10_000 + RECENT_ASK_MS - 1, asked)).toEqual(['b']);
    expect(leadTargets(sessions, agents, 10_000 + RECENT_ASK_MS, asked)).toEqual(['a', 'b']);
  });
});

describe('runSequential and broadcast', () => {
  test('never two in flight, and counts ok, busy, failed and skipped', async () => {
    const outcomes: Record<string, ApiResult | 'throw'> = {
      a: { ok: true },
      b: { ok: false, status: 409, message: 'busy' },
      c: { ok: false, status: 502, message: 'no' },
      d: 'throw',
    };
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const tally = await runSequential(
      ['a', 'b', 'c', 'd', 'gone'],
      async (id) => {
        started.push(id);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        const outcome = outcomes[id]!;
        if (outcome === 'throw') throw new Error('network');
        return outcome;
      },
      (id) => id !== 'gone',
    );
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(peak).toBe(1);
    expect(tally).toEqual({ ok: 1, busy: 1, failed: 2, skipped: 1 });
  });

  test('a second broadcast while one is going is a no-op, and the guard is freed after', async () => {
    let release: () => void = () => {};
    const seen: string[] = [];
    const first = broadcast(['a', 'b'], async (id) => {
      seen.push(id);
      if (id === 'a') await new Promise<void>((resolve) => (release = resolve));
      return { ok: true };
    });
    expect(broadcastRunning()).toBe(true);
    expect(await broadcast(['z'], async (id) => (seen.push(id), { ok: true }))).toBeNull();
    release();
    expect(await first).toEqual({ ok: 2, busy: 0, failed: 0, skipped: 0 });
    expect(seen).toEqual(['a', 'b']);
    expect(broadcastRunning()).toBe(false);
  });
});

describe('broadcastTextValid', () => {
  test('needs text and fits the inbox limit', () => {
    expect(broadcastTextValid('   ')).toBe(false);
    expect(broadcastTextValid('hola')).toBe(true);
    expect(broadcastTextValid('x'.repeat(BROADCAST_MAX_TEXT))).toBe(true);
    expect(broadcastTextValid('x'.repeat(BROADCAST_MAX_TEXT + 1))).toBe(false);
  });
});
