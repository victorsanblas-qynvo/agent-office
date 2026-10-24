import type { OfficeApi } from './api';
import type { BoardHandle } from './board/board';
import type { ChatHandle } from './chat/chat';
import { t } from './i18n';
import { agentName } from './labels';
import { needsFilterAfter } from './focus';
import { activeNeedsOf, getFloorFilter, needToast, setFloorFilter, type Need, type NeedCursor, type NeedKind } from './needs';
import type { NoticeTarget } from './notice-log';
import type { Notifier } from './notify';
import type { SoundDesk } from './sound';
import type { OfficeHandle } from './office/office';
import type { PaletteContext, PaletteEntry, PaletteTarget } from './palette/entries';
import { readRecent, recordRecent, writeRecent } from './palette/recent';
import { openDocument } from './panel/deliverables';
import { focusOrders } from './panel/orders';
import { relaunchable } from './panel/orderable';
import { togglePin } from './pins';
import { broadcastRunning } from './broadcast';
import { contrast } from './contrast';
import { motion } from './motion';
import { theme } from './theme';
import { readSaved } from './table/history';
import { relaunchCandidates, relaunchRunning } from './relaunch-all';
import { openSection, type SectionId } from './panel/section';
import { broadcastTargets, requestMessageAll, requestRelaunchAll, requestSession, requestStatusAll } from './panel/session-controls';
import type { Store } from './store';
import type { TableHandle } from './table/table';
import { TABS, type Tab } from './topbar';
import type { AgentView, QuestionView } from './types';
import type { KeyAction } from './keys';

import type { WhatsNewDialog } from './whats-new-dialog';

export type Nav = {
  store: Store;
  api: OfficeApi | null;
  notifier: Notifier | null;
  sound: SoundDesk | null;
  tab(): Tab;
  showTab(tab: Tab): void;
  office(): OfficeHandle | null;
  board(): BoardHandle;
  chat(): ChatHandle | null;
  table(): TableHandle;
  whatsNew(): WhatsNewDialog;
};

const SECTION_OF: Record<NeedKind, SectionId | null> = {
  permission: 'question',
  question: 'question',
  blocked: 'orders',
  hung: 'floors',
  stalled: 'floors',
  context: 'floors',
  claim: null,
  plan: null,
  checks: null,
  staleOrder: null,
  limit: null,
  budget: null,
};

// Selects the agent, opens the section of the panel that matters and brings the camera to it. The tabs that
// do not show the office are left for the Oficina one.
export function goToAgent(nav: Nav, key: string, section: SectionId | null = null): void {
  const tab = nav.tab();
  if (tab !== 'office' && tab !== 'table') nav.showTab('office');
  nav.store.select(key);
  if (section) openSection(section);
  nav.office()?.focusAgent(key);
}

export function goToNeed(nav: Nav, need: Need): void {
  if (need.kind === 'limit' || need.kind === 'budget') {
    nav.showTab('table');
    return;
  }
  if (need.kind === 'claim') {
    nav.showTab('chat');
    if (need.channel !== undefined) nav.chat()?.show(need.channel);
    return;
  }
  if (need.agentKey !== null) {
    goToAgent(nav, need.agentKey, SECTION_OF[need.kind]);
    return;
  }
  if (need.docPath !== null) {
    const doc = nav.store.documents.find((item) => item.path === need.docPath);
    nav.showTab('plans');
    if (doc) openDocument(nav.store, doc);
    return;
  }
  if (need.orderSlug !== null) {
    nav.showTab('board');
    nav.board().show(need.floor, need.orderSlug);
  }
}

// Opens what a notice pointed at; whatever no longer exists is skipped, and a vanished agent says so.
export function openNoticeTarget(nav: Nav, target: NoticeTarget): void {
  const { store } = nav;
  if (target === null) return;
  switch (target.kind) {
    case 'agent':
      if (store.agents.has(target.key)) goToAgent(nav, target.key);
      else store.toast(t('notices.gone'), 'info');
      return;
    case 'question': {
      const question = store.questions.find((item) => item.id === target.id);
      if (question && store.agents.has(question.agentKey)) goToAgent(nav, question.agentKey, 'question');
      return;
    }
    case 'order':
      if (!store.orders.some((order) => order.floor === target.floor && order.slug === target.slug)) return;
      nav.showTab('board');
      nav.board().show(target.floor, target.slug);
      return;
    case 'doc': {
      const doc = store.documents.find((item) => item.path === target.path);
      if (!doc) return;
      nav.showTab('plans');
      openDocument(store, doc);
      return;
    }
    case 'tab':
      nav.showTab(target.tab);
  }
}

