import type { Database } from 'bun:sqlite';
import { SAMPLE_RETENTION_MS } from './usage';

const DAY_MS = 86_400_000;
export const PRUNE_CHUNK = 5000;

const RULES: readonly [table: string, where: string][] = [
  ['events', 'ts < ?'],
  ['edits', 'ts < ?'],
  ['verdicts', "ts < ? AND kind = 'tests'"],
  ['messages', 'ts < ?'],
  ['gate_decisions', 'ts < ?'],
  ['alerts', 'ts < ?'],
  ['chat_messages', 'ts < ?'],
  ['questions', "created_at < ? AND status != 'pending'"],
  ['tasks', 'updated_at < ?'],
  ['token_usage', 'updated_at < ?'],
  ['token_cursor', 'updated_at < ?'],
  ['agents', 'COALESCE(ended_at, updated_at) < ?'],
  ['sessions', 'COALESCE(ended_at, updated_at) < ?'],
  ['reports', 'updated_at < ? AND role_id IS NULL'],
  ['activity_log', 'ts < ?'],
];

// The output of a check is the bulkiest thing a run keeps: past the retention it goes, the result stays.
const CLEAR_OUTPUT = 'UPDATE checks SET output_tail = NULL WHERE output_tail IS NOT NULL AND run_id IN (SELECT id FROM check_runs WHERE started_at < ?)';

// The full-text index is created apart from the migrations (it may not exist, or FTS5 may be missing).
function pruneSearch(db: Database, cutoff: number): void {
  try {
    db.query('DELETE FROM search_fts WHERE ts < ?').run(cutoff);
  } catch {}
}
// Samples of the limit forecast live a fixed eight days, whatever the retention of the rest.
const DROP_SAMPLES = 'DELETE FROM usage_samples WHERE ts < ?';

export function prune(db: Database, now: number, retentionDays: number): number {
  const cutoff = now - retentionDays * DAY_MS;
  let removed = 0;
  for (const [table, where] of RULES) removed += db.query(`DELETE FROM ${table} WHERE ${where}`).run(cutoff).changes;
  removed += db.query(CLEAR_OUTPUT).run(cutoff).changes;
  pruneSearch(db, cutoff);
  removed += db.query(DROP_SAMPLES).run(now - SAMPLE_RETENTION_MS).changes;
  return removed;
}

// The same rules in slices: a year of events in one statement holds the loop (and every hook waiting on it) for seconds.
export async function pruneInChunks(
  db: Database,
  now: number,
  retentionDays: number,
  opts: { chunk?: number; yieldLoop?: () => Promise<void> } = {},
): Promise<number> {
  const cutoff = now - retentionDays * DAY_MS;
  const chunk = Math.max(1, Math.floor(opts.chunk ?? PRUNE_CHUNK));
  const yieldLoop = opts.yieldLoop ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let removed = 0;
  for (const [table, where] of RULES) {
    const statement = db.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${chunk})`);
    for (;;) {
      const { changes } = statement.run(cutoff);
      removed += changes;
      if (changes < chunk) break;
      await yieldLoop();
    }
  }
  removed += db.query(CLEAR_OUTPUT).run(cutoff).changes;
  pruneSearch(db, cutoff);
  removed += db.query(DROP_SAMPLES).run(now - SAMPLE_RETENTION_MS).changes;
  return removed;
}
