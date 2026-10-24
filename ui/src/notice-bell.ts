import { button, el } from './dom';
import { t, type MessageKey } from './i18n';
import { menuStep } from './needs';
import { filterNotices, outcomeLabel, type Notice, type NoticeFilter, type NoticeLog, type NoticeTarget } from './notice-log';
import type { NotifyEvent } from './notify';
import type { Store } from './store';
import { clockTime } from './time';

export type NoticeBell = {
  root: HTMLElement;
  // Starts showing this inbox; the bell stays hidden until then (a replay has none).
  bind(log: NoticeLog, open: (target: NoticeTarget) => void): void;
  // Opens the menu if there is an inbox and it is not open.
  open(): void;
  // Closes the menu if it is open and says whether it was.
  close(): boolean;
};

const KIND_ICONS: Record<NotifyEvent, string> = {
  permission: '\u{1F512}',
  question: '❓',
  blocked: '⛔',
  done: '✅',
  document: '\u{1F4C4}',
  alert: '\u{1F6A8}',
  stalled: '⏳',
  usage: '\u{1F4C8}',
  checks: '\u{1F9EA}',
};

// The bell next to "Te necesitan": a list of the notices the office raised, also those the desktop never saw.
export function mountNoticeBell(store: Store): NoticeBell {
  const count = el('b', 'pending-count');
  const trigger = button('', 'pending notices-trigger');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'needs-menu notices-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const root = el('div', 'needs notices', trigger, menu);
  root.hidden = true;

  let log: NoticeLog | null = null;
  let openTarget: (target: NoticeTarget) => void = () => {};
  let filter: NoticeFilter = 'all';
  let stops: HTMLElement[] = [];
  // Entries newer than this were unread when the menu opened.
  let freshFrom = Number.POSITIVE_INFINITY;

  const isOpen = (): boolean => !menu.hidden;

  const close = (): boolean => {
    if (!isOpen()) return false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus();
    return true;
  };

  const row = (notice: Notice): HTMLButtonElement => {
    const node = button('', `needs-item notices-item needs-${notice.kind}`);
    node.setAttribute('role', 'menuitem');
    const kind = t(`notices.kind.${notice.kind}` as MessageKey);
    const label = el('span', 'needs-label notices-label', `${KIND_ICONS[notice.kind]} ${kind} · ${notice.title}`);
    if (notice.body) label.title = notice.body;
    const tag = outcomeLabel(notice.outcome);
    node.append(label);
    if (notice.id >= freshFrom) node.append(el('span', 'notices-new', t('notices.new')));
    if (tag !== null) node.append(el('span', 'notices-outcome muted', tag));
    node.append(el('time', 'needs-age muted', clockTime(notice.at)));
    node.addEventListener('click', () => {
      close();
      openTarget(notice.target);
    });
    return node;
  };

  const paintFace = (): void => {
    if (!log) return;
    const unread = log.unread;
    count.textContent = String(unread);
    count.hidden = unread === 0;
    trigger.classList.toggle('has-pending', unread > 0);
    trigger.replaceChildren('\u{1F514}', ' ', t('notices.button'), ' ', count);
    trigger.title = unread > 0 ? `${t('notices.title')} · ${t('notices.unread', { n: unread })}` : t('notices.title');
    menu.setAttribute('aria-label', t('notices.title'));
  };

  const render = (): void => {
    paintFace();
    if (!log || !isOpen()) return;
    const entries = filterNotices(log.entries, filter).reverse();
    const rows = entries.map(row);
    const filters = (['all', 'hidden'] as const).map((choice) => {
      const toggle = button(t(choice === 'all' ? 'notices.filter.all' : 'notices.filter.hidden'), 'notices-action notices-filter');
      toggle.setAttribute('aria-pressed', String(filter === choice));
      toggle.addEventListener('click', () => {
        filter = choice;
        render();
      });
      return toggle;
    });
    const markRead = button(t('notices.markRead'), 'notices-action');
    markRead.disabled = log.unread === 0;
    markRead.addEventListener('click', () => {
      freshFrom = Number.POSITIVE_INFINITY;
      log?.markRead();
      markRead.focus();
    });
    const clear = button(t('notices.clear'), 'notices-action');
    clear.disabled = log.entries.length === 0;
    clear.addEventListener('click', () => {
      log?.clear();
      trigger.focus();
    });
    const focused = document.activeElement;
    const was = focused instanceof HTMLElement ? stops.indexOf(focused) : -1;
    stops = [...filters, ...rows, markRead, clear];
    const body = entries.length === 0 ? [el('p', 'muted notices-empty', t('notices.empty'))] : rows;
    menu.replaceChildren(el('div', 'notices-filters', ...filters), ...body, el('div', 'notices-footer', markRead, clear));
    if (was >= 0) (stops[Math.min(was, stops.length - 1)] ?? trigger).focus();
  };

  const open = (): void => {
    if (!log) return;
    freshFrom = log.readThrough + 1;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    (stops[0] ?? trigger).focus();
    log.markRead();
  };

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const at = stops.findIndex((stop) => stop === document.activeElement);
    const next = menuStep(at, event.key === 'ArrowDown' ? 1 : -1, stops.length);
    if (next === null) return;
    event.preventDefault();
    stops[next]?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && event.target instanceof Node && !root.contains(event.target)) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
  store.watch(['lang'], render);

  return {
    root,
    close,
    open() {
      if (!isOpen()) open();
    },
    bind(next, open) {
      log = next;
      openTarget = open;
      root.hidden = false;
      next.subscribe(render);
      render();
    },
  };
}
