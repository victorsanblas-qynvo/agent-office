import { describe, expect, test } from 'bun:test';
import { neighbourStatus, nextCard } from '../src/board/columns';
import { applyLang } from '../src/i18n/index';
import { BINDINGS, keepsEnter, resolveKey, shouldRun, type KeyLike } from '../src/keys';

applyLang('es');

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

const columns = [['a1', 'a2', 'a3'], [], ['c1'], ['d1', 'd2']];

describe('nextCard', () => {
  test('down and up walk the column and clamp at its ends', () => {
    expect(nextCard(columns, 'a1', 'down')).toBe('a2');
    expect(nextCard(columns, 'a3', 'down')).toBe('a3');
    expect(nextCard(columns, 'a2', 'up')).toBe('a1');
    expect(nextCard(columns, 'a1', 'up')).toBe('a1');
  });

  test('right and left skip empty columns and keep the position, clamped', () => {
    expect(nextCard(columns, 'a2', 'right')).toBe('c1');
    expect(nextCard(columns, 'c1', 'right')).toBe('d1');
    expect(nextCard(columns, 'd2', 'left')).toBe('c1');
    expect(nextCard(columns, 'c1', 'left')).toBe('a1');
    expect(nextCard([['a1', 'a2', 'a3'], ['b1', 'b2']], 'a3', 'right')).toBe('b2');
  });

  test('stays put when there is no column further on', () => {
    expect(nextCard(columns, 'd2', 'right')).toBe('d2');
    expect(nextCard(columns, 'a1', 'left')).toBe('a1');
  });

  test('no current card, or one no longer shown, picks the first card', () => {
    expect(nextCard(columns, null, 'down')).toBe('a1');
    expect(nextCard(columns, 'gone', 'left')).toBe('a1');
    expect(nextCard([[], ['b1']], null, 'right')).toBe('b1');
  });

  test('nothing to highlight', () => {
    expect(nextCard([], null, 'down')).toBeNull();
    expect(nextCard([[], []], 'x', 'up')).toBeNull();
  });
});

describe('neighbourStatus', () => {
  test('previous and next column, none past the edges', () => {
    expect(neighbourStatus('en-curso', 'prev')).toBe('pendiente');
    expect(neighbourStatus('en-curso', 'next')).toBe('revision');
    expect(neighbourStatus('revision', 'next')).toBe('hecho');
    expect(neighbourStatus('pendiente', 'prev')).toBeNull();
    expect(neighbourStatus('hecho', 'next')).toBeNull();
    expect(neighbourStatus('descartado', 'next')).toBeNull();
  });
});

describe('board key routing', () => {
  test('letters, arrows, Enter and brackets resolve to board moves', () => {
    expect(resolveKey(press('j'))).toEqual({ type: 'board', move: 'down' });
    expect(resolveKey(press('ArrowUp'))).toEqual({ type: 'board', move: 'up' });
    expect(resolveKey(press('h'))).toEqual({ type: 'board', move: 'left' });
    expect(resolveKey(press('ArrowRight'))).toEqual({ type: 'board', move: 'right' });
    expect(resolveKey(press('Enter'))).toEqual({ type: 'board', move: 'open' });
    expect(resolveKey(press('['))).toEqual({ type: 'board', move: 'prev' });
    expect(resolveKey(press(']'))).toEqual({ type: 'board', move: 'next' });
    expect(resolveKey(press('j', { metaKey: true }))).toBeNull();
  });

  test('they run only on a ready Tablero, never while typing or under a dialog', () => {
    const action = { type: 'board', move: 'down' } as const;
    expect(shouldRun(action, { typing: false, modalOpen: false, boardReady: true })).toBe(true);
    expect(shouldRun(action, { typing: false, modalOpen: false, boardReady: false })).toBe(false);
    expect(shouldRun(action, { typing: true, modalOpen: false, boardReady: true })).toBe(false);
    expect(shouldRun(action, { typing: false, modalOpen: true, boardReady: true })).toBe(false);
  });

  test('Enter on a button or a link is left to it', () => {
    expect(keepsEnter({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(true);
    expect(keepsEnter({ tagName: 'a' } as unknown as EventTarget)).toBe(true);
    expect(keepsEnter({ tagName: 'BODY' } as unknown as EventTarget)).toBe(false);
    expect(keepsEnter(null)).toBe(false);
  });

  test('arrow aliases stay out of the help and every shown row is labelled', () => {
    const shown = BINDINGS.filter((binding) => binding.hidden !== true).map((binding) => binding.combo);
    expect(shown).toEqual(expect.arrayContaining(['j', 'k', 'h', 'l', 'Enter', '[', ']']));
    expect(shown.some((combo) => combo.startsWith('Arrow'))).toBe(false);
  });
});
