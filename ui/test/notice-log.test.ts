import { beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { filterNotices, keepNotices, NOTICE_LIMIT, NOTICES_KEY, NoticeLog, outcomeLabel, parseNotices, serializeNotices, type Notice, type NoticeInput, type NoticeOutcome } from '../src/notice-log';
import { NOTIFY_EVENTS, Notifier, type NotifyPrefs } from '../src/notify';
import { MUTED_FLOORS_KEY, QUIET_KEY } from '../src/prefs';
import type { Store } from '../src/store';
import type { AgentView, DocumentView, QuestionView } from '../src/types';

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
  return { at: 1, kind: 'question', title, target: null, outcome };
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
  let opened: unknown[];

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
    opened = [];
  });

  test('a notice that reaches the desktop is recorded as shown, with what a click opens', () => {
    const notifier = notifierAt();
    notifier.observe({ type: 'question', data: ask('q1') });
    const [entry] = notifier.notices.entries;
    expect(entry).toMatchObject({ kind: 'question', outcome: 'shown', floor: 'mobile' });
    expect(entry?.title).toContain('lead-mobile');
    expect(entry?.target).toEqual({ kind: 'question', id: 'q1' });
    notifier.openTarget = (target) => opened.push(target);
    FakeNotification.created[0]?.onclick?.();
    expect(opened).toEqual([{ kind: 'question', id: 'q1' }]);
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

function entry(id: number, extra: Partial<Notice> = {}): Notice {
  return { id, at: id * 10, kind: 'question', title: `n${id}`, target: null, outcome: 'shown', ...extra };
}

describe('stored notices', () => {
  test('round-trips entries with their targets and the last-read timestamp', () => {
    const entries = [entry(1, { body: 'b', floor: 'mobile', target: { kind: 'agent', key: 'k' } }), entry(2, { target: { kind: 'order', id: 4, floor: 'mobile', slug: 'x' } }), entry(3, { target: { kind: 'tab', tab: 'table' }, outcome: 'quiet' })];
    expect(parseNotices(serializeNotices(entries, 25))).toEqual({ entries, readAt: 25 });
  });

  test('drops malformed entries and bad payloads', () => {
    const raw = JSON.stringify({
      readAt: 'x',
      items: [entry(1), { ...entry(2), kind: 'nope' }, { ...entry(3), outcome: 'x' }, { ...entry(4), at: 'z' }, 7, null, entry(1), { ...entry(5), target: { kind: 'tab', tab: 'zzz' } }],
    });
    const parsed = parseNotices(raw);
    expect(parsed.entries.map((item) => item.id)).toEqual([1, 5]);
    expect(parsed.entries[1]?.target).toBeNull();
    expect(parsed.readAt).toBe(0);
    expect(parseNotices('{broken')).toEqual({ entries: [], readAt: 0 });
    expect(parseNotices(null).entries).toEqual([]);
    expect(parseNotices('[]').entries).toEqual([]);
  });

  test('keeps only the last 100 on write and on read', () => {
    const many = Array.from({ length: NOTICE_LIMIT + 7 }, (_, n) => entry(n + 1));
    expect(JSON.parse(serializeNotices(many, 0)).items).toHaveLength(NOTICE_LIMIT);
    const raw = JSON.stringify({ readAt: 0, items: many });
    const parsed = parseNotices(raw);
    expect(parsed.entries).toHaveLength(NOTICE_LIMIT);
    expect(parsed.entries[0]?.id).toBe(8);
  });

  test('unread after a restore counts what is newer than the stored last-read', () => {
    const log = new NoticeLog();
    log.restore([entry(1), entry(2), entry(3)], 20);
    expect(log.unread).toBe(1);
    expect(log.readAt).toBe(20);
    log.push(input('next'));
    expect(log.entries.at(-1)?.id).toBe(4);
    expect(log.unread).toBe(2);
  });

  test('markRead stamps the clock', () => {
    const log = new NoticeLog(NOTICE_LIMIT, () => 999);
    log.push(input('a'));
    log.markRead();
    expect(log.readAt).toBe(999);
  });

  test('filters out what reached the desktop', () => {
    const entries = [entry(1), entry(2, { outcome: 'muted' }), entry(3, { outcome: 'front' })];
    expect(filterNotices(entries, 'all').map((item) => item.id)).toEqual([1, 2, 3]);
    expect(filterNotices(entries, 'hidden').map((item) => item.id)).toEqual([2, 3]);
  });

  test('writes once after a burst and flush writes at once', async () => {
    storage.clear();
    const log = new NoticeLog();
    const keeper = keepNotices(log, 20);
    log.push(input('a'));
    log.push(input('b'));
    expect(storage.has(NOTICES_KEY)).toBe(false);
    await new Promise((done) => setTimeout(done, 40));
    expect(parseNotices(storage.get(NOTICES_KEY) ?? null).entries).toHaveLength(2);
    log.push(input('c'));
    keeper.flush();
    expect(parseNotices(storage.get(NOTICES_KEY) ?? null).entries).toHaveLength(3);
    storage.clear();
  });
});

describe('notice targets per event', () => {
  const doc = (status: DocumentView['status']): DocumentView => ({ path: 'plans/p.md', title: 'P', kind: 'plan', status, round: 1 }) as DocumentView;
  let notifier: Notifier;

  beforeEach(() => {
    storage.clear();
    FakeNotification.permission = 'granted';
    page.visible = false;
    page.focused = false;
    notifier = new Notifier(fakeStore([]), () => new Date(2026, 9, 23, 12, 0));
    notifier.save(prefs());
  });

  const last = (): Notice | undefined => notifier.notices.entries.at(-1);

  test('permission and question point at the question', () => {
    notifier.observe({ type: 'question', data: ask('q1', { kind: 'permission', tool: 'Bash' }) });
    expect(last()).toMatchObject({ kind: 'permission', target: { kind: 'question', id: 'q1' } });
    notifier.observe({ type: 'question', data: ask('q2') });
    expect(last()).toMatchObject({ kind: 'question', target: { kind: 'question', id: 'q2' } });
  });

  test('blocked and done point at the agent', () => {
    notifier.observe({ type: 'message', data: { id: 1, ts: 1, fromKey: LEAD, toName: 'x', toKey: 'x', text: 'BLOQUEADO: falta la key — necesito la key', floor: 'mobile' } });
    expect(last()).toMatchObject({ kind: 'blocked', target: { kind: 'agent', key: LEAD } });
  });

  test('stalled and alert point at the agent', () => {
    notifier.observe({ type: 'agent', data: { key: LEAD, name: 'lead-mobile', floor: 'mobile', stalledSince: null } as AgentView });
    notifier.observe({ type: 'agent', data: { key: LEAD, name: 'lead-mobile', floor: 'mobile', stalledSince: 5 } as AgentView });
    expect(last()).toMatchObject({ kind: 'stalled', target: { kind: 'agent', key: LEAD } });
    notifier.observe({ type: 'alert', data: { id: 'a1', level: 'alerta', floor: 'mobile', agentKey: LEAD, files: ['x'] } as never });
    expect(last()).toMatchObject({ kind: 'alert', target: { kind: 'agent', key: LEAD } });
  });

  test('a document points at its path', () => {
    notifier.observe({ type: 'documents', data: [doc('borrador')] });
    notifier.observe({ type: 'documents', data: [doc('aprobado')] });
    expect(last()).toMatchObject({ kind: 'document', target: { kind: 'doc', path: 'plans/p.md' } });
  });

  test('usage points at the Tabla', () => {
    notifier.observe({ type: 'usage', data: { fiveHour: { usedPct: 85, resetsAt: 9, samples: [] }, sevenDay: null } as never });
    expect(last()).toMatchObject({ kind: 'usage', target: { kind: 'tab', tab: 'table' } });
  });

  test('a finished order points at its order, a plan at the Tablero', () => {
    const view = { id: 3, ts: 1, kind: 'order', slug: 'o-1', title: 'T', floors: ['mobile'], branch: null, summary: '', cycle: 1, manual: false, checks: null, touched: [], prUrl: null, orderSlugs: [] };
    notifier.observe({ type: 'finished', data: view as never });
    expect(last()).toMatchObject({ kind: 'done', target: { kind: 'order', id: 3, floor: 'mobile', slug: 'o-1' } });
    notifier.observe({ type: 'finished', data: { ...view, id: 4, kind: 'plan' } as never });
    expect(last()).toMatchObject({ kind: 'done', target: { kind: 'tab', tab: 'board' } });
  });
});
