import { focusable } from '../focus';
import { fold, fuzzyFilter } from '../fuzzy';
import { noteTitle, type Notes } from '../notes';
import { canPin } from '../pins';
import { currentLang, plural, t } from '../i18n';
import type { SavedSearch } from '../table/history';
import { THEME_OPTIONS, type ThemePref } from '../theme';
import { agentName, documentStatusLabel, floorKindLabel, floorLabel, roleLabel } from '../labels';
import type { AgentView, DocumentView, FloorView, OrderView } from '../types';

export type PaletteGroup = 'action' | 'tab' | 'floor' | 'agent' | 'plan' | 'order' | 'note' | 'search';

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['action', 'tab', 'floor', 'agent', 'plan', 'order', 'note', 'search'];

export type PaletteTarget =
  | { type: 'agent'; key: string }
  | { type: 'floor'; slug: string }
  | { type: 'tab'; index: number }
  | { type: 'plan'; path: string }
  | { type: 'order'; slug: string; floor: string }
  | { type: 'note'; key: string }
  | { type: 'reply' }
  | { type: 'status'; sessionId: string }
  | { type: 'relaunch'; sessionId: string }
  | { type: 'relaunchAll' }
  | { type: 'statusAll' }
  | { type: 'messageAll' }
  | { type: 'pin'; key: string }
  | { type: 'newOrder' }
  | { type: 'focus'; floor: string | null }
  | { type: 'lang' }
  | { type: 'history' }
  | { type: 'whatsNew' }
  | { type: 'mute' }
  | { type: 'muteSound' }
  | { type: 'theme'; theme: ThemePref }
  | { type: 'search'; name: string }
  | { type: 'clearRecent' };

export type PaletteEntry = { id: string; group: PaletteGroup; label: string; hint: string; keywords?: string; body?: string; target: PaletteTarget; write: boolean };

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
  notes: Notes;
  newOrder: boolean;
  // The floor the panel is focused on, if any.
  focus: string | null;
  mute: boolean;
  muteSound: boolean;
  searches: readonly SavedSearch[];
  // The ids of the entries run lately, newest first.
  recent: readonly string[];
};

export const EMPTY_LIMIT = 30;
export const RESULT_LIMIT = 50;
export const RECENT_SHOWN = 8;

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
  const focusFloors = new Set(focusable(context.floors));
  for (const floor of context.floors) {
    if (!focusFloors.has(floor.slug) || floor.slug === context.focus) continue;
    const name = floorLabel(floor);
    out.push({ id: `action:focus:${floor.slug}`, group: 'action', label: t('palette.action.focus', { name }), hint: t('palette.hint.focus'), keywords: `${floor.slug} ${name}`, target: { type: 'focus', floor: floor.slug }, write: false });
  }
  if (context.focus !== null) add('focusClear', t('palette.action.focusClear'), t('palette.hint.focus'), { type: 'focus', floor: null }, false);
  add('lang', t(currentLang() === 'es' ? 'palette.action.langEn' : 'palette.action.langEs'), t('palette.hint.lang'), { type: 'lang' }, false);
  add('history', t('palette.action.history'), '/', { type: 'history' }, false);
  add('whatsNew', t('palette.action.whatsNew'), t('palette.hint.whatsNew'), { type: 'whatsNew' }, false);
  if (context.mute) add('mute', t('palette.action.mute'), t('palette.hint.notifications'), { type: 'mute' }, false);
  if (context.muteSound) add('muteSound', t('palette.action.muteSound'), t('palette.hint.sound'), { type: 'muteSound' }, false);
  if (context.recent.length > 0) add('clearRecent', t('palette.action.clearRecent'), t('palette.hint.recent'), { type: 'clearRecent' }, false);
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

// One entry per note whose order or agent is still there, the most recently written first; the text of the note
// is matched by `body`, as typed, because letters in order would fit almost any long text.
function noteEntries(context: PaletteContext): PaletteEntry[] {
  const orders = new Map(context.orders.map((order) => [`order:${order.slug}`, order]));
  const agents = new Map(context.agents.map((agent) => [`agent:${agent.key}`, agent]));
  const out: PaletteEntry[] = [];
  for (const [key, note] of Object.entries(context.notes).sort(([, a], [, b]) => b.updatedAt - a.updatedAt)) {
    const order = orders.get(key);
    const agent = agents.get(key);
    const name = order ? order.title : agent ? agentName(agent) : null;
    if (name === null) continue;
    out.push({ id: `note:${key}`, group: 'note', label: t('palette.note', { name }), hint: noteTitle(note.text), keywords: order ? order.slug : agent?.key, body: note.text, target: { type: 'note', key }, write: false });
  }
  return out;
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
  entries.push(...noteEntries(context));
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

export type PaletteResult = { entry: PaletteEntry; indices: number[]; recent?: true };

// The entries run lately that still exist, newest first.
export function recentEntries(entries: readonly PaletteEntry[], recent: readonly string[]): PaletteEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: PaletteEntry[] = [];
  for (const id of recent) {
    const entry = byId.get(id);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

// The entries with the recent ones first, newest first, and the others as they were. With no query the first
// RECENT_SHOWN lead the list; with one they only break ties, because the fuzzy ranking keeps the order of
// equal scores, so a recent entry never outranks a better match.
export function withRecent(entries: readonly PaletteEntry[], recent: readonly string[], query: string): PaletteEntry[] {
  const lately = recentEntries(entries, recent);
  const head = query.trim() === '' ? lately.slice(0, RECENT_SHOWN) : lately;
  const first = new Set(head);
  return [...head, ...entries.filter((entry) => !first.has(entry))];
}

// With no query, the recent entries, then the actions and the tabs; with one, the best matches over name and
// hint, whose highlighted letters are the ones of the name.
export function searchEntries(entries: readonly PaletteEntry[], query: string, recent: readonly string[] = []): PaletteResult[] {
  const ordered = withRecent(entries, recent, query);
  if (query.trim() === '') {
    const shown = recentEntries(entries, recent).slice(0, RECENT_SHOWN).length;
    return ordered.slice(0, shown + EMPTY_LIMIT).map((entry, index): PaletteResult => (index < shown ? { entry, indices: [], recent: true } : { entry, indices: [] }));
  }
  const matched = fuzzyFilter(ordered, query, (entry) => `${entry.label} ${entry.hint} ${entry.keywords ?? ''}`).map(({ item, match }): PaletteResult => ({ entry: item, indices: match.indices.filter((index) => index < item.label.length) }));
  const needle = fold(query.trim());
  const found = new Set(matched.map((result) => result.entry));
  const inBody = ordered.filter((entry) => !found.has(entry) && entry.body !== undefined && fold(entry.body).includes(needle)).map((entry): PaletteResult => ({ entry, indices: [] }));
  return [...matched, ...inBody].slice(0, RESULT_LIMIT);
}
