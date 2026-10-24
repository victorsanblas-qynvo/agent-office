import { readJson, writeJson } from '../prefs';
import type { ChatMessageView } from '../types';

export const CHAT_READ_KEY = 'agent-office.chatRead';
export const CHAT_READ_LIMIT = 50;

// Last read message id per channel.
export type ChatRead = Record<string, number>;

// Keeps only known channels with a sane id, at most CHAT_READ_LIMIT of them (the last ones stored).
export function normalizeChatRead(stored: unknown, known: ReadonlySet<string>): ChatRead {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const entries = Object.entries(stored).filter(([channel, id]) => known.has(channel) && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0);
  return Object.fromEntries(entries.slice(-CHAT_READ_LIMIT)) as ChatRead;
}

export function readChatRead(known: ReadonlySet<string>): ChatRead {
  return normalizeChatRead(readJson(CHAT_READ_KEY), known);
}

export function writeChatRead(read: ChatRead): void {
  writeJson(CHAT_READ_KEY, normalizeChatRead(read, new Set(Object.keys(read))));
}

// Messages of the agents after the last read id of their channel, per channel.
export function unreadCounts(messages: readonly ChatMessageView[], read: ChatRead): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.origin !== 'agent' || message.id <= (read[message.channel] ?? 0)) continue;
    counts.set(message.channel, (counts.get(message.channel) ?? 0) + 1);
  }
  return counts;
}

// Index of the first message of an agent after the last read id; -1 if there is none.
export function firstUnreadIndex(messages: readonly ChatMessageView[], lastRead: number): number {
  return messages.findIndex((message) => message.origin === 'agent' && message.id > lastRead);
}

const USER_MENTION = /@(usuario|user)(?![\p{L}\p{N}_])/iu;

// An agent message that names the user or asks a question.
export function addressesUser(message: ChatMessageView): boolean {
  return message.origin === 'agent' && (message.kind === 'pregunta' || USER_MENTION.test(message.text));
}

export type Segment = { text: string; match: boolean };

// Lowercase and without accents, with the index in the original text of each folded code unit.
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  let at = 0;
  for (const char of text) {
    const part = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    folded += part;
    for (let i = 0; i < part.length; i += 1) origin.push(at);
    at += char.length;
  }
  return { folded, origin };
}

function foldQuery(query: string): string {
  return fold(query.trim()).folded;
}

export function filterMessages(messages: readonly ChatMessageView[], query: string): ChatMessageView[] {
  const needle = foldQuery(query);
  if (needle === '') return [...messages];
  return messages.filter((message) => fold(message.text).folded.includes(needle) || fold(message.authorName).folded.includes(needle));
}

// The text cut into runs that match the query and runs that do not, without losing a character.
export function splitHighlight(text: string, query: string): Segment[] {
  const needle = foldQuery(query);
  if (needle === '' || text === '') return [{ text, match: false }];
  const { folded, origin } = fold(text);
  const segments: Segment[] = [];
  let cursor = 0;
  let from = folded.indexOf(needle);
  while (from !== -1) {
    const start = origin[from];
    const end = origin[from + needle.length - 1] + (String.fromCodePoint(text.codePointAt(origin[from + needle.length - 1]) ?? 0).length);
    if (start >= cursor) {
      if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
      segments.push({ text: text.slice(start, end), match: true });
      cursor = end;
    }
    from = folded.indexOf(needle, from + needle.length);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}
