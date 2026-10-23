import { activeOrder, checksBadge } from './board/columns';
import { agentName, compareAgents, documentStatusLabel, floorLabel, formatTokens, isAway, STATE_COLORS, stateLabel, tokensTotal } from './labels';
import { plural, t } from './i18n';
import { duration } from './time';
import type { Store } from './store';
import type { Tab } from './topbar';
import type { AgentState, AgentView, DocumentView, FloorView, OrderView, UsageSummary, UsageView, UsageWindow } from './types';

export const BOARD_MAX_LINES = 8;
export const BOARD_REPAINT_MS = 10_000;
export const TODAY_POLL_MS = 60_000;

export type BoardTone = 'plain' | 'ok' | 'warn' | 'danger' | 'muted';

export type BoardLine = { text: string; tone: BoardTone; dot?: string; bar?: number };

export type BoardData = { title: string; tab: Tab; lines: BoardLine[] };

export type BoardInput = {
  floor: FloorView;
  // Every floor of the office: the board of the direction scores the managed ones.
  floors: readonly FloorView[];
  // The agents in the office, all floors: the board of the direction counts them.
  everyone: readonly AgentView[];
  orders: readonly OrderView[];
  documents: readonly DocumentView[];
  usage: UsageView | null;
  // The spend of today when the hub could be asked; null in a replay or before the first answer.
  today: UsageSummary | null;
  now: number;
  stateOf(agent: AgentView): AgentState;
};

const WARN_PCT = 70;
const DANGER_PCT = 90;
const AGENT_ROWS = 5;
const TOP_PLANS = 3;
const NO_VALUE = '—';

function pctTone(pct: number): BoardTone {
  if (pct >= DANGER_PCT) return 'danger';
  return pct >= WARN_PCT ? 'warn' : 'ok';
}

function windowLine(label: string, window: UsageWindow | null, now: number): BoardLine {
  if (!window || window.resetsAt <= now) return { text: `${label} ${NO_VALUE}`, tone: 'muted' };
  const pct = Math.round(window.usedPct);
  return { text: `${label} ${pct} % · ${duration(window.resetsAt - now)}`, tone: pctTone(window.usedPct), bar: Math.min(100, Math.max(0, window.usedPct)) };
}

export type FloorScore = { slug: string; label: string; open: number; red: number; blocked: number; working: number };

const CLOSED: ReadonlySet<string> = new Set(['hecho', 'descartado']);

// Working means busy and not stuck: idle, done, failed and blocked agents do not count.
export function isWorking(agent: AgentView, stateOf: (agent: AgentView) => AgentState): boolean {
  const state = stateOf(agent);
  return state !== 'idle' && state !== 'done' && state !== 'failed' && state !== 'blocked';
}

// One score per managed floor, the ones with red checks or blocked agents first, then the most open orders.
export function floorScores(floors: readonly FloorView[], agents: readonly AgentView[], orders: readonly OrderView[], stateOf: (agent: AgentView) => AgentState): FloorScore[] {
  const scores = floors
    .filter((floor) => floor.kind === 'managed')
    .map((floor): FloorScore => {
      const open = orders.filter((order) => order.floor === floor.slug && !CLOSED.has(order.status));
      const states = agents.filter((agent) => agent.floor === floor.slug && !isAway(agent)).map(stateOf);
      return {
        slug: floor.slug,
        label: floorLabel(floor),
        open: open.length,
        red: open.filter((order) => checksBadge(order)?.kind === 'failed' && !order.checks?.forced).length,
        blocked: states.filter((state) => state === 'blocked').length,
        working: agents.filter((agent) => agent.floor === floor.slug && !isAway(agent) && isWorking(agent, stateOf)).length,
      };
    });
  const urgent = (score: FloorScore): boolean => score.red > 0 || score.blocked > 0;
  return scores.sort((a, b) => Number(urgent(b)) - Number(urgent(a)) || b.open - a.open || a.label.localeCompare(b.label));
}

function scoreText(score: FloorScore): string {
  const parts = [
    score.open > 0 ? t('whiteboard.floor.open', { n: score.open }) : t('whiteboard.floor.clear'),
    score.red > 0 ? t('whiteboard.floor.red', { n: score.red }) : '',
    score.blocked > 0 ? t('whiteboard.floor.blocked', { n: score.blocked }) : '',
    score.working > 0 ? t('whiteboard.floor.working', { n: score.working }) : '',
  ];
  return `${score.label}  ${parts.filter(Boolean).join(' · ')}`;
}

function directionBoard(input: BoardInput): BoardLine[] {
  const { today, everyone, usage, now } = input;
  const working = everyone.filter((agent) => isWorking(agent, input.stateOf)).length;
  const lines: BoardLine[] = [
    { text: t('whiteboard.today', { tokens: today ? formatTokens(tokensTotal(today.total.tokens)) : NO_VALUE }), tone: today ? 'plain' : 'muted' },
    windowLine('5 h', usage?.fiveHour ?? null, now),
    windowLine(t('usage.week'), usage?.sevenDay ?? null, now),
    { text: t('whiteboard.working', { working, total: everyone.length }), tone: 'plain' },
  ];
  const scores = floorScores(input.floors, everyone, input.orders, input.stateOf);
  const room = BOARD_MAX_LINES - lines.length;
  const shown = scores.length > room ? room - 1 : scores.length;
  for (const score of scores.slice(0, shown)) lines.push({ text: scoreText(score), tone: score.red > 0 || score.blocked > 0 ? 'danger' : score.open === 0 ? 'muted' : 'plain' });
  if (scores.length > shown) lines.push({ text: t('whiteboard.floors.more', { n: scores.length - shown }), tone: 'muted' });
  return lines;
}

