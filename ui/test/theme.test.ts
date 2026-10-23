import { describe, expect, test } from 'bun:test';
import { effectiveTheme, THEME_DEFAULT, THEME_OPTIONS } from '../src/theme';

describe('effectiveTheme', () => {
  test('auto follows the system', () => {
    expect(effectiveTheme('auto', true)).toBe('dark');
    expect(effectiveTheme('auto', false)).toBe('light');
  });

  test('light and dark ignore the system', () => {
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
  });

  test('the default is auto and all three are offered', () => {
    expect(THEME_DEFAULT).toBe('auto');
    expect(THEME_OPTIONS).toEqual(['auto', 'light', 'dark']);
  });
});
