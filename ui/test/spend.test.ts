import { describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { SPEND_REFRESH_MS, dayBars, planRows, spendDue } from '../src/table/usage-block';
import type { TokenRow } from '../src/types';


describe('spendDue', () => {
  test('loads when visible and never loaded, then once a minute, never while loading or hidden', () => {
    expect(spendDue(1000, null, true, false)).toBe(true);
    expect(spendDue(1000, null, false, false)).toBe(false);
    expect(spendDue(1000, null, true, true)).toBe(false);
    expect(spendDue(1000 + SPEND_REFRESH_MS - 1, 1000, true, false)).toBe(false);
    expect(spendDue(1000 + SPEND_REFRESH_MS, 1000, true, false)).toBe(true);
  });
});


describe('dayBars', () => {
  const NOW = new Date(2026, 9, 16, 12, 30).getTime();
  const days = (...tokens: number[]) => tokens.map((value, i) => ({ day: `2026-10-${String(10 + i).padStart(2, '0')}`, tokens: value }));

  test('scales to the largest day and flags today', () => {
    applyLang('es');
    const bars = dayBars(days(0, 50, 100, 0, 25, 0, 10), NOW);
    expect(bars.map((b) => b.pct)).toEqual([0, 50, 100, 0, 25, 0, 10]);
    expect(bars.map((b) => b.value)).toEqual([0, 50, 100, 0, 25, 0, 10]);
    expect(bars.map((b) => b.isToday)).toEqual([false, false, false, false, false, false, true]);
  });

  test('is flat when nothing was spent', () => {
    expect(dayBars(days(0, 0, 0), NOW).map((b) => b.pct)).toEqual([0, 0, 0]);
  });

  test('labels the weekday in the active language', () => {
    applyLang('es');
    const es = dayBars(days(1), NOW)[0].label;
    applyLang('en');
    const en = dayBars(days(1), NOW)[0].label;
    applyLang('es');
    expect(es.toLowerCase()).toStartWith('s');
    expect(en).toBe('Sat');
  });
});

describe('planRows', () => {
  const row = (key: string, output: number): TokenRow => ({ key, agents: 1, tokens: { turns: 1, input: 0, cacheRead: 0, cacheCreate: 0, output } });

  test('keeps the five biggest plans and folds the rest into others', () => {
    const rows = planRows([row('a', 10), row('b', 70), row('c', 30), row('d', 60), row('e', 20), row('f', 5), row('g', 1)]);
    expect(rows.map((r) => [r.key, r.tokens, r.other])).toEqual([
      ['b', 70, false],
      ['d', 60, false],
      ['c', 30, false],
      ['e', 20, false],
      ['a', 10, false],
      ['', 6, true],
    ]);
  });

  test('adds no others row for five plans or fewer', () => {
    expect(planRows([row('a', 1), row('b', 2)]).map((r) => r.key)).toEqual(['b', 'a']);
    expect(planRows([])).toEqual([]);
  });
});
