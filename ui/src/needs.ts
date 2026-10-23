import { t } from './i18n';
import { hubText } from './i18n/hub';
import { collisions, heldClaims, type Collision } from './chat/claims';
import { agentName, isAway } from './labels';
import { readHungMinutes, readSnoozes, writeSnoozes, type Snoozes } from './prefs';
import type { Store, Topic } from './store';
import { clockMinutes } from './time';
import type { AgentState, AgentView, DocumentView, OrderView, QuestionView, UsageView, UsageWindow } from './types';

export type NeedKind = 'permission' | 'question' | 'blocked' | 'hung' | 'stalled' | 'claim' | 'plan' | 'checks' | 'limit';

// Most urgent first: this is also the order of the queue.
export const NEED_KINDS: readonly NeedKind[] = ['permission', 'question', 'blocked', 'hung', 'stalled', 'claim', 'plan', 'checks', 'limit'];

export type Need = {
  id: string;
  kind: NeedKind;
  since: number;
  name: string;
  // Which occurrence this is (the question, the blocking, the window...): a new one is a new entry.
  instance: string;
  agentKey: string | null;
  floor: string | null;
  docPath: string | null;
  orderSlug: string | null;
  // The chat channel where a file claim collides.
  channel?: string;
  // A usage limit that runs out within the half hour goes right after the permissions.
  imminent?: true;
};

export type NeedSources = {
  agents: Iterable<AgentView>;
  questions: readonly QuestionView[];
  documents: readonly DocumentView[];
  orders: readonly OrderView[];
  usage: UsageView | null;
  claims: readonly Collision[];
  now: number;
  // Minutes a tool may run before it is hung; 0 is off.
  hungAfterMinutes: number;
  stateOf(agent: AgentView): AgentState;
};

// Every store topic the queue reads; the time-based entries (limit, hung) also need the tick.
export const NEEDS_TOPICS: readonly Topic[] = ['agents', 'questions', 'documents', 'orders', 'usage', 'chat', 'lang', 'tick'];

const RANK = new Map<NeedKind, number>(NEED_KINDS.map((kind, index) => [kind, index]));
const LIMIT_PCT = 90;
const LIMIT_SOON_MS = 30 * 60_000;
const LIMIT_FRESH_MS = 10 * 60_000;
const HUNG_DETAIL_MAX = 60;
// The reset time of a window wobbles by a minute or so between samples; the hour names the window.
const WINDOW_BUCKET_MS = 3_600_000;
// Tools that wait for somebody by design.
const PATIENT_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode', 'Agent', 'Task']);

function rankOf(need: Need): number {
  return need.imminent ? (RANK.get('permission') ?? 0) + 0.5 : (RANK.get(need.kind) ?? 0);
}

// A window that runs dry before it resets at the pace of the last minutes, is already past 90 %, or is out.
// A sample older than ten minutes no longer vouches for its forecast.
function limitNeed(id: 'five' | 'seven', sample: UsageWindow | null, now: number, at: number): Need | null {
  if (!sample || sample.resetsAt <= now) return null;
  const forecast = sample.forecast;
  const fresh = now - at <= LIMIT_FRESH_MS;
  const exhaustsAt = fresh && forecast && forecast.basis !== 'thin' && !forecast.safe && forecast.exhaustsAt !== null && forecast.exhaustsAt < sample.resetsAt ? forecast.exhaustsAt : null;
  if (exhaustsAt === null && sample.usedPct < LIMIT_PCT) return null;
  const out = sample.usedPct >= 100 || (exhaustsAt !== null && exhaustsAt <= now);
  const window = id === 'five' ? '5 h' : t('usage.week');
  let name: string;
  if (out) name = t('needs.limit.out', { window });
  else if (exhaustsAt !== null) name = t('needs.limit.exhausts', { window, time: clockMinutes(exhaustsAt) });
  else name = t('needs.limit.high', { window, pct: Math.round(sample.usedPct) });
  const instance = String(Math.round(sample.resetsAt / WINDOW_BUCKET_MS));
  const need: Need = { id: `limit:${id}`, kind: 'limit', since: at, name, instance, agentKey: null, floor: null, docPath: null, orderSlug: null };
  if (out || (exhaustsAt !== null && exhaustsAt - now < LIMIT_SOON_MS)) need.imminent = true;
  return need;
}

function agentNeed(kind: NeedKind, agent: AgentView | undefined, key: string, since: number, floor: string | null, instance: string): Need {
  return {
    id: `agent:${key}`,
    kind,
    since,
    name: agent ? agentName(agent) : key.slice(0, 8),
    instance,
    agentKey: key,
    floor,
    docPath: null,
    orderSlug: null,
  };
}

