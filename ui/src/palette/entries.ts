import { fuzzyFilter } from '../fuzzy';
import { canPin } from '../pins';
import { currentLang, plural, t } from '../i18n';
import type { SavedSearch } from '../table/history';
import { THEME_OPTIONS, type ThemePref } from '../theme';
import { agentName, documentStatusLabel, floorKindLabel, floorLabel, roleLabel } from '../labels';
import type { AgentView, DocumentView, FloorView, OrderView } from '../types';

export type PaletteGroup = 'action' | 'tab' | 'floor' | 'agent' | 'plan' | 'order' | 'search';

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['action', 'tab', 'floor', 'agent', 'plan', 'order', 'search'];

export type PaletteTarget =
  | { type: 'agent'; key: string }
  | { type: 'floor'; slug: string }
  | { type: 'tab'; index: number }
  | { type: 'plan'; path: string }
  | { type: 'order'; slug: string; floor: string }
  | { type: 'reply' }
  | { type: 'status'; sessionId: string }
  | { type: 'relaunch'; sessionId: string }
  | { type: 'relaunchAll' }
  | { type: 'statusAll' }
  | { type: 'messageAll' }
  | { type: 'pin'; key: string }
  | { type: 'newOrder' }
  | { type: 'lang' }
  | { type: 'history' }
  | { type: 'mute' }
  | { type: 'muteSound' }
  | { type: 'theme'; theme: ThemePref }
  | { type: 'search'; name: string };

export type PaletteEntry = { id: string; group: PaletteGroup; label: string; hint: string; keywords?: string; target: PaletteTarget; write: boolean };

export type PaletteContext = {
  agents: readonly AgentView[];
  floors: readonly FloorView[];
  documents: readonly DocumentView[];
  orders: readonly OrderView[];
  tabs: readonly string[];
  // Whether there is a hub to write to: false in a replay, where the actions that change something are left out.
  live: boolean;
  reply: { name: string } | null;
  status: { sessionId: string; name: string } | null;
  relaunch: { sessionId: string; name: string } | null;
  // How many open sessions are marked for relaunch.
  relaunchAll: number;
  // How many floor leads a broadcast reaches now; the status one leaves out those asked a moment ago.
  statusAll: number;
  messageAll: number;
  pins: readonly string[];
  newOrder: boolean;
  mute: boolean;
  muteSound: boolean;
  searches: readonly SavedSearch[];
};

export const EMPTY_LIMIT = 30;
export const RESULT_LIMIT = 50;

function actions(context: PaletteContext): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const add = (id: string, label: string, hint: string, target: PaletteTarget, write: boolean): void => {
    out.push({ id: `action:${id}`, group: 'action', label, hint, target, write });
  };
  if (context.reply) add('reply', t('palette.action.reply', { name: context.reply.name }), t('palette.hint.question'), { type: 'reply' }, true);
  if (context.status) add('status', t('palette.action.status', { name: context.status.name }), t('palette.hint.session'), { type: 'status', sessionId: context.status.sessionId }, true);
  if (context.relaunch) add('relaunch', t('palette.action.relaunch', { name: context.relaunch.name }), t('palette.hint.session'), { type: 'relaunch', sessionId: context.relaunch.sessionId }, true);
  if (context.relaunchAll > 0) add('relaunchAll', t('palette.action.relaunchAll'), plural('palette.hint.relaunchAll', context.relaunchAll), { type: 'relaunchAll' }, true);
  if (context.statusAll > 0) add('statusAll', t('palette.action.statusAll'), plural('palette.hint.leads', context.statusAll), { type: 'statusAll' }, true);
  if (context.messageAll > 0) add('messageAll', t('palette.action.messageAll'), plural('palette.hint.leads', context.messageAll), { type: 'messageAll' }, true);
  if (context.newOrder) add('newOrder', t('palette.action.newOrder'), t('palette.hint.board'), { type: 'newOrder' }, true);
  add('lang', t(currentLang() === 'es' ? 'palette.action.langEn' : 'palette.action.langEs'), t('palette.hint.lang'), { type: 'lang' }, false);
  add('history', t('palette.action.history'), '/', { type: 'history' }, false);
  if (context.mute) add('mute', t('palette.action.mute'), t('palette.hint.notifications'), { type: 'mute' }, false);
  if (context.muteSound) add('muteSound', t('palette.action.muteSound'), t('palette.hint.sound'), { type: 'muteSound' }, false);
  for (const option of THEME_OPTIONS) add(`theme:${option}`, t(`palette.action.theme.${option}`), t('palette.hint.theme'), { type: 'theme', theme: option }, false);
  return out;
}

