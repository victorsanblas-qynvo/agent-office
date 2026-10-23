import { isBlockedMessage, leadDeliveryFloor } from './deliveries';
import { currentLang, plural, t, translatorFor, type Lang } from './i18n';
import { agentName, floorLabel } from './labels';
import type { Store } from './store';
import { dueReminders, floorMuted, inQuietHours, quietSilences, readMutedFloors, readQuietHours, readRemindMinutes } from './prefs';
import { keepNotices, NoticeLog, readNotices, type NoticeOutcome, type NoticeTarget } from './notice-log';
import { forecastText } from './usage-card';
import { finishedNotice, readFinishedMode, wantsDesktop } from './panel/finished';
import type { AgentView, CheckRunView, FloorView, DocumentView, FinishedView, GuardAlert, MessageView, QuestionView, ServerMessage, UsageView, UsageWindow } from './types';

export type NotifyEvent = 'permission' | 'question' | 'blocked' | 'done' | 'document' | 'alert' | 'stalled' | 'usage' | 'checks';

export const NOTIFY_EVENTS: readonly NotifyEvent[] = ['permission', 'question', 'blocked', 'done', 'document', 'alert', 'stalled', 'usage', 'checks'];

// Percentages of a usage window that warn, once each per window.
export const USAGE_THRESHOLDS: readonly number[] = [80, 95];

export type CheckNotice = { orderId: number; tag: string; key: 'notify.checks.failed' | 'notify.checks.passed'; body: string };

// A run that was running and is now failed or passed notifies once, with only the name of the first failing check as body.
export function checkTransitionNotice(prev: Pick<CheckRunView, 'id' | 'status'> | null | undefined, next: CheckRunView, enabled = true): CheckNotice | null {
  if (!enabled || !prev || prev.id !== next.id || prev.status !== 'running') return null;
  if (next.status === 'passed') return { orderId: next.orderId, tag: `checks:${next.id}`, key: 'notify.checks.passed', body: '' };
  if (next.status !== 'failed') return null;
  const failing = next.checks.find((check) => check.status === 'failed' || check.status === 'timeout');
  return { orderId: next.orderId, tag: `checks:${next.id}`, key: 'notify.checks.failed', body: failing?.name ?? '' };
}

export type RecapKind = 'delivery' | 'blocked' | 'checks' | 'plans' | 'alerts' | 'stalled';

export const RECAP_KINDS: readonly RecapKind[] = ['delivery', 'blocked', 'checks', 'plans', 'alerts', 'stalled'];

export type RecapCounts = Record<RecapKind, number>;

const RECAP_OF: Partial<Record<NotifyEvent, RecapKind>> = { done: 'delivery', blocked: 'blocked', checks: 'checks', document: 'plans', alert: 'alerts', stalled: 'stalled' };

// What quiet hours dropped, by kind; it lives in memory and is emptied when the recap is taken.
export class QuietRecap {
  private counts: RecapCounts = emptyRecap();

  add(kind: RecapKind): void {
    this.counts[kind] += 1;
  }

  get total(): number {
    return RECAP_KINDS.reduce((sum, kind) => sum + this.counts[kind], 0);
  }

  take(): RecapCounts {
    const taken = this.counts;
    this.counts = emptyRecap();
    return taken;
  }
}

function emptyRecap(): RecapCounts {
  return { delivery: 0, blocked: 0, checks: 0, plans: 0, alerts: 0, stalled: 0 };
}

// One line for the whole quiet stretch, only the kinds that dropped something; null when nothing did.
export function recapText(counts: RecapCounts, lang: Lang): string | null {
  const tr = translatorFor(lang);
  const parts = RECAP_KINDS.filter((kind) => counts[kind] > 0).map((kind) => tr.plural(`notify.recap.${kind}`, counts[kind]));
  return parts.length > 0 ? tr.t('notify.recap.title', { parts: parts.join(', ') }) : null;
}

// Events held back through quiet hours instead of dropped: they stay open (a question) or true (a usage level) after the window; a check result is dropped in quiet hours.
const DEFERRED_EVENTS: ReadonlySet<NotifyEvent> = new Set(['permission', 'question', 'usage']);

export type NotifyPrefs = { enabled: boolean; events: Record<NotifyEvent, boolean> };

const PREFS_KEY = 'agent-office.notify';
export const SEEN_LIMIT = 500;

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