function hungNeed(agent: AgentView, now: number, thresholdMs: number): Need | null {
  const tool = agent.tool;
  if (!tool || PATIENT_TOOLS.has(tool) || agent.waiting !== null) return null;
  const ran = now - agent.updatedAt;
  if (ran < thresholdMs) return null;
  const line = hubText(agent.detail).replace(/\s+/g, ' ').trim();
  const detail = line.length > HUNG_DETAIL_MAX ? `${line.slice(0, HUNG_DETAIL_MAX - 1)}…` : line;
  const params = { agent: agentName(agent), tool };
  const name = detail ? t('needs.hung.detail', { ...params, detail }) : t('needs.hung.name', params);
  const instance = `${tool}:${agent.updatedAt}`;
  return { id: `hung:${agent.key}`, kind: 'hung', since: agent.updatedAt, name, instance, agentKey: agent.key, floor: agent.floor, docPath: null, orderSlug: null };
}

function moreUrgent(a: Need, b: Need): boolean {
  const byKind = rankOf(a) - rankOf(b);
  return byKind !== 0 ? byKind < 0 : a.since < b.since;
}

// What waits for the user, in the order to attend it. An agent counts once, under its most urgent kind, and
// the ones that went home do not count.
export function collectNeeds(sources: NeedSources): Need[] {
  const agents = new Map<string, AgentView>();
  for (const agent of sources.agents) agents.set(agent.key, agent);
  const byAgent = new Map<string, Need>();
  const offer = (need: Need): void => {
    const owner = need.agentKey ?? need.id;
    const known = byAgent.get(owner);
    if (!known || moreUrgent(need, known)) byAgent.set(owner, need);
  };

  for (const question of sources.questions) {
    const agent = agents.get(question.agentKey);
    if (agent && isAway(agent)) continue;
    offer(agentNeed(question.kind === 'permission' ? 'permission' : 'question', agent, question.agentKey, question.createdAt, question.floor, question.id));
  }
  for (const agent of agents.values()) {
    if (isAway(agent)) continue;
    if (sources.stateOf(agent) === 'blocked') offer(agentNeed('blocked', agent, agent.key, agent.stateSince, agent.floor, String(agent.stateSince)));
    if (agent.stalledSince !== null) offer(agentNeed('stalled', agent, agent.key, agent.stalledSince, agent.floor, String(agent.stalledSince)));
  }
  if (sources.hungAfterMinutes > 0) {
    const asking = new Set(sources.questions.map((question) => question.agentKey));
    for (const agent of agents.values()) {
      if (isAway(agent) || asking.has(agent.key) || sources.stateOf(agent) !== 'working') continue;
      const need = hungNeed(agent, sources.now, sources.hungAfterMinutes * 60_000);
      if (need) offer(need);
    }
  }

  const needs = [...byAgent.values()];
  for (const doc of sources.documents) {
    if (doc.kind !== 'plan' || doc.status !== 'entregado') continue;
    needs.push({
      id: `plan:${doc.path}`,
      kind: 'plan',
      since: doc.deliveredAt ?? doc.updatedAt,
      name: doc.title,
      instance: String(doc.deliveredAt ?? doc.updatedAt),
      agentKey: null,
      floor: doc.base[0]?.floor ?? null,
      docPath: doc.path,
      orderSlug: null,
    });
  }
  for (const order of sources.orders) {
    const open = order.status === 'en-curso' || order.status === 'revision';
    if (!open || !order.checks || order.checks.touched.length === 0 || order.checks.forced) continue;
    needs.push({
      id: `checks:${order.slug}`,
      kind: 'checks',
      since: order.updatedAt,
      name: order.title,
      instance: order.checks.sha ?? '',
      agentKey: null,
      floor: order.floor,
      docPath: null,
      orderSlug: order.slug,
    });
  }
  for (const collision of sources.claims) {
    const [first, second] = collision.holders;
    const rest = collision.holders.length - 2;
    const name =
      rest > 0
        ? t('needs.claim.many', { path: collision.path, a: first.name, b: second.name, n: rest })
        : t('needs.claim.two', { path: collision.path, a: first.name, b: second.name });
    const instance = collision.holders.map((holder) => holder.key).sort().join(',');
    needs.push({ id: `claim:${collision.channel}:${collision.path}`, kind: 'claim', since: collision.since, name, instance, agentKey: null, floor: first.floor, docPath: null, orderSlug: null, channel: collision.channel });
  }
  const usage = sources.usage;
  if (usage) {
    for (const need of [limitNeed('five', usage.fiveHour, sources.now, usage.at ?? sources.now), limitNeed('seven', usage.sevenDay, sources.now, usage.at ?? sources.now)]) {
      if (need) needs.push(need);
    }
  }

  return needs.sort((a, b) => rankOf(a) - rankOf(b) || a.since - b.since || a.id.localeCompare(b.id));
}

export function needsOf(store: Store): Need[] {
  return collectNeeds({
    agents: store.agents.values(),
    questions: store.questions,
    documents: store.documents,
    orders: store.orders,
    usage: store.usage,
    claims: collisions(heldClaims(store.chat, store.now())),
    now: store.now(),
    hungAfterMinutes: readHungMinutes(),
    stateOf: (agent) => store.shownState(agent),
  });
}

export function needLabel(need: Pick<Need, 'kind' | 'name'>): string {
  return t(`needs.kind.${need.kind}`, { name: need.name });
}

function hashOf(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 33) + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

