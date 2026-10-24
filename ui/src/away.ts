import { isBlockedText, isDoneText, isTracked, type DeliveryContext } from './deliveries';
import { plural } from './i18n';
import { readJson, writeJson } from './prefs';
import type { CheckRunStatus, SearchHit } from './types';

export const LAST_SEEN_KEY = 'agent-office.lastSeen';
export const LAST_SEEN_SAVE_MS = 60_000;
export const AWAY_MIN_MS = 30 * 60_000;
export const AWAY_MAX_MS = 7 * 24 * 60 * 60_000;

export type AwayKind = 'delivery' | 'blocked' | 'checks' | 'notices';

export const AWAY_KINDS: readonly AwayKind[] = ['delivery', 'blocked', 'checks', 'notices'];

export type AwayInputs = {
  // BLOQUEADO and HECHO messages found in the history.
  messages: readonly { ts: number; kind: 'blocked' | 'done' }[];
  // Ends of orders and plans that reached the panel.
  finished: readonly { ts: number }[];
  checks: readonly { endedAt: number | null; status: CheckRunStatus }[];
  notices: readonly { at: number }[];
};

export type AwaySummary = { since: number; elapsedMs: number; counts: Record<AwayKind, number> };

export function readLastSeen(): number | null {
  const raw = readJson(LAST_SEEN_KEY);
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function writeLastSeen(now: number): void {
  writeJson(LAST_SEEN_KEY, now);
}

// Pure: whether the panel was left long enough to deserve a summary; a replay never has one.
export function shouldSummarize(lastSeen: number | null, now: number, replay: boolean): boolean {
  if (replay || lastSeen === null || !Number.isFinite(lastSeen)) return false;
  return lastSeen <= now && now - lastSeen >= AWAY_MIN_MS;
}

// Pure: what happened since lastSeen (at most a week back), or null when nothing did.
export function awaySummary(inputs: AwayInputs, lastSeen: number, now: number): AwaySummary | null {
  const since = Math.max(lastSeen, now - AWAY_MAX_MS);
  const within = (ts: number | null): boolean => ts !== null && ts >= since && ts <= now;
  const counts: Record<AwayKind, number> = {
    delivery: inputs.finished.filter((item) => within(item.ts)).length + inputs.messages.filter((item) => item.kind === 'done' && within(item.ts)).length,
    blocked: inputs.messages.filter((item) => item.kind === 'blocked' && within(item.ts)).length,
    checks: inputs.checks.filter((run) => run.status === 'failed' && within(run.endedAt)).length,
    notices: inputs.notices.filter((item) => within(item.at)).length,
  };
  if (AWAY_KINDS.every((kind) => counts[kind] === 0)) return null;
  return { since, elapsedMs: now - since, counts };
}

// Pure: the message hits that are a BLOQUEADO or a HECHO a user would count (a lead's HECHO on a floor with orders is counted by its end).
export function awayMessages(hits: readonly SearchHit[], context: DeliveryContext): { ts: number; kind: 'blocked' | 'done' }[] {
  const out: { ts: number; kind: 'blocked' | 'done' }[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (hit.kind !== 'message' || typeof hit.text !== 'string' || seen.has(hit.id)) continue;
    seen.add(hit.id);
    if (isBlockedText(hit.text)) {
      out.push({ ts: hit.ts, kind: 'blocked' });
      continue;
    }
    const lead = hit.agent === null ? undefined : context.agents.get(hit.agent);
    if (isDoneText(hit.text) && lead !== undefined && lead.roleKind === 'lead' && !isTracked(context, lead.key)) out.push({ ts: hit.ts, kind: 'done' });
  }
  return out;
}

const PART_KEYS = {
  delivery: 'away.delivery',
  blocked: 'away.blocked',
  checks: 'away.checks',
  notices: 'away.notices',
} as const;

// Pure: the parts of the summary line, only the kinds that are not zero.
export function awayParts(summary: AwaySummary): { kind: AwayKind; text: string }[] {
  return AWAY_KINDS.filter((kind) => summary.counts[kind] > 0).map((kind) => ({ kind, text: plural(PART_KEYS[kind], summary.counts[kind]) }));
}
