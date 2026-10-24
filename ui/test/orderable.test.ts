import { describe, expect, test } from 'bun:test';
import { orderableSessions, relaunchable, statusAllowed } from '../src/panel/orderable';
import type { SessionView } from '../src/types';

const session = (sessionId: string, extra: Partial<SessionView>): SessionView => ({
  sessionId,
  agentKey: sessionId,
  name: null,
  role: null,
  floor: 'mobile',
  canReceive: true,
  endedAt: null,
  needsRelaunch: false,
  rulesPending: false,
  canRelaunch: true,
  relaunchResumes: true,
  office: true,
  cwd: null,
  ...extra,
});

describe('orderable sessions', () => {
  test('only live, reachable sessions of the office receive orders', () => {
    const sessions = [
      session('a', {}),
      session('b', { office: false }),
      session('c', { canReceive: false }),
      session('d', { endedAt: 1 }),
    ];
    expect(orderableSessions(sessions).map((s) => s.sessionId)).toEqual(['a']);
  });

  test('Pedir estado and Relanzar are offered only to sessions of the office', () => {
    expect(statusAllowed(session('a', {}))).toBe(true);
    expect(statusAllowed(session('b', { office: false }))).toBe(false);
    expect(statusAllowed(undefined)).toBe(false);
    expect(relaunchable(session('a', { needsRelaunch: true }))).toBe(true);
    expect(relaunchable(session('b', { needsRelaunch: true, office: false }))).toBe(false);
    expect(relaunchable(session('c', { needsRelaunch: false }))).toBe(false);
    expect(relaunchable(session('d', { needsRelaunch: true, endedAt: 1 }))).toBe(false);
  });
});
