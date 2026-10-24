import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSFER_KEYS, planImport } from '../src/settings/prefs-transfer';
import { CONTRAST_DEFAULT, CONTRAST_KEY, CONTRAST_OPTIONS, effectiveContrast, normalizeContrast } from '../src/contrast';

const CSS = readFileSync(join(import.meta.dir, '..', 'src', 'styles.css'), 'utf8');

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// WCAG relative luminance of a #rrggbb colour.
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// The custom properties of the rule that opens with this exact selector.
function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf('{', start) + 1, CSS.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
  return out;
}

const HIGH = ':root[data-contrast="high"]';
const VARIANTS: Record<string, string> = {
  light: `${HIGH}[data-theme="light"]`,
  dark: `${HIGH}[data-theme="dark"]`,
};

describe('contrast ratio', () => {
  test('matches the WCAG extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.6);
  });
});

describe('high contrast tokens', () => {
  for (const [name, selector] of Object.entries(VARIANTS)) {
    test(`${name}: text, muted and border meet the thresholds on the background`, () => {
      const t = tokens(selector);
      expect(contrastRatio(t['--text']!, t['--bg']!)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(t['--muted']!, t['--bg']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['--border']!, t['--bg']!)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t['--focus']!, t['--bg']!)).toBeGreaterThanOrEqual(3);
    });

    test(`${name}: state colours and accent text stay readable`, () => {
      const t = tokens(selector);
      for (const key of ['--danger', '--ok', '--asking', '--accent']) expect(contrastRatio(t[key]!, t['--bg']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['--accent-text']!, t['--accent']!)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('the automatic variants repeat the explicit ones', () => {
    expect(tokens(`${HIGH}:not([data-theme="light"])`)).toEqual(tokens(VARIANTS.dark!));
    expect(tokens(`${HIGH}:not([data-theme="dark"])`)).toEqual(tokens(VARIANTS.light!));
  });

  test('the focus ring is 2px with a 2px offset', () => {
    expect(CSS).toContain(`${HIGH} :focus-visible`);
    expect(CSS).toMatch(/outline: 2px solid var\(--focus\);\s*outline-offset: 2px;/);
  });
});

describe('contrast preference', () => {
  test('auto follows the system, the others ignore it', () => {
    expect(effectiveContrast('auto', true)).toBe('high');
    expect(effectiveContrast('auto', false)).toBe('normal');
    expect(effectiveContrast('high', false)).toBe('high');
    expect(effectiveContrast('normal', true)).toBe('normal');
  });

  test('normalizes unknown values to auto', () => {
    expect(CONTRAST_DEFAULT).toBe('auto');
    expect(CONTRAST_OPTIONS).toEqual(['auto', 'high', 'normal']);
    expect(normalizeContrast('neon')).toBe('auto');
    expect(normalizeContrast('high')).toBe('high');
  });

  test('travels with the exported preferences and rejects unknown values', () => {
    expect(TRANSFER_KEYS).toContain(CONTRAST_KEY);
    const doc = (value: unknown): string => JSON.stringify({ format: 'agent-office-prefs', version: 1, exportedAt: 'x', prefs: { [CONTRAST_KEY]: value } });
    const storage = { getItem: () => null, setItem: () => {} };
    expect(planImport(doc('high'), storage).apply.map((item) => item.value)).toEqual(['high']);
    expect(planImport(doc('neon'), storage).skipped).toEqual([{ key: CONTRAST_KEY, reason: 'invalid' }]);
  });
});
