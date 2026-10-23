import type { CheckRunView } from '../types';

const FAILED = new Set(['failed', 'timeout']);

// Checks that failed and later passed on the same commit; a dirty run is not a commit, so it never counts.
export function flakyChecks(runs: readonly CheckRunView[]): Set<string> {
  const flaky = new Set<string>();
  const failedOn = new Set<string>();
  const ordered = runs.filter((run) => !run.sha.endsWith('-dirty')).sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  for (const run of ordered) {
    for (const check of run.checks) {
      const key = `${run.sha}\n${check.name}`;
      if (FAILED.has(check.status)) failedOn.add(key);
      else if (check.status === 'passed' && failedOn.has(key)) flaky.add(check.name);
    }
  }
  return flaky;
}
