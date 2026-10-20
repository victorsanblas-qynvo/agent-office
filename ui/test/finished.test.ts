import { beforeEach, describe, expect, test } from 'bun:test';
import { applyLang, t } from '../src/i18n/index';
import { NOTIFY_EVENTS, Notifier, type NotifyPrefs } from '../src/notify';
import { FINISHED_KEY, FinishedQueue, finishedHeading, finishedNotice, readFinishedMode, wantsDesktop, wantsPopup, writeFinishedMode } from '../src/panel/finished';
import type { Store } from '../src/store';
import type { FinishedView, OrderView, ServerMessage } from '../src/types';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static created: FakeNotification[] = [];
  static requestPermission = async (): Promise<NotificationPermission> => FakeNotification.permission;
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
Object.assign(globalThis, {
  Notification: FakeNotification,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  document: { visibilityState: 'hidden', hasFocus: () => false, documentElement: { lang: 'es' } },
  window: { focus: () => {} },
});

// The tests share the process with the other files: the texts asserted here are the Spanish ones.
beforeEach(() => applyLang('es'));

const finished = (id: number, over: Partial<FinishedView> = {}): FinishedView => ({
  id,
  ts: id * 10,
  kind: 'order',
  slug: `o-${id}`,
  title: `Encargo ${id}`,
  floors: ['mobile'],
  branch: `encargo/o-${id}`,
  summary: 'listo',
  cycle: 1,
  manual: false,
  checks: { passed: 2, total: 2 },
  touched: [],
  prUrl: null,
  orderSlugs: [`o-${id}`],
  ...over,
});

describe('the queue of popups', () => {
  test('several arriving together are shown one after the other, "1 of 3" first', () => {
    const queue = new FinishedQueue();
    expect(queue.current()).toBeNull();
    expect(queue.position()).toEqual({ n: 0, total: 0 });
    for (const id of [1, 2, 3]) expect(queue.add(finished(id))).toBe(true);
    expect(queue.add(finished(2))).toBe(false);
    expect(queue.current()?.id).toBe(1);
    expect(queue.position()).toEqual({ n: 1, total: 3 });
    expect(t('finished.counter', queue.position())).toBe('1 de 3');
    expect(queue.close()?.id).toBe(1);
    expect(queue.current()?.id).toBe(2);
    expect(t('finished.counter', queue.position())).toBe('1 de 2');
    queue.close();
    queue.close();
    expect(queue.close()).toBeNull();
    expect(queue.size).toBe(0);
  });

  test('a reload rebuilds the queue from the alerts nobody closed, oldest first', () => {
    const queue = new FinishedQueue();
    queue.rebuild([finished(3), finished(1), finished(2)]);
    expect(queue.current()?.id).toBe(1);
    expect(queue.position().total).toBe(3);
    queue.rebuild([finished(3)]);
    expect(queue.current()?.id).toBe(3);
    queue.rebuild([]);
    expect(queue.current()).toBeNull();
  });
});

describe('what a popup says', () => {
  test('order or plan, and again once reopened', () => {
    expect(t(finishedHeading(finished(1)).key, finishedHeading(finished(1)).params)).toBe('Encargo terminado');
    const again = finishedHeading(finished(1, { cycle: 2 }));
    expect(t(again.key, again.params)).toBe('Encargo terminado de nuevo (ciclo 2)');
    expect(t(finishedHeading(finished(1, { kind: 'plan' })).key)).toBe('Plan terminado');
    const planAgain = finishedHeading(finished(1, { kind: 'plan', cycle: 3 }));
    expect(t(planAgain.key, planAgain.params)).toBe('Plan terminado de nuevo (ciclo 3)');
  });

  test('the desktop notice carries the title', () => {
    const notice = finishedNotice(finished(1, { title: 'Login con Apple' }));
    expect(t(notice.key, notice.params)).toBe('Encargo terminado: Login con Apple');
    const plan = finishedNotice(finished(1, { kind: 'plan', title: 'Login con Apple' }));
    expect(t(plan.key, plan.params)).toBe('Plan terminado: Login con Apple');
  });
});

