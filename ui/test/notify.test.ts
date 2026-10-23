import { beforeEach, describe, expect, test } from 'bun:test';
import { applyLang, t } from '../src/i18n/index';
import { MUTED_FLOORS_KEY, QUIET_KEY } from '../src/prefs';
import { NOTIFY_EVENTS, Notifier, checkTransitionNotice, QuietRecap, recapText, SEEN_LIMIT, type NotifyPrefs } from '../src/notify';
import type { Store } from '../src/store';
import type { AgentView, CheckRunView, DocumentView, OrderView, QuestionView, ServerMessage, Snapshot } from '../src/types';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static created: FakeNotification[] = [];
  static requestPermission = async (): Promise<NotificationPermission> => FakeNotification.permission;
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeNotification.created.push(this);
  }

  close(): void {
    this.closed = true;
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

// The tests share the process with the other files: the texts asserted here are the Spanish ones.
beforeEach(() => applyLang('es'));

const LEAD = 'lead-1';
const DEV = 'dev-1';

function fakeStore(selected: string[], questions: QuestionView[] = []): Store {
  const agents = new Map<string, Partial<AgentView>>([
    [LEAD, { key: LEAD, name: 'lead-mobile', role: 'office-lead-mobile', roleKind: 'lead', floor: 'mobile' }],
    [DEV, { key: DEV, name: 'dev-mobile', role: 'office-dev-mobile', roleKind: 'dev' }],
  ]);
  return { agents, questions, documents: [], orders: [], select: (key: string) => selected.push(key), floorBySlug: () => undefined } as unknown as Store;
}

function allOn(): NotifyPrefs {
  return { enabled: true, events: Object.fromEntries(NOTIFY_EVENTS.map((event) => [event, true])) as NotifyPrefs['events'] };
}

function question(id: string, extra: Partial<QuestionView> = {}): QuestionView {
  return {
    id,
    agentKey: LEAD,
    sessionId: 's-1',
    floor: 'mobile',
    questions: [{ question: '¿Seguimos con la migración de la base de datos?', options: [{ label: 'Sí' }, { label: 'No' }] }],
    createdAt: 1,
    expiresAt: 2,
    ...extra,
  } as QuestionView;
}

function snapshot(extra: Partial<Snapshot> = {}): ServerMessage {
  return {
    type: 'snapshot',
    data: { now: 1, floors: [], agents: [], sessions: [], questions: [], messages: [], activity: [], documents: [], alerts: [], ...extra },
  } as ServerMessage;
}

function plan(status: DocumentView['status'], round: number): DocumentView {
  return { path: 'redaccion/planes/login.md', kind: 'plan', slug: 'login', title: 'Login con Apple', status, round } as DocumentView;
}

describe('desktop notifier', () => {
  let selected: string[];
  let notifier: Notifier;

  beforeEach(() => {
    storage.clear();
    FakeNotification.permission = 'granted';
    FakeNotification.created = [];
    page.visible = false;
    page.focused = false;
    selected = [];
    notifier = new Notifier(fakeStore(selected));
    notifier.save(allOn());
  });

  test('is off by default', () => {
    storage.clear();
    const fresh = new Notifier(fakeStore([]));
    expect(fresh.preferences.enabled).toBe(false);
    fresh.observe({ type: 'question', data: question('q0') });
    expect(FakeNotification.created).toHaveLength(0);
  });

  test('each tag notifies once, also when the snapshot repeats a pending question', () => {
    notifier.observe({ type: 'question', data: question('q1') });
    notifier.observe({ type: 'question', data: question('q1') });
    notifier.observe(snapshot({ questions: [question('q1')] }));
    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0]?.options.tag).toBe('question:q1');
  });

  describe('muted floors', () => {
    const mute = (...floors: string[]): void => {
      storage.set(MUTED_FLOORS_KEY, JSON.stringify(floors));
    };

    test('drop the notice of a muted floor and keep the others', () => {
      mute('mobile');
      notifier.observe({ type: 'question', data: question('q1') });
      expect(FakeNotification.created).toHaveLength(0);
      notifier.observe({ type: 'question', data: question('q2', { floor: 'backend' }) });
      expect(FakeNotification.created).toHaveLength(1);
    });

    test('let a permission of a muted floor through', () => {
      mute('mobile');
      notifier.observe({ type: 'question', data: question('p1', { kind: 'permission' }) });
      expect(FakeNotification.created).toHaveLength(1);
    });

    test('drop a blocked message from an agent on a muted floor', () => {
      mute('mobile');
      notifier.observe({ type: 'message', data: { id: 9, ts: 1, fromKey: LEAD, toName: 'x', toKey: null, text: 'BLOQUEADO: falta la key', floor: 'mobile' } as never });
      expect(FakeNotification.created).toHaveLength(0);
    });
  });

  describe('quiet hours', () => {
    const at = (hour: number): Date => new Date(2026, 9, 23, hour, 0);
    const quiet = (allowPermissions: boolean): void => {
      storage.set(QUIET_KEY, JSON.stringify({ enabled: true, from: '22:00', to: '08:00', allowPermissions }));
    };
    const blocked = { id: 7, ts: 1, fromKey: DEV, toName: 'lead', toKey: LEAD, text: 'BLOQUEADO: falta la key — necesito la key de backend', floor: 'mobile' };

    test('block a normal notice and let it through outside the window', () => {
      quiet(true);
      const night = new Notifier(fakeStore(selected), () => at(23));
      night.save(allOn());
      night.observe({ type: 'message', data: blocked });
      expect(FakeNotification.created).toHaveLength(0);
      const day = new Notifier(fakeStore(selected), () => at(12));
      day.save(allOn());
      day.observe({ type: 'message', data: { ...blocked, id: 8 } });
      expect(FakeNotification.created).toHaveLength(1);
    });

    test('let a permission through when the exception is on, block it when off', () => {
      quiet(true);
      const allowed = new Notifier(fakeStore(selected), () => at(23));
      allowed.save(allOn());
      allowed.observe({ type: 'question', data: question('p1', { kind: 'permission' }) });
      expect(FakeNotification.created).toHaveLength(1);
      quiet(false);
      const silent = new Notifier(fakeStore(selected), () => at(23));
      silent.save(allOn());
      silent.observe({ type: 'question', data: question('p2', { kind: 'permission' }) });
      expect(FakeNotification.created).toHaveLength(1);
    });

    describe('deferred through the window', () => {
      let clock: Date;
      let open: QuestionView[];
      let desk: Notifier;

      beforeEach(() => {
        clock = at(23);
        open = [];
        quiet(true);
        desk = new Notifier(fakeStore(selected, open), () => clock);
        desk.save(allOn());
      });

      test('a question still open when quiet hours end notifies on the next tick, once', () => {
        const pending = question('q5', { createdAt: clock.getTime() });
        open.push(pending);
        desk.observe({ type: 'question', data: pending });
        desk.tick();
        expect(FakeNotification.created).toHaveLength(0);
        clock = at(8);
        desk.tick();
        desk.tick();
        expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['question:q5']);
      });

      test('a question closed before the window ends never notifies', () => {
        const pending = question('q6', { createdAt: clock.getTime() });
        open.push(pending);
        desk.observe({ type: 'question', data: pending });
        desk.observe({ type: 'question-closed', id: 'q6', outcome: 'answered' });
        open.length = 0;
        clock = at(8);
        desk.tick();
        expect(FakeNotification.created).toHaveLength(0);
      });

      test('a usage threshold crossed in the window warns after it', () => {
        desk.observe({ type: 'usage', data: { fiveHour: { usedPct: 96, resetsAt: 1_800_000_000_000 }, sevenDay: null, at: 1 } });
        expect(FakeNotification.created).toHaveLength(0);
        clock = at(8);
        desk.tick();
        desk.tick();
        expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['usage:five:1800000000000:80', 'usage:five:1800000000000:95']);
      });

      test('a reminder is held through the window and given once after it', () => {
        quiet(false);
        clock = at(21);
        const pending = question('q7', { createdAt: clock.getTime() });
        open.push(pending);
        desk.observe({ type: 'question', data: pending });
        expect(FakeNotification.created).toHaveLength(1);
        clock = new Date(2026, 9, 23, 23, 30);
        desk.tick();
        expect(FakeNotification.created).toHaveLength(1);
        clock = new Date(2026, 9, 24, 8, 0);
        desk.tick();
        desk.tick();
        expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['question:q7', 'question:q7:remind']);
      });
    });

    test('a plain question is still quiet while a permission is allowed', () => {
      quiet(true);
      const night = new Notifier(fakeStore(selected), () => at(23));
      night.save(allOn());
      night.observe({ type: 'question', data: question('q9') });
      expect(FakeNotification.created).toHaveLength(0);
    });
  });

  describe('reminders', () => {
    const MIN = 60_000;
    test('a question already past due on the first snapshot is not reminded', () => {
      const clock = new Date(2026, 9, 23, 12, 0);
      const old = question('q1', { createdAt: clock.getTime() - 60 * MIN });
      const desk = new Notifier(fakeStore(selected, [old]), () => clock);
      desk.save(allOn());
      desk.observe(snapshot({ questions: [old] }));
      FakeNotification.created.length = 0;
      desk.tick();
      expect(FakeNotification.created).toHaveLength(0);
    });

    test('a question still open after the wait reminds once, and a closed one never does', () => {
      let clock = new Date(2026, 9, 23, 12, 0);
      const open = [question('q1', { createdAt: clock.getTime() }), question('p1', { kind: 'permission', createdAt: clock.getTime() })];
      const desk = new Notifier(fakeStore(selected, open), () => clock);
      desk.save(allOn());
      for (const item of open) desk.observe({ type: 'question', data: item });
      clock = new Date(clock.getTime() + 9 * MIN);
      desk.tick();
      expect(FakeNotification.created).toHaveLength(2);
      clock = new Date(clock.getTime() + 1 * MIN);
      open.pop();
      desk.observe({ type: 'question-closed', id: 'p1', outcome: 'answered' });
      desk.tick();
      desk.tick();
      expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['question:q1', 'question:p1', 'question:q1:remind']);
      expect(FakeNotification.created[2]?.title).toBe(t('notify.remind.title', { agent: 'lead-mobile' }));
    });
  });

  test('messages in the snapshot are history and do not notify', () => {
    const blocked = { id: 7, ts: 1, fromKey: DEV, toName: 'lead', toKey: LEAD, text: 'BLOQUEADO: falta la key — necesito la key de backend', floor: 'mobile' };
    notifier.observe(snapshot({ messages: [blocked] }));
    expect(FakeNotification.created).toHaveLength(0);
    notifier.observe({ type: 'message', data: { ...blocked, id: 8 } });
    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0]?.title).toBe(t('notify.blocked.title', { agent: 'dev-mobile' }));
  });

  test('the first list of documents only seeds; a later approval notifies once per status and round', () => {
    notifier.observe({ type: 'documents', data: [plan('aprobado', 2)] });
    expect(FakeNotification.created).toHaveLength(0);
    notifier.observe({ type: 'documents', data: [plan('revision', 3)] });
    notifier.observe({ type: 'documents', data: [plan('aprobado', 3)] });
    notifier.observe({ type: 'documents', data: [plan('aprobado', 3)] });
    expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['document:redaccion/planes/login.md:aprobado:3']);
  });

  test('a plan delivered for a decision notifies with its title only, once', () => {
    notifier.observe({ type: 'documents', data: [plan('aprobado', 3)] });
    notifier.observe({ type: 'documents', data: [plan('entregado', 3)] });
    notifier.observe({ type: 'documents', data: [plan('entregado', 3)] });
    notifier.observe({ type: 'documents', data: [plan('aparcado', 3)] });
    expect(FakeNotification.created.map((n) => [n.title, n.options.tag, n.options.body])).toEqual([
      ['Plan pendiente de decisión: Login con Apple', 'document:redaccion/planes/login.md:entregado:3', ''],
    ]);
  });

  test('a lead that becomes stalled notifies once, with a generic body; the snapshot only seeds', () => {
    const lead = (stalledSince: number | null): ServerMessage => ({ type: 'agent', data: { key: LEAD, name: 'lead-mobile', role: 'office-lead-mobile', stalledSince } as AgentView });
    notifier.observe(snapshot({ agents: [{ key: LEAD, name: 'lead-mobile', role: 'office-lead-mobile', stalledSince: 5 } as AgentView] }));
    notifier.observe(lead(5));
    expect(FakeNotification.created).toHaveLength(0);
    notifier.observe(lead(null));
    notifier.observe(lead(null));
    notifier.observe(lead(9));
    notifier.observe(lead(9));
    expect(FakeNotification.created.map((n) => [n.title, n.options.tag, n.options.body])).toEqual([
      [t('notify.stalled.title', { agent: 'lead-mobile' }), `stalled:${LEAD}:9`, t('notify.openPanel')],
    ]);
    const opened: unknown[] = [];
    notifier.openTarget = (target) => opened.push(target);
    FakeNotification.created[0]?.onclick?.();
    expect(opened).toEqual([{ kind: 'agent', key: LEAD }]);
    notifier.observe(lead(null));
    notifier.observe(lead(20));
    expect(FakeNotification.created).toHaveLength(2);
  });

  test('stalled notifications respect their own preference', () => {
    const prefs = allOn();
    prefs.events.stalled = false;
    notifier.save(prefs);
    notifier.observe({ type: 'agent', data: { key: LEAD, name: 'lead-mobile', stalledSince: 1 } as AgentView });
    expect(FakeNotification.created).toHaveLength(0);
  });

  describe('usage limit', () => {
    const RESETS = 1_800_000_000_000;
    const view = (five: number | null, seven: number | null = null, resetsAt = RESETS): ServerMessage => ({
      type: 'usage',
      data: {
        fiveHour: five === null ? null : { usedPct: five, resetsAt },
        sevenDay: seven === null ? null : { usedPct: seven, resetsAt: resetsAt + 86_400_000 },
        at: 1,
      },
    });
    const tags = (): (string | undefined)[] => FakeNotification.created.map((n) => n.options.tag);

    test('80 and then 95 notify once each per window, below 80 nothing', () => {
      notifier.observe(view(40));
      notifier.observe(view(79.9));
      expect(FakeNotification.created).toHaveLength(0);
      notifier.observe(view(81));
      notifier.observe(view(84));
      expect(tags()).toEqual([`usage:five:${RESETS}:80`]);
      expect(FakeNotification.created[0]?.title).toBe(t('notify.usage.five', { pct: 81 }));
      notifier.observe(view(96));
      notifier.observe(view(97));
      expect(tags()).toEqual([`usage:five:${RESETS}:80`, `usage:five:${RESETS}:95`]);
      expect(FakeNotification.created[1]?.title).toBe(t('notify.usage.five', { pct: 96 }));
    });

    test('a jump from 50 to 97 notifies both thresholds, and the week has its own tags', () => {
      notifier.observe(view(50, 85));
      notifier.observe(view(97, 85));
      expect(tags()).toEqual([`usage:seven:${RESETS + 86_400_000}:80`, `usage:five:${RESETS}:80`, `usage:five:${RESETS}:95`]);
      expect(FakeNotification.created[0]?.title).toBe(t('notify.usage.seven', { pct: 85 }));
    });

    test('the snapshot seeds the thresholds already passed, so a reconnect does not warn again', () => {
      notifier.observe(snapshot({ usage: { fiveHour: { usedPct: 90, resetsAt: RESETS }, sevenDay: null, at: 1 } }));
      notifier.observe(view(91));
      expect(FakeNotification.created).toHaveLength(0);
      notifier.observe(view(96));
      expect(tags()).toEqual([`usage:five:${RESETS}:95`]);
    });

    test('a new window warns again, and the preference turns it off', () => {
      notifier.observe(view(85));
      notifier.observe(view(85, null, RESETS + 5 * 3_600_000));
      expect(tags()).toEqual([`usage:five:${RESETS}:80`, `usage:five:${RESETS + 5 * 3_600_000}:80`]);
      const prefs = allOn();
      prefs.events.usage = false;
      notifier.save(prefs);
      notifier.observe(view(99, null, RESETS + 10 * 3_600_000));
      expect(FakeNotification.created).toHaveLength(2);
    });

    test('the body says the forecast when there is one', () => {
      const exhausts = RESETS - 3_600_000;
      notifier.observe({
        type: 'usage',
        data: { fiveHour: { usedPct: 82, resetsAt: RESETS, forecast: { rate: 12.4, exhaustsAt: exhausts, safe: false, basis: 'fit' } }, sevenDay: null, at: 1 },
      });
      expect(FakeNotification.created[0]?.options.body).toMatch(/^se agota ~\d\d:\d\d \(\+12 %\/h\)$/);
    });
  });

  test('nothing is notified while the panel is in front and focused', () => {
    page.visible = true;
    page.focused = true;
    notifier.observe({ type: 'question', data: question('q2') });
    expect(FakeNotification.created).toHaveLength(0);
    page.focused = false;
    notifier.observe({ type: 'question', data: question('q3') });
    expect(FakeNotification.created).toHaveLength(1);
  });

  test('a browser that refuses to construct notifications does not break the event stream', () => {
    class ThrowingNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = async (): Promise<NotificationPermission> => 'granted';
      constructor() {
        throw new TypeError('Illegal constructor');
      }
    }
    const original = globalThis.Notification;
    Object.assign(globalThis, { Notification: ThrowingNotification });
    try {
      expect(() => notifier.test()).not.toThrow();
      expect(() => notifier.observe({ type: 'question', data: question('q-throws') })).not.toThrow();
    } finally {
      Object.assign(globalThis, { Notification: original });
    }
    notifier.observe({ type: 'question', data: question('q-after') });
    expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['question:q-after']);
  });

  test('bodies never carry the command, the question or the message text', () => {
    notifier.observe({ type: 'question', data: question('p1', { kind: 'permission', detail: 'curl -H "Authorization: Bearer secreto"', tool: 'Bash' }) });
    notifier.observe({ type: 'question', data: question('q4') });
    notifier.observe({ type: 'message', data: { id: 9, ts: 1, fromKey: LEAD, toName: 'director', toKey: null, text: 'HECHO: login — TOKEN=abc', floor: 'mobile' } });
    const [permission, ask, done] = FakeNotification.created;
    expect(permission?.title).toBe(t('notify.permission.tool', { agent: 'lead-mobile', tool: 'Bash' }));
    for (const n of [permission, ask, done]) {
      expect(n?.options.body).toBe(t('notify.openPanel'));
      expect(`${n?.title} ${n?.options.body}`).not.toMatch(/secreto|migraci|TOKEN/);
    }
  });

  test('a click selects the agent and a closed question closes and forgets its notification', () => {
    notifier.observe({ type: 'question', data: question('q5') });
    const opened: unknown[] = [];
    notifier.openTarget = (target) => opened.push(target);
    FakeNotification.created[0]?.onclick?.();
    expect(opened).toEqual([{ kind: 'question', id: 'q5' }]);

    notifier.observe({ type: 'question', data: question('q6') });
    notifier.observe({ type: 'question-closed', id: 'q6', outcome: 'answered' });
    expect(FakeNotification.created[1]?.closed).toBe(true);
    expect((notifier as unknown as { shown: Map<string, unknown> }).shown.has('question:q6')).toBe(false);
  });

  test('seen tags and open notifications are capped', () => {
    for (let index = 0; index <= SEEN_LIMIT; index += 1) notifier.observe({ type: 'question', data: question(`b${index}`) });
    const internals = notifier as unknown as { seen: Set<string>; shown: Map<string, unknown> };
    expect(internals.seen.size).toBe(SEEN_LIMIT);
    expect(internals.shown.size).toBe(SEEN_LIMIT);
    expect(internals.seen.has('question:b0')).toBe(false);
    expect(internals.shown.has('question:b0')).toBe(false);
    expect(internals.shown.has(`question:b${SEEN_LIMIT}`)).toBe(true);
  });
});