function floorBoard(input: BoardInput): BoardLine[] {
  const { floor } = input;
  const here = input.everyone.filter((agent) => agent.floor === floor.slug && !isAway(agent)).sort(compareAgents);
  const lead = here.find((agent) => agent.roleKind === 'lead');
  const lines: BoardLine[] = [{ text: t('whiteboard.task', { task: lead?.task ?? NO_VALUE }), tone: lead?.task ? 'plain' : 'muted' }];
  if (here.length === 0) {
    lines.push({ text: t('floors.nobody'), tone: 'muted' });
  } else {
    const shown = here.length > AGENT_ROWS ? AGENT_ROWS - 1 : here.length;
    for (const agent of here.slice(0, shown)) {
      const state = input.stateOf(agent);
      lines.push({ text: `${agentName(agent)} · ${stateLabel(state)}`, tone: state === 'blocked' || state === 'failed' ? 'danger' : 'plain', dot: STATE_COLORS[state] });
    }
    if (here.length > shown) lines.push({ text: t('whiteboard.more', { n: here.length - shown }), tone: 'muted' });
  }
  const order = activeOrder(input.orders, floor.slug);
  if (order) lines.push({ text: t('whiteboard.order', { title: order.title }), tone: 'plain' });
  return lines;
}

function recent(doc: DocumentView): number {
  return Math.max(doc.updatedAt, doc.deliveredAt ?? 0, doc.decidedAt ?? 0);
}

function topDocuments(docs: readonly DocumentView[]): BoardLine[] {
  return [...docs]
    .sort((a, b) => recent(b) - recent(a))
    .slice(0, TOP_PLANS)
    .map((doc) => ({ text: `${doc.title} · ${documentStatusLabel(doc.status)}`, tone: doc.status === 'sin-acuerdo' ? 'danger' : doc.status === 'entregado' ? 'warn' : 'plain' }));
}

function plansBoard(input: BoardInput): BoardLine[] {
  const plans = input.documents.filter((doc) => doc.kind === 'plan' && doc.status !== 'descartado' && doc.status !== 'cerrado');
  if (plans.length === 0) return [{ text: t('whiteboard.noPlans'), tone: 'muted' }];
  const count = (...statuses: DocumentView['status'][]): number => plans.filter((doc) => statuses.includes(doc.status)).length;
  const pending = count('entregado');
  return [
    { text: plural('whiteboard.plans.pending', pending), tone: pending > 0 ? 'warn' : 'muted' },
    { text: plural('whiteboard.plans.running', count('ejecutando')), tone: 'plain' },
    { text: plural('whiteboard.plans.drafting', count('borrador', 'revision', 'aprobado', 'sin-acuerdo')), tone: 'plain' },
    ...topDocuments(plans),
  ];
}

function skillsBoard(input: BoardInput): BoardLine[] {
  const skills = input.documents.filter((doc) => doc.kind === 'skill' && doc.status !== 'descartado');
  if (skills.length === 0) return [{ text: t('whiteboard.noSkills'), tone: 'muted' }];
  const approved = skills.filter((doc) => doc.status === 'aprobado' || doc.status === 'cerrado').length;
  return [
    { text: plural('whiteboard.skills.total', skills.length), tone: 'plain' },
    { text: plural('whiteboard.skills.approved', approved), tone: approved > 0 ? 'ok' : 'muted' },
    ...topDocuments(skills),
  ];
}

export function boardTab(input: Pick<BoardInput, 'floor' | 'orders'>): Tab {
  const { floor } = input;
  if (floor.kind === 'redaccion') return 'plans';
  if (floor.kind === 'managed' && activeOrder(input.orders, floor.slug)) return 'board';
  return 'table';
}

// What the whiteboard of a floor says, as plain lines the painter draws.
export function boardData(input: BoardInput): BoardData {
  const { floor } = input;
  let lines: BoardLine[];
  switch (floor.kind) {
    case 'direccion':
      lines = directionBoard(input);
      break;
    case 'redaccion':
      lines = plansBoard(input);
      break;
    case 'mantenimiento':
      lines = skillsBoard(input);
      break;
    default:
      lines = floorBoard(input);
  }
  return { title: floorLabel(floor), tab: boardTab(input), lines: lines.slice(0, BOARD_MAX_LINES) };
}

export function boardSignature(data: BoardData): string {
  return JSON.stringify([data.title, data.tab, data.lines]);
}

// The input of the board of one floor from the live store; null when the floor is gone.
export function boardInputFor(store: Store, slug: string, today: UsageSummary | null): BoardInput | null {
  const floor = store.floorBySlug(slug);
  if (!floor) return null;
  return {
    floor,
    floors: store.floors,
    everyone: store.officeAgents(),
    orders: store.orders,
    documents: store.documents,
    usage: store.usage,
    today,
    now: store.now(),
    stateOf: (agent) => store.shownState(agent),
  };
}
