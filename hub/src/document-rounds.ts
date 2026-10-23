import { MAX_PATCH_BYTES, capPatch } from './delivery-desk';
import type { GitRunner } from './git';
import { pathspecPath, validSha } from './repo-ops';
import type { DocumentRound, DocumentRoundDiff, HubText } from './types';

const GIT_TIMEOUT_MS = 15_000;
const MAX_ROUNDS = 50;
const PATCH_READ_BYTES = MAX_PATCH_BYTES + 64 * 1024;
const ROUND_SUBJECT = /\bronda (\d+)$/;

export type RoundsFailure = { ok: false; status: 400 | 404 | 500; error: HubText };
export type RoundsResult = { ok: true; rounds: DocumentRound[] } | RoundsFailure;
export type RoundDiffResult = { ok: true; diff: DocumentRoundDiff } | RoundsFailure;

const failure = (status: RoundsFailure['status'], key: 'hub.api.roundSha' | 'hub.api.roundsFailed'): RoundsFailure => ({ ok: false, status, error: { key } });

export function parseRounds(stdout: string): DocumentRound[] {
  const rounds: DocumentRound[] = [];
  for (const line of stdout.split('\n')) {
    const [sha, ts, ...rest] = line.split('\x1f');
    if (!sha || !validSha(sha) || !ts) continue;
    const subject = rest.join('\x1f');
    const round = ROUND_SUBJECT.exec(subject)?.[1];
    rounds.push({ sha, at: Number(ts) * 1000, subject, ...(round ? { round: Number(round) } : {}) });
  }
  return rounds;
}

async function history(git: GitRunner, root: string, path: string): Promise<DocumentRound[] | null> {
  const log = await git(
    root,
    ['log', `--max-count=${MAX_ROUNDS}`, '--format=%H%x1f%ct%x1f%s', '--', `:(literal)${pathspecPath(path)}`],
    GIT_TIMEOUT_MS,
  );
  return log.code === 0 ? parseRounds(log.stdout) : null;
}

export async function documentRounds(git: GitRunner, root: string, path: string): Promise<RoundsResult> {
  const rounds = await history(git, root, path);
  return rounds ? { ok: true, rounds } : failure(500, 'hub.api.roundsFailed');
}

function resolve(rounds: DocumentRound[], sha: string): string | null {
  const hits = rounds.filter((r) => r.sha.startsWith(sha));
  return hits.length === 1 ? (hits[0]?.sha ?? null) : null;
}

export async function documentRoundDiff(git: GitRunner, root: string, path: string, from: string, to: string): Promise<RoundDiffResult> {
  if (!validSha(from) || !validSha(to)) return failure(400, 'hub.api.roundSha');
  const rounds = await history(git, root, path);
  if (!rounds) return failure(500, 'hub.api.roundsFailed');
  const a = resolve(rounds, from);
  const b = resolve(rounds, to);
  if (!a || !b) return failure(400, 'hub.api.roundSha');
  const diff = await git(
    root,
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', a, b, '--', `:(literal)${pathspecPath(path)}`],
    GIT_TIMEOUT_MS,
    undefined,
    { maxStdoutBytes: PATCH_READ_BYTES },
  );
  if (diff.code !== 0) return failure(500, 'hub.api.roundsFailed');
  const capped = capPatch(diff.stdout);
  return { ok: true, diff: { path, from: a, to: b, patch: capped.patch, truncated: capped.truncated || diff.cut === true } };
}
