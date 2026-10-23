import { t } from '../i18n';
import { hubText } from '../i18n/hub';
import type { CheckRunView, CheckpointView, OrderView, SearchHit } from '../types';

export const TIMELINE_CAP = 200;

export type TimelineKind = 'event' | 'run' | 'checkpoint';
export type TimelineRow = { ts: number; kind: TimelineKind; who: string; text: string };

// Pure: the path of GET /api/search for what one order left in the office: its floor, from its creation, matching a term.
export function activityPath(order: Pick<OrderView, 'floor' | 'createdAt'>, term: string): string {
  const params = new URLSearchParams();
  params.set('q', term);
  params.set('floor', order.floor);
  params.set('from', String(order.createdAt));
  params.set('limit', '100');
  return `/api/search?${params.toString()}`;
}

// Pure: the terms to look for, the slug and the branch when there is one.
export function activityTerms(order: Pick<OrderView, 'slug' | 'branch'>): string[] {
  return order.branch && order.branch !== order.slug ? [order.slug, order.branch] : [order.slug];
}

// Pure: search hits, check runs and checkpoints of one order as a single timeline, newest first.
export function orderTimeline(
  hits: readonly SearchHit[],
  runs: readonly CheckRunView[],
  checkpoints: readonly CheckpointView[],
  order: Pick<OrderView, 'createdAt'>,
  agentLabel: (key: string) => string = (key) => key,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const hit of hits) {
    rows.push({ ts: hit.ts, kind: 'event', who: hit.agent ? agentLabel(hit.agent) : '', text: hubText(hit.text) });
  }
  for (const run of runs) {
    rows.push({
      ts: run.startedAt,
      kind: 'run',
      who: '',
      text: `${t(`board.checks.run.${run.status}`)} · ${t(`board.trigger.${run.trigger}`)} · ${run.sha.slice(0, 7)}`,
    });
  }
  for (const point of checkpoints) {
    rows.push({ ts: point.createdAt, kind: 'checkpoint', who: '', text: `${point.sha.slice(0, 7)} · ${point.label} · ${point.reason}` });
  }
  const seen = new Set<string>();
  return rows
    .filter((row) => row.ts >= order.createdAt)
    .sort((a, b) => b.ts - a.ts)
    .filter((row) => {
      const key = `${row.ts}\u0000${row.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, TIMELINE_CAP);
}
