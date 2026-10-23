import { beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { NOTICE_LIMIT, NoticeLog, outcomeLabel, type NoticeInput, type NoticeOutcome } from '../src/notice-log';
import { NOTIFY_EVENTS, Notifier, type NotifyPrefs } from '../src/notify';
import { MUTED_FLOORS_KEY, QUIET_KEY } from '../src/prefs';
import type { Store } from '../src/store';
import type { AgentView, QuestionView } from '../src/types';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static created: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeNotification.created.push(this);
  }

  close(): void {
    this.onclose?.();
  }
}

const storage = new Map<string, string>();
const page = { visible: false, focused: false };

Object.assign(globalThis, {
  Notification: FakeNotification,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  document: {
    get visibilityState() {
      return page.visible ? 'visible' : 'hidden';
    },
    hasFocus: () => page.focused,
    documentElement: { lang: 'es' },
  },
  window: { focus: () => {} },
});

beforeEach(() => applyLang('es'));

function input(title: string, outcome: NoticeOutcome = 'shown'): NoticeInput {
  return { at: 1, kind: 'question', title, target: () => {}, outcome };
}

describe('notice log', () => {
  test('keeps the last 100 and drops the oldest', () => {
    const log = new NoticeLog();
    for (let n = 1; n <= NOTICE_LIMIT + 5; n += 1) log.push(input(`n${n}`));
    expect(log.entries).toHaveLength(NOTICE_LIMIT);
    expect(log.entries[0]?.title).toBe('n6');
    expect(log.entries.at(-1)?.title).toBe(`n${NOTICE_LIMIT + 5}`);
  });

  test('counts unread since the last markRead', () => {
    const log = new NoticeLog();
    log.push(input('a'));
    log.push(input('b'));
    expect(log.unread).toBe(2);
    log.markRead();
    expect(log.unread).toBe(0);
    log.push(input('c'));
    expect(log.unread).toBe(1);
  });

  test('unread never exceeds what the ring holds', () => {
    const log = new NoticeLog(3);
    for (let n = 0; n < 10; n += 1) log.push(input(`n${n}`));
    expect(log.unread).toBe(3);
  });

  test('clear empties the ring and leaves nothing unread', () => {
    const log = new NoticeLog();
    log.push(input('a'));
    log.clear();
    expect(log.entries).toHaveLength(0);
    expect(log.unread).toBe(0);
    log.push(input('b'));
    expect(log.unread).toBe(1);
  });

  test('tells the listeners about each change', () => {
    const log = new NoticeLog();
    let calls = 0;
    const stop = log.subscribe(() => (calls += 1));
    log.push(input('a'));
    log.markRead();
    log.clear();
    stop();
    log.push(input('b'));
    expect(calls).toBe(3);
  });

  test('outcome labels: none for a shown notice, one for each other', () => {
    expect(outcomeLabel('shown')).toBeNull();
    expect(outcomeLabel('muted')).toBe('silenciado');
    expect(outcomeLabel('quiet')).toBe('en horas de silencio');
    expect(outcomeLabel('front')).toBe('panel delante');
    expect(outcomeLabel('off')).toBe('avisos apagados');
    expect(outcomeLabel('deferred')).toBe('aplazado');
  });
});

const LEAD = 'lead-1';

function fakeStore(selected: string[]): Store {
  const agents = new Map<string, Partial<AgentView>>([[LEAD, { key: LEAD, name: 'lead-mobile', role: 'office-lead-mobile', roleKind: 'lead', floor: 'mobile' }]]);
  return { agents, questions: [], documents: [], orders: [], select: (key: string) => selected.push(key), floorBySlug: () => undefined } as unknown as Store;
}

function prefs(enabled = true): NotifyPrefs {
  return { enabled, events: Object.fromEntries(NOTIFY_EVENTS.map((event) => [event, true])) as NotifyPrefs['events'] };
}

function ask(id: string, extra: Partial<QuestionView> = {}): QuestionView {
  return { id, agentKey: LEAD, sessionId: 's-1', floor: 'mobile', questions: [], createdAt: 1, expiresAt: 2, ...extra } as QuestionView;
}

describe('notifier inbox', () => {
  let selected: string[];

  const notifierAt = (hour = 12): Notifier => {
    const notifier = new Notifier(fakeStore(selected), () => new Date(2026, 9, 23, hour, 0));
    notifier.save(prefs());
    return notifier;
  };
  const quiet = (): void => {
    storage.set(QUIET_KEY, JSON.stringify({ enabled: true, from: '22:00', to: '08:00', allowPermissions: false }));
  };

  beforeEach(() => {
    storage.clear();
    FakeNotification.permission = 'granted';
    FakeNotification.created = [];
    page.visible = false;
    page.focused = false;
    selected = [];
  });

  test('a notice that reaches the desktop is recorded as shown, with what a click opens', () => {
    const notifier = notifierAt();
    notifier.observe({ type: 'question', data: ask('q1') });
    const [entry] = notifier.notices.entries;
    expect(entry).toMatchObject({ kind: 'question', outcome: 'shown', floor: 'mobile' });
    expect(entry?.title).toContain('lead-mobile');
    entry?.target();
    expect(selected).toEqual([LEAD]);
  });

  test('records a notice that quiet hours dropped', () => {
    quiet();
    const notifier = notifierAt(23);
    notifier.observe({ type: 'message', data: { id: 7, ts: 1, fromKey: LEAD, toName: 'x', toKey: 'x', text: 'BLOQUEADO: falta la key — necesito la key de backend', floor: 'mobile' } });
    expect(FakeNotification.created).toHaveLength(0);
    expect(notifier.notices.entries.map((entry) => entry.outcome)).toEqual(['quiet']);
  });

  test('records a question held back by quiet hours as deferred', () => {
    quiet();
    const notifier = notifierAt(23);
    notifier.observe({ type: 'question', data: ask('q1') });
    expect(notifier.notices.entries.map((entry) => entry.outcome)).toEqual(['deferred']);
  });

  test('records a notice of a muted floor', () => {
    storage.set(MUTED_FLOORS_KEY, JSON.stringify(['mobile']));
    const notifier = notifierAt();
    notifier.observe({ type: 'question', data: ask('q1') });
    expect(notifier.notices.entries.map((entry) => entry.outcome)).toEqual(['muted']);
  });

  test('records a notice while notifications are off, once per tag', () => {
    const notifier = new Notifier(fakeStore(selected));
    notifier.observe({ type: 'question', data: ask('q1') });
    notifier.observe({ type: 'question', data: ask('q1') });
    expect(notifier.notices.entries.map((entry) => entry.outcome)).toEqual(['off']);
  });

  test('records a notice the panel in front already shows', () => {
    page.visible = true;
    page.focused = true;
    const notifier = notifierAt();
    notifier.observe({ type: 'question', data: ask('q1') });
    expect(notifier.notices.entries.map((entry) => entry.outcome)).toEqual(['front']);
  });

  test('a repeated tag is recorded once', () => {
    const notifier = notifierAt();
    notifier.observe({ type: 'question', data: ask('q1') });
    notifier.observe({ type: 'question', data: ask('q1') });
    expect(notifier.notices.entries).toHaveLength(1);
  });
});
