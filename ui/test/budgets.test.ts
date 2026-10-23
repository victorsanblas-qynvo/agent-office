import { describe, expect, test } from 'bun:test';
import { BUDGET_REFRESH_MS, FLOOR_BUDGETS_KEY, formatTokenShorthand, parseTokenShorthand, readFloorBudgets, shouldFetchBudgets, writeFloorBudgets } from '../src/budgets';

function withStorage(run: (store: Map<string, string>) => void): void {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    run(store);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true });
  }
}

describe('parseTokenShorthand', () => {
  test('reads k and m shorthand and plain numbers', () => {
    expect(parseTokenShorthand('2M')).toBe(2_000_000);
    expect(parseTokenShorthand('500k')).toBe(500_000);
    expect(parseTokenShorthand('1.5m')).toBe(1_500_000);
    expect(parseTokenShorthand(' 1,5 M ')).toBe(1_500_000);
    expect(parseTokenShorthand('750000')).toBe(750_000);
  });

  test('rejects text, zero and values over the limit', () => {
    expect(parseTokenShorthand('abc')).toBeNull();
    expect(parseTokenShorthand('0')).toBeNull();
    expect(parseTokenShorthand('')).toBeNull();
    expect(parseTokenShorthand('-5k')).toBeNull();
    expect(parseTokenShorthand('2000000M')).toBeNull();
  });

  test('formats back to the short form', () => {
    expect(formatTokenShorthand(2_000_000)).toBe('2M');
    expect(formatTokenShorthand(500_000)).toBe('500k');
    expect(formatTokenShorthand(1_234_567)).toBe('1234567');
  });
});

describe('floor budgets pref', () => {
  test('keeps only positive integers up to 1e12', () => {
    withStorage((store) => {
      store.set(FLOOR_BUDGETS_KEY, JSON.stringify({ a: 100, b: 0, c: 1.5, d: 'x', e: 2e12, f: -1 }));
      expect(readFloorBudgets()).toEqual({ a: 100 });
      writeFloorBudgets({ a: 5, b: 0 });
      expect(readFloorBudgets()).toEqual({ a: 5 });
    });
  });

  test('a corrupt or missing value reads as no budgets', () => {
    withStorage((store) => {
      expect(readFloorBudgets()).toEqual({});
      store.set(FLOOR_BUDGETS_KEY, '[1,2]');
      expect(readFloorBudgets()).toEqual({});
      store.set(FLOOR_BUDGETS_KEY, '{oops');
      expect(readFloorBudgets()).toEqual({});
    });
  });
});

describe('shouldFetchBudgets', () => {
  const some = { mobile: 1_000_000 };
  test('never without budgets', () => {
    expect(shouldFetchBudgets({}, 1_000_000, null, false)).toBe(false);
  });

  test('fetches the first time, then every five minutes, never while loading', () => {
    expect(shouldFetchBudgets(some, 1_000_000, null, false)).toBe(true);
    expect(shouldFetchBudgets(some, 1_000_000, null, true)).toBe(false);
    expect(shouldFetchBudgets(some, 1_000_000 + BUDGET_REFRESH_MS - 1, 1_000_000, false)).toBe(false);
    expect(shouldFetchBudgets(some, 1_000_000 + BUDGET_REFRESH_MS, 1_000_000, false)).toBe(true);
  });
});
