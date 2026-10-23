import { button, el } from './dom';
import { LANG_NAMES, LANGS, plural, t, type Lang, type MessageKey } from './i18n';
import { mountFocusPill } from './focus-pill';
import { mountNeedsMenu, type NeedsMenu } from './needs-menu';
import type { Need } from './needs';
import { mountNoticeBell, type NoticeBell } from './notice-bell';
import { mountPinnedStrip } from './pinned-strip';
import type { ConnectionStatus, Store } from './store';

export type Tab = 'office' | 'table' | 'board' | 'plans' | 'chat' | 'settings';

export type Topbar = {
  root: HTMLElement;
  replayHost: HTMLElement;
  needs: NeedsMenu;
  notices: NoticeBell;
  setTab(tab: Tab): void;
};

const STATUS_KEYS: Record<ConnectionStatus, MessageKey> = {
  nokey: 'topbar.status.nokey',
  connecting: 'topbar.status.connecting',
  online: 'topbar.status.online',
  offline: 'topbar.status.offline',
  denied: 'topbar.status.denied',
  replay: 'topbar.status.replay',
};

export const TABS: readonly { tab: Tab; labelKey: MessageKey }[] = [
  { tab: 'office', labelKey: 'topbar.tab.office' },
  { tab: 'table', labelKey: 'topbar.tab.table' },
  { tab: 'board', labelKey: 'topbar.tab.board' },
  { tab: 'plans', labelKey: 'topbar.tab.plans' },
  { tab: 'chat', labelKey: 'topbar.tab.chat' },
  { tab: 'settings', labelKey: 'topbar.tab.settings' },
];

export function mountTopbar(store: Store, onTab: (tab: Tab) => void, onNeed: (need: Need) => void, onPin: (key: string) => void, onFocus: (floor: string | null) => void): Topbar {
  const dot = el('span', 'status-dot');
  const statusText = el('span', 'status-text');
  const needs = mountNeedsMenu(store, onNeed);
  const notices = mountNoticeBell(store);
  const pinned = mountPinnedStrip(store, onPin);
  const focus = mountFocusPill(store, onFocus);
  const replayHost = el('div', 'replay-controls');

  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const tabs = el('nav', 'tabs');
  const plansCount = el('b', 'tab-count');
  plansCount.hidden = true;
  const chatCount = el('b', 'tab-count');
  chatCount.hidden = true;
  for (const { tab } of TABS) {
    const tabButton = button('', 'tab');
    tabButton.addEventListener('click', () => onTab(tab));
    tabButtons.set(tab, tabButton);
    tabs.append(tabButton);
  }

  const langSelect = el('select', 'lang-select');
  for (const lang of LANGS) {
    const option = el('option', '', LANG_NAMES[lang]);
    option.value = lang;
    langSelect.append(option);
  }
  langSelect.addEventListener('change', () => store.setLang(langSelect.value as Lang));

  const root = el(
    'header',
    'topbar',
    el('h1', 'brand', 'Agent Office'),
    el('div', 'status', dot, statusText),
    needs.root,
    notices.root,
    focus,
    pinned,
    replayHost,
    tabs,
    langSelect,
  );

  const relabel = (): void => {
    for (const { tab, labelKey } of TABS) {
      const tabButton = tabButtons.get(tab);
      if (tabButton) tabButton.replaceChildren(t(labelKey), ...(tab === 'plans' ? [plansCount] : tab === 'chat' ? [chatCount] : []));
    }
    langSelect.setAttribute('aria-label', t('topbar.lang'));
    langSelect.value = store.lang;
  };
  store.watch(['lang'], relabel);

  store.watch(['connection', 'lang'], () => {
    dot.dataset.status = store.connection;
    statusText.textContent = t(STATUS_KEYS[store.connection]);
  });

  store.watch(['documents', 'lang'], () => {
    const count = store.documents.filter((doc) => doc.kind === 'plan' && doc.status === 'entregado').length;
    plansCount.textContent = String(count);
    plansCount.hidden = count === 0;
    tabButtons.get('plans')?.setAttribute('title', count > 0 ? plural('topbar.plansPending', count) : '');
  });

  store.watch(['chat', 'lang'], () => {
    const count = store.unreadChat();
    chatCount.textContent = String(count);
    chatCount.hidden = count === 0;
    tabButtons.get('chat')?.setAttribute('title', count > 0 ? plural('topbar.chatUnread', count) : '');
  });

  const setTab = (active: Tab): void => {
    for (const [tab, tabButton] of tabButtons) {
      tabButton.classList.toggle('active', tab === active);
      tabButton.setAttribute('aria-selected', String(tab === active));
      if (tab === active) tabButton.setAttribute('aria-current', 'page');
      else tabButton.removeAttribute('aria-current');
    }
  };
  setTab('office');

  return { root, replayHost, needs, notices, setTab };
}
