export type FlakyRun = { id: number; sha: string; startedAt: number; checks: readonly { name: string; status: string }[] };

export type FlakyHit = { name: string; sha: string; at: number };

const FAILED = new Set(['failed', 'timeout']);

// Checks that failed and later passed on the same commit, once per commit and check; a dirty run is not a commit, so it never counts.
export function flakyHits(runs: readonly FlakyRun[]): FlakyHit[] {
  const hits: FlakyHit[] = [];
  const failedOn = new Set<string>();
  const reported = new Set<string>();
  const ordered = runs.filter((run) => !run.sha.endsWith('-dirty')).sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  for (const run of ordered) {
    for (const check of run.checks) {
      const key = `${run.sha}\n${check.name}`;
      if (FAILED.has(check.status)) failedOn.add(key);
      else if (check.status === 'passed' && failedOn.has(key) && !reported.has(key)) {
        reported.add(key);
        hits.push({ name: check.name, sha: run.sha, at: run.startedAt });
      }
    }
  }
  return hits;
}
