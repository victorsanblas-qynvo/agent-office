import { describe, expect, test } from 'bun:test';
import { NOTES_LIMIT, NOTE_MAX, noteTitle, parseNotes, setNote } from '../src/notes';
import { TRANSFER_KEYS, collectPrefs } from '../src/settings/prefs-transfer';
import { buildEntries, searchEntries } from '../src/palette/entries';
import { applyLang } from '../src/i18n/index';
import { agent, order } from './fixtures';

describe('parseNotes', () => {
  test('keeps valid notes and drops malformed ones', () => {
    const raw = {
      'order:a': { text: 'hola', updatedAt: 5 },
      'agent:b': { text: 'x', updatedAt: 'no' },
      'floor:c': { text: 'y', updatedAt: 1 },
      'order:': { text: 'y', updatedAt: 1 },
      'order:d': { text: '   ', updatedAt: 1 },
      'order:e': 'text',
    };
    expect(parseNotes(raw)).toEqual({ 'order:a': { text: 'hola', updatedAt: 5 }, 'agent:b': { text: 'x', updatedAt: 0 } });
    expect(parseNotes(null)).toEqual({});
    expect(parseNotes([1])).toEqual({});
  });

  test('clips long texts and keeps the newest past the cap', () => {
    const raw: Record<string, unknown> = { 'order:long': { text: 'a'.repeat(NOTE_MAX + 10), updatedAt: NOTES_LIMIT + 5 } };
    for (let i = 0; i < NOTES_LIMIT + 4; i += 1) raw[`order:n${i}`] = { text: 't', updatedAt: i };
    const notes = parseNotes(raw);
    expect(Object.keys(notes)).toHaveLength(NOTES_LIMIT);
    expect(notes['order:long']!.text).toHaveLength(NOTE_MAX);
    expect(notes['order:n0']).toBeUndefined();
    expect(notes[`order:n${NOTES_LIMIT + 3}`]).toBeDefined();
  });
});

describe('setNote', () => {
  test('sets, replaces and deletes without touching the input', () => {
    const empty = {};
    const one = setNote(empty, 'order:a', 'uno', 10);
    expect(one).toEqual({ 'order:a': { text: 'uno', updatedAt: 10 } });
    expect(empty).toEqual({});
    expect(setNote(one, 'order:a', 'dos', 20)['order:a']).toEqual({ text: 'dos', updatedAt: 20 });
    expect(setNote(one, 'order:a', '  \n', 30)).toEqual({});
  });

  test('past the cap the oldest note falls off', () => {
    let notes = {};
    for (let i = 0; i < NOTES_LIMIT; i += 1) notes = setNote(notes, `agent:k${i}`, 't', i + 1);
    notes = setNote(notes, 'agent:new', 't', 1000);
    expect(Object.keys(notes)).toHaveLength(NOTES_LIMIT);
    expect(notes).not.toHaveProperty('agent:k0');
    expect(notes).toHaveProperty('agent:new');
  });

  test('a key that is neither an order nor an agent is refused', () => {
    expect(setNote({}, 'x', 'hola', 1)).toEqual({});
  });
});

describe('noteTitle', () => {
  test('is the first line with something on it, cut when long', () => {
    expect(noteTitle('\n  primera  \nsegunda')).toBe('primera');
    expect(noteTitle('')).toBe('');
    const title = noteTitle('x'.repeat(100));
    expect(title).toHaveLength(60);
    expect(title.endsWith('...')).toBe(true);
  });
});

describe('palette and transfer', () => {
  const notes = { 'order:o1': { text: 'Hablar con Marta del login\nsegunda', updatedAt: 2 }, 'agent:gone': { text: 'x', updatedAt: 1 } };
  const context = {
    agents: [agent('lead-mobile')],
    floors: [],
    documents: [],
    orders: [order('o1', { title: 'Login' })],
    tabs: [],
    live: true,
    reply: null,
    status: null,
    relaunch: null,
    relaunchAll: 0,
    statusAll: 0,
    messageAll: 0,
    pins: [],
    notes,
    newOrder: false,
    focus: null,
    mute: false,
    muteSound: false,
    searches: [],
    recent: [],
  };

  test('a note of an existing order is an entry, and its text is searched as typed', () => {
    applyLang('es');
    const entries = buildEntries(context).filter((entry) => entry.group === 'note');
    expect(entries.map((entry) => entry.id)).toEqual(['note:order:o1']);
    expect(entries[0]!.label).toBe('Nota: Login');
    expect(entries[0]!.hint).toBe('Hablar con Marta del login');
    expect(searchEntries(buildEntries(context), 'marta').map((result) => result.entry.id)).toContain('note:order:o1');
    expect(searchEntries(buildEntries(context), 'zzmartaa').map((result) => result.entry.id)).not.toContain('note:order:o1');
  });

  test('the notes travel with the exported preferences, repaired', () => {
    expect(TRANSFER_KEYS).toContain('agent-office.notes');
    const storage = { getItem: (key: string) => (key === 'agent-office.notes' ? JSON.stringify({ ...notes, 'bad:x': { text: 'y', updatedAt: 1 } }) : null), setItem: () => undefined };
    expect(collectPrefs(storage)['agent-office.notes']).toEqual(notes);
  });
});
