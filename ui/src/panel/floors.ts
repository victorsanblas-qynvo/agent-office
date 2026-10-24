import { orderRows, type Row } from '../agents-order';
import type { OfficeApi } from '../api';
import { el, keepFocus, setStateColor } from '../dom';
import { plural, t } from '../i18n';
import { checksBadgeNode } from '../board/badges';
import { activeOrder } from '../board/columns';
import { agentName, contextFill, contextLevel, contextLine, contextOf, doingPhrase, floorLabel, isAway, roleLabel, STATE_COLORS } from '../labels';
import type { Store } from '../store';
import { agentNoteKey } from '../notes';
import { noteIcon } from '../notes-editor';
import { relativeTime } from '../time';
import type { AgentView, FloorView } from '../types';
import { panelSection } from './section';
import { relaunchable } from './orderable';
import { canAskStatus, mainSession, relaunchButton, runSessionAction, stalledText, statusButton } from './session-controls';

type TimeNode = { node: HTMLElement; text: (now: number) => string };

function agentRow(store: Store, row: Row, times: TimeNode[], now: number): HTMLElement {
  const { agent, depth } = row;
  const state = store.shownState(agent);
  const away = isAway(agent);
  const dot = el('span', 'floors-dot');
  setStateColor(dot, STATE_COLORS[state]);
  const since = agent.endedAt ?? agent.stateSince;
  const time = el('time', 'floors-time muted', relativeTime(since, now));
  times.push({ node: time, text: (at) => relativeTime(since, at) });
  const item = el(
    'button',
    `floors-row${away ? ' floors-row-away' : ''}${store.selectedKey === agent.key ? ' selected' : ''}`,
    dot,
    el('span', 'floors-name', agentName(agent), noteIcon(store.notes, agentNoteKey(agent.key))),
    el('span', 'chip floors-role', roleLabel(agent.roleKind)),
    store.questionFor(agent.key) ? el('span', 'floors-ask', '?') : null,
    time,
    el('span', 'floors-doing', doingPhrase(agent, state)),
    contextBar(agent),
  );
  item.type = 'button';
  item.dataset.key = agent.key;
  if (store.selectedKey === agent.key) item.setAttribute('aria-current', 'true');
  item.style.paddingLeft = `${8 + depth * 14}px`;
  item.title = agent.task ? t('floors.task', { task: agent.task }) : agentName(agent);
  return el('li', '', item, sessionActions(store, agent, depth, times, now));
}

// Two pixels under the row: how full the context window of the agent is.
function contextBar(agent: AgentView): HTMLElement | null {
  const context = contextOf(agent);
  if (!context) return null;
  const bar = el('span', 'floors-ctx');
  bar.dataset.level = contextLevel(context.usedPct);
  bar.style.width = `${contextFill(context)}%`;
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', contextLine(context));
  return bar;
}

function sessionActions(store: Store, agent: AgentView, depth: number, times: TimeNode[], now: number): HTMLElement | null {
  const session = mainSession(store, agent);
  const stalled = agent.stalledSince;
  const relaunch = relaunchable(session);
  if (stalled === null && !relaunch) return null;
  const items: HTMLElement[] = [];
  if (stalled !== null) {
    const mark = el('span', 'chip floors-stalled', stalledText(stalled, now));
    times.push({ node: mark, text: (at) => stalledText(stalled, at) });
    items.push(mark);
    if (canAskStatus(store, agent)) items.push(statusButton(agent));
  }
  if (relaunch && session) items.push(relaunchButton(session));
  const actions = el('div', 'floors-actions', ...items);
  actions.style.paddingLeft = `${26 + depth * 14}px`;
  return actions;
}