describe('the preference', () => {
  beforeEach(() => storage.clear());

  test('both by default, then what was chosen, junk ignored', () => {
    expect(readFinishedMode()).toBe('both');
    writeFinishedMode('popup');
    expect(storage.get(FINISHED_KEY)).toBe('"popup"');
    expect(readFinishedMode()).toBe('popup');
    writeFinishedMode('desktop');
    expect(readFinishedMode()).toBe('desktop');
    storage.set(FINISHED_KEY, '"otra cosa"');
    expect(readFinishedMode()).toBe('both');
    storage.set(FINISHED_KEY, 'no es json');
    expect(readFinishedMode()).toBe('both');
  });

  test('popup, desktop or both decide what is shown', () => {
    expect([wantsPopup('popup'), wantsDesktop('popup')]).toEqual([true, false]);
    expect([wantsPopup('desktop'), wantsDesktop('desktop')]).toEqual([false, true]);
    expect([wantsPopup('both'), wantsDesktop('both')]).toEqual([true, true]);
  });
});

describe('the desktop notice of a finished order', () => {
  const orders: OrderView[] = [{ id: 1, floor: 'mobile', worktree: { path: '/x', state: 'listo', error: null, stale: false } } as OrderView];
  let notifier: Notifier;
  let opened: FinishedView[];

  beforeEach(() => {
    storage.clear();
    FakeNotification.created = [];
    opened = [];
    const store = {
      agents: new Map([['lead-1', { key: 'lead-1', name: 'lead-mobile', roleKind: 'lead', floor: 'mobile' }]]),
      documents: [],
      orders,
      select: () => {},
      floorBySlug: () => undefined,
    } as unknown as Store;
    notifier = new Notifier(store);
    notifier.save({ enabled: true, events: Object.fromEntries(NOTIFY_EVENTS.map((event) => [event, true])) as NotifyPrefs['events'] });
    notifier.openFinished = (view) => opened.push(view);
  });

  const arrives = (view: FinishedView) => notifier.observe({ type: 'finished', data: view } as ServerMessage);

  test('says "Encargo terminado: <title>", once, and a click takes to the board', () => {
    arrives(finished(5, { title: 'Login con Apple' }));
    arrives(finished(5, { title: 'Login con Apple' }));
    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0]?.title).toBe('Encargo terminado: Login con Apple');
    expect(FakeNotification.created[0]?.options.tag).toBe('finished:5');
    FakeNotification.created[0]?.onclick?.();
    expect(opened.map((v) => v.id)).toEqual([5]);
  });

  test('only when the user chose desktop or both', () => {
    writeFinishedMode('popup');
    arrives(finished(6));
    expect(FakeNotification.created).toHaveLength(0);
    writeFinishedMode('desktop');
    arrives(finished(7));
    writeFinishedMode('both');
    arrives(finished(8));
    expect(FakeNotification.created.map((n) => n.options.tag)).toEqual(['finished:7', 'finished:8']);
  });

  test('the snapshot does not notify for alerts that were waiting', () => {
    notifier.observe({ type: 'snapshot', data: { now: 1, floors: [], agents: [], sessions: [], questions: [], messages: [], activity: [], documents: [], alerts: [], finished: [finished(9)] } } as unknown as ServerMessage);
    expect(FakeNotification.created).toHaveLength(0);
  });

  test('a floor that works with orders does not also notify the plain HECHO message', () => {
    const message = { id: 3, ts: 1, fromKey: 'lead-1', toName: 'director', toKey: null, text: 'HECHO: algo — validado', floor: 'mobile' };
    notifier.observe({ type: 'message', data: message });
    expect(FakeNotification.created).toHaveLength(0);
  });
});