// N and Shift+N: the next or the previous thing that waits for the user, with a toast that says which.
export function stepNeed(nav: Nav, cursor: NeedCursor, direction: 1 | -1): void {
  const step = cursor.step(activeNeedsOf(nav.store), direction);
  if (!step) {
    nav.store.toast(t('needs.none'), 'info');
    return;
  }
  goToNeed(nav, step.need);
  nav.store.toast(needToast(step.position, step.total, step.need), 'info', { ttlMs: 2500 });
}

// The history lives in the Tabla and needs the hub; a replay has none, so there it is the search of the timeline.
export function openHistory(nav: Nav): void {
  if (nav.api === null) {
    openSection('timeline');
    return;
  }
  nav.showTab('table');
  nav.table().showHistory();
}

function oldestQuestion(nav: Nav): QuestionView | undefined {
  const { store } = nav;
  const own = store.selectedKey === null ? undefined : store.questionFor(store.selectedKey);
  if (own) return own;
  let oldest: QuestionView | undefined;
  for (const question of store.questions) {
    if (!oldest || question.createdAt < oldest.createdAt) oldest = question;
  }
  return oldest;
}

function selectedAgent(nav: Nav): AgentView | undefined {
  return nav.store.selectedKey === null ? undefined : nav.store.agents.get(nav.store.selectedKey);
}

// Narrows the whole panel to one floor (or lifts it): the queue's chip, the Tablero and the store follow, and the
// camera and the Chat go to the floor.
export function focusFloor(nav: Nav, floor: string | null): void {
  const { store } = nav;
  const previous = store.focusedFloor();
  setFloorFilter(needsFilterAfter(getFloorFilter(), previous, floor));
  store.setFocus(floor);
  if (floor !== null) goToFocus(nav, floor);
}

// The camera on the floor; the Chat on its channel, which only the floors the hub manages have.
export function goToFocus(nav: Nav, floor: string): void {
  nav.office()?.focusFloor(floor);
  const kind = nav.store.floorBySlug(floor)?.kind;
  if (kind === undefined || kind === 'managed') nav.chat()?.show(floor);
}

// A focus kept from the last visit: the queue's chip and the Chat start on it.
export function restoreFocus(nav: Nav): void {
  const floor = nav.store.focus;
  if (floor === null) return;
  setFloorFilter(floor);
  goToFocus(nav, floor);
}

export function paletteContext(nav: Nav): PaletteContext {
  const { store } = nav;
  const selected = selectedAgent(nav);
  const question = oldestQuestion(nav);
  const asker = question ? store.agents.get(question.agentKey) : undefined;
  const session = selected ? store.sessions.get(selected.sessionId) : undefined;
  const main = selected !== undefined && selected.key === selected.sessionId ? session : undefined;
  return {
    agents: store.officeAgents(),
    floors: store.floorList(),
    documents: store.documents,
    orders: store.orders,
    tabs: TABS.map(({ labelKey }) => t(labelKey)),
    live: nav.api !== null,
    reply: question ? { name: asker ? agentName(asker) : question.agentKey.slice(0, 8) } : null,
    status: selected && session?.office ? { sessionId: selected.sessionId, name: agentName(selected) } : null,
    relaunch: selected && main && relaunchable(main) && main.canRelaunch ? { sessionId: selected.sessionId, name: agentName(selected) } : null,
    relaunchAll: relaunchRunning() ? 0 : relaunchCandidates(store.sessions.values()).length,
    statusAll: broadcastRunning() ? 0 : broadcastTargets(store, true).length,
    messageAll: broadcastRunning() ? 0 : broadcastTargets(store, false).length,
    pins: store.pins,
    notes: store.notes,
    newOrder: nav.board().canCreate(),
    focus: store.focusedFloor(),
    mute: nav.notifier?.preferences.enabled === true,
    muteSound: nav.sound?.preferences.enabled === true,
    searches: readSaved(),
    recent: readRecent(),
  };
}