function permissionState(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

function defaultPrefs(): NotifyPrefs {
  return { enabled: false, events: { permission: true, question: true, blocked: true, done: true, document: true, alert: true, stalled: true, usage: true, checks: false } };
}

function readPrefs(): NotifyPrefs {
  const prefs = defaultPrefs();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return prefs;
    const record = raw as { enabled?: unknown; events?: unknown };
    if (typeof record.enabled === 'boolean') prefs.enabled = record.enabled;
    const events = typeof record.events === 'object' && record.events !== null ? (record.events as Record<string, unknown>) : {};
    for (const event of NOTIFY_EVENTS) {
      if (typeof events[event] === 'boolean') prefs.events[event] = events[event];
    }
  } catch {
    // Blocked or broken storage: notifications stay off.
  }
  return prefs;
}

function finishedTarget(view: FinishedView): NoticeTarget {
  const floor = view.floors[0];
  return view.kind === 'order' && floor !== undefined ? { kind: 'order', id: view.id, floor, slug: view.slug } : { kind: 'tab', tab: 'board' };
}

export class Notifier {
  private prefs: NotifyPrefs = readPrefs();
  private readonly seen = new Set<string>();
  private readonly shown = new Map<string, Notification>();
  private documents: Map<string, DocumentView['status']> | null = null;
  private readonly stalled = new Map<string, number | null>();
  private readonly reminded = new Set<string>();
  private readonly lastRuns = new Map<number, CheckRunView>();
  private lastUsage: UsageView | null = null;
  private wasQuiet: boolean;
  private readonly recap = new QuietRecap();
  private readonly logged = new Set<string>();
  readonly notices = new NoticeLog();
  private readonly keeper: { flush(): void };
  // Where a clicked notification, or a notice of the inbox, takes the user.
  openTarget: ((target: NoticeTarget) => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.wasQuiet = inQuietHours(readQuietHours(), this.now());
    const kept = readNotices();
    this.notices.restore(kept.entries, kept.readAt);
    this.keeper = keepNotices(this.notices);
  }

  flushNotices(): void {
    this.keeper.flush();
  }

  get floors(): readonly FloorView[] {
    return this.store.floors;
  }

  get preferences(): NotifyPrefs {
    return { enabled: this.prefs.enabled, events: { ...this.prefs.events } };
  }

