import { readJson, writeJson } from './prefs';

export const NOTES_KEY = 'agent-office.notes';
export const NOTES_LIMIT = 200;
export const NOTE_MAX = 4000;
export const NOTE_TITLE_MAX = 60;
export const NOTE_SAVE_MS = 500;

export interface Note {
  text: string;
  updatedAt: number;
}

// Private notes by subject: "order:<slug>" or "agent:<key>".
export type Notes = Record<string, Note>;

export const orderNoteKey = (slug: string): string => `order:${slug}`;
export const agentNoteKey = (key: string): string => `agent:${key}`;

function validKey(key: string): boolean {
  return (key.startsWith('order:') && key.length > 6) || (key.startsWith('agent:') && key.length > 6);
}

function capped(notes: Notes): Notes {
  const keys = Object.keys(notes);
  if (keys.length <= NOTES_LIMIT) return notes;
  const newest = keys.sort((a, b) => notes[b]!.updatedAt - notes[a]!.updatedAt).slice(0, NOTES_LIMIT);
  const kept = new Set(newest);
  return Object.fromEntries(Object.entries(notes).filter(([key]) => kept.has(key)));
}

// Drops malformed entries, clips long texts and keeps the newest NOTES_LIMIT.
export function parseNotes(raw: unknown): Notes {
  const notes: Notes = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return notes;
  for (const [key, value] of Object.entries(raw)) {
    if (!validKey(key) || typeof value !== 'object' || value === null) continue;
    const { text, updatedAt } = value as { text?: unknown; updatedAt?: unknown };
    if (typeof text !== 'string' || text.trim() === '') continue;
    notes[key] = { text: text.slice(0, NOTE_MAX), updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0 };
  }
  return capped(notes);
}

// A copy with the note of `key` replaced; an empty text deletes it, and the oldest fall off past the cap.
export function setNote(notes: Notes, key: string, text: string, now: number): Notes {
  const { [key]: _old, ...rest } = notes;
  if (!validKey(key) || text.trim() === '') return rest;
  return capped({ ...rest, [key]: { text: text.slice(0, NOTE_MAX), updatedAt: now } });
}

// The first line with something on it, cut to NOTE_TITLE_MAX.
export function noteTitle(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '')?.trim() ?? '';
  return line.length > NOTE_TITLE_MAX ? `${line.slice(0, NOTE_TITLE_MAX - 3).trimEnd()}...` : line;
}

export function readNotes(): Notes {
  return parseNotes(readJson(NOTES_KEY));
}

export function writeNotes(notes: Notes): void {
  writeJson(NOTES_KEY, notes);
}
