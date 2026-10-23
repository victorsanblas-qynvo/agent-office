import { describe, expect, test } from 'bun:test';
import type { QuestionView } from '../src/types';
import { SNOOZE_KEY, dueReminders, readContextWarn, writeContextWarn, readSnoozes, writeSnoozes, QUIET_DEFAULT, MUTED_FLOORS_KEY, floorMuted, readMutedFloors, inQuietHours, quietSilences, type QuietHours } from '../src/prefs';

const at = (hour: number, minute = 0): Date => new Date(2026, 9, 23, hour, minute);
const window = (from: string, to: string, extra: Partial<QuietHours> = {}): QuietHours => ({ ...QUIET_DEFAULT, enabled: true, from, to, ...extra });

describe('inQuietHours', () => {
  test('is off by default', () => {
    expect(QUIET_DEFAULT).toEqual({ enabled: false, from: '22:00', to: '08:00', allowPermissions: true });
    expect(inQuietHours(QUIET_DEFAULT, at(23))).toBe(false);
  });

  test('a disabled window is never quiet', () => {
    expect(inQuietHours(window('22:00', '08:00', { enabled: false }), at(23))).toBe(false);
  });

  test('same-day window: inside and outside', () => {
    const day = window('09:00', '17:00');
    expect(inQuietHours(day, at(12))).toBe(true);
    expect(inQuietHours(day, at(8, 59))).toBe(false);
    expect(inQuietHours(day, at(20))).toBe(false);
  });

  test('a window crossing midnight is quiet on both sides of it', () => {
    const night = window('22:00', '08:00');
    expect(inQuietHours(night, at(23))).toBe(true);
    expect(inQuietHours(night, at(3))).toBe(true);
    expect(inQuietHours(night, at(12))).toBe(false);
  });

  test('from is inclusive and to is exclusive', () => {
    const night = window('22:00', '08:00');
    expect(inQuietHours(night, at(22, 0))).toBe(true);
    expect(inQuietHours(night, at(21, 59))).toBe(false);
    expect(inQuietHours(night, at(7, 59))).toBe(true);
    expect(inQuietHours(night, at(8, 0))).toBe(false);
  });

  test('from equal to to is never quiet', () => {
    expect(inQuietHours(window('10:00', '10:00'), at(10))).toBe(false);
    expect(inQuietHours(window('10:00', '10:00'), at(3))).toBe(false);
  });
});

describe('quietSilences', () => {
  test('a permission passes only with the exception on', () => {
    expect(quietSilences(window('22:00', '08:00'), true, at(23))).toBe(false);
    expect(quietSilences(window('22:00', '08:00', { allowPermissions: false }), true, at(23))).toBe(true);
    expect(quietSilences(window('22:00', '08:00'), false, at(23))).toBe(true);
    expect(quietSilences(window('22:00', '08:00'), false, at(12))).toBe(false);
  });
});

describe('snoozes', () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

  test('round-trips and skips malformed entries', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    try {
      store.clear();
      writeSnoozes({ a: { until: 5, sig: 'x' }, b: { until: null, sig: 'y' } });
      expect(readSnoozes()).toEqual({ a: { until: 5, sig: 'x' }, b: { until: null, sig: 'y' } });
      store.set(SNOOZE_KEY, JSON.stringify({ a: { until: 'soon', sig: 'x' }, b: 3, c: { until: 1, sig: 'z' } }));
      expect(readSnoozes()).toEqual({ c: { until: 1, sig: 'z' } });
      store.set(SNOOZE_KEY, '[1]');
      expect(readSnoozes()).toEqual({});
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});

describe('dueReminders', () => {
  const MIN = 60_000;
  const open = (id: string, createdAt: number): QuestionView => ({ id, createdAt }) as QuestionView;
  const ids = (list: QuestionView[]): string[] => list.map((item) => item.id);

  test('a question open for the wait is due, a younger one is not', () => {
    const list = [open('old', 0), open('young', 6 * MIN)];
    expect(ids(dueReminders(list, 10 * MIN, 10, new Set()))).toEqual(['old']);
    expect(ids(dueReminders(list, 10 * MIN - 1, 10, new Set()))).toEqual([]);
  });

  test('one already reminded is skipped', () => {
    expect(dueReminders([open('a', 0)], 20 * MIN, 10, new Set(['a']))).toEqual([]);
  });

  test('a closed question is not in the list, so nothing is due', () => {
    expect(dueReminders([], 20 * MIN, 10, new Set())).toEqual([]);
  });

  test('0 turns the reminders off', () => {
    expect(dueReminders([open('a', 0)], 60 * MIN, 0, new Set())).toEqual([]);
  });
});

describe('context warning threshold', () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

  test('defaults to 85 and only accepts the listed options', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    try {
      store.clear();
      expect(readContextWarn()).toBe(85);
      writeContextWarn(90);
      expect(readContextWarn()).toBe(90);
      writeContextWarn(0);
      expect(readContextWarn()).toBe(0);
      writeContextWarn(77);
      expect(readContextWarn()).toBe(85);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});

describe('floorMuted', () => {
  test('silences a muted floor and nothing else', () => {
    expect(floorMuted(['mobile'], 'mobile', false)).toBe(true);
    expect(floorMuted(['mobile'], 'backend', false)).toBe(false);
    expect(floorMuted(['mobile'], null, false)).toBe(false);
    expect(floorMuted([], 'mobile', false)).toBe(false);
  });

  test('lets a permission request through', () => {
    expect(floorMuted(['mobile'], 'mobile', true)).toBe(false);
  });

  test('reads only a list of slugs', () => {
    const store = new Map<string, string>();
    Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
    expect(readMutedFloors()).toEqual([]);
    store.set(MUTED_FLOORS_KEY, '["mobile",3,"backend"]');
    expect(readMutedFloors()).toEqual(['mobile', 'backend']);
    store.set(MUTED_FLOORS_KEY, '{"mobile":true}');
    expect(readMutedFloors()).toEqual([]);
  });
});
