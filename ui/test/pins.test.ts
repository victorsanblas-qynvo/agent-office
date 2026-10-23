import { describe, expect, test } from 'bun:test';
import { canPin, MAX_PINS, pinnedRows, togglePin } from '../src/pins';
import { pinSignature } from '../src/pinned-strip';
import type { AgentView } from '../src/types';
import { agent } from './fixtures';

const map = (...agents: AgentView[]): Map<string, AgentView> => new Map(agents.map((item) => [item.key, item]));

describe('pinnedRows', () => {
  test('keeps the pin order, not the order of the agents', () => {
    const agents = map(agent('a'), agent('b'), agent('c'));
    expect(pinnedRows(agents, ['c', 'a']).map((row) => row.key)).toEqual(['c', 'a']);
  });

  test('drops agents that are gone and agents that ended', () => {
    const agents = map(agent('a'), agent('b', { endedAt: 5000 }));
    expect(pinnedRows(agents, ['gone', 'b', 'a']).map((row) => row.key)).toEqual(['a']);
  });

  test('caps at four', () => {
    const agents = map(...['a', 'b', 'c', 'd', 'e'].map((key) => agent(key)));
    expect(pinnedRows(agents, ['a', 'b', 'c', 'd', 'e']).map((row) => row.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('skipped ones do not use up the cap', () => {
    const agents = map(...['a', 'b', 'c', 'd', 'e'].map((key) => agent(key)));
    expect(pinnedRows(agents, ['x', 'a', 'b', 'c', 'd']).map((row) => row.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('nothing pinned, nothing shown', () => {
    expect(pinnedRows(map(agent('a')), [])).toEqual([]);
    expect(pinnedRows(new Map(), ['a'])).toEqual([]);
  });
});

describe('togglePin', () => {
  test('pins at the end and unpins', () => {
    expect(togglePin(['a'], 'b')).toEqual(['a', 'b']);
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b']);
  });

  test('a full strip refuses a fifth but still lets one go', () => {
    const full = ['a', 'b', 'c', 'd'];
    expect(full).toHaveLength(MAX_PINS);
    expect(togglePin(full, 'e')).toEqual(full);
    expect(canPin(full, 'e')).toBe(false);
    expect(canPin(full, 'a')).toBe(true);
    expect(togglePin(full, 'a')).toEqual(['b', 'c', 'd']);
  });
});

describe('pinSignature', () => {
  const face = (extra = {}) => ({ agent: agent('a', extra), state: 'working' as const });

  test('is stable for the same faces and changes with tool, context, state or language', () => {
    const base = pinSignature('es', [face()]);
    expect(pinSignature('es', [face()])).toBe(base);
    expect(pinSignature('en', [face()])).not.toBe(base);
    expect(pinSignature('es', [face({ openTool: 'Bash' })])).not.toBe(base);
    expect(pinSignature('es', [face({ context: { usedPct: 42, tokens: 1, window: 2, compactions: 0, source: 'transcript', at: 1 } })])).not.toBe(base);
    expect(pinSignature('es', [{ ...face(), state: 'idle' }])).not.toBe(base);
  });
});
