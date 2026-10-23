import { t } from '../i18n';
import { relativeTime } from '../time';
import type { DocumentRound } from '../types';

const SHORT_SHA = 7;

export type RoundPair = { from: string; to: string };

export function roundName(round: DocumentRound): string {
  return round.round === undefined ? round.sha.slice(0, SHORT_SHA) : t('deliverables.rounds.round', { n: round.round });
}

export function roundOptionText(round: DocumentRound, now: number): string {
  return `${roundName(round)} · ${relativeTime(round.at, now)} · ${round.subject}`;
}

// The two newest rounds, oldest first, as the diff reads: what the last round changed.
export function defaultPair(rounds: readonly DocumentRound[]): RoundPair | null {
  const [newest, previous] = rounds;
  return newest && previous ? { from: previous.sha, to: newest.sha } : null;
}

// Rounds come newest first. The older pick is always the origin, whichever select it was made in; the same round twice compares nothing.
export function orderedPair(rounds: readonly DocumentRound[], a: string, b: string): RoundPair | null {
  const ia = rounds.findIndex((round) => round.sha === a);
  const ib = rounds.findIndex((round) => round.sha === b);
  if (ia < 0 || ib < 0 || ia === ib) return null;
  const [older, newer] = ia > ib ? [a, b] : [b, a];
  return { from: older, to: newer };
}
