import { afterEach, beforeEach, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { chipSignature, floorHeaderChips, type FloorHeaderInputs } from '../src/panel/floor-header';

beforeEach(() => applyLang('es'));
afterEach(() => applyLang('es'));

const quiet: FloorHeaderInputs = { score: { open: 0, red: 0, blocked: 0 }, spent: null, budget: null, muted: false, focused: false };
const kinds = (inputs: FloorHeaderInputs): string[] => floorHeaderChips(inputs).map((chip) => chip.kind);

test('a quiet floor has no chips', () => {
  expect(kinds(quiet)).toEqual([]);
  expect(kinds({ ...quiet, score: null })).toEqual([]);
});

test('open work, red checks and blocked agents get their own chip', () => {
  const chips = floorHeaderChips({ ...quiet, score: { open: 3, red: 1, blocked: 2 } });
  expect(chips.map((chip) => [chip.kind, chip.label, chip.tone])).toEqual([
    ['open', '3 abiertos', 'plain'],
    ['red', '1 en rojo', 'danger'],
    ['blocked', '2 bloqueados', 'danger'],
  ]);
  expect(chips.every((chip) => chip.action)).toBe(true);
});

test('spend shows tokens alone without a budget and the percentage with one', () => {
  expect(floorHeaderChips({ ...quiet, spent: 1500 })[0]).toMatchObject({ kind: 'spend', label: '1,5 K', tone: 'plain' });
  expect(floorHeaderChips({ ...quiet, spent: 1500, budget: 2000 })[0]).toMatchObject({ label: '1,5 K · 75 %', tone: 'plain' });
  expect(floorHeaderChips({ ...quiet, spent: 1700, budget: 2000 })[0]?.tone).toBe('warn');
  expect(floorHeaderChips({ ...quiet, spent: 2000, budget: 2000 })[0]?.tone).toBe('danger');
  expect(kinds({ ...quiet, spent: 0, budget: 2000 })).toEqual([]);
});

test('muted and focused floors get indicators that are not buttons', () => {
  const chips = floorHeaderChips({ ...quiet, muted: true, focused: true });
  expect(chips.map((chip) => [chip.kind, chip.action])).toEqual([
    ['muted', false],
    ['focus', false],
  ]);
});

test('the signature changes with the chips and with the language', () => {
  const inputs = { ...quiet, score: { open: 1, red: 0, blocked: 0 } };
  const before = chipSignature(floorHeaderChips(inputs));
  expect(chipSignature(floorHeaderChips(inputs))).toBe(before);
  expect(chipSignature(floorHeaderChips({ ...inputs, score: { open: 2, red: 0, blocked: 0 } }))).not.toBe(before);
  applyLang('en');
  expect(chipSignature(floorHeaderChips(inputs))).not.toBe(before);
});
