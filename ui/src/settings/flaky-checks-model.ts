import type { FlakyCheckView } from '../types';

export const FLAKY_DAYS = 14;
export const FLAKY_TOP = 10;

// The worst offenders first, as many as the block shows.
export function topFlaky(views: readonly FlakyCheckView[], limit = FLAKY_TOP): FlakyCheckView[] {
  return [...views].sort((a, b) => b.flakyCount - a.flakyCount || b.lastAt - a.lastAt || a.check.localeCompare(b.check)).slice(0, limit);
}
