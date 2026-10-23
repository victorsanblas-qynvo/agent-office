import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { t } from '../i18n';
import { floorLabel, formatTokens, tokensTotal } from '../labels';
import { readBoardStaleHours, readJson, writeJson } from '../prefs';
import type { BoardMove } from '../keys';
import type { Store } from '../store';
import { relativeTime } from '../time';
import type { OrderStatus, OrderView } from '../types';
import { checksBadgeNode, folderBadgeNode } from './badges';
import { ageBadge, agesDue, type AgeBadge, columnsOf, deliveryFloors, filterOrders, neighbours, neighbourStatus, nextCard, orderFloors } from './columns';
import { mountOrderDetail, type OrderDetail } from './order-detail';
import { openNewOrder } from './new-order';

const FILTER_KEY = 'agent-office.board.floor';

export type BoardHandle = {
  // Shows the cards of one floor (or all) and opens the drawer of an order when it is named.
  show(floor: string | null, orderSlug?: string): void;
  // Whether a new order can be started from here, and opens its form.
  canCreate(): boolean;
  newOrder(): void;
  // Puts the cursor in the text filter.
  focusFilter(): void;
  // A keyboard move of the highlighted card: step, open its drawer or ask to move it.
  key(move: BoardMove): void;
  hasHighlight(): boolean;
  // Drops the highlight and says whether there was one to drop.
  clearHighlight(): boolean;
};

function readFilter(): string | null {
  const stored = readJson(FILTER_KEY);
  return typeof stored === 'string' && stored !== '' ? stored : null;
}

