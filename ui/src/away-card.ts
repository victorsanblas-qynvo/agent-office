import type { OfficeApi } from './api';
import { AWAY_MAX_MS, LAST_SEEN_SAVE_MS, awayMessages, awayParts, awaySummary, readLastSeen, shouldSummarize, writeLastSeen, type AwayKind, type AwaySummary } from './away';
import { button, el } from './dom';
import { t } from './i18n';
import type { NoticeLog } from './notice-log';
import type { Store } from './store';
import { duration } from './time';
import type { SearchHit } from './types';

const SNAPSHOT_SETTLE_MS = 1000;

export type AwayDeps = {
  store: Store;
  api: OfficeApi;
  notices: NoticeLog;
  openMessages(query: 'HECHO' | 'BLOQUEADO', fromDay: string): void;
  openBoard(): void;
  openNotices(): void;
};

// Pure: the local day (YYYY-MM-DD) of a moment, as the filters of the history take it.
export function dayOf(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Pure: the path of the search for the messages of one protocol word since a moment.
export function awaySearchPath(query: 'HECHO' | 'BLOQUEADO', since: number): string {
  const params = new URLSearchParams({ q: query, kind: 'message', from: String(since), limit: '100' });
  return `/api/search?${params.toString()}`;
}

async function messagesSince(api: OfficeApi, since: number): Promise<SearchHit[]> {
  const pages = await Promise.all((['HECHO', 'BLOQUEADO'] as const).map((query) => api.search(awaySearchPath(query, since))));
  return pages.flatMap((page) => (page.ok ? page.data.hits : []));
}

// The card on top of the panel that says what happened while the tab was hidden or closed, and keeps lastSeen up to date.
export function mountAway(host: HTMLElement, deps: AwayDeps): void {
  const { store, api, notices } = deps;
  let card: HTMLElement | null = null;

  const dismiss = (): void => {
    card?.remove();
    card = null;
  };

  const act = (kind: AwayKind, summary: AwaySummary): void => {
    dismiss();
    if (kind === 'delivery') deps.openMessages('HECHO', dayOf(summary.since));
    else if (kind === 'blocked') deps.openMessages('BLOQUEADO', dayOf(summary.since));
    else if (kind === 'checks') deps.openBoard();
    else deps.openNotices();
  };

  const show = (summary: AwaySummary): void => {
    dismiss();
    const parts = awayParts(summary).map((part) => button(part.text, 'away-part'));
    awayParts(summary).forEach((part, index) => parts[index]?.addEventListener('click', () => act(part.kind, summary)));
    const close = button('×', 'away-close', t('away.dismiss'));
    close.setAttribute('aria-label', t('away.dismiss'));
    close.addEventListener('click', dismiss);
    card = el('div', 'away-card', el('span', 'away-title', t('away.title', { elapsed: duration(summary.elapsedMs) })), ...parts, close);
    card.setAttribute('role', 'status');
    host.append(card);
  };

  const check = async (): Promise<void> => {
    const lastSeen = readLastSeen();
    const now = Date.now();
    writeLastSeen(now);
    if (lastSeen === null || !shouldSummarize(lastSeen, now, false)) return;
    const since = Math.max(lastSeen, now - AWAY_MAX_MS);
    const hits = await messagesSince(api, since).catch(() => []);
    const summary = awaySummary(
      {
        messages: awayMessages(hits, store),
        finished: store.finished,
        checks: [...store.checkRuns.values()],
        notices: notices.entries,
      },
      lastSeen,
      Date.now(),
    );
    if (summary) show(summary);
  };

  const stamp = (): void => writeLastSeen(Date.now());
  window.setInterval(() => {
    if (document.visibilityState === 'visible') stamp();
  }, LAST_SEEN_SAVE_MS);
  window.addEventListener('pagehide', stamp);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stamp();
    else void check();
  });
  let started = false;
  store.watch(['connection'], () => {
    if (started || store.connection !== 'online') return;
    started = true;
    window.setTimeout(() => void check(), SNAPSHOT_SETTLE_MS);
  });
}
