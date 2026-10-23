import type { OfficeApi } from './api';
import { readJson, writeJson } from './prefs';
import type { Store } from './store';
import type { UsageSummary } from './types';

export const FLOOR_BUDGETS_KEY = 'agent-office.floorBudgets';
export const BUDGET_MAX = 1e12;
export const BUDGET_REFRESH_MS = 5 * 60_000;

export type FloorBudgets = Record<string, number>;

const SHORTHAND = /^(\d+(?:[.,]\d+)?)\s*([kKmM])?$/;

function validBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= BUDGET_MAX;
}

// "2M", "500k", "1.5m" or a plain number of tokens; anything else (or zero, or too large) is no budget.
export function parseTokenShorthand(text: string): number | null {
  const match = SHORTHAND.exec(text.trim());
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const scale = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1;
  const value = Math.round(Number(match[1].replace(',', '.')) * scale);
  return validBudget(value) ? value : null;
}

// The inverse for the settings input: whole millions and thousands keep their short form.
export function formatTokenShorthand(tokens: number): string {
  if (tokens % 1e6 === 0) return `${tokens / 1e6}M`;
  if (tokens % 1e3 === 0) return `${tokens / 1e3}k`;
  return String(tokens);
}

export function readFloorBudgets(): FloorBudgets {
  return normalizeFloorBudgets(readJson(FLOOR_BUDGETS_KEY));
}

export function normalizeFloorBudgets(raw: unknown): FloorBudgets {
  const budgets: FloorBudgets = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return budgets;
  for (const [slug, value] of Object.entries(raw)) if (validBudget(value)) budgets[slug] = value;
  return budgets;
}

export function writeFloorBudgets(budgets: FloorBudgets): void {
  const kept: FloorBudgets = {};
  for (const [slug, value] of Object.entries(budgets)) if (validBudget(value)) kept[slug] = value;
  writeJson(FLOOR_BUDGETS_KEY, kept);
}

export function hasBudgets(budgets: FloorBudgets): boolean {
  return Object.keys(budgets).length > 0;
}

// Only while some floor has a budget, and never twice at once or before the refresh time.
export function shouldFetchBudgets(budgets: FloorBudgets, now: number, loadedAt: number | null, loading: boolean): boolean {
  if (!hasBudgets(budgets) || loading) return false;
  return loadedAt === null || now - loadedAt >= BUDGET_REFRESH_MS;
}

export type BudgetSpend = { summary: UsageSummary; at: number };

let latest: BudgetSpend | null = null;
let loading = false;

// Today's spend by floor, as last fetched here or by the Tabla's usage block.
export function budgetSpend(): BudgetSpend | null {
  return latest;
}

export function adoptTodaySummary(summary: UsageSummary, at: number): void {
  latest = { summary, at };
}

export function floorSpendOf(summary: UsageSummary | null): Record<string, number> {
  const spend: Record<string, number> = {};
  for (const row of summary?.byFloor ?? []) spend[row.key] = row.tokens.input + row.tokens.cacheRead + row.tokens.cacheCreate + row.tokens.output;
  return spend;
}

export function mountBudgetWatch(store: Store, api: OfficeApi): void {
  store.watch(['tick'], () => {
    const now = store.now();
    if (!shouldFetchBudgets(readFloorBudgets(), now, latest?.at ?? null, loading)) return;
    loading = true;
    void api.usageSummary('today').then((result) => {
      loading = false;
      if (result.ok) adoptTodaySummary(result.data, store.now());
      else if (latest) latest = { ...latest, at: store.now() };
    });
  });
}
