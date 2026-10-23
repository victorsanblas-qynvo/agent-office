import { describe, expect, test } from 'bun:test';
import { TAIL_THROTTLE_MS, tailDue, tailIcon } from '../src/panel/tail-model';

describe('transcript tail model', () => {
  test('a first read and a different agent are due at once', () => {
    expect(tailDue(null, 'a', 1, 100)).toBe(true);
    expect(tailDue({ key: 'a', stateSince: 1, at: 100 }, 'b', 1, 101)).toBe(true);
  });

  test('the same agent is read again only after a state change and 5 s', () => {
    const mark = { key: 'a', stateSince: 1, at: 1000 };
    expect(tailDue(mark, 'a', 1, 1000 + TAIL_THROTTLE_MS * 2)).toBe(false);
    expect(tailDue(mark, 'a', 2, 1000 + TAIL_THROTTLE_MS - 1)).toBe(false);
    expect(tailDue(mark, 'a', 2, 1000 + TAIL_THROTTLE_MS)).toBe(true);
  });

  test('each role has its own icon', () => {
    expect(new Set(['assistant', 'tool', 'user'].map((role) => tailIcon(role as 'user'))).size).toBe(3);
  });
});
