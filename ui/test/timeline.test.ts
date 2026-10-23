import { afterEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { readTableView } from '../src/table/history';
import { hourTicks, layoutSegments, readTimelineHours } from '../src/table/timeline-model';

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
