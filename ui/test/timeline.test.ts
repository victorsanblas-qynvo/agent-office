import { afterEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { readTableView } from '../src/table/history';
import { timelineAgentName } from '../src/table/timeline';
import type { Store } from '../src/store';
import { hourTicks, layoutSegments, readTimelineHours, segmentFilters } from '../src/table/timeline-model';

afterEach(() => applyLang('es'));

const MIN = 60_000;
const FROM = new Date(2026, 9, 24, 10, 0, 0).getTime();
const TO = FROM + 60 * MIN;

describe('layoutSegments', () => {
  test('places segments in whole pixels with a title', () => {
    applyLang('es');
    const [placed] = layoutSegments([{ from: FROM + 15 * MIN, to: FROM + 45 * MIN, state: 'working' }], FROM, TO, 600);
    expect(placed).toEqual({ left: 150, width: 300, state: 'working', title: 'Trabajando · 10:15–10:45 · 30 min' });
  });

  test('clips to the window and drops what is outside', () => {
    const placed = layoutSegments(
      [
        { from: FROM - 30 * MIN, to: FROM - 10 * MIN, state: 'idle' },
        { from: FROM - 30 * MIN, to: FROM + 30 * MIN, state: 'blocked' },
        { from: TO - 10 * MIN, to: TO + 10 * MIN, state: 'done' },
      ],
      FROM,
      TO,
      600,
    );
    expect(placed.map((p) => [p.left, p.width, p.state])).toEqual([
      [0, 300, 'blocked'],
      [500, 100, 'done'],
    ]);
  });

  test('never narrower than 1 px and rounds', () => {
    const placed = layoutSegments(
      [
        { from: FROM + 10 * MIN, to: FROM + 10 * MIN + 1000, state: 'idle' },
        { from: FROM + 20 * MIN + 10_000, to: FROM + 30 * MIN, state: 'working' },
      ],
      FROM,
      TO,
      100,
    );
    expect(placed.map((p) => [p.left, p.width])).toEqual([
      [17, 1],
      [34, 16],
    ]);
  });

  test('empty window gives nothing', () => {
    expect(layoutSegments([{ from: 0, to: 10, state: 'idle' }], FROM, FROM, 100)).toEqual([]);
  });
});

describe('timeline helpers', () => {
  test('hour ticks sit on full hours', () => {
    expect(hourTicks(FROM - 30 * MIN, TO, 180)).toEqual([
      { left: 60, label: '10:00' },
      { left: 180, label: '11:00' },
    ]);
  });

  test('hours and view are read defensively', () => {
    expect(readTimelineHours(8)).toBe(8);
    expect(readTimelineHours(5)).toBe(4);
    expect(readTableView('timeline')).toBe('timeline');
  });
});

describe('timelineAgentName', () => {
  const store = { agents: new Map([['abcdef123456', { key: 'abcdef123456', name: 'dev-mobile', role: 'office-dev-mobile' }]]) } as unknown as Store;

  test('shows the name of a known agent and the start of the key of an unknown one', () => {
    expect(timelineAgentName(store, 'abcdef123456')).toBe('dev-mobile');
    expect(timelineAgentName(store, 'ffff00001111aaaa')).toBe('ffff0000');
  });
});

describe('segmentFilters', () => {
  test('filters the history by the agent and the local days of the segment', () => {
    const filters = segmentFilters('abcdef123456', { from: new Date(2026, 9, 23, 23, 30).getTime(), to: new Date(2026, 9, 24, 0, 15).getTime() });
    expect(filters).toEqual({ q: '', floor: '', agent: 'abcdef123456', kind: '', from: '2026-10-23', to: '2026-10-24' });
  });

  test('a segment inside one day gives the same day twice', () => {
    expect(segmentFilters('a', { from: FROM, to: TO })).toMatchObject({ from: '2026-10-24', to: '2026-10-24' });
  });
});
