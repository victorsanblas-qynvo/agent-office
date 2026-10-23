import { describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { BINDINGS, comboOf, dismissTopLayer, displayCombo, isTypingTarget, resolveKey, shouldRun, type KeyLike } from '../src/keys';
import { TABS } from '../src/topbar';

applyLang('es');

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

describe('isTypingTarget', () => {
  test('fields where the user types', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  test('everything else', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('comboOf', () => {
  test('plain keys and shifted letters', () => {
    expect(comboOf(press('n'))).toBe('n');
    expect(comboOf(press('N', { shiftKey: true }))).toBe('shift+n');
    expect(comboOf(press('3'))).toBe('3');
    expect(comboOf(press('/'))).toBe('/');
    expect(comboOf(press('?', { shiftKey: true }))).toBe('?');
    expect(comboOf(press('Escape'))).toBe('esc');
  });

  test('Cmd and Ctrl both count as mod, Alt cancels', () => {
    expect(comboOf(press('k', { metaKey: true }))).toBe('mod+k');
    expect(comboOf(press('K', { ctrlKey: true, shiftKey: true }))).toBe('mod+k');
    expect(comboOf(press('n', { altKey: true }))).toBeNull();
  });
});

describe('resolveKey', () => {
  test('finds the action of each binding', () => {
    expect(resolveKey(press('k', { metaKey: true }))).toEqual({ type: 'palette' });
    expect(resolveKey(press('k', { ctrlKey: true }))).toEqual({ type: 'palette' });
    expect(resolveKey(press('n'))).toEqual({ type: 'need', step: 1 });
    expect(resolveKey(press('N', { shiftKey: true }))).toEqual({ type: 'need', step: -1 });
    expect(resolveKey(press('/'))).toEqual({ type: 'history' });
    expect(resolveKey(press('o'))).toEqual({ type: 'orders' });
    expect(resolveKey(press('?', { shiftKey: true }))).toEqual({ type: 'help' });
    expect(resolveKey(press('Escape'))).toEqual({ type: 'escape' });
  });

  test('digits go to the tabs in TABS order, the Tablero included', () => {
    expect(TABS.map((entry) => entry.tab)).toContain('board');
    TABS.forEach((_, index) => expect(resolveKey(press(String(index + 1)))).toEqual({ type: 'tab', index }));
    expect(resolveKey(press(String(TABS.length + 1)))).toBeNull();
    expect(resolveKey(press('0'))).toBeNull();
  });

  test('browser shortcuts with a modifier are left alone', () => {
    expect(resolveKey(press('n', { metaKey: true }))).toBeNull();
    expect(resolveKey(press('1', { ctrlKey: true }))).toBeNull();
    expect(resolveKey(press('o', { metaKey: true }))).toBeNull();
    expect(resolveKey(press('z'))).toBeNull();
  });
});

describe('shouldRun', () => {
  const free = { typing: false, modalOpen: false, boardReady: false };

  test('Cmd+K and Esc work anywhere', () => {
    expect(shouldRun({ type: 'palette' }, { typing: true, modalOpen: true, boardReady: false })).toBe(true);
    expect(shouldRun({ type: 'escape' }, { typing: true, modalOpen: true, boardReady: false })).toBe(true);
  });

  test('single keys wait while typing', () => {
    for (const action of [{ type: 'need', step: 1 }, { type: 'tab', index: 0 }, { type: 'history' }, { type: 'orders' }, { type: 'help' }] as const) {
      expect(shouldRun(action, { typing: true, modalOpen: false, boardReady: false })).toBe(false);
      expect(shouldRun(action, free)).toBe(true);
    }
  });

  test('a dialog blocks everything but the help toggle', () => {
    const modal = { typing: false, modalOpen: true, boardReady: false };
    expect(shouldRun({ type: 'help' }, modal)).toBe(true);
    expect(shouldRun({ type: 'need', step: 1 }, modal)).toBe(false);
    expect(shouldRun({ type: 'tab', index: 2 }, modal)).toBe(false);
  });
});

describe('dismissTopLayer', () => {
  test('closes only the first layer that is open, in priority order', () => {
    const closed: string[] = [];
    const layer = (name: string, open: boolean) => () => {
      if (!open) return false;
      closed.push(name);
      return true;
    };
    expect(dismissTopLayer([layer('palette', false), layer('help', true), layer('menu', true), layer('viewer', true)])).toBe(true);
    expect(closed).toEqual(['help']);
    expect(dismissTopLayer([layer('palette', false), layer('help', false)])).toBe(false);
  });
});

describe('the binding table', () => {
  test('no combo is repeated and every row has a label', () => {
    const combos = BINDINGS.map((binding) => binding.combo);
    expect(new Set(combos).size).toBe(combos.length);
    for (const binding of BINDINGS) expect(binding.label().trim()).not.toBe('');
  });

  test('has one row per tab, named after the tab', () => {
    const rows = BINDINGS.filter((binding) => binding.action.type === 'tab');
    expect(rows).toHaveLength(TABS.length);
    expect(rows[2].label()).toContain('Tablero');
  });

  test('combos are shown the way each platform writes them', () => {
    expect(displayCombo('mod+k', true)).toBe('⌘K');
    expect(displayCombo('mod+k', false)).toBe('Ctrl+K');
    expect(displayCombo('shift+n', false)).toBe('Shift+N');
    expect(displayCombo('esc', true)).toBe('Esc');
    expect(displayCombo('?', false)).toBe('?');
  });
});
