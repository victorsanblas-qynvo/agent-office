import { t, type MessageKey } from './i18n';
import type { NotifyEvent } from './notify';

export type NoticeOutcome = 'shown' | 'front' | 'quiet' | 'muted' | 'off' | 'deferred';

export const NOTICE_LIMIT = 100;

export type Notice = {
  id: number;
  at: number;
  kind: NotifyEvent;
  title: string;
  body?: string;
  floor?: string;
  // What clicking the desktop notice would open.
  target: () => void;
  outcome: NoticeOutcome;
};

export type NoticeInput = Omit<Notice, 'id'>;

// The last notices the office raised, whatever the gate did with them; it lives in memory and is lost with the page.
export class NoticeLog {
  private items: Notice[] = [];
  private nextId = 1;
  private readId = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit = NOTICE_LIMIT) {}

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
    this.emit();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.readId = this.nextId - 1;
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
