import { afterEach, describe, expect, test } from 'bun:test';
import { spendLine, spendTitle } from '../src/board/spend';
import { applyLang } from '../src/i18n';
import { SPEND_REFRESH_MS, dayBars, planRows, spendDue } from '../src/table/usage-block';
import type { OrderSpend, TokenRow } from '../src/types';


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

afterEach(() => applyLang('es'));

const ORDER_SPEND: OrderSpend = {
  tokens: 1_234_567,
  byModel: [
    { model: 'claude-sonnet-5-5', tokens: 1_000_000 },
    { model: 'claude-opus-5-5', tokens: 234_567 },
  ],
  byRole: [
    { role: 'dev', tokens: 1_000_000 },
    { role: '', tokens: 234_567 },
  ],
  sessions: 3,
  basis: 'plan+folder',
};

describe('spendLine', () => {
  test('writes the tokens and the sessions in the language', () => {
    applyLang('es');
    expect(spendLine(ORDER_SPEND)).toBe('≈ 1,2 M tokens · 3 sesiones');
    expect(spendLine({ ...ORDER_SPEND, tokens: 52_000, sessions: 1 })).toBe('≈ 52,0 K tokens · 1 sesión');
    applyLang('en');
    expect(spendLine(ORDER_SPEND)).toBe('≈ 1.2 M tokens · 3 sessions');
  });

  test('shows nothing for an order that cost nothing', () => {
    expect(spendLine({ ...ORDER_SPEND, tokens: 0, sessions: 0 })).toBeNull();
  });
});

describe('spendTitle', () => {
  test('lists models and roles from the biggest and says how it was attributed', () => {
    applyLang('es');
    const lines = spendTitle(ORDER_SPEND, 'login').split('\n');
    expect(lines[0]).toBe('Por modelo: claude-sonnet-5-5 1,0 M · claude-opus-5-5 235 K');
    expect(lines[1]).toBe('Por rol: dev 1,0 M · ? 235 K');
    expect(lines[2]).toContain('encargo/login');
  });
});