function floorCard(store: Store, floor: FloorView, agents: readonly AgentView[], open: boolean, times: TimeNode[], now: number): HTMLElement {
  const inside = agents.filter((agent) => !isAway(agent));
  const outside = agents.filter((agent) => isAway(agent));
  const body: HTMLElement[] = [];
  if (inside.length > 0) body.push(el('ul', 'floors-list', ...orderRows(inside).map((row) => agentRow(store, row, times, now))));
  else body.push(el('p', 'floors-empty muted', t(agents.length > 0 ? 'floors.nobody' : 'floors.noAgents')));
  if (outside.length > 0) {
    body.push(
      el('p', 'floors-away-title section-title', t('floors.away')),
      el('ul', 'floors-list', ...orderRows(outside).map((row) => agentRow(store, row, times, now))),
    );
  }
  const details = el(
    'details',
    'floors-card',
    el(
      'summary',
      'floors-summary',
      el('span', 'floors-floor', floorLabel(floor)),
      orderBadge(store, floor.slug),
      el('span', 'chip floors-count', outside.length > 0 ? t('floors.countAway', { inside: inside.length, outside: outside.length }) : String(inside.length)),
    ),
    el('div', 'floors-body', ...body),
  );
  details.dataset.floor = floor.slug;
  details.dataset.shown = open ? '1' : '0';
  details.open = open;
  return details;
}

// The checks of the order the floor is working on, next to its name.
function orderBadge(store: Store, floor: string): HTMLElement | null {
  const order = activeOrder(store.orders, floor);
  const badge = order ? checksBadgeNode(order) : null;
  if (badge && order) badge.title = `${order.title} · ${badge.title}`;
  return badge;
}

function floorsMeta(groups: readonly (readonly AgentView[])[]): string | null {
  let inside = 0;
  let outside = 0;
  for (const agents of groups) {
    for (const agent of agents) {
      if (isAway(agent)) outside += 1;
      else inside += 1;
    }
  }
  if (inside + outside === 0) return null;
  const count = plural('panel.sectionMeta.agents', inside);
  return outside > 0 ? t('panel.sectionMeta.away', { agents: count, n: outside }) : count;
}

export function mountFloors(host: HTMLElement, store: Store, api: OfficeApi | null): void {
  const section = panelSection({ id: 'floors', title: () => t('floors.title'), host });
  const open = new Set<string>();
  let touched = false;
  let selectedFloor: string | null = null;
  let scheduled = false;
  let pressed = false;
  let deferred = false;
  let times: TimeNode[] = [];

  const render = (): void => {
    const now = store.now();
    const byFloor = new Map<string, AgentView[]>();
    for (const agent of store.agents.values()) {
      const list = byFloor.get(agent.floor) ?? [];
      list.push(agent);
      byFloor.set(agent.floor, list);
    }
    const selected = store.selectedKey === null ? undefined : store.agents.get(store.selectedKey);
    if (selected && selected.floor !== selectedFloor) {
      selectedFloor = selected.floor;
      open.add(selected.floor);
    }
    const floors = store.floorList();
    times = [];
    section.setTitle();
    section.setMeta(floorsMeta(floors.map((floor) => byFloor.get(floor.slug) ?? [])));
    if (floors.length === 0) {
      section.body.replaceChildren(el('p', 'floors-empty muted', t('table.waiting')));
      return;
    }
    if (!touched && !selected) {
      for (const floor of floors) {
        if ((byFloor.get(floor.slug) ?? []).some((agent) => !isAway(agent))) open.add(floor.slug);
      }
    }
    section.body.replaceChildren(...floors.map((floor) => floorCard(store, floor, byFloor.get(floor.slug) ?? [], open.has(floor.slug), times, now)));
  };

  const schedule = (): void => {
    if (pressed) {
      deferred = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      keepFocus(section.body, render);
    });
  };

  const release = (): void => {
    if (!pressed) return;
    pressed = false;
    if (deferred) {
      deferred = false;
      schedule();
    }
  };

  host.addEventListener('pointerdown', () => {
    pressed = true;
  });
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);

  host.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLButtonElement>('button[data-action]');
    if (action) {
      void runSessionAction(api, store, action);
      return;
    }
    const key = target.closest<HTMLElement>('[data-key]')?.dataset.key;
    if (key) store.select(key);
  });

  host.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement) || target.dataset.floor === undefined) return;
      if (target.open === (target.dataset.shown === '1')) return;
      const slug = target.dataset.floor;
      target.dataset.shown = target.open ? '1' : '0';
      touched = true;
      if (target.open) open.add(slug);
      else open.delete(slug);
    },
    true,
  );

  store.watch(['agents', 'floors', 'selection', 'questions', 'sessions', 'lang', 'orders', 'notes'], schedule);
  store.watch(['tick'], () => {
    const now = store.now();
    for (const { node, text } of times) node.textContent = text(now);
  });
}
