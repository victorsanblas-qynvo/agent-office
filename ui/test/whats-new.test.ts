import { beforeEach, describe, expect, test } from 'bun:test';
import { en } from '../src/i18n/en';
import { applyLang } from '../src/i18n/index';
import { es } from '../src/i18n/es';
import { buildEntries, type PaletteContext } from '../src/palette/entries';
import { WHATS_NEW, WHATS_NEW_VERSION, shouldShowWhatsNew } from '../src/whats-new';

beforeEach(() => applyLang('es'));

describe('the content', () => {
  test('every section title and item key exists in both languages with text', () => {
    for (const section of WHATS_NEW) {
      for (const key of [section.title, ...section.items]) {
        expect(es[key]?.trim()).toBeTruthy();
        expect(en[key]?.trim()).toBeTruthy();
      }
    }
  });

  test('keys are not repeated and sections are not empty', () => {
    const keys = WHATS_NEW.flatMap((section) => [section.title, ...section.items]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(WHATS_NEW.every((section) => section.items.length > 0)).toBe(true);
    expect(new Set(WHATS_NEW.map((section) => section.id)).size).toBe(WHATS_NEW.length);
  });

  test('every item sits under its own section', () => {
    for (const section of WHATS_NEW) {
      expect(section.title).toBe(`whatsNew.${section.id}.title` as typeof section.title);
      for (const key of section.items) expect(key.startsWith(`whatsNew.${section.id}.`)).toBe(true);
    }
  });
});

describe('shouldShowWhatsNew', () => {
  test('unseen or stale, live: opens', () => {
    expect(shouldShowWhatsNew(null, true)).toBe(true);
    expect(shouldShowWhatsNew('2026-01-01', true)).toBe(true);
    expect(shouldShowWhatsNew(42, true)).toBe(true);
  });

  test('seen this version: stays closed', () => {
    expect(shouldShowWhatsNew(WHATS_NEW_VERSION, true)).toBe(false);
  });

  test('in a replay it never opens by itself', () => {
    expect(shouldShowWhatsNew(null, false)).toBe(false);
  });
});

describe('the palette', () => {
  const context: PaletteContext = {
    agents: [],
    notes: {},
    floors: [],
    documents: [],
    orders: [],
    tabs: [],
    live: false,
    reply: null,
    status: null,
    relaunch: null,
    relaunchAll: 0,
    statusAll: 0,
    messageAll: 0,
    pins: [],
    newOrder: false,
    focus: null,
    mute: false,
    muteSound: false,
    searches: [],
    recent: [],
  };

  test('offers Novedades, also in a replay', () => {
    for (const live of [true, false]) {
      const entry = buildEntries({ ...context, live }).find((item) => item.id === 'action:whatsNew');
      expect(entry?.label).toBe('Novedades');
      expect(entry?.target).toEqual({ type: 'whatsNew' });
    }
  });
});