export function mountBoard(host: HTMLElement, store: Store, api: OfficeApi | null): BoardHandle {
  const heading = el('h2', 'board-heading');
  const filterLabel = el('label', 'board-filter');
  const filter = el('select', 'board-filter-select');
  const search = el('input', 'board-search');
  search.type = 'search';
  const add = button('', 'primary board-new');
  const head = el('header', 'board-head', heading, filterLabel, search, add);
  const notice = el('p', 'board-notice muted');
  const columnsHost = el('div', 'board-columns');
  const drawerHost = el('div', 'board-drawer-host');
  host.replaceChildren(el('div', 'board', head, notice, columnsHost), drawerHost);

  let floor: string | null = readFilter();
  let query = '';
  let dragging = false;
  let pendingRender = false;
  let open: OrderDetail | null = null;
  let openId: number | null = null;
  let highlightId: string | null = null;
  let visible: string[][] = [];
  let agedAt = store.now();
  let agedStale = readBoardStaleHours();

  const closeDetail = (): void => {
    open?.destroy();
    open = null;
    openId = null;
    drawerHost.replaceChildren();
  };

  const openDetail = (order: OrderView): void => {
    if (openId === order.id) return;
    closeDetail();
    openId = order.id;
    open = mountOrderDetail(drawerHost, store, api, order.id, closeDetail);
  };

  const move = async (order: OrderView, to: OrderStatus): Promise<void> => {
    if (!api || to === order.status) return;
    const attempt = async (force: boolean): Promise<void> => {
      const result = await api.moveOrder(order.id, to, force);
      if (result.ok) return;
      if (result.status === 409 && result.key === 'hub.api.moveNeedsForce' && !force) {
        if (window.confirm(t('board.confirm.force', { reason: result.message }))) await attempt(true);
        return;
      }
      store.toast(result.message, 'error');
    };
    await attempt(false);
  };

  const card = (order: OrderView, now: number): HTMLElement => {
    const near = neighbours(order.status);
    const arrows = el('div', 'board-card-arrows');
    if (api) {
      for (const [direction, target] of [
        ['back', near.back],
        ['next', near.next],
      ] as const) {
        const arrow = button(direction === 'back' ? '←' : '→', 'board-arrow');
        arrow.disabled = target === null;
        arrow.title = target ? t(`board.move.${direction}`, { column: t(`board.col.${target}`) }) : '';
        arrow.setAttribute('aria-label', arrow.title || t(`board.move.${direction}`, { column: '' }));
        arrow.addEventListener('click', (event) => {
          event.stopPropagation();
          if (target) void move(order, target);
        });
        arrows.append(arrow);
      }
    }
    const age = ageBadge(order, now, readBoardStaleHours());
    const tokens = order.tokens ? tokensTotal(order.tokens) : 0;
    const link = order.pr ? el('a', 'board-pr', t('board.card.pr')) : null;
    if (link && order.pr) {
      link.href = order.pr.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.addEventListener('click', (event) => event.stopPropagation());
    }
    const node = el(
      'article',
      `board-card board-card-${order.status}`,
      el('h4', 'board-card-title', order.title),
      el(
        'div',
        'board-card-meta',
        el('span', 'chip', store.floorBySlug(order.floor) ? floorLabel(store.floorBySlug(order.floor) as never) : order.floor),
        order.planSlug ? el('span', 'chip', t('board.card.plan', { plan: order.planSlug })) : null,
        order.cycle > 1 ? el('span', 'chip', t('board.card.cycle', { cycle: order.cycle })) : null,
        el('span', 'muted', t('board.card.lead', { lead: order.lead ?? '—' })),
      ),
      order.branch ? el('code', 'board-card-branch muted', order.branch) : null,
      el(
        'div',
        'board-card-badges',
        checksBadgeNode(order),
        order.checks && order.checks.touched.length > 0 ? touchedBadge(order) : null,
        order.review.state !== 'none' ? el('span', 'chip', t('board.card.review', { state: order.review.state })) : null,
        folderBadgeNode(order),
        age ? ageNode(order, age) : null,
        link,
      ),
      el(
        'div',
        'board-card-foot',
        el('span', 'muted', relativeTime(Math.max(order.lastActivity ?? 0, order.updatedAt), now)),
        tokens > 0 ? el('span', 'muted', t('board.card.tokens', { tokens: formatTokens(tokens) })) : null,
        arrows,
      ),
    );
    node.dataset.orderId = String(order.id);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.addEventListener('click', () => openDetail(order));
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail(order);
      }
    });
    if (api) {
      node.draggable = true;
      node.addEventListener('dragstart', (event) => {
        dragging = true;
        event.dataTransfer?.setData('text/plain', String(order.id));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      node.addEventListener('dragend', () => {
        dragging = false;
        if (pendingRender) render();
      });
    }
    return node;
  };

  const column = (status: OrderStatus, orders: readonly OrderView[], now: number): HTMLElement => {
    const cards = el('div', 'board-cards', ...(orders.length > 0 ? orders.map((order) => card(order, now)) : [el('p', 'board-col-empty muted', t('board.col.empty'))]));
    const section = el('section', `board-col board-col-${status}`, el('header', 'board-col-head', el('h3', 'board-col-title', t(`board.col.${status}`)), el('span', 'chip', String(orders.length))), cards);
    if (api) {
      section.addEventListener('dragover', (event) => {
        event.preventDefault();
        section.classList.add('drop');
      });
      section.addEventListener('dragleave', () => section.classList.remove('drop'));
      section.addEventListener('drop', (event) => {
        event.preventDefault();
        section.classList.remove('drop');
        dragging = false;
        const id = Number(event.dataTransfer?.getData('text/plain'));
        const order = store.orders.find((o) => o.id === id);
        if (order) void move(order, status);
        else if (pendingRender) render();
      });
    }
    return section;
  };

  const relabelFilter = (): void => {
    const floors = orderFloors(store.floorList());
    const previous = floor;
    filter.replaceChildren(new Option(t('board.filter.all'), ''), ...floors.map((slug) => new Option(slug, slug)));
    if (previous !== null && !floors.includes(previous)) floor = null;
    filter.value = floor ?? '';
  };

  const paintHighlight = (scroll: boolean): void => {
    for (const node of columnsHost.querySelectorAll<HTMLElement>('.board-card')) {
      const on = node.dataset.orderId === highlightId;
      node.classList.toggle('highlight', on);
      if (on && scroll) node.scrollIntoView?.({ block: 'nearest' });
    }
  };

  const keyMove = (step: BoardMove): void => {
    if (step === 'open' || step === 'prev' || step === 'next') {
      const order = highlightId === null ? undefined : store.orders.find((o) => String(o.id) === highlightId);
      if (!order || !visible.some((ids) => ids.includes(highlightId as string))) return;
      if (step === 'open') {
        openDetail(order);
        return;
      }
      const to = neighbourStatus(order.status, step);
      if (to) void move(order, to);
      return;
    }
    highlightId = nextCard(visible, highlightId, step);
    paintHighlight(true);
  };

  const render = (): void => {
    if (dragging) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    heading.textContent = t('board.title');
    filterLabel.replaceChildren(t('board.filter.label'), ' ', filter);
    search.placeholder = t('board.search.placeholder');
    search.setAttribute('aria-label', t('board.search.placeholder'));
    add.textContent = t('board.new');
    add.hidden = api === null;
    add.disabled = deliveryFloors(store.floorList()).length === 0;
    add.title = add.disabled ? t('board.new.none') : '';
    relabelFilter();
    const now = store.now();
    agedAt = now;
    agedStale = readBoardStaleHours();
    const shown = filterOrders(store.orders, query, (slug) => (store.floorBySlug(slug) ? floorLabel(store.floorBySlug(slug) as never) : slug));
    const grouped = columnsOf(shown, floor);
    const total = grouped.reduce((sum, group) => sum + group.orders.length, 0);
    notice.textContent =
      api === null ? t(store.replay ? 'board.replay' : 'board.offline') : [total === 0 ? t(query.trim() !== '' && store.orders.length > 0 ? 'board.search.empty' : 'board.empty') : '', add.disabled ? t('board.new.none') : ''].filter((part) => part !== '').join(' ');
    notice.hidden = notice.textContent === '';
    columnsHost.replaceChildren(...grouped.map((group) => column(group.status, group.orders, now)));
    visible = grouped.map((group) => group.orders.map((order) => String(order.id)));
    paintHighlight(false);
    if (openId !== null && !store.orders.some((order) => order.id === openId)) closeDetail();
  };

  filter.addEventListener('change', () => {
    floor = filter.value || null;
    writeJson(FILTER_KEY, floor);
    render();
  });
  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return;
    event.preventDefault();
    search.value = '';
    query = '';
    render();
  });
  const newOrder = (): void => {
    if (api && deliveryFloors(store.floorList()).length > 0) openNewOrder(host, store, api, floor, (order) => openDetail(order));
  };
  add.addEventListener('click', newOrder);
  store.watch(['orders', 'lang', 'floors', 'mode'], render);
  // The age of a card moves on its own, and follows the stale threshold of Ajustes.
  store.watch(['tick'], () => {
    const now = store.now();
    const stale = readBoardStaleHours();
    if (!agesDue(agedAt, agedStale, now, stale)) return;
    agedAt = now;
    agedStale = stale;
    for (const node of columnsHost.querySelectorAll<HTMLElement>('.board-age[data-order]')) {
      const order = store.orders.find((candidate) => String(candidate.id) === node.dataset.order);
      const age = order ? ageBadge(order, now, stale) : null;
      if (!age) continue;
      node.textContent = age.text;
      node.classList.toggle('stale', age.stale);
    }
  });

  return {
    canCreate: () => api !== null && deliveryFloors(store.floorList()).length > 0,
    newOrder,
    focusFilter: () => search.focus(),
    key: keyMove,
    hasHighlight: () => highlightId !== null && visible.some((ids) => ids.includes(highlightId as string)),
    clearHighlight() {
      if (highlightId === null || document.activeElement === search) return false;
      highlightId = null;
      paintHighlight(false);
      return true;
    },
    show(next, orderSlug) {
      floor = next;
      writeJson(FILTER_KEY, floor);
      render();
      const target = orderSlug ? store.orders.find((order) => order.slug === orderSlug) : undefined;
      if (target) openDetail(target);
    },
  };
}

function ageNode(order: OrderView, age: AgeBadge): HTMLElement {
  const node = el('span', `chip board-age${age.stale ? ' stale' : ''}`, age.text);
  node.dataset.order = String(order.id);
  return node;
}

function touchedBadge(order: OrderView): HTMLElement {
  const forced = order.checks?.forced === true;
  const chip = el('span', `chip checks-touched${forced ? ' confirmed' : ''}`, t('board.checks.touchedBadge'));
  chip.title = t(forced ? 'board.checks.touchedConfirmed' : 'board.checks.touched', { files: order.checks?.touched.join(', ') ?? '' });
  return chip;
}