function run(id: number, status: CheckRunView['status'], extra: Partial<CheckRunView> = {}): CheckRunView {
  return {
    id,
    orderId: 7,
    sha: 'abc1234',
    trigger: 'listo',
    status,
    startedAt: 1,
    endedAt: null,
    checks: [
      { name: 'typecheck', command: 'bun run typecheck', status: 'passed', exitCode: 0, durationMs: 1, outputTail: 'secret output' },
      { name: 'test', command: 'bun test', status: status === 'failed' ? 'failed' : 'passed', exitCode: 1, durationMs: 1, outputTail: 'secret output' },
    ],
    ...extra,
  } as CheckRunView;
}

describe('checkTransitionNotice', () => {
  test('running to failed names only the failing check', () => {
    const notice = checkTransitionNotice(run(1, 'running'), run(1, 'failed'));
    expect(notice).toEqual({ orderId: 7, tag: 'checks:1', key: 'notify.checks.failed', body: 'test' });
  });

  test('running to passed has no body', () => {
    const notice = checkTransitionNotice(run(1, 'running'), run(1, 'passed'));
    expect(notice).toEqual({ orderId: 7, tag: 'checks:1', key: 'notify.checks.passed', body: '' });
  });

  test('passed to passed, a first sight and another run id give nothing', () => {
    expect(checkTransitionNotice(run(1, 'passed'), run(1, 'passed'))).toBeNull();
    expect(checkTransitionNotice(undefined, run(1, 'failed'))).toBeNull();
    expect(checkTransitionNotice(run(1, 'running'), run(2, 'failed'))).toBeNull();
  });

  test('the toggle off gives nothing', () => {
    expect(checkTransitionNotice(run(1, 'running'), run(1, 'failed'), false)).toBeNull();
  });
});

