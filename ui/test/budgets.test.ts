import { describe, expect, test } from 'bun:test';
import type { ApiData } from '../src/api';
import {
  BUDGET_REFRESH_MS,
  BUDGET_RETRY_MS,
  FLOOR_BUDGETS_KEY,
  adoptTodaySummary,
  budgetSpend,
  formatTokenShorthand,
  parseTokenShorthand,
  readFloorBudgets,
  refreshBudgetSpend,
  shouldFetchBudgets,
  writeFloorBudgets,
} from '../src/budgets';
import type { UsageSummary } from '../src/types';

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

describe('the spend of today', () => {
  const some = { mobile: 1_000_000 };
  const local = (hour: number, minute = 0): number => new Date(2026, 9, 24, hour, minute).getTime();
  const summary = { range: 'today', byFloor: [] } as unknown as UsageSummary;

  test('a new day is due at once, and a failure waits a minute before the next try', () => {
    expect(shouldFetchBudgets(some, local(0, 1), local(23, 59) - 86_400_000, false)).toBe(true);
    expect(shouldFetchBudgets(some, local(10), null, false, local(10) - BUDGET_RETRY_MS + 1)).toBe(false);
    expect(shouldFetchBudgets(some, local(10), null, false, local(10) - BUDGET_RETRY_MS)).toBe(true);
  });

  test('a first fetch that fails is not repeated every tick', async () => {
    let calls = 0;
    let now = local(9);
    const failing = async (): Promise<ApiData<UsageSummary>> => {
      calls += 1;
      return { ok: false, status: 502, message: 'no' };
    };
    await refreshBudgetSpend(failing, () => now, some);
    now += 1_000;
    await refreshBudgetSpend(failing, () => now, some);
    expect(calls).toBe(1);
    now = local(9) + BUDGET_RETRY_MS;
    await refreshBudgetSpend(failing, () => now, some);
    expect(calls).toBe(2);
    await refreshBudgetSpend(async () => ({ ok: true, data: summary }), () => now + BUDGET_RETRY_MS, some);
    expect(budgetSpend(now + BUDGET_RETRY_MS)?.summary).toBe(summary);
  });

  test("yesterday's spend is no spend after midnight", () => {
    adoptTodaySummary(summary, local(23, 58) - 86_400_000);
    expect(budgetSpend(local(23, 59) - 86_400_000)?.summary).toBe(summary);
    expect(budgetSpend(local(0, 1))).toBeNull();
  });
});
