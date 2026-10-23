import { describe, expect, test } from 'bun:test';
import { topFlaky } from '../src/settings/flaky-checks-model';

const view = (check: string, flakyCount: number, lastAt: number) => ({ floor: 'mobile', check, flakyCount, lastAt, orders: 1 });

describe('topFlaky', () => {
  test('sorts by count then recency and keeps the top 10', () => {
    const views = [view('a', 1, 5), view('b', 3, 1), view('c', 3, 9), ...Array.from({ length: 12 }, (_, i) => view(`x${i}`, 1, i))];
    const top = topFlaky(views);
    expect(top).toHaveLength(10);
    expect(top.slice(0, 3).map((v) => v.check)).toEqual(['c', 'b', 'x11']);
  });
});
