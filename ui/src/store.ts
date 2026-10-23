import { StateDebouncer } from './debounce';
import { deliveryFloors } from './deliveries';
import { emptyLayouts } from './layouts';
import { applyLang, currentLang, plural, storeLang, t, type Lang, type MessageKey } from './i18n';
import type {
  ActivityView,
  AgentState,
  AgentView,
  ChatMessageView,
  CheckRunView,
  DocumentView,
  FinishedView,
  FloorKind,
  FloorView,
  GuardAlert,
  LayoutsFile,
  MessageView,
  OrderView,
  QuestionOutcome,
  QuestionView,
  RoleId,
  ServerMessage,
  SessionView,
  SettingsView,
  Snapshot,
  UsageView,
} from './types';

export type Topic =
  | 'connection'
  | 'mode'
  | 'floors'
  | 'agents'
  | 'sessions'
  | 'questions'
  | 'messages'
  | 'activity'
  | 'selection'
  | 'toasts'
  | 'tick'
  | 'documents'
  | 'alerts'
  | 'memory'
  | 'settings'
  | 'usage'
  | 'lang'
  | 'chat'
  | 'orders'
  | 'finished'
  | 'deliveries'
  | 'layouts'
  | 'checks'
  | 'worktrees';

export type ConnectionStatus = 'nokey' | 'connecting' | 'online' | 'offline' | 'denied' | 'replay';
export type ToastKind = 'ok' | 'info' | 'error';
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; text: string; kind: ToastKind; action?: ToastAction };
export type ToastOptions = { action?: ToastAction; ttlMs?: number };

type Listener = (topics: ReadonlySet<Topic>) => void;

const MESSAGE_LIMIT = 200;
const ACTIVITY_LIMIT = 500;
const ALERT_LIMIT = 50;
const CHAT_LIMIT = 500;
const TOAST_MS = 4000;
export const ENDED_VISIBLE_MS = 60_000;

const OUTCOME_KEYS: Record<QuestionOutcome, MessageKey> = {
  answered: 'toast.question.answered',
  released: 'toast.question.released',
  expired: 'toast.question.expired',
};

const FLOOR_KIND_RANK: Record<FloorKind, number> = { direccion: 0, redaccion: 1, managed: 2, observed: 3, mantenimiento: 4 };

export class Store {
  floors: FloorView[] = [];
  readonly agents = new Map<string, AgentView>();
  readonly sessions = new Map<string, SessionView>();
  questions: QuestionView[] = [];
  messages: MessageView[] = [];
  activity: ActivityView[] = [];
  documents: DocumentView[] = [];
  alerts: GuardAlert[] = [];
  settings: SettingsView | null = null;
  usage: UsageView | null = null;
  chat: ChatMessageView[] = [];
  orders: OrderView[] = [];
  // Alerts of finished orders and plans the user has not closed yet; the popup is rebuilt from them.
  finished: FinishedView[] = [];
  // Where the user moved desks and furniture, and which model each role wears; the hub keeps it in layouts.json.
  layouts: LayoutsFile = emptyLayouts();
  // The last accepted delivery and the floors it was for; `seq` grows with each, and the printers listen to it.
  delivery: { seq: number; floors: string[] } = { seq: 0, floors: [] };
  readonly checkRuns = new Map<number, CheckRunView>();
  worktreeVersion = 0;
  // Last id seen with the Chat tab open, per channel; what came in the snapshot counts as seen.
  chatSeen = 0;
  private readonly chatSeenIn = new Map<string, number>();
  memoryVersion = new Map<string, number>();
  toasts: Toast[] = [];
  selectedKey: string | null = null;
  connection: ConnectionStatus = 'connecting';
  replay = false;

  private clock: () => number = () => Date.now();
  private readonly listeners = new Set<Listener>();
  private readonly dirty = new Set<Topic>();
  private flushQueued = false;
  private toastSeq = 0;
  private readonly debouncer = new StateDebouncer(() => this.mark('agents'));

