import { t } from './i18n';
import { hubText } from './i18n/hub';
import { collisions, heldClaims, type Collision } from './chat/claims';
import { agentName, isAway } from './labels';
import { readHungMinutes, readSnoozes, type Snoozes } from './prefs';
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
  const need: Need = { id: `limit:${id}`, kind: 'limit', since: at, name, agentKey: null, floor: null, docPath: null, orderSlug: null };
  if (out || (exhaustsAt !== null && exhaustsAt - now < LIMIT_SOON_MS)) need.imminent = true;
  return need;
}

function agentNeed(kind: NeedKind, agent: AgentView | undefined, key: string, since: number, floor: string | null): Need {
  return {
    id: `agent:${key}`,
    kind,
    since,
    name: agent ? agentName(agent) : key.slice(0, 8),
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
  const params = { agent: agentName(agent), min: Math.floor(ran / 60_000), tool };
  const name = detail ? t('needs.hung.detail', { ...params, detail }) : t('needs.hung.name', params);
  return { id: `hung:${agent.key}`, kind: 'hung', since: agent.updatedAt, name, agentKey: agent.key, floor: agent.floor, docPath: null, orderSlug: null };
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
    const known = byAgent.get(need.id);
    if (!known || moreUrgent(need, known)) byAgent.set(need.id, need);
  };

  for (const question of sources.questions) {
    const agent = agents.get(question.agentKey);
    if (agent && isAway(agent)) continue;
    offer(agentNeed(question.kind === 'permission' ? 'permission' : 'question', agent, question.agentKey, question.createdAt, question.floor));
  }
  for (const agent of agents.values()) {
    if (isAway(agent)) continue;
    if (sources.stateOf(agent) === 'blocked') offer(agentNeed('blocked', agent, agent.key, agent.stateSince, agent.floor));
    if (agent.stalledSince !== null) offer(agentNeed('stalled', agent, agent.key, agent.stalledSince, agent.floor));
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
    needs.push({ id: `claim:${collision.channel}:${collision.path}`, kind: 'claim', since: collision.since, name, agentKey: null, floor: first.floor, docPath: null, orderSlug: null, channel: collision.channel });
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

// A short fingerprint of what the entry says: when it changes, a snooze "until it changes" ends.
export function needSignature(need: Pick<Need, 'kind' | 'name'>): string {
  const text = `${need.kind}|${need.name}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 33) + text.charCodeAt(i)) | 0;
  return `${need.kind}:${(hash >>> 0).toString(36)}`;
}

// A permission blocks an agent, so it can never be postponed.
export function canSnooze(need: Pick<Need, 'kind'>): boolean {
  return need.kind !== 'permission';
}

function isSnoozed(need: Need, snoozes: Snoozes, now: number): boolean {
  const entry = snoozes[need.id];
  if (!entry || !canSnooze(need) || entry.sig !== needSignature(need)) return false;
  return entry.until === null || now < entry.until;
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

// What N and Shift+N walk: the queue without the postponed entries.
export function activeNeedsOf(store: Store): Need[] {
  return activeNeeds(needsOf(store), readSnoozes(), store.now());
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
