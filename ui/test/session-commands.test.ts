import { describe, expect, test } from 'bun:test';
import { sessionCommands } from '../src/panel/session-commands';
import type { SessionView } from '../src/types';
import { agent } from './fixtures';

const ID = '3cc3ffbb-1ee1-4b96-9468-36265c0f295e';
const session = (extra: Partial<SessionView> = {}): SessionView => ({
  sessionId: ID,
  agentKey: ID,
  name: 'lead-mobile',
  role: null,
  floor: 'mobile',
  canReceive: true,
  endedAt: null,
  needsRelaunch: false,
  rulesPending: false,
  canRelaunch: true,
  relaunchResumes: true,
  office: true,
  cwd: '/work/app',
  ...extra,
});
const main = agent(ID);

describe('sessionCommands', () => {
  test('builds the tmux and resume commands', () => {
    expect(sessionCommands(session(), main)).toEqual({
      tmux: "tmux select-window -t 'agent-office:=lead-mobile' && tmux attach -t agent-office",
      resume: `cd '/work/app' && claude --resume ${ID}`,
    });
  });

  test('escapes single quotes in the folder', () => {
    expect(sessionCommands(session({ cwd: "/work/it's" }), main).resume).toBe(`cd '/work/it'\\''s' && claude --resume ${ID}`);
  });

  test('refuses control characters in the folder', () => {
    expect(sessionCommands(session({ cwd: '/work/a\nrm -rf' }), main).resume).toBeUndefined();
    expect(sessionCommands(session({ cwd: '/work/a\u001b[0m' }), main).resume).toBeUndefined();
  });

  test('refuses a session id that is not a plain token', () => {
    const odd = agent('a b;c');
    expect(sessionCommands(session({ sessionId: 'a b;c' }), odd).resume).toBeUndefined();
    expect(sessionCommands(session({ sessionId: 'short' }), agent('short')).resume).toBeUndefined();
  });

  test('omits what is missing', () => {
    expect(sessionCommands(session({ name: null }), main).tmux).toBeUndefined();
    expect(sessionCommands(session({ name: "x'; ls" }), main).tmux).toBeUndefined();
    expect(sessionCommands(session({ endedAt: 5 }), main).tmux).toBeUndefined();
    expect(sessionCommands(session({ cwd: null }), main).resume).toBeUndefined();
    expect(sessionCommands(undefined, main)).toEqual({});
  });

  test('gives nothing for observed sessions or sub-agents', () => {
    expect(sessionCommands(session({ office: false, cwd: null }), main)).toEqual({});
    expect(sessionCommands(session(), agent('child', { sessionId: ID }))).toEqual({});
  });
});