  constructor() {
    window.setInterval(() => this.mark('tick'), 1000);
  }

  now(): number {
    return this.clock();
  }

  setClock(clock: () => number): void {
    this.clock = clock;
    this.mark('tick');
  }

  get lang(): Lang {
    return currentLang();
  }

  setLang(lang: Lang): void {
    if (lang === currentLang()) return;
    applyLang(lang);
    storeLang(lang);
    this.mark('lang');
  }

  setReplay(replay: boolean): void {
    this.replay = replay;
    this.mark('mode');
  }

  setConnection(status: ConnectionStatus): void {
    if (this.connection === status) return;
    this.connection = status;
    this.mark('connection');
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  watch(topics: readonly Topic[], run: () => void): () => void {
    const wanted = new Set<Topic>(topics);
    run();
    return this.subscribe((changed) => {
      for (const topic of changed) {
        if (wanted.has(topic)) {
          run();
          return;
        }
      }
    });
  }

  apply(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.applySnapshot(message.data);
        break;
      case 'floors':
        this.floors = message.data;
        this.mark('floors');
        break;
      case 'agent': {
        const agent = withDefaults(message.data);
        this.agents.set(agent.key, agent);
        this.debouncer.observe(agent);
        this.mark('agents');
        break;
      }
      case 'agent-gone':
        if (!this.agents.delete(message.key)) break;
        this.debouncer.forget(message.key);
        this.mark('agents');
        break;
      case 'session':
        this.sessions.set(message.data.sessionId, message.data);
        this.mark('sessions');
        break;
      case 'question':
        this.questions = [...this.questions.filter((q) => q.id !== message.data.id), message.data];
        this.mark('questions');
        break;
      case 'question-closed':
        this.closeQuestion(message.id, message.outcome);
        break;
      case 'message':
        this.messages.push(message.data);
        if (this.messages.length > MESSAGE_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LIMIT);
        this.mark('messages');
        this.noteDelivery(message);
        break;
      case 'activity':
        this.activity.push(message.data);
        if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT);
        this.mark('activity');
        break;
      case 'documents':
        this.documents = message.data;
        this.mark('documents');
        break;
      case 'alert':
        this.alerts = [...this.alerts.filter((a) => a.id !== message.data.id), message.data].slice(-ALERT_LIMIT);
        this.mark('alerts');
        this.toast(
          plural('toast.alert', message.data.files.length, {
            level: t(`toast.alertLevel.${message.data.level}`),
            floor: message.data.floor,
          }),
          message.data.level === 'alerta' ? 'error' : 'info',
        );
        break;
      case 'memory': {
        const key = memoryKey(message.floor, message.role);
        this.memoryVersion.set(key, (this.memoryVersion.get(key) ?? 0) + 1);
        this.mark('memory');
        break;
      }
      case 'settings':
        this.settings = message.data;
        this.mark('settings');
        break;
      case 'usage':
        this.usage = message.data;
        this.mark('usage');
        break;
      case 'tokens': {
        const agent = this.agents.get(message.data.agentKey);
        if (!agent) break;
        this.agents.set(agent.key, { ...agent, tokens: message.data.tokens, context: message.data.context ?? agent.context ?? null });
        this.mark('agents');
        break;
      }
      case 'orders':
        this.orders = message.data;
        this.mark('orders');
        break;
      case 'order': {
        const at = this.orders.findIndex((order) => order.id === message.data.id);
        if (at >= 0) this.orders = this.orders.map((order, index) => (index === at ? message.data : order));
        else this.orders = [...this.orders, message.data];
        this.mark('orders');
        break;
      }
      case 'checks':
        this.checkRuns.set(message.orderId, message.data);
        this.mark('checks');
        break;
      case 'worktrees':
        this.worktreeVersion += 1;
        this.mark('worktrees');
        break;
      case 'finished':
        if (this.finished.some((item) => item.id === message.data.id)) break;
        this.finished = [...this.finished, message.data];
        this.mark('finished');
        this.noteDelivery(message);
        break;
      case 'layouts':
        this.layouts = message.data;
        this.mark('layouts');
        break;
      case 'chat':
        if (this.chat.some((m) => m.id === message.data.id)) break;
        this.chat.push(message.data);
        if (this.chat.length > CHAT_LIMIT) this.chat.splice(0, this.chat.length - CHAT_LIMIT);
        this.mark('chat');
        break;
    }
  }

  reset(): void {
    this.floors = [];
    this.agents.clear();
    this.sessions.clear();
    this.questions = [];
    this.messages = [];
    this.activity = [];
    this.documents = [];
    this.alerts = [];
    this.usage = null;
    this.chat = [];
    this.orders = [];
    this.finished = [];
    this.layouts = emptyLayouts();
    this.checkRuns.clear();
    this.chatSeen = 0;
    this.chatSeenIn.clear();
    this.debouncer.clear();
    this.markAll();
  }

  dropFinished(id: number): void {
    if (!this.finished.some((item) => item.id === id)) return;
    this.finished = this.finished.filter((item) => item.id !== id);
    this.mark('finished');
  }

  select(key: string | null): void {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    this.mark('selection');
  }

  dropQuestion(id: string): void {
    if (!this.questions.some((q) => q.id === id)) return;
    this.questions = this.questions.filter((q) => q.id !== id);
    this.mark('questions');
  }

  toast(text: string, kind: ToastKind = 'info', opts: ToastOptions = {}): void {
    const toast: Toast = { id: ++this.toastSeq, text, kind, ...(opts.action ? { action: opts.action } : {}) };
    this.toasts = [...this.toasts, toast];
    this.mark('toasts');
    window.setTimeout(() => this.dismissToast(toast.id), opts.ttlMs ?? TOAST_MS);
  }

  dismissToast(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.mark('toasts');
  }

  shownState(agent: AgentView): AgentState {
    return this.debouncer.shown(agent.key) ?? agent.state;
  }

  isVisible(agent: AgentView): boolean {
    return agent.endedAt === null || this.now() - agent.endedAt <= ENDED_VISIBLE_MS;
  }

  visibleAgents(): AgentView[] {
    return [...this.agents.values()].filter((agent) => this.isVisible(agent));
  }

  officeAgents(): AgentView[] {
    return this.visibleAgents().filter((agent) => !agent.away);
  }

  floorList(): FloorView[] {
    const known = new Map<string, FloorView>(this.floors.map((floor) => [floor.slug, floor]));
    for (const agent of this.agents.values()) {
      if (known.has(agent.floor) || !this.isVisible(agent)) continue;
      known.set(agent.floor, { slug: agent.floor, label: agent.floor, path: null, stack: 'generic', kind: 'observed', building: 'principal' });
    }
    return [...known.values()].sort((a, b) => {
      const byKind = FLOOR_KIND_RANK[a.kind] - FLOOR_KIND_RANK[b.kind];
      return byKind !== 0 ? byKind : a.label.localeCompare(b.label, currentLang());
    });
  }

  floorBySlug(slug: string): FloorView | undefined {
    return this.floorList().find((floor) => floor.slug === slug);
  }

  questionFor(agentKey: string): QuestionView | undefined {
    let oldest: QuestionView | undefined;
    for (const question of this.questions) {
      if (question.agentKey !== agentKey) continue;
      if (!oldest || question.createdAt < oldest.createdAt) oldest = question;
    }
    return oldest;
  }

  chatOf(channel: string): ChatMessageView[] {
    return this.chat.filter((message) => message.channel === channel);
  }

  // Messages of the agents not seen yet with the tab open, in one channel or in all of them.
  unreadChat(channel?: string): number {
    let count = 0;
    for (const message of this.chat) {
      if (message.origin !== 'agent' || (channel !== undefined && message.channel !== channel)) continue;
      if (message.id > Math.max(this.chatSeen, this.chatSeenIn.get(message.channel) ?? 0)) count += 1;
    }
    return count;
  }

  markChatSeen(channel: string): void {
    const last = this.chatOf(channel).at(-1)?.id ?? 0;
    if (last <= Math.max(this.chatSeen, this.chatSeenIn.get(channel) ?? 0)) return;
    this.chatSeenIn.set(channel, last);
    this.mark('chat');
  }

  prependChat(messages: readonly ChatMessageView[]): void {
    const known = new Set(this.chat.map((message) => message.id));
    const older = messages.filter((message) => !known.has(message.id));
    if (older.length === 0) return;
    this.chat = [...older, ...this.chat].sort((a, b) => a.id - b.id);
    this.mark('chat');
  }

  private applySnapshot(snapshot: Snapshot): void {
    this.floors = snapshot.floors;
    this.agents.clear();
    this.debouncer.clear();
    for (const raw of snapshot.agents) {
      const agent = withDefaults(raw);
      this.agents.set(agent.key, agent);
      this.debouncer.observe(agent);
    }
    this.sessions.clear();
    for (const session of snapshot.sessions) this.sessions.set(session.sessionId, session);
    this.questions = [...snapshot.questions];
    this.messages = snapshot.messages.slice(-MESSAGE_LIMIT);
    this.activity = snapshot.activity.slice(-ACTIVITY_LIMIT);
    this.documents = snapshot.documents ?? [];
    this.alerts = (snapshot.alerts ?? []).slice(-ALERT_LIMIT);
    this.usage = snapshot.usage ?? null;
    this.chat = (snapshot.chat ?? []).slice(-CHAT_LIMIT);
    this.orders = snapshot.orders ?? [];
    this.finished = snapshot.finished ?? [];
    this.layouts = snapshot.layouts ?? emptyLayouts();
    this.chatSeen = this.chat.at(-1)?.id ?? 0;
    this.chatSeenIn.clear();
    this.markAll();
  }

  private closeQuestion(id: string, outcome: QuestionOutcome): void {
    const existed = this.questions.some((q) => q.id === id);
    if (!existed) return;
    this.questions = this.questions.filter((q) => q.id !== id);
    this.mark('questions');
    this.toast(t(OUTCOME_KEYS[outcome]),outcome === 'answered' ? 'ok' : 'info');
  }

  private noteDelivery(message: ServerMessage): void {
    const floors = deliveryFloors(this, message);
    if (floors.length === 0) return;
    this.delivery = { seq: this.delivery.seq + 1, floors };
    this.mark('deliveries');
  }

  private markAll(): void {
    const all: Topic[] = ['floors', 'agents', 'sessions', 'questions', 'messages', 'activity', 'selection', 'documents', 'alerts', 'memory', 'usage', 'chat', 'orders', 'finished', 'layouts'];
    for (const topic of all) this.mark(topic);
  }

  private mark(topic: Topic): void {
    this.dirty.add(topic);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    const changed = new Set(this.dirty);
    this.dirty.clear();
    for (const listener of [...this.listeners]) listener(changed);
  }
}

export function withDefaults(agent: AgentView): AgentView {
  const partial: Partial<Pick<AgentView, 'file' | 'task' | 'away' | 'tokens' | 'waiting' | 'stalledSince' | 'toolSince' | 'context'>> = agent;
  return {
    ...agent,
    file: partial.file ?? null,
    task: partial.task ?? null,
    away: partial.away ?? agent.endedAt !== null,
    tokens: partial.tokens ?? null,
    waiting: partial.waiting ?? null,
    stalledSince: partial.stalledSince ?? null,
    toolSince: partial.toolSince ?? null,
    context: partial.context ?? null,
  };
}

export function memoryKey(floor: string, role: RoleId): string {
  return `${floor}|${role}`;
}
