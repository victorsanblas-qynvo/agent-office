import { describe, expect, test } from 'bun:test';
import { CRITERIA_MAX_CHARS, CRITERIA_MAX_ITEMS, criteriaMarkdown, criteriaOf, criteriaProgress, criterionHash } from '../src/board/criteria';

describe('criteriaOf', () => {
  test('splits on semicolons and stops at fuera', () => {
    expect(criteriaOf('Hace algo — criterios: uno; dos ; tres — fuera: cuatro')).toEqual(['uno', 'dos', 'tres']);
  });

  test('splits on newlines and bullets', () => {
    expect(criteriaOf('criterios:\nuno\ndos\n• tres • cuatro')).toEqual(['uno', 'dos', 'tres', 'cuatro']);
  });

  test('strips dash list markers', () => {
    expect(criteriaOf('criterios:\n- uno\n- dos-tres\n* cuatro')).toEqual(['uno', 'dos-tres', 'cuatro']);
  });

  test('splits numbered items on one line or several', () => {
    expect(criteriaOf('criterios: 1. uno 2. dos 3) tres')).toEqual(['uno', 'dos', 'tres']);
    expect(criteriaOf('criterios:\n1) uno\n2. dos')).toEqual(['uno', 'dos']);
  });

  test('mixes separators and drops empties', () => {
    expect(criteriaOf('criterios: - uno;; 2. dos\n\n• tres;')).toEqual(['uno', 'dos', 'tres']);
  });

  test('returns nothing without a criterios part', () => {
    expect(criteriaOf('Hace algo — fuera: nada')).toEqual([]);
    expect(criteriaOf('criterios:   ')).toEqual([]);
  });

  test('caps the count and the length', () => {
    const many = Array.from({ length: 40 }, (_, i) => `c${i}`).join(';');
    expect(criteriaOf(`criterios: ${many}`)).toHaveLength(CRITERIA_MAX_ITEMS);
    expect(criteriaOf(`criterios: ${'x'.repeat(500)}`)[0]).toHaveLength(CRITERIA_MAX_CHARS);
  });
});

describe('criterionHash', () => {
  test('is stable and ignores surrounding and repeated whitespace', () => {
    expect(criterionHash('a  b')).toBe(criterionHash(' a b '));
    expect(criterionHash('a b')).not.toBe(criterionHash('a c'));
    expect(criterionHash('a b')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('checklist output', () => {
  const items = ['uno', 'dos', 'tres'];
  const ticks = new Set([criterionHash('uno'), criterionHash('tres')]);

  test('markdown marks ticked items', () => {
    expect(criteriaMarkdown(items, ticks)).toBe('- [x] uno\n- [ ] dos\n- [x] tres');
  });

  test('progress counts ticked items', () => {
    expect(criteriaProgress(items, ticks)).toBe('2/3');
    expect(criteriaProgress(items, new Set())).toBe('0/3');
  });
});