// A short fingerprint of the occurrence and of what the entry says: `kind:instance:label`. A snooze "until it
// changes" ends when any of it changes; a timed one only when the occurrence does.
export function needSignature(need: Pick<Need, 'kind' | 'name' | 'instance'>): string {
  return `${need.kind}:${hashOf(need.instance)}:${hashOf(need.name)}`;
}

function occurrenceOf(signature: string): string {
  return signature.slice(0, signature.lastIndexOf(':'));
}

// A permission blocks an agent, so it can never be postponed.
export function canSnooze(need: Pick<Need, 'kind'>): boolean {
  return need.kind !== 'permission';
}

function isSnoozed(need: Need, snoozes: Snoozes, now: number): boolean {
  const entry = snoozes[need.id];
  if (!entry || !canSnooze(need)) return false;
  const signature = needSignature(need);
  if (entry.until === null) return entry.sig === signature;
  return now < entry.until && occurrenceOf(entry.sig) === occurrenceOf(signature);
}

export function activeNeeds(needs: readonly Need[], snoozes: Snoozes, now: number): Need[] {
  return needs.filter((need) => !isSnoozed(need, snoozes, now));
}

export function snoozedNeeds(needs: readonly Need[], snoozes: Snoozes, now: number): Need[] {
  return needs.filter((need) => isSnoozed(need, snoozes, now));
}

// Drops what no longer postpones anything: expired, woken by a change, or gone from the queue.
export function pruneSnoozes(snoozes: Snoozes, needs: readonly Need[], now: number): Snoozes {
  const kept: Snoozes = {};
  for (const need of needs) {
    const entry = snoozes[need.id];
    if (entry && isSnoozed(need, snoozes, now)) kept[need.id] = entry;
  }
  return kept;
}

export function snoozeNeed(snoozes: Snoozes, need: Need, until: number | null): Snoozes {
  return canSnooze(need) ? { ...snoozes, [need.id]: { until, sig: needSignature(need) } } : snoozes;
}

export function wakeNeed(snoozes: Snoozes, id: string): Snoozes {
  const { [id]: _gone, ...rest } = snoozes;
  return rest;
}

type SnoozeMode = Pick<Store, 'replay' | 'connection'>;

// Only the live office keeps snoozes: a replay postpones for its own page and never touches the stored ones.
export function shouldPersistSnoozes(mode: SnoozeMode): boolean {
  return !mode.replay && mode.connection !== 'replay';
}

// Pruning drops what is gone from the queue, so it needs the queue of a live snapshot, not an empty or stale one.
export function shouldPruneSnoozes(mode: SnoozeMode): boolean {
  return shouldPersistSnoozes(mode) && mode.connection === 'online';
}

let pageSnoozes: Snoozes | null = null;

// Read on every use, so another tab's snoozes count here too.
export function loadSnoozes(mode: SnoozeMode): Snoozes {
  if (shouldPersistSnoozes(mode)) return readSnoozes();
  pageSnoozes ??= readSnoozes();
  return pageSnoozes;
}

export function saveSnoozes(mode: SnoozeMode, snoozes: Snoozes): void {
  if (shouldPersistSnoozes(mode)) writeSnoozes(snoozes);
  else pageSnoozes = snoozes;
}

// What N and Shift+N walk: the queue without the postponed entries.
export function activeNeedsOf(store: Store): Need[] {
  return activeNeeds(needsOf(store), loadSnoozes(store), store.now());
}

// Where the menu puts the focus when it opens: the first entry, or the postponed ones when all of them are.
export function menuStart(active: number, snoozed: number): 'entry' | 'snoozed' | null {
  if (active > 0) return 'entry';
  return snoozed > 0 ? 'snoozed' : null;
}

// The arrows walk the menu and wrap around; from outside it they start at the first (or the last) stop.
export function menuStep(at: number, direction: 1 | -1, length: number): number | null {
  if (length === 0) return null;
  if (at < 0) return direction === 1 ? 0 : length - 1;
  return (at + direction + length) % length;
}

// What the trigger shows; the menu rewrites it only when this changes.
export function triggerSignature(lang: string, active: number, total: number): string {
  return `${lang}|${active}|${total === 0 ? 'off' : 'on'}`;
}

export function needToast(position: number, total: number, need: Need): string {
  return t('needs.toast', { n: position, total, label: needLabel(need) });
}

export type NeedStep = { need: Need; position: number; total: number };

// Remembers the last need visited so N and Shift+N walk the queue: they wrap around, and start over from the
// first (or the last) one when the one visited is gone.
export class NeedCursor {
  private lastId: string | null = null;

  reset(): void {
    this.lastId = null;
  }

  step(needs: readonly Need[], direction: 1 | -1): NeedStep | null {
    if (needs.length === 0) {
      this.lastId = null;
      return null;
    }
    const at = this.lastId === null ? -1 : needs.findIndex((need) => need.id === this.lastId);
    let next: number;
    if (at < 0) next = direction === 1 ? 0 : needs.length - 1;
    else next = (at + direction + needs.length) % needs.length;
    const need = needs[next];
    this.lastId = need.id;
    return { need, position: next + 1, total: needs.length };
  }
}
