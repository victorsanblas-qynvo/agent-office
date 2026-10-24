import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { en } from '../src/i18n/en';
import { applyLang } from '../src/i18n/index';
import { es } from '../src/i18n/es';
import { MOTION_DEFAULT, MOTION_KEY, MOTION_OPTIONS, MotionStore, effectiveMotion, normalizeMotion } from '../src/motion';
import { buildEntries, type PaletteContext } from '../src/palette/entries';
import { TRANSFER_KEYS, planImport } from '../src/settings/prefs-transfer';

beforeEach(() => applyLang('es'));

const SRC = join(import.meta.dir, '..', 'src');

describe('effectiveMotion', () => {
  test('auto follows the system', () => {
    expect(effectiveMotion('auto', true)).toBe('reduced');
    expect(effectiveMotion('auto', false)).toBe('full');
  });

  test('reduced and full ignore the system', () => {
    expect(effectiveMotion('reduced', false)).toBe('reduced');
    expect(effectiveMotion('full', true)).toBe('full');
  });

  test('the default is auto, all three are offered and bad values fall back', () => {
    expect(MOTION_DEFAULT).toBe('auto');
    expect(MOTION_OPTIONS).toEqual(['auto', 'reduced', 'full']);
    expect(normalizeMotion('reduced')).toBe('reduced');
    expect(normalizeMotion('slow')).toBe('auto');
    expect(normalizeMotion(3)).toBe('auto');
  });
});

describe('MotionStore', () => {
  test('reduced() follows the preference and listeners hear changes', () => {
    const store = new MotionStore('full');
    let heard = 0;
    store.subscribe(() => (heard += 1));
    expect(store.reduced()).toBe(false);
    store.set('reduced');
    expect(store.reduced()).toBe(true);
    expect(heard).toBe(1);
  });
});

describe('palette', () => {
  test('it offers the three motion actions in both languages', () => {
    const context: PaletteContext = { agents: [], floors: [], documents: [], orders: [], tabs: [], live: false, reply: null, status: null, relaunch: null, relaunchAll: 0, statusAll: 0, messageAll: 0, pins: [], newOrder: false, focus: null, mute: false, muteSound: false, searches: [], recent: [], notes: {} };
    const entries = buildEntries(context).filter((entry) => entry.target.type === 'motion');
    expect(entries.map((entry) => entry.label)).toEqual(['Movimiento: automático', 'Movimiento: reducido', 'Movimiento: completo']);
    expect(entries.some((entry) => entry.write)).toBe(false);
    for (const option of MOTION_OPTIONS) {
      expect(es[`palette.action.motion.${option}`]).toBeTruthy();
      expect(en[`palette.action.motion.${option}`]).toBeTruthy();
    }
  });
});

describe('stylesheets', () => {
  test('the data-motion rules sit beside the media query, which the full preference overrides', () => {
    const styles = readFileSync(join(SRC, 'styles.css'), 'utf8');
    const scene = readFileSync(join(SRC, 'scene', 'scene.css'), 'utf8');
    for (const css of [styles, scene]) {
      expect(css).toContain(':root[data-motion="reduced"]');
      expect(css).toContain(':root:not([data-motion="full"])');
    }
  });
});

describe('prefs transfer', () => {
  const doc = (prefs: unknown): string => JSON.stringify({ format: 'agent-office-prefs', version: 1, exportedAt: 'x', prefs });
  const storage = { getItem: () => null, setItem: () => undefined };

  test('the key is allowlisted, accepts a valid value and rejects a bad one', () => {
    expect(TRANSFER_KEYS).toContain(MOTION_KEY);
    const good = planImport(doc({ [MOTION_KEY]: 'reduced' }), storage);
    expect(good.apply.map((item) => item.key)).toEqual([MOTION_KEY]);
    const bad = planImport(doc({ [MOTION_KEY]: 'slow' }), storage);
    expect(bad.apply).toEqual([]);
    expect(bad.skipped).toEqual([{ key: MOTION_KEY, reason: 'invalid' }]);
  });
});
