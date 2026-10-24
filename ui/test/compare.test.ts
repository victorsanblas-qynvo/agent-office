import { beforeEach, describe, expect, test } from 'bun:test';
import { compareOrders, fileSets } from '../src/board/compare-model';
import type { CompareSide } from '../src/board/compare-model';
import { applyLang } from '../src/i18n/index';
import type { OrderDiff } from '../src/types';
import { order } from './fixtures';

beforeEach(() => applyLang('es'));

const diffOf = (paths: string[], adds: number, dels: number): OrderDiff => ({
  base: 'aaaaaaa',
  head: 'bbbbbbb',
  files: paths.map((path) => ({ path, oldPath: null, adds: 1, dels: 0, binary: false })),
  totals: { files: paths.length, adds, dels },
  truncated: false,
});

describe('fileSets', () => {
  test('splits into only-a, only-b and both, sorted', () => {
    expect(fileSets(['b.ts', 'a.ts', 'c.ts'], ['c.ts', 'd.ts', 'a.ts'])).toEqual({ onlyA: ['b.ts'], onlyB: ['d.ts'], both: ['a.ts', 'c.ts'] });
  });

  test('repeats collapse and empty lists stay empty', () => {
    expect(fileSets(['a.ts', 'a.ts'], [])).toEqual({ onlyA: ['a.ts'], onlyB: [], both: [] });
    expect(fileSets([], [])).toEqual({ onlyA: [], onlyB: [], both: [] });
  });
});

describe('compareOrders', () => {
  const original: CompareSide = {
    order: order('uno', { status: 'revision', cycle: 2, createdAt: 0, checks: { status: 'passed', passed: 3, total: 3, sha: null, touched: [], forced: false } }),
    diff: diffOf(['a.ts', 'b.ts'], 10, 2),
    spend: { tokens: 12_000, byModel: [], byRole: [], sessions: 2, basis: 'plan+folder' },
  };
  const fork: CompareSide = {
    order: order('dos', { id: 2, status: 'en-curso', createdAt: 3_600_000, checks: { status: 'failed', passed: 1, total: 3, sha: null, touched: [], forced: false } }),
    diff: diffOf(['b.ts'], 1, 0),
    spend: null,
  };

  test('one row per fact, in order, with both sides', () => {
    const rows = compareOrders(original, fork, 7_200_000);
    expect(rows.map((row) => row.key)).toEqual(['status', 'cycle', 'diff', 'checks', 'spend', 'age']);
    expect(rows[0]).toMatchObject({ a: 'Revisión', b: 'En curso' });
    expect(rows[1]).toMatchObject({ a: '2', b: '1' });
    expect(rows[2]).toMatchObject({ a: 'Ficheros: 2 · +10 −2', b: 'Ficheros: 1 · +1 −0' });
    expect(rows[3]).toMatchObject({ a: 'Pasan 3/3', b: 'Fallan (1/3 pasan)' });
    expect(rows[4]!.b).toBe('—');
    expect(rows[4]!.a).toStartWith('≈ ');
  });

  test('missing data shows a dash', () => {
    const rows = compareOrders({ order: order('x'), diff: null, spend: null }, { order: order('y'), diff: null, spend: null }, 5000);
    expect(rows.find((row) => row.key === 'diff')).toMatchObject({ a: '—', b: '—' });
    expect(rows.find((row) => row.key === 'checks')).toMatchObject({ a: '—', b: '—' });
  });
});
