import './styles.css';
import { liveActions, replayActions, type Actions } from './actions';
import { OfficeApi } from './api';
import { browserPanelEnv, forgetPanelToken, panelCredential } from './auth';
import { el } from './dom';
import { Heartbeat } from './heartbeat';
import { mountHelp } from './help';
import { applyLang, readStoredLang, t, type MessageKey, type Params } from './i18n';
import { boardKeysReady, mountKeys } from './keys';
import { LiveConnection } from './live';
import type { NoticeTarget } from './notice-log';
import { focusFloor, goToAgent, goToNeed, restoreFocus, openNoticeTarget, paletteContext, runEntry, runKey, type Nav } from './navigate';
import { NeedCursor } from './needs';
import { Notifier } from './notify';
import { SoundDesk } from './sound';
import type { OfficeHandle, OfficeHooks } from './office/office';
import { mountPalette } from './palette/palette';
import { mountSettings } from './settings/settings';
import { closeDocument } from './panel/deliverables';
import { mountFinished } from './panel/finished';
import { mountPanel } from './panel/panel';
import { mountPlans } from './plans/plans';
import { loadRecording, mountReplayControls, replayFetchUrl, ReplayPlayer } from './replay';
import { Store } from './store';
import { contrast } from './contrast';
import { motion } from './motion';
import { theme } from './theme';
import { mountBudgetWatch } from './budgets';
import { UsageToday } from './usage-today';
import { mountBoard } from './board/board';
import { mountChat, type ChatHandle } from './chat/chat';
import { mountAway } from './away-card';
import { EMPTY_FILTERS } from './table/history';
import { mountTable } from './table/table';
import { mountToasts } from './toasts';
import { readWhatsNewSeen, shouldShowWhatsNew } from './whats-new';
import { mountWhatsNew } from './whats-new-dialog';
import { mountTopbar, type Tab } from './topbar';
import type { FinishedView } from './types';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function boot(): Promise<void> {
  theme.apply();
  motion.apply();
  contrast.apply();
  applyLang(readStoredLang());
  const root = document.getElementById('app');
  if (!root) return;

  const store = new Store();
  const replayUrl = new URLSearchParams(location.search).get('replay');
  const panelEnv = replayUrl ? null : browserPanelEnv();
  const token = panelEnv ? await panelCredential(panelEnv) : null;

  let tab: Tab = 'office';
  let office: OfficeHandle | null = null;
  let chat: ChatHandle | null = null;
  let usageToday: UsageToday | null = null;

  const officeHost = el('div', 'view office-view active');
  const tableHost = el('div', 'view table-view');
  const boardHost = el('div', 'view board-view');
  const plansHost = el('div', 'view plans-view');
  const chatHost = el('div', 'view chat-view');
  const settingsHost = el('div', 'view settings-view');
  const view = new URLSearchParams(location.search).get('view') === '3d' ? '3d' : '2d';
  const notice = el('div', 'notice');
  notice.hidden = true;
  const awayHost = el('div', 'away-host');
  const panelHost = el('aside', 'panel');
  const toastHost = el('div', 'toasts');
  const finishedHost = el('div', 'finished-host');
  const overlayHost = el('div', 'overlay-host');

  let noticeText: { key: MessageKey; params?: Params } | null = null;
  const paintNotice = (): void => {
    notice.hidden = noticeText === null;
    notice.textContent = noticeText ? t(noticeText.key, noticeText.params) : '';
  };
  const setNotice = (key: MessageKey | null, params?: Params): void => {
    noticeText = key === null ? null : { key, params };
    paintNotice();
  };
  store.watch(['lang'], paintNotice);

  const showTab = (next: Tab): void => {
    tab = next;
    topbar.setTab(next);
    officeHost.classList.toggle('active', next === 'office');
    tableHost.classList.toggle('active', next === 'table');
    boardHost.classList.toggle('active', next === 'board');
    plansHost.classList.toggle('active', next === 'plans');
    chatHost.classList.toggle('active', next === 'chat');
    settingsHost.classList.toggle('active', next === 'settings');
    office?.setActive(next === 'office');
    chat?.setActive(next === 'chat');
    usageToday?.setActive(next === 'office');
  };

  const topbar = mountTopbar(store, showTab, (need) => goToNeed(nav, need), (key) => goToAgent(nav, key), (floor) => focusFloor(nav, floor));
  root.replaceChildren(
    topbar.root,
    el('main', 'main', officeHost, tableHost, boardHost, plansHost, chatHost, settingsHost, notice, awayHost),
    panelHost,
    toastHost,
    finishedHost,
    overlayHost,
  );

  let live: LiveConnection | null = null;
  let expired = false;
  const expire = (): void => {
    if (expired) return;
    expired = true;
    forgetPanelToken(panelEnv?.storage ?? null);
    live?.stop();
    store.setConnection('denied');
    setNotice('auth.expired');
  };

  const api = replayUrl || !token ? null : new OfficeApi(token, expire);
  usageToday = api ? new UsageToday(api) : null;
  usageToday?.setActive(tab === 'office');
  if (api) mountBudgetWatch(store, api);
  const actions: Actions = api ? liveActions(store, api) : replayActions(store);

  const table = mountTable(tableHost, store, api);
  mountPanel(panelHost, store, actions, api, {
    openBoard: (floor) => {
      showTab('board');
      board.show(floor);
    },
    openSpend: () => {
      showTab('table');
      table.showNow();
    },
  });
  const board = mountBoard(boardHost, store, api);
  mountPlans(plansHost, store, api);
  chat = mountChat(chatHost, store, api);
  const notifier = api ? new Notifier(store) : null;
  const sound = api ? new SoundDesk(store) : null;
  const showFinished = (view: FinishedView): void => {
    showTab('board');
    board.show(view.floors.length === 1 ? (view.floors[0] ?? null) : null, view.kind === 'order' ? view.slug : undefined);
  };
  if (notifier || sound) {
    store.watch(['tick'], () => {
      notifier?.tick();
      sound?.tick(store.questions);
    });
  }
  mountFinished(finishedHost, store, api, { openBoard: showFinished });
  mountSettings(settingsHost, store, api, notifier, sound);
  mountToasts(toastHost, store);

  const whatsNew = mountWhatsNew(overlayHost);
  const nav: Nav = {
    store,
    api,
    notifier,
    sound,
    tab: () => tab,
    showTab,
    office: () => office,
    board: () => board,
    chat: () => chat,
    table: () => table,
    whatsNew: () => whatsNew,
  };
  if (notifier) {
    const open = (target: NoticeTarget): void => openNoticeTarget(nav, target);
    notifier.openTarget = open;
    topbar.notices.bind(notifier.notices, open);
    window.addEventListener('pagehide', () => notifier.flushNotices());
  }
  if (api && notifier) {
    mountAway(awayHost, {
      store,
      api,
      notices: notifier.notices,
      openMessages: (query, fromDay) => {
        showTab('table');
        table.showSearch({ name: '', filters: { ...EMPTY_FILTERS, kind: 'message', q: query, from: fromDay } });
      },
      openBoard: () => showTab('board'),
      openNotices: () => topbar.notices.open(),
    });
  }
  restoreFocus(nav);
  const palette = mountPalette(overlayHost, { context: () => paletteContext(nav), run: (entry) => runEntry(nav, entry) });
  const help = mountHelp(overlayHost, whatsNew.open);
  const cursor = new NeedCursor();
  mountKeys({
    run: (action) => runKey(nav, action, cursor, { palette: palette.open, help: help.toggle }),
    layers: [palette.close, help.close, whatsNew.close, topbar.needs.close, topbar.notices.close, closeDocument, () => tab === 'board' && board.clearHighlight()],
    boardReady: (move) => boardKeysReady(tab === 'board', document.querySelector('.order-drawer-backdrop') !== null, move === 'open', board.hasHighlight()),
    modalOpen: () => palette.isOpen() || help.isOpen() || whatsNew.isOpen() || document.querySelector('.dialog-backdrop, .modal-backdrop') !== null,
  });

  if (shouldShowWhatsNew(readWhatsNewSeen(), api !== null)) whatsNew.open();

  const hooks: OfficeHooks = { openTab: showTab, usageToday: () => usageToday?.latest ?? null };
  const mountView: Promise<OfficeHandle> =
    view === '3d'
      ? import('./scene/scene').then((module) => module.mountScene(officeHost, store, hooks))
      : import('./office/office').then((module) => module.mountOffice(officeHost, store, hooks));
  mountView
    .then((handle) => {
      office = handle;
      handle.setActive(tab === 'office');
      restoreFocus(nav);
    })
    .catch((error: unknown) => {
      const failure = el('p', 'placeholder');
      officeHost.replaceChildren(failure);
      store.watch(['lang'], () => {
        failure.textContent = t('main.officeFailed', { error: messageOf(error) });
      });
    });

  if (replayUrl) {
    const search = new URLSearchParams(location.search);
    // A recording the hub builds (/api/replay/...) needs the panel credential; a file does not.
    const credential = replayUrl.startsWith('/api/') ? await panelCredential(browserPanelEnv()) : null;
    loadRecording(replayFetchUrl(replayUrl, search), credential)
      .then((recording) => {
        const player = new ReplayPlayer(recording, store);
        mountReplayControls(topbar.replayHost, player, store);
        player.start();
      })
      .catch((error: unknown) => {
        store.setConnection('offline');
        setNotice('main.replayFailed', { error: messageOf(error) });
      });
    return;
  }

  if (!token) {
    store.setConnection('nokey');
    setNotice('auth.locked');
    return;
  }

  const heartbeat = new Heartbeat((message) => live?.send(message) ?? false);
  live = new LiveConnection(token, {
    onStatus: (status) => {
      if (status === 'denied') return expire();
      store.setConnection(status);
      setNotice(null);
    },
    onMessage: (message) => {
      store.apply(message);
      notifier?.observe(message);
      sound?.observe(message);
    },
    onOpen: () => heartbeat.pulse(),
  });
  heartbeat.start();
  live.start();
}

void boot();
