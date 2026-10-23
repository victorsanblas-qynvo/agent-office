import { flakyHits } from '../../../shared/flaky';
import type { CheckRunView } from '../types';

// Checks that failed and later passed on the same commit; a dirty run is not a commit, so it never counts.
export function flakyChecks(runs: readonly CheckRunView[]): Set<string> {
  return new Set(flakyHits(runs).map((hit) => hit.name));
}