describe('check result notices', () => {
  const order = { id: 7, slug: 'login', floor: 'mobile', title: 'Login con Apple' } as OrderView;
  let opened: unknown[];
  let notifier: Notifier;

  beforeEach(() => {
    storage.clear();
    FakeNotification.permission = 'granted';
    FakeNotification.created = [];
    page.visible = false;
    page.focused = false;
    opened = [];
    const store = { ...fakeStore([]), orders: [order] } as unknown as Store;
    notifier = new Notifier(store);
    notifier.openTarget = (target) => opened.push(target);
  });

  test('is off by default', () => {
    expect(notifier.preferences.events.checks).toBe(false);
    notifier.save({ ...allOn(), events: { ...allOn().events, checks: false } });
    notifier.observe({ type: 'checks', orderId: 7, data: run(1, 'running') });
    notifier.observe({ type: 'checks', orderId: 7, data: run(1, 'failed') });
    expect(FakeNotification.created).toHaveLength(0);
  });

  test('notifies once per run and a click opens the order', () => {
    notifier.save(allOn());
    notifier.observe({ type: 'checks', orderId: 7, data: run(1, 'running') });
    notifier.observe({ type: 'checks', orderId: 7, data: run(1, 'failed') });
    notifier.observe({ type: 'checks', orderId: 7, data: run(1, 'failed') });
    expect(FakeNotification.created).toHaveLength(1);
    const shown = FakeNotification.created[0];
    expect(shown?.title).toBe('Checks en rojo · Login con Apple');
    expect(shown?.options.body).toBe('test');
    shown?.onclick?.();
    expect(opened).toEqual([{ kind: 'order', id: order.id, floor: order.floor, slug: order.slug }]);
  });

  test('is dropped in quiet hours', () => {
    storage.set(QUIET_KEY, JSON.stringify({ enabled: true, from: '22:00', to: '08:00', allowPermissions: false }));
    const store = { ...fakeStore([]), orders: [order] } as unknown as Store;
    const desk = new Notifier(store, () => new Date(2026, 9, 23, 23, 0));
    desk.save(allOn());
    desk.observe({ type: 'checks', orderId: 7, data: run(1, 'running') });
    desk.observe({ type: 'checks', orderId: 7, data: run(1, 'passed') });
    expect(FakeNotification.created).toHaveLength(0);
  });
});