// Runs what a palette entry points at and remembers the entry, but for the action that forgets them.
export function runEntry(nav: Nav, entry: PaletteEntry): void {
  if (entry.target.type !== 'clearRecent') writeRecent(recordRecent(readRecent(), entry.id));
  runTarget(nav, entry.target);
}

export function runTarget(nav: Nav, target: PaletteTarget): void {
  const { store } = nav;
  switch (target.type) {
    case 'agent':
      goToAgent(nav, target.key);
      break;
    case 'floor':
      nav.showTab('office');
      nav.office()?.focusFloor(target.slug);
      break;
    case 'tab':
      nav.showTab(TABS[target.index].tab);
      break;
    case 'plan': {
      const doc = store.documents.find((item) => item.path === target.path);
      nav.showTab('plans');
      if (doc) openDocument(store, doc);
      break;
    }
    case 'order':
      nav.showTab('board');
      nav.board().show(target.floor, target.slug);
      break;
    case 'note': {
      if (target.key.startsWith('agent:')) {
        goToAgent(nav, target.key.slice('agent:'.length));
      } else {
        const order = store.orders.find((item) => `order:${item.slug}` === target.key);
        if (!order) break;
        nav.showTab('board');
        nav.board().show(order.floor, order.slug);
      }
      store.jumpToNote(target.key);
      break;
    }
    case 'reply': {
      const question = oldestQuestion(nav);
      if (question) goToAgent(nav, question.agentKey, 'question');
      break;
    }
    case 'status':
      void requestSession(nav.api, store, target.sessionId, 'status');
      break;
    case 'relaunch':
      void requestSession(nav.api, store, target.sessionId, 'relaunch');
      break;
    case 'relaunchAll':
      void requestRelaunchAll(nav.api, store);
      break;
    case 'statusAll':
      void requestStatusAll(nav.api, store);
      break;
    case 'messageAll':
      requestMessageAll(nav.api, store);
      break;
    case 'pin':
      store.setPins(togglePin(store.pins, target.key, store.agents));
      break;
    case 'newOrder':
      nav.showTab('board');
      nav.board().newOrder();
      break;
    case 'focus':
      focusFloor(nav, target.floor);
      break;
    case 'lang':
      store.setLang(store.lang === 'es' ? 'en' : 'es');
      break;
    case 'history':
      openHistory(nav);
      break;
    case 'whatsNew':
      nav.whatsNew().open();
      break;
    case 'theme':
      theme.set(target.theme);
      break;
    case 'motion':
      motion.set(target.motion);
      break;
    case 'contrast':
      contrast.set(target.contrast);
      break;
    case 'search': {
      const search = readSaved().find((item) => item.name === target.name);
      if (!search || nav.api === null) break;
      nav.showTab('table');
      nav.table().showSearch(search);
      break;
    }
    case 'clearRecent':
      writeRecent([]);
      store.toast(t('palette.recentCleared'), 'ok');
      break;
    case 'mute': {
      const prefs = nav.notifier?.preferences;
      if (!nav.notifier || !prefs) break;
      prefs.enabled = false;
      nav.notifier.save(prefs);
      store.toast(t('palette.muted'), 'ok');
      break;
    }
    case 'muteSound':
      if (!nav.sound) break;
      nav.sound.mute();
      store.toast(t('palette.mutedSound'), 'ok');
      break;
  }
}

export function runKey(nav: Nav, action: KeyAction, cursor: NeedCursor, extra: { palette(): void; help(): void }): void {
  switch (action.type) {
    case 'palette':
      extra.palette();
      break;
    case 'help':
      extra.help();
      break;
    case 'tab':
      nav.showTab(TABS[action.index].tab);
      break;
    case 'need':
      stepNeed(nav, cursor, action.step);
      break;
    case 'history':
      if (nav.tab() === 'board') nav.board().focusFilter();
      else openHistory(nav);
      break;
    case 'orders':
      focusOrders();
      break;
    case 'board':
      nav.board().key(action.move);
      break;
    case 'escape':
      break;
  }
}
