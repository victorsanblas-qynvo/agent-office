import { describe, expect, test } from 'bun:test';
import { QUIET_DEFAULT, inQuietHours, quietSilences, type QuietHours } from '../src/prefs';

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
