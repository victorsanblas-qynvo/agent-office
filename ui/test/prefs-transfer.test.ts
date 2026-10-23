import { describe, expect, test } from 'bun:test';
import { PANEL_STORAGE_KEY } from '../src/auth';
import { PINS_KEY, QUIET_KEY, HUNG_KEY, SNOOZE_KEY, MUTED_FLOORS_KEY } from '../src/prefs';
import { THEME_KEY } from '../src/theme';
import { FLOOR_BUDGETS_KEY } from '../src/budgets';
import { NOTICES_KEY } from '../src/notice-log';
import { BRIEF_DRAFT_KEY } from '../src/panel/brief-compose';
import { TRANSFER_KEYS, applyImport, collectPrefs, exportPrefs, overwrittenKeys, planImport } from '../src/settings/prefs-transfer';

class FakeStorage {
  readonly data = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.data.set(key, value);
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const doc = (prefs: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ format: 'agent-office-prefs', version: 1, exportedAt: 'x', prefs, ...extra });

describe('collectPrefs', () => {
  test('exports only allowlisted keys, parsed, and never the panel token', () => {
    const storage = new FakeStorage({
      [PANEL_STORAGE_KEY]: 'secret-token',
      [THEME_KEY]: '"dark"',
      [PINS_KEY]: '["a","b"]',
      [SNOOZE_KEY]: '{"n1":{"until":null,"sig":"s"}}',
      [NOTICES_KEY]: '[]',
      [BRIEF_DRAFT_KEY]: '{}',
      'agent-office.other': '1',
    });
    expect(collectPrefs(storage)).toEqual({ [THEME_KEY]: 'dark', [PINS_KEY]: ['a', 'b'] });
    const text = exportPrefs(storage, new Date(Date.UTC(2026, 9, 24)));
    expect(text).not.toContain('secret-token');
    expect(JSON.parse(text)).toMatchObject({ format: 'agent-office-prefs', version: 1, exportedAt: '2026-10-24T00:00:00.000Z' });
  });

  test('the allowlist holds neither the token nor session data', () => {
    for (const key of [PANEL_STORAGE_KEY, SNOOZE_KEY, NOTICES_KEY, BRIEF_DRAFT_KEY, 'agent-office.focusFloor', 'agent-office.criteria.x']) expect(TRANSFER_KEYS).not.toContain(key);
  });

  test('a malformed stored value is left out', () => {
    const storage = new FakeStorage({ [HUNG_KEY]: '7', [PINS_KEY]: 'not json' });
    expect(collectPrefs(storage)).toEqual({});
  });
});

describe('planImport', () => {
  test('rejects a wrong format, version or shape', () => {
    const storage = new FakeStorage();
    expect(planImport('nope', storage).errors).toEqual(['json']);
    expect(planImport(JSON.stringify({ format: 'other', version: 1, prefs: {} }), storage).errors).toEqual(['format']);
    expect(planImport(JSON.stringify({ format: 'agent-office-prefs', version: 2, prefs: {} }), storage).errors).toEqual(['version']);
    expect(planImport(JSON.stringify({ format: 'agent-office-prefs', version: 1, prefs: [] }), storage).errors).toEqual(['prefs']);
  });

  test('skips unknown keys and the token', () => {
    const plan = planImport(doc({ [PANEL_STORAGE_KEY]: 'x', 'agent-office.nope': 1, toString: 1, [THEME_KEY]: 'light' }), new FakeStorage());
    expect(plan.apply.map((item) => item.key)).toEqual([THEME_KEY]);
    expect(plan.skipped).toEqual([
      { key: PANEL_STORAGE_KEY, reason: 'unknown' },
      { key: 'agent-office.nope', reason: 'unknown' },
      { key: 'toString', reason: 'unknown' },
    ]);
  });

  test('drops invalid values with the same readers the app uses', () => {
    const plan = planImport(doc({ [HUNG_KEY]: 7, [THEME_KEY]: 'neon', [PINS_KEY]: 'a', [MUTED_FLOORS_KEY]: ['f', 3], [FLOOR_BUDGETS_KEY]: { a: 5, b: -1 }, [QUIET_KEY]: { enabled: true, from: '25:00', to: '06:30' } }), new FakeStorage());
    expect(plan.skipped).toEqual([
      { key: HUNG_KEY, reason: 'invalid' },
      { key: THEME_KEY, reason: 'invalid' },
      { key: PINS_KEY, reason: 'invalid' },
    ]);
    expect(Object.fromEntries(plan.apply.map((item) => [item.key, item.value]))).toEqual({
      [MUTED_FLOORS_KEY]: ['f'],
      [FLOOR_BUDGETS_KEY]: { a: 5 },
      [QUIET_KEY]: { enabled: true, from: '22:00', to: '06:30', allowPermissions: true },
    });
  });

  test('lists what it would overwrite and writes on apply', () => {
    const storage = new FakeStorage({ [THEME_KEY]: '"dark"', [PINS_KEY]: '["a"]' });
    const plan = planImport(doc({ [THEME_KEY]: 'light', [PINS_KEY]: ['a'], [MUTED_FLOORS_KEY]: ['f'] }), storage);
    expect(overwrittenKeys(plan)).toEqual([THEME_KEY]);
    applyImport(plan, storage);
    expect(storage.getItem(THEME_KEY)).toBe('"light"');
    expect(storage.getItem(MUTED_FLOORS_KEY)).toBe('["f"]');
    expect(storage.getItem(PANEL_STORAGE_KEY)).toBeNull();
  });
});
