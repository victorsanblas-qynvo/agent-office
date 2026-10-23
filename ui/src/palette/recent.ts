import { readJson, writeJson } from '../prefs';

export const RECENT_KEY = 'agent-office.paletteRecent';
export const RECENT_MAX = 15;
const ID_MAX = 300;

// Pure: the entry ids in a stored value, newest first, dropping what is not an id, repeats and whatever goes past the limit.
export function parseRecent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= RECENT_MAX) break;
    if (typeof item !== 'string' || item === '' || item.length > ID_MAX || out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

// Pure: the list with an entry id put first, wherever it was before.
export function recordRecent(list: readonly string[], id: string): string[] {
  if (id === '' || id.length > ID_MAX) return [...list];
  return [id, ...list.filter((item) => item !== id)].slice(0, RECENT_MAX);
}

export function readRecent(): string[] {
  return parseRecent(readJson(RECENT_KEY));
}

export function writeRecent(list: readonly string[]): void {
  writeJson(RECENT_KEY, list);
}