  save(prefs: NotifyPrefs): void {
    this.prefs = { enabled: prefs.enabled, events: { ...prefs.events } };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Blocked storage: the choice lasts for this session only.
    }
  }

  test(): void {
    if (permissionState() !== 'granted') return;
    try {
      new Notification(t('notify.test'), { tag: 'test' });
    } catch {
      // Some browsers expose Notification but only allow it through a service worker (for example mobile Chrome).
    }
  }

  // On the store tick: the end of quiet hours offers what is still open, and a question open long enough is announced once more.
  tick(): void {
    const date = this.now();
    const quiet = inQuietHours(readQuietHours(), date);
    const open = this.store.questions;
    if (this.wasQuiet && !quiet) {
      for (const question of open) {
        if (this.seen.has(`question:${question.id}`)) continue;
        this.question(question);
        this.reminded.add(question.id);
      }
      this.usage(this.lastUsage, true);
      this.showRecap();
    }
    this.wasQuiet = quiet;
    const ids = new Set(open.map((question) => question.id));
    for (const id of this.reminded) if (!ids.has(id)) this.reminded.delete(id);
    for (const question of dueReminders(open, date.getTime(), readRemindMinutes(), this.reminded)) {
      const permission = question.kind === 'permission';
      if (quietSilences(readQuietHours(), permission, date)) continue;
      this.reminded.add(question.id);
      this.show(permission ? 'permission' : 'question', `question:${question.id}:remind`, t('notify.remind.title', { agent: this.name(question.agentKey) }), t('notify.openPanel'), { kind: 'question', id: question.id }, question.floor);
    }
  }

  // The panel in front gets the recap as a toast; the desktop notice carries only counts, never a text.
  private showRecap(): void {
    const text = recapText(this.recap.take(), currentLang());
    if (text === null || !this.prefs.enabled) return;
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      this.store.toast(text, 'info');
      return;
    }
    if (permissionState() !== 'granted') return;
    try {
      const notification = new Notification(text, { tag: 'quiet-recap' });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // A browser may expose Notification but refuse the constructor; one failed notice must not break the tick.
    }
  }

  observe(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        // History does not notify: only pending questions, which may have arrived while the hub restarted.
        for (const question of message.data.questions) this.question(question);
        for (const question of dueReminders(message.data.questions, this.now().getTime(), readRemindMinutes(), this.reminded)) this.reminded.add(question.id);
        this.seedDocuments(message.data.documents ?? []);
        this.stalled.clear();
        for (const agent of message.data.agents) this.stalled.set(agent.key, agent.stalledSince ?? null);
        // The thresholds already passed are history, not news.
        this.usage(message.data.usage ?? null, false);
        break;
      case 'usage':
        this.usage(message.data, true);
        break;
      case 'agent':
        this.agent(message.data);
        break;
      case 'agent-gone':
        this.stalled.delete(message.key);
        break;
      case 'question':
        this.question(message.data);
        break;
      case 'question-closed': {
        const tag = `question:${message.id}`;
        this.shown.get(tag)?.close();
        this.shown.delete(tag);
        break;
      }
      case 'message':
        this.message(message.data);
        break;
      case 'documents':
        this.changedDocuments(message.data);
        break;
      case 'alert':
        this.alert(message.data);
        break;
      case 'finished':
        this.finished(message.data);
        break;
      case 'checks':
        this.checks(message.data);
        break;
    }
  }

  private name(key: string): string {
    const agent = this.store.agents.get(key);
    return agent ? agentName(agent) : key.slice(0, 8);
  }

  private agentTarget(key: string): NoticeTarget {
    return { kind: 'agent', key };
  }

  // Bodies stay generic on purpose: the command of a permission, the question and the text of a BLOQUEADO or a
  // HECHO may carry secrets or private details, and the Notification Center shows them even on a locked screen.
  // The panel shows them in full.
  private question(question: QuestionView): void {
    const agent = this.name(question.agentKey);
    if (question.kind === 'permission') {
      const title = question.tool ? t('notify.permission.tool', { agent, tool: question.tool }) : t('notify.permission.title', { agent });
      this.show('permission', `question:${question.id}`, title, t('notify.openPanel'), { kind: 'question', id: question.id }, question.floor);
    } else {
      this.show('question', `question:${question.id}`, t('notify.question.title', { agent }), t('notify.openPanel'), { kind: 'question', id: question.id }, question.floor);
    }
  }

  private message(message: MessageView): void {
    if (message.text === null) return;
    const agent = this.name(message.fromKey);
    if (isBlockedMessage(message)) {
      this.show('blocked', `message:${message.id}`, t('notify.blocked.title', { agent }), t('notify.openPanel'), this.agentTarget(message.fromKey), this.store.agents.get(message.fromKey)?.floor);
    } else {
      const floor = leadDeliveryFloor(this.store, message);
      if (floor !== null) this.show('done', `message:${message.id}`, t('notify.done.title', { agent }), t('notify.openPanel'), this.agentTarget(message.fromKey), floor);
    }
  }

  private finished(view: FinishedView): void {
    if (!wantsDesktop(readFinishedMode())) return;
    const notice = finishedNotice(view);
    this.show('done', `finished:${view.id}`, t(notice.key, notice.params), t('notify.openPanel'), finishedTarget(view), this.mutedFloorOf(view.floors));
  }

  private checks(run: CheckRunView): void {
    const prev = this.lastRuns.get(run.orderId);
    this.lastRuns.set(run.orderId, run);
    const notice = checkTransitionNotice(prev, run, this.prefs.events.checks);
    if (!notice) return;
    const order = this.store.orders.find((item) => item.id === run.orderId);
    if (!order) return;
    this.show('checks', notice.tag, t(notice.key, { title: order.title }), notice.body, { kind: 'order', id: order.id, floor: order.floor, slug: order.slug }, null, notice.key === 'notify.checks.failed');
  }

  // 80 % and 95 % of each window warn once; the tag carries the reset of the window, so the next one warns again.
  private usage(view: UsageView | null, announce: boolean): void {
    if (!view) return;
    this.lastUsage = view;
    const windows: [string, UsageWindow | null][] = [
      ['five', view.fiveHour],
      ['seven', view.sevenDay],
    ];
    for (const [name, sample] of windows) {
      if (!sample) continue;
      for (const threshold of USAGE_THRESHOLDS) {
        if (sample.usedPct < threshold) continue;
        const tag = `usage:${name}:${sample.resetsAt}:${threshold}`;
        if (!announce) {
          this.seen.add(tag);
          continue;
        }
        const title = t(name === 'five' ? 'notify.usage.five' : 'notify.usage.seven', { pct: Math.round(sample.usedPct) });
        this.show('usage', tag, title, forecastText(sample)?.text ?? '', { kind: 'tab', tab: 'table' });
      }
    }
  }

  private agent(agent: AgentView): void {
    const before = this.stalled.get(agent.key) ?? null;
    const since = agent.stalledSince ?? null;
    this.stalled.set(agent.key, since);
    if (before !== null || since === null) return;
    this.show('stalled', `stalled:${agent.key}:${since}`, t('notify.stalled.title', { agent: agentName(agent) }), t('notify.openPanel'), this.agentTarget(agent.key), agent.floor);
  }

  private seedDocuments(documents: readonly DocumentView[]): void {
    this.documents = new Map(documents.map((doc) => [doc.path, doc.status]));
  }

  private changedDocuments(documents: readonly DocumentView[]): void {
    const before = this.documents;
    this.seedDocuments(documents);
    if (before === null) return;
    for (const doc of documents) {
      if (doc.status === before.get(doc.path)) continue;
      let title: string;
      if (doc.status === 'aprobado') {
        title = t(doc.kind === 'plan' ? 'notify.document.approvedPlan' : 'notify.document.approvedSkill', { title: doc.title });
      } else if (doc.status === 'sin-acuerdo') {
        title = t('notify.document.noAgreement', { title: doc.title });
      } else if (doc.status === 'entregado' && doc.kind === 'plan') {
        title = t('notify.document.deliveredPlan', { title: doc.title });
      } else {
        continue;
      }
      this.show('document', `document:${doc.path}:${doc.status}:${doc.round}`, title, '', { kind: 'doc', path: doc.path });
    }
  }

  private alert(alert: GuardAlert): void {
    if (alert.level !== 'alerta') return;
    const floor = this.store.floorBySlug(alert.floor);
    this.show(
      'alert',
      `alert:${alert.id}`,
      t('notify.alert.title', { floor: floor ? floorLabel(floor) : alert.floor }),
      plural('notify.alert.files', alert.files.length),
      this.agentTarget(alert.agentKey),
      alert.floor,
    );
  }

  // A delivery to several floors is silenced only when every one of them is muted.
  private mutedFloorOf(floors: readonly string[]): string | null {
    const muted = readMutedFloors();
    return floors.length > 0 && floors.every((slug) => muted.includes(slug)) ? (floors[0] ?? null) : null;
  }

  // Every candidate lands in the inbox once per outcome, before or after the gate decides.
  private record(event: NotifyEvent, tag: string, title: string, body: string, target: NoticeTarget, floor: string | null, outcome: NoticeOutcome): void {
    const id = `${tag}|${outcome}`;
    if (this.logged.has(id)) return;
    this.logged.add(id);
    if (this.logged.size > SEEN_LIMIT) this.logged.delete(this.logged.values().next().value as string);
    this.notices.push({ at: this.now().getTime(), kind: event, title, ...(body ? { body } : {}), ...(floor ? { floor } : {}), target, outcome });
  }

  // The recap toast needs no desktop permission: what quiet hours would have held still counts without it.
  private countQuiet(event: NotifyEvent, tag: string, floor: string | null, countable: boolean): void {
    const kind = RECAP_OF[event];
    if (!kind || !countable || this.seen.has(tag) || DEFERRED_EVENTS.has(event)) return;
    if (floorMuted(readMutedFloors(), floor, event === 'permission') || !quietSilences(readQuietHours(), event === 'permission', this.now())) return;
    this.seen.add(tag);
    this.recap.add(kind);
  }

  private show(event: NotifyEvent, tag: string, title: string, body: string, target: NoticeTarget, floor: string | null = null, countable = true): void {
    if (!this.prefs.enabled || !this.prefs.events[event]) {
      this.record(event, tag, title, body, target, floor, 'off');
      return;
    }
    if (permissionState() !== 'granted') {
      this.countQuiet(event, tag, floor, countable);
      this.record(event, tag, title, body, target, floor, 'off');
      return;
    }
    if (this.seen.has(tag)) return;
    if (floorMuted(readMutedFloors(), floor, event === 'permission')) {
      this.seen.add(tag);
      this.record(event, tag, title, body, target, floor, 'muted');
      return;
    }
    const quiet = quietSilences(readQuietHours(), event === 'permission', this.now());
    if (quiet && DEFERRED_EVENTS.has(event)) {
      this.record(event, tag, title, body, target, floor, 'deferred');
      return;
    }
    this.seen.add(tag);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    if (quiet) {
      const kind = RECAP_OF[event];
      if (kind && countable) this.recap.add(kind);
      this.record(event, tag, title, body, target, floor, 'quiet');
      return;
    }
    // The panel in front already shows it.
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      this.record(event, tag, title, body, target, floor, 'front');
      return;
    }
    let notification: Notification;
    try {
      notification = new Notification(title, { body, tag });
    } catch {
      // A browser may expose Notification but refuse the constructor; one failed notice must not break the stream.
      this.record(event, tag, title, body, target, floor, 'off');
      return;
    }
    this.record(event, tag, title, body, target, floor, 'shown');
    this.shown.set(tag, notification);
    if (this.shown.size > SEEN_LIMIT) this.shown.delete(this.shown.keys().next().value as string);
    notification.onclick = () => {
      window.focus();
      if (target) this.openTarget?.(target);
      notification.close();
    };
    notification.onclose = () => {
      if (this.shown.get(tag) === notification) this.shown.delete(tag);
    };
  }
}