const lastTouch = (order: OrderView): number => Math.max(order.lastActivity ?? 0, order.updatedAt);
const isOpen = (order: OrderView): boolean => order.status !== 'hecho' && order.status !== 'descartado';

// The open orders first, the most recently touched first, then the rest; the Tablero's own notion of open.
function orderEntries(context: PaletteContext): PaletteEntry[] {
  const floors = new Map(context.floors.map((floor) => [floor.slug, floor]));
  return [...context.orders]
    .sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || lastTouch(b) - lastTouch(a) || b.id - a.id)
    .map((order): PaletteEntry => {
      const floor = floors.get(order.floor);
      const floorName = floor ? floorLabel(floor) : order.floor;
      return {
        id: `order:${order.slug}`,
        group: 'order',
        label: order.title,
        hint: `${floorName} · ${t(`board.col.${order.status}`)} · ${order.slug}`,
        keywords: [order.slug, order.branch ?? '', order.floor, floorName].join(' '),
        target: { type: 'order', slug: order.slug, floor: order.floor },
        write: false,
      };
    });
}

export function buildEntries(context: PaletteContext): PaletteEntry[] {
  const entries = actions(context);
  context.tabs.forEach((label, index) => {
    entries.push({ id: `tab:${index}`, group: 'tab', label, hint: String(index + 1), target: { type: 'tab', index }, write: false });
  });
  for (const floor of context.floors) {
    entries.push({ id: `floor:${floor.slug}`, group: 'floor', label: floorLabel(floor), hint: floorKindLabel(floor.kind), target: { type: 'floor', slug: floor.slug }, write: false });
  }
  const floors = new Map(context.floors.map((floor) => [floor.slug, floor]));
  for (const agent of context.agents) {
    const floor = floors.get(agent.floor);
    entries.push({
      id: `agent:${agent.key}`,
      group: 'agent',
      label: agentName(agent),
      hint: `${roleLabel(agent.roleKind)} · ${floor ? floorLabel(floor) : agent.floor}`,
      target: { type: 'agent', key: agent.key },
      write: false,
    });
  }
  for (const doc of context.documents) {
    if (doc.kind !== 'plan') continue;
    entries.push({ id: `plan:${doc.path}`, group: 'plan', label: doc.title, hint: documentStatusLabel(doc.status), target: { type: 'plan', path: doc.path }, write: false });
  }
  entries.push(...orderEntries(context));
  if (context.live) {
    for (const search of context.searches) {
      entries.push({ id: `search:${search.name}`, group: 'search', label: t('palette.search', { name: search.name }), hint: t('palette.hint.search'), keywords: search.filters.q, target: { type: 'search', name: search.name }, write: false });
    }
  }
  const live = new Map(context.agents.map((agent) => [agent.key, agent]));
  for (const agent of context.agents) {
    const pinned = context.pins.includes(agent.key);
    if (!pinned && !canPin(context.pins, agent.key, live)) continue;
    const name = agentName(agent);
    entries.push({
      id: `action:pin:${agent.key}`,
      group: 'action',
      label: t(pinned ? 'palette.action.unpin' : 'palette.action.pin', { name }),
      hint: t('palette.hint.pins'),
      keywords: name,
      target: { type: 'pin', key: agent.key },
      write: true,
    });
  }
  return context.live ? entries : entries.filter((entry) => !entry.write);
}

export type PaletteResult = { entry: PaletteEntry; indices: number[] };

// With no query, the actions and the tabs first; with one, the best matches over name and hint, whose
// highlighted letters are the ones of the name.
export function searchEntries(entries: readonly PaletteEntry[], query: string): PaletteResult[] {
  if (query.trim() === '') return entries.slice(0, EMPTY_LIMIT).map((entry) => ({ entry, indices: [] }));
  return fuzzyFilter(entries, query, (entry) => `${entry.label} ${entry.hint} ${entry.keywords ?? ''}`)
    .slice(0, RESULT_LIMIT)
    .map(({ item, match }) => ({ entry: item, indices: match.indices.filter((index) => index < item.label.length) }));
}
