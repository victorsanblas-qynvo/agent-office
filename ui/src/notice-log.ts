import { t, type MessageKey } from './i18n';
import type { NotifyEvent } from './notify';
import type { Tab } from './topbar';

export type NoticeOutcome = 'shown' | 'front' | 'quiet' | 'muted' | 'off' | 'deferred';

export const NOTICE_LIMIT = 100;
export const NOTICES_KEY = 'agent-office.notices';
export const NOTICES_SAVE_MS = 1000;

// What clicking a notice opens, in a form that survives a reload.
export type NoticeTarget =
  | { kind: 'agent'; key: string }
  | { kind: 'order'; id: number; floor: string; slug: string }
  | { kind: 'doc'; path: string }
  | { kind: 'question'; id: string }
  | { kind: 'tab'; tab: Tab }
  | null;

export type NoticeFilter = 'all' | 'hidden';

export type Notice = {
  id: number;
  at: number;
  kind: NotifyEvent;
  title: string;
  body?: string;
  floor?: string;
  target: NoticeTarget;
  outcome: NoticeOutcome;
};

export type NoticeInput = Omit<Notice, 'id'>;

// The last notices the office raised, whatever the gate did with them; it is kept in localStorage so a reload does not lose it.
export class NoticeLog {
  private items: Notice[] = [];
  private nextId = 1;
  private readId = 0;
  private readonly listeners = new Set<() => void>();

  private readAtMs = 0;

  constructor(
    private readonly limit = NOTICE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  // Puts back what a previous page kept; what was stamped at or before readAt counts as read.
  restore(entries: readonly Notice[], readAt: number): void {
    this.items = entries.slice(-this.limit);
    this.nextId = this.items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    this.readAtMs = readAt;
    this.readId = this.items.reduce((max, item) => (item.at <= readAt ? Math.max(max, item.id) : max), 0);
    this.emit();
  }

  // When the inbox was last read; 0 if never.
  get readAt(): number {
    return this.readAtMs;
  }

  // Oldest first.
  get entries(): readonly Notice[] {
    return this.items;
  }

  // Ids up to this one were read.
  get readThrough(): number {
    return this.readId;
  }

  get unread(): number {
    return this.items.filter((item) => item.id > this.readId).length;
  }

  push(input: NoticeInput): Notice {
    const notice: Notice = { ...input, id: this.nextId };
    this.nextId += 1;
    this.items.push(notice);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    this.emit();
    return notice;
  }

  markRead(): void {
    const last = this.nextId - 1;
    if (this.readId === last) return;
    this.readId = last;
    this.readAtMs = this.now();
    this.emit();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.readId = this.nextId - 1;
    this.readAtMs = this.now();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const OUTCOME_KEYS: Record<NoticeOutcome, MessageKey | null> = {
  shown: null,
  front: 'notices.outcome.front',
  quiet: 'notices.outcome.quiet',
  muted: 'notices.outcome.muted',
  off: 'notices.outcome.off',
  deferred: 'notices.outcome.deferred',
};

// The small tag next to a notice that did not reach the desktop; null when it did.
export function outcomeLabel(outcome: NoticeOutcome): string | null {
  const key = OUTCOME_KEYS[outcome];
  return key === null ? null : t(key);
}

const OUTCOMES: ReadonlySet<string> = new Set<NoticeOutcome>(['shown', 'front', 'quiet', 'muted', 'off', 'deferred']);
const KINDS: ReadonlySet<string> = new Set<NotifyEvent>(['permission', 'question', 'blocked', 'done', 'document', 'alert', 'stalled', 'usage', 'checks']);
const TABS: ReadonlySet<string> = new Set<Tab>(['office', 'table', 'board', 'plans', 'chat', 'settings']);

function str(value: unknown): value is string {
  return typeof value === 'string';
}

function parseTarget(raw: unknown): NoticeTarget {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (item.kind === 'agent' && str(item.key)) return { kind: 'agent', key: item.key };
  if (item.kind === 'order' && typeof item.id === 'number' && str(item.floor) && str(item.slug)) return { kind: 'order', id: item.id, floor: item.floor, slug: item.slug };
  if (item.kind === 'doc' && str(item.path)) return { kind: 'doc', path: item.path };
  if (item.kind === 'question' && str(item.id)) return { kind: 'question', id: item.id };
  if (item.kind === 'tab' && str(item.tab) && TABS.has(item.tab)) return { kind: 'tab', tab: item.tab as Tab };
  return null;
}

function parseNotice(raw: unknown): Notice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'number' || !Number.isInteger(item.id) || item.id < 1) return null;
  if (typeof item.at !== 'number' || !Number.isFinite(item.at)) return null;
  if (!str(item.kind) || !KINDS.has(item.kind) || !str(item.title) || !str(item.outcome) || !OUTCOMES.has(item.outcome)) return null;
  return {
    id: item.id,
    at: item.at,
    kind: item.kind as NotifyEvent,
    title: item.title,
    ...(str(item.body) && item.body ? { body: item.body } : {}),
    ...(str(item.floor) && item.floor ? { floor: item.floor } : {}),
    target: parseTarget(item.target),
    outcome: item.outcome as NoticeOutcome,
  };
}

export function serializeNotices(entries: readonly Notice[], readAt: number, limit = NOTICE_LIMIT): string {
  return JSON.stringify({ readAt, items: entries.slice(-limit) });
}

// Entries that do not validate are dropped; ids that repeat keep the first.
export function parseNotices(raw: string | null, limit = NOTICE_LIMIT): { entries: Notice[]; readAt: number } {
  const empty = { entries: [], readAt: 0 };
  if (raw === null) return empty;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof data !== 'object' || data === null) return empty;
  const record = data as { readAt?: unknown; items?: unknown };
  const readAt = typeof record.readAt === 'number' && Number.isFinite(record.readAt) ? record.readAt : 0;
  if (!Array.isArray(record.items)) return { entries: [], readAt };
  const ids = new Set<number>();
  const entries: Notice[] = [];
  for (const item of record.items) {
    const notice = parseNotice(item);
    if (!notice || ids.has(notice.id)) continue;
    ids.add(notice.id);
    entries.push(notice);
  }
  return { entries: entries.slice(-limit), readAt };
}

export function filterNotices(entries: readonly Notice[], filter: NoticeFilter): Notice[] {
  return filter === 'hidden' ? entries.filter((entry) => entry.outcome !== 'shown') : [...entries];
}

export function readNotices(): { entries: Notice[]; readAt: number } {
  try {
    return parseNotices(localStorage.getItem(NOTICES_KEY));
  } catch {
    return { entries: [], readAt: 0 };
  }
}

// Writes the inbox at most once per delay, after the last change; flush writes now.
export function keepNotices(log: NoticeLog, delayMs = NOTICES_SAVE_MS): { flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (): void => {
    timer = null;
    try {
      localStorage.setItem(NOTICES_KEY, serializeNotices(log.entries, log.readAt));
    } catch {
      // Blocked or full storage: the inbox lasts for this page only.
    }
  };
  log.subscribe(() => {
    if (timer === null) timer = setTimeout(write, delayMs);
  });
  return {
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      write();
    },
  };
}