describe('quiet recap', () => {
  const at = (day: number, hour: number): Date => new Date(2026, 9, day, hour, 0);
  const blocked = (id: number, fromKey = DEV) => ({ id, ts: 1, fromKey, toName: 'lead', toKey: LEAD, text: 'BLOQUEADO: falta la key', floor: 'mobile' });
  const alert = (id: number) => ({ id, level: 'alerta', floor: 'mobile', files: ['a.ts'], agentKey: DEV }) as never;
  let clock: Date;
  let toasts: string[];
  let desk: Notifier;

  beforeEach(() => {
    storage.clear();
    storage.set(QUIET_KEY, JSON.stringify({ enabled: true, from: '22:00', to: '08:00', allowPermissions: true }));
    FakeNotification.permission = 'granted';
    FakeNotification.created = [];
    page.visible = false;
    page.focused = false;
    clock = at(23, 23);
    toasts = [];
    const store = { ...fakeStore([]), toast: (text: string) => toasts.push(text) } as unknown as Store;
    desk = new Notifier(store, () => clock);
    desk.save(allOn());
  });

  test('recapText lists only the kinds that dropped something, pluralized', () => {
    const none = { delivery: 0, blocked: 0, checks: 0, plans: 0, alerts: 0, stalled: 0 };
    expect(recapText(none, 'es')).toBeNull();
    expect(recapText({ ...none, delivery: 3, blocked: 1, checks: 2 }, 'es')).toBe('Mientras estabas en silencio: 3 entregas, 1 BLOQUEADO, 2 checks en rojo');
    expect(recapText({ ...none, alerts: 1, checks: 1 }, 'es')).toBe('Mientras estabas en silencio: 1 check en rojo, 1 alerta');
    expect(recapText({ ...none, delivery: 1, checks: 2 }, 'en')).toBe('While you were away: 1 delivery, 2 red checks');
  });

  test('QuietRecap counts by kind and empties when taken', () => {
    const recap = new QuietRecap();
    recap.add('delivery');
    recap.add('delivery');
    recap.add('blocked');
    expect(recap.total).toBe(3);
    expect(recap.take()).toEqual({ delivery: 2, blocked: 1, checks: 0, plans: 0, alerts: 0, stalled: 0 });
    expect(recap.total).toBe(0);
  });

  test('one notice when quiet hours end, with the counts, then nothing more', () => {
    desk.observe({ type: 'message', data: blocked(1) });
    desk.observe({ type: 'message', data: blocked(2) });
    desk.observe({ type: 'alert', data: alert(3) });
    desk.tick();
    expect(FakeNotification.created).toHaveLength(0);
    clock = at(24, 8);
    desk.tick();
    desk.tick();
    expect(FakeNotification.created.map((n) => n.title)).toEqual(['Mientras estabas en silencio: 2 BLOQUEADOS, 1 alerta']);
  });

  test('a green check and a deferred question are not counted', () => {
    const order = { id: 7, title: 'Login' };
    const store = { ...fakeStore([], [question('q1')]), orders: [order], toast: () => {} } as unknown as Store;
    const night = new Notifier(store, () => clock);
    night.save(allOn());
    const run = (status: string) => ({ id: 1, orderId: 7, sha: 'a', trigger: 'listo', status, startedAt: 1, endedAt: null, checks: [] }) as never;
    night.observe({ type: 'checks', orderId: 7, data: run('running') });
    night.observe({ type: 'checks', orderId: 7, data: run('passed') });
    night.observe({ type: 'question', data: question('q1') });
    clock = at(24, 8);
    night.tick();
    expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['question:q1']);
  });

  test('a muted floor is not counted', () => {
    storage.set(MUTED_FLOORS_KEY, JSON.stringify(['mobile']));
    desk.observe({ type: 'message', data: blocked(1, LEAD) });
    desk.observe({ type: 'message', data: blocked(2) });
    clock = at(24, 8);
    desk.tick();
    expect(FakeNotification.created.map((n) => n.title)).toEqual(['Mientras estabas en silencio: 1 BLOQUEADO']);
  });

  test('without the desktop permission the recap still counts and shows as a toast', () => {
    FakeNotification.permission = 'denied';
    desk.observe({ type: 'message', data: blocked(1) });
    desk.observe({ type: 'message', data: blocked(1) });
    page.visible = true;
    page.focused = true;
    clock = at(24, 8);
    desk.tick();
    expect(FakeNotification.created).toHaveLength(0);
    expect(toasts).toEqual(['Mientras estabas en silencio: 1 BLOQUEADO']);
  });

  test('nothing dropped means no recap', () => {
    clock = at(24, 8);
    desk.tick();
    expect(FakeNotification.created).toHaveLength(0);
    expect(toasts).toEqual([]);
  });

  test('with the panel in front the recap is a toast', () => {
    desk.observe({ type: 'message', data: blocked(1) });
    page.visible = true;
    page.focused = true;
    clock = at(24, 8);
    desk.tick();
    expect(FakeNotification.created).toHaveLength(0);
    expect(toasts).toEqual(['Mientras estabas en silencio: 1 BLOQUEADO']);
  });
});
