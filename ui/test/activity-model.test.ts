import { beforeEach, describe, expect, test } from 'bun:test';
import { activityPath, activityTerms, orderTimeline, TIMELINE_CAP } from '../src/board/activity-model';
import { applyLang } from '../src/i18n/index';
import type { CheckRunView, CheckpointView, SearchHit } from '../src/types';
import { order } from './fixtures';

beforeEach(() => applyLang('es'));

const hit = (id: string, ts: number, text: string, agent: string | null = null): SearchHit => ({ kind: 'activity', id, ts, floor: 'api', agent, sessionId: null, text });
const run = (id: number, startedAt: number): CheckRunView => ({ id, orderId: 1, sha: 'abcdef123456', trigger: 'listo', status: 'passed', startedAt, endedAt: null, checks: [] });
const point = (id: number, createdAt: number): CheckpointView => ({ id, sha: '1234567890ab', reason: 'listo', label: 'antes', createdAt });

const o = order('alpha', { createdAt: 1000 });

describe('orderTimeline', () => {
  test('merges the three sources newest first', () => {
    const rows = orderTimeline([hit('1', 1500, 'edita', 'k1')], [run(1, 2000)], [point(1, 1800)], o, (key) => `label-${key}`);
    expect(rows.map((r) => r.kind)).toEqual(['run', 'checkpoint', 'event']);
    expect(rows[2]).toEqual({ ts: 1500, kind: 'event', who: 'label-k1', text: 'edita' });
    expect(rows[0]!.text).toContain('abcdef1');
    expect(rows[1]!.text).toContain('1234567');
  });

  test('drops repeated (ts, text) pairs', () => {
    const rows = orderTimeline([hit('1', 1500, 'edita'), hit('2', 1500, 'edita'), hit('3', 1500, 'otra')], [], [], o);
    expect(rows.map((r) => r.text).sort()).toEqual(['edita', 'otra']);
  });

  test('caps the timeline', () => {
    const hits = Array.from({ length: TIMELINE_CAP + 50 }, (_, i) => hit(String(i), 1000 + i, `t${i}`));
    const rows = orderTimeline(hits, [], [], o);
    expect(rows).toHaveLength(TIMELINE_CAP);
    expect(rows[0]!.ts).toBe(1000 + TIMELINE_CAP + 49);
  });

  test('ignores what happened before the order existed', () => {
    const rows = orderTimeline([hit('1', 999, 'viejo'), hit('2', 1000, 'justo')], [run(1, 500)], [point(1, 10)], o);
    expect(rows.map((r) => r.text)).toEqual(['justo']);
  });

  test('empty inputs give no rows', () => {
    expect(orderTimeline([], [], [], o)).toEqual([]);
  });
});

describe('activityPath and activityTerms', () => {
  test('filters by floor, creation and term', () => {
    const path = activityPath(o, 'encargo/alpha');
    const params = new URL(`http://x${path}`).searchParams;
    expect(params.get('q')).toBe('encargo/alpha');
    expect(params.get('floor')).toBe(o.floor);
    expect(params.get('from')).toBe('1000');
  });

  test('slug and branch, once when equal', () => {
    expect(activityTerms({ slug: 'alpha', branch: 'encargo/alpha' })).toEqual(['alpha', 'encargo/alpha']);
    expect(activityTerms({ slug: 'alpha', branch: null })).toEqual(['alpha']);
  });
});
