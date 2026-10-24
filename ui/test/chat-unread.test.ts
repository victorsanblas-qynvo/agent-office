import { describe, expect, test } from 'bun:test';
import type { ChatMessageView } from '../src/types';
import { addressesUser, filterMessages, firstUnreadIndex, normalizeChatRead, splitHighlight, unreadCounts } from '../src/chat/unread';

const message = (id: number, extra: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id,
  ts: id * 1000,
  channel: 'global',
  floor: 'mobile',
  authorKey: 'a',
  authorName: 'Ana',
  role: null,
  roleId: null,
  origin: 'agent',
  kind: 'texto',
  text: 'hola',
  files: [],
  ...extra,
});

describe('unreadCounts', () => {
  test('counts agent messages after the last read id, per channel', () => {
    const messages = [message(1), message(2), message(3, { channel: 'mobile' }), message(4, { origin: 'user' }), message(5)];
    const counts = unreadCounts(messages, { global: 1 });
    expect(counts.get('global')).toBe(2);
    expect(counts.get('mobile')).toBe(1);
    expect(unreadCounts(messages, { global: 5, mobile: 3 }).size).toBe(0);
  });
});

describe('firstUnreadIndex', () => {
  test('finds the first agent message after the marker', () => {
    const messages = [message(1), message(2, { origin: 'user' }), message(3), message(4)];
    expect(firstUnreadIndex(messages, 1)).toBe(2);
    expect(firstUnreadIndex(messages, 0)).toBe(0);
    expect(firstUnreadIndex(messages, 4)).toBe(-1);
  });
});

describe('normalizeChatRead', () => {
  const known = new Set(['global', 'mobile']);
  test('drops unknown channels and bad ids', () => {
    expect(normalizeChatRead({ global: 3, nope: 4, mobile: -1 }, known)).toEqual({ global: 3 });
    expect(normalizeChatRead({ global: 1.5 }, known)).toEqual({});
    expect(normalizeChatRead(['global'], known)).toEqual({});
    expect(normalizeChatRead(null, known)).toEqual({});
  });

  test('keeps at most 50 channels', () => {
    const many = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const out = normalizeChatRead(Object.fromEntries(many.map((c, i) => [c, i])), new Set(many));
    expect(Object.keys(out)).toHaveLength(50);
    expect(out.c59).toBe(59);
  });
});

describe('filterMessages', () => {
  const messages = [message(1, { text: 'Revisión lista' }), message(2, { authorName: 'Óscar', text: 'nada' }), message(3, { text: 'otra cosa' })];
  test('matches text and author without case or accents', () => {
    expect(filterMessages(messages, 'revision').map((m) => m.id)).toEqual([1]);
    expect(filterMessages(messages, 'OSCAR').map((m) => m.id)).toEqual([2]);
  });

  test('an empty query keeps everything', () => {
    expect(filterMessages(messages, '  ')).toHaveLength(3);
  });
});

describe('splitHighlight', () => {
  test('cuts the original text around accent-insensitive matches', () => {
    expect(splitHighlight('La Revisión de revision', 'revisión')).toEqual([
      { text: 'La ', match: false },
      { text: 'Revisión', match: true },
      { text: ' de ', match: false },
      { text: 'revision', match: true },
    ]);
  });

  test('no match or empty query is one plain segment', () => {
    expect(splitHighlight('abc', 'z')).toEqual([{ text: 'abc', match: false }]);
    expect(splitHighlight('abc', '')).toEqual([{ text: 'abc', match: false }]);
  });

  test('the segments always rebuild the text', () => {
    const text = 'Ñandú café CAFÉ 😀 cafe';
    expect(splitHighlight(text, 'cafe').map((s) => s.text).join('')).toBe(text);
  });
});

describe('addressesUser', () => {
  test('questions and @usuario mentions from agents', () => {
    expect(addressesUser(message(1, { kind: 'pregunta' }))).toBe(true);
    expect(addressesUser(message(1, { text: 'ojo @Usuario, mira' }))).toBe(true);
    expect(addressesUser(message(1, { text: 'hey @user' }))).toBe(true);
    expect(addressesUser(message(1, { text: '@usuarios' }))).toBe(false);
    expect(addressesUser(message(1, { origin: 'user', text: '@usuario' }))).toBe(false);
  });
});
