import { readJson, writeJson } from '../prefs';

export const CRITERIA_MAX_ITEMS = 30;
export const CRITERIA_MAX_CHARS = 300;

const CRITERIA_HEAD = /criterios\s*:/i;
const OUT_OF_SCOPE = /(?:\s[—–-]\s*)?\bfuera\s*:/i;
const SEPARATORS = /;|\n|•|\s+(?=\d+[.)]\s)/;
const MARKER = /^(?:[-*]\s+|\d+[.)]\s+)/;

// The acceptance criteria of an ENCARGO brief: what follows "criterios:" up to "fuera:", one item per list entry.
export function criteriaOf(briefText: string): string[] {
  const head = CRITERIA_HEAD.exec(briefText);
  if (!head) return [];
  let part = briefText.slice(head.index + head[0].length);
  const out = OUT_OF_SCOPE.exec(part);
  if (out) part = part.slice(0, out.index);
  const items: string[] = [];
  for (const piece of part.split(SEPARATORS)) {
    const item = piece.trim().replace(MARKER, '').trim();
    if (item === '') continue;
    items.push(item.slice(0, CRITERIA_MAX_CHARS));
    if (items.length >= CRITERIA_MAX_ITEMS) break;
  }
  return items;
}

// FNV-1a over the whitespace-normalised text: the same wording keeps its tick wherever it moves in the list.
export function criterionHash(item: string): string {
  let hash = 0x811c9dc5;
  for (const char of item.trim().replace(/\s+/g, ' ')) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function criteriaKey(slug: string): string {
  return `agent-office.criteria.${slug}`;
}

export function readTicks(slug: string): Set<string> {
  const raw = readJson(criteriaKey(slug));
  return new Set(Array.isArray(raw) ? raw.filter((hash): hash is string => typeof hash === 'string') : []);
}

export function writeTicks(slug: string, ticks: ReadonlySet<string>, items: readonly string[]): void {
  const live = new Set(items.map(criterionHash));
  writeJson(criteriaKey(slug), [...ticks].filter((hash) => live.has(hash)));
}

export function criteriaProgress(items: readonly string[], ticks: ReadonlySet<string>): string {
  return `${items.filter((item) => ticks.has(criterionHash(item))).length}/${items.length}`;
}

export function criteriaMarkdown(items: readonly string[], ticks: ReadonlySet<string>): string {
  return items.map((item) => `- [${ticks.has(criterionHash(item)) ? 'x' : ' '}] ${item}`).join('\n');
}
