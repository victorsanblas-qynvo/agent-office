import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server';
import { capSegments, parseTimelineHours, timeline, MAX_TIMELINE_AGENTS, MAX_TIMELINE_SEGMENTS } from '../src/timeline';
import { harness, type Harness } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function office(): Harness {
  h = harness();
  h.clock.now = NOW;
  return h;
}

function row(db: Harness['db'], ts: number, agent: string, floor: string | null, state: string | null): void {
  db.run("INSERT INTO activity_log (ts, agent_key, floor, event, state, summary) VALUES (?, ?, ?, 'e', ?, 's')", [ts, agent, floor, state]);
}

describe('timeline', () => {
  test('merges consecutive rows with the same state and ends the last segment at now', () => {
    const { db } = office();
    row(db, NOW - 3 * HOUR, 'dev', 'mobile', 'working');
    row(db, NOW - 2 * HOUR, 'dev', 'mobile', 'working');
    row(db, NOW - HOUR, 'dev', 'mobile', 'blocked');
    row(db, NOW - HOUR + 1000, 'dev', 'mobile', null);
    expect(timeline(db, 4, NOW)).toEqual([
      {
        agent: 'dev',
        floor: 'mobile',
        segments: [
          { from: NOW - 3 * HOUR, to: NOW - HOUR, state: 'working' },
          { from: NOW - HOUR, to: NOW, state: 'blocked' },
        ],
      },
    ]);
  });

  test('leaves out rows outside the window and sorts by floor then agent', () => {
    const { db } = office();
    row(db, NOW - 2 * HOUR, 'old', 'a', 'idle');
    row(db, NOW - 30 * 60_000, 'zed', 'a', 'idle');
    row(db, NOW - 30 * 60_000, 'amy', 'b', 'idle');
    row(db, NOW - 30 * 60_000, 'bob', 'a', 'idle');
    expect(timeline(db, 1, NOW).map((a) => `${a.floor}/${a.agent}`)).toEqual(['a/bob', 'a/zed', 'b/amy']);
  });

  test('caps agents', () => {
    const { db } = office();
    for (let i = 0; i < MAX_TIMELINE_AGENTS + 5; i += 1) row(db, NOW - 1000, `a${String(i).padStart(3, '0')}`, 'f', 'idle');
    expect(timeline(db, 1, NOW)).toHaveLength(MAX_TIMELINE_AGENTS);
  });

  test('caps segments by merging tiny ones into the previous', () => {
    const segments = [];
    for (let i = 0; i < MAX_TIMELINE_SEGMENTS + 100; i += 1) {
      segments.push({ from: i * 40_000, to: (i + 1) * 40_000, state: i % 2 ? 'working' : 'idle' });
    }
    expect(capSegments(segments).length).toBe(MAX_TIMELINE_SEGMENTS);
    const tiny = [{ from: 0, to: 100_000, state: 'idle' }];
    for (let i = 0; i < MAX_TIMELINE_SEGMENTS + 10; i += 1) {
      tiny.push({ from: 100_000 + i * 10_000, to: 110_000 + i * 10_000, state: i % 2 ? 'idle' : 'working' });
    }
    const capped = capSegments(tiny);
    expect(capped).toEqual([{ from: 0, to: 110_000 + (MAX_TIMELINE_SEGMENTS + 9) * 10_000, state: 'idle' }]);
  });

  test('validates hours', () => {
    expect(parseTimelineHours(undefined)).toBe(4);
    expect(parseTimelineHours('24')).toBe(24);
    for (const bad of ['0', '25', '-1', '1.5', 'x']) expect(parseTimelineHours(bad)).toBeNull();
  });
});

describe('GET /api/timeline', () => {
  function request(path: string, key = KEY) {
    const { office: o } = h!;
    const app = createApp({ office: o, port: PORT, key: () => KEY, publicDir: h!.root }, () => {});
    return app.request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, 'x-office-key': key } });
  }

  test('answers the window, 400 for bad hours, 401 without the credential', async () => {
    const { db } = office();
    row(db, NOW - 1000, 'dev', 'mobile', 'working');
    const ok = await request('/api/timeline?hours=2');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ hours: 2, agents: [{ agent: 'dev', floor: 'mobile', segments: [{ from: NOW - 1000, to: NOW, state: 'working' }] }] });
    const bad = await request('/api/timeline?hours=99');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.key).toBe('hub.api.timelineHours');
    expect((await request('/api/timeline', 'wrong')).status).toBe(401);
  });
});
