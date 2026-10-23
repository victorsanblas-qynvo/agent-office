import { afterEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { defaultPair, orderedPair, roundName, roundOptionText } from '../src/panel/rounds-model';
import type { DocumentRound } from '../src/types';

const sha = (c: string): string => c.repeat(40);
const rounds: DocumentRound[] = [
  { sha: sha('c'), at: 1_000_000, subject: 'redaccion: login descartado' },
  { sha: sha('b'), at: 900_000, subject: 'redaccion: login ronda 2', round: 2 },
  { sha: sha('a'), at: 800_000, subject: 'redaccion: login ronda 1', round: 1 },
];

afterEach(() => applyLang('es'));

describe('rounds model', () => {
  test('names a round by its number, or by the short sha when the commit carries none', () => {
    expect(roundName(rounds[1]!)).toBe('Ronda 2');
    expect(roundName(rounds[0]!)).toBe('ccccccc');
    applyLang('en');
    expect(roundName(rounds[2]!)).toBe('Round 1');
  });

  test('the option reads name, relative date and subject', () => {
    expect(roundOptionText(rounds[1]!, 900_000 + 3 * 3_600_000)).toBe('Ronda 2 · hace 3 h · redaccion: login ronda 2');
  });

  test('the default pair is the last two rounds, oldest first, and needs two', () => {
    expect(defaultPair(rounds)).toEqual({ from: sha('b'), to: sha('c') });
    expect(defaultPair(rounds.slice(0, 1))).toBeNull();
    expect(defaultPair([])).toBeNull();
  });

  test('a pick is ordered older to newer in whichever select it was made, and the same round twice is none', () => {
    expect(orderedPair(rounds, sha('c'), sha('a'))).toEqual({ from: sha('a'), to: sha('c') });
    expect(orderedPair(rounds, sha('a'), sha('c'))).toEqual({ from: sha('a'), to: sha('c') });
    expect(orderedPair(rounds, sha('a'), sha('a'))).toBeNull();
    expect(orderedPair(rounds, sha('a'), sha('z'))).toBeNull();
  });
});
