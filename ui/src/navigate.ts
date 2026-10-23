import type { OfficeApi } from './api';
import type { BoardHandle } from './board/board';
import type { ChatHandle } from './chat/chat';
import { t } from './i18n';
import { agentName } from './labels';
import { activeNeedsOf, needToast, type Need, type NeedCursor, type NeedKind } from './needs';
import type { Notifier } from './notify';
import type { SoundDesk } from './sound';
import type { OfficeHandle } from './office/office';
import type { PaletteContext, PaletteTarget } from './palette/entries';
import { openDocument } from './panel/deliverables';
import { focusOrders } from './panel/orders';
import { relaunchable } from './panel/orderable';
import { openSection, type SectionId } from './panel/section';
import { requestSession } from './panel/session-controls';
import type { Store } from './store';
import type { TableHandle } from './table/table';
import { TABS, type Tab } from './topbar';
import type { AgentView, QuestionView } from './types';
import type { KeyAction } from './keys';

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
};

const SECTION_OF: Record<NeedKind, SectionId | null> = {
  permission: 'question',
  question: 'question',
  blocked: 'orders',
  hung: 'floors',
  stalled: 'floors',
  claim: null,
  plan: null,
  checks: null,
  limit: null,
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
  if (need.kind === 'limit') {
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
    newOrder: nav.board().canCreate(),
    mute: nav.notifier?.preferences.enabled === true,
    muteSound: nav.sound?.preferences.enabled === true,
  };
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
    case 'newOrder':
      nav.showTab('board');
      nav.board().newOrder();
      break;
    case 'lang':
      store.setLang(store.lang === 'es' ? 'en' : 'es');
      break;
    case 'history':
      openHistory(nav);
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
      openHistory(nav);
      break;
    case 'orders':
      focusOrders();
      break;
    case 'escape':
      break;
  }
}
