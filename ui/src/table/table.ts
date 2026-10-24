import type { OfficeApi } from '../api';
import { orderRows, type Row } from '../agents-order';
import { stateBadge } from '../badge';
import { checksBadgeNode } from '../board/badges';
import { activeOrder } from '../board/columns';
import { button, el, keepFocus, setStateColor } from '../dom';
import { plural, t, type MessageKey } from '../i18n';
import { hubText } from '../i18n/hub';
import {
  agentName,
  alertLevelHint,
  alertLevelLabel,
  DOCUMENT_STATUS_COLORS,
  documentKindFor,
  documentStatusHint,
  documentStatusLabel,
  floorKindHint,
  floorKindLabel,
  floorLabel,
  hasMaxRounds,
  roleLabel,
  scoreText,
  stackLabel,
  STATE_COLORS,
  stateHint,
} from '../labels';
import { documentBadge, openDocument } from '../panel/deliverables';
import { readJson, writeJson } from '../prefs';
import type { Store } from '../store';
import { relativeTime } from '../time';
import type { AgentState, AgentView, DocumentKind, DocumentStatus, DocumentView, FloorKind, FloorView, GuardAlert, GuardAlertLevel } from '../types';
import { mountDigest } from './digest';
import { mountTimeline } from './timeline';
import { mountHistory, readTableView, replayHref, VIEW_KEY, type SavedSearch, type TableView } from './history';
import { mountUsageBlock } from './usage-block';

const COLUMNS: readonly { col: MessageKey; hint: MessageKey }[] = [
  { col: 'table.col.agent', hint: 'table.col.hint.agent' },
  { col: 'table.col.role', hint: 'table.col.hint.role' },
  { col: 'table.col.state', hint: 'table.col.hint.state' },
  { col: 'table.col.detail', hint: 'table.col.hint.detail' },
  { col: 'table.col.lastTest', hint: 'table.col.hint.lastTest' },
  { col: 'table.col.since', hint: 'table.col.hint.since' },
];
const ALERT_COUNT = 5;
const HELP_KEY = 'agent-office.help.table';

const FLOOR_KINDS: readonly FloorKind[] = ['direccion', 'managed', 'observed', 'redaccion', 'mantenimiento'];
const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'borrador',
  'revision',
  'aprobado',
  'sin-acuerdo',
  'entregado',
  'aparcado',
  'ejecutando',
  'cerrado',
  'descartado',
];
const ALERT_LEVELS: readonly GuardAlertLevel[] = ['alerta', 'posible'];

function askFlag(): HTMLElement {
  const flag = el('span', 'ask-flag', t('table.askFlag'));
  flag.title = t('table.askFlag.hint');
  return flag;
}

function kindChip(kind: FloorKind): HTMLElement {
  const chip = el('span', 'chip chip-kind', floorKindLabel(kind));
  chip.title = floorKindHint(kind);
  return chip;
}

function alertLevel(level: GuardAlertLevel): HTMLElement {
  const badge = el('span', `alert-level alert-level-${level}`, alertLevelLabel(level));
  badge.title = alertLevelHint(level);
  return badge;
}

function statusBadge(status: DocumentStatus): HTMLElement {
  const badge = el('span', 'badge', el('span', 'badge-dot'), documentStatusLabel(status));
  setStateColor(badge, DOCUMENT_STATUS_COLORS[status]);
  badge.title = documentStatusHint(status);
  return badge;
}

function helpItem(term: Node | string, hint: string): HTMLElement {
  return el('li', '', term, ' ', el('span', 'muted', hint));
}

function helpContent(): Node[] {
  const states = Object.keys(STATE_COLORS) as AgentState[];
  return [
    el('summary', '', t('table.help.summary')),
    el('p', '', t('table.help.intro')),
    el('h4', '', t('table.help.floor.title')),
    el('p', '', t('table.help.floor')),
    el('ul', '', ...FLOOR_KINDS.map((kind) => helpItem(kindChip(kind), floorKindHint(kind)))),
    el('h4', '', t('table.help.columns.title')),
    el('ul', '', ...COLUMNS.map(({ col, hint }) => helpItem(el('b', '', t(col)), t(hint)))),
    el('ul', '', helpItem(askFlag(), t('table.askFlag.hint'))),
    el('h4', '', t('table.help.states.title')),
    el('ul', '', ...states.map((state) => helpItem(stateBadge(state), stateHint(state)))),
    el('h4', '', t('table.help.docs.title')),
    el('p', '', t('table.help.docs')),
    el(
      'ul',
      '',
      ...DOCUMENT_STATUSES.map((status) => helpItem(statusBadge(status), documentStatusHint(status))),
      helpItem(el('b', '', t('table.round', { n: 'N' })), t('table.round.hint')),
      helpItem(el('b', '', t('docStatus.score', { score: 'N' })), t('table.score.hint')),
    ),
    el('h4', '', t('table.help.alerts.title')),
    el('p', '', t('table.help.alerts')),
    el('ul', '', ...ALERT_LEVELS.map((level) => helpItem(alertLevel(level), alertLevelHint(level)))),
  ];
}

function readHelpOpen(): boolean {
  try {
    return localStorage.getItem(HELP_KEY) !== '0';
  } catch {
    return true;
  }
}

function storeHelpOpen(open: boolean): void {
  try {
    localStorage.setItem(HELP_KEY, open ? '1' : '0');
  } catch {
    // Blocked storage: the legend just opens again next time.
  }
}

function testCell(agent: AgentView, now: number): HTMLTableCellElement {
  const cell = el('td', 'col-test');
  if (!agent.lastTest) {
    cell.classList.add('muted');
    cell.textContent = '—';
    return cell;
  }
  const { ok, ts, command } = agent.lastTest;
  cell.title = command;
  cell.append(el('span', ok ? 'test-ok' : 'test-fail', ok ? '✓' : '✗'), ' ', el('span', 'muted', relativeTime(ts, now)));
  return cell;
}

function agentRow(store: Store, row: Row, now: number): HTMLTableRowElement {
  const { agent, depth } = row;
  const state = store.shownState(agent);
  const tr = el('tr', 'agent-row');
  tr.dataset.key = agent.key;
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  if (store.selectedKey === agent.key) tr.setAttribute('aria-current', 'true');
  tr.classList.toggle('selected', store.selectedKey === agent.key);
  tr.classList.toggle('ended', agent.endedAt !== null);

  const nameCell = el('td', 'col-agent', depth > 0 ? el('span', 'tree-mark', '↳') : null, el('span', 'agent-name', agentName(agent)));
  nameCell.style.paddingLeft = `${12 + depth * 20}px`;

  const stateCell = el('td', 'col-state', stateBadge(state));
  if (store.questionFor(agent.key)) stateCell.append(askFlag());

  const detail = hubText(agent.detail);
  const detailCell = el('td', 'col-detail', agent.tool ? el('code', 'tool-tag', agent.tool) : null, detail);
  detailCell.title = detail;

  tr.append(
    nameCell,
    el('td', 'col-role', roleLabel(agent.roleKind)),
    stateCell,
    detailCell,
    testCell(agent, now),
    el('td', 'col-since muted', relativeTime(agent.stateSince, now)),
  );
  return tr;
}

function documentRow(doc: DocumentView): HTMLElement {
  const open = button('', 'doc-row');
  open.dataset.doc = doc.path;
  open.title = doc.path;
  const badge = documentBadge(doc, documentStatusLabel(doc.status));
  badge.title = documentStatusHint(doc.status);
  const roundLabel = hasMaxRounds(doc) ? t('table.roundOfMax', { n: doc.round, max: doc.maxRounds }) : t('table.round', { n: doc.round });
  const round = el('span', 'doc-row-round muted', doc.round > 0 ? roundLabel : '—');
  round.title = t('table.round.hint');
  const score = el('span', 'doc-row-score muted', doc.score !== null ? scoreText(doc.score) : '—');
  score.title = t('table.score.hint');
  open.append(el('span', 'doc-row-title', doc.title), badge, round, score);
  return el('li', 'doc-row-item', open);
}

function documentList(store: Store, kind: DocumentKind): HTMLElement {
  const documents = store.documents.filter((doc) => doc.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt);
  const title = t(kind === 'plan' ? 'table.docs.plans' : 'table.docs.skills');
  const empty = t(kind === 'plan' ? 'table.docs.noPlans' : 'table.docs.noSkills');
  return el(
    'div',
    'floor-docs',
    el('h3', 'section-title', title),
    documents.length > 0
      ? el('ul', 'doc-rows', ...documents.map(documentRow))
      : el('p', 'muted floor-docs-empty', empty),
  );
}

// The checks of the order the floor is working on.
function orderBadge(store: Store, floor: string): HTMLElement | null {
  const order = activeOrder(store.orders, floor);
  const badge = order ? checksBadgeNode(order) : null;
  if (badge && order) badge.title = `${order.title} · ${badge.title}`;
  return badge;
}

function floorSection(store: Store, floor: FloorView, agents: readonly AgentView[], now: number): HTMLElement {
  const documentKind = documentKindFor(floor.kind);
  let stackChip: HTMLElement | null = null;
  if (documentKind === null) {
    stackChip = el('span', 'chip', stackLabel(floor.stack));
    stackChip.title = t('table.chip.stack');
  }
  const header = el(
    'header',
    'floor-header',
    el('h2', 'floor-title', floorLabel(floor)),
    stackChip,
    kindChip(floor.kind),
    orderBadge(store, floor.slug),
    el('code', 'floor-path', floor.path ?? '—'),
  );

  const head = el(
    'thead',
    '',
    el(
      'tr',
      '',
      ...COLUMNS.map(({ col, hint }) => {
        const th = el('th', '', t(col));
        th.title = t(hint);
        return th;
      }),
    ),
  );
  const body = el('tbody');
  const rows = orderRows(agents);
  if (rows.length === 0) {
    const empty = el('td', 'empty muted', t('table.noAgents'));
    empty.colSpan = COLUMNS.length;
    body.append(el('tr', 'empty-row', empty));
  }
  for (const row of rows) body.append(agentRow(store, row, now));

  return el(
    'section',
    `floor-section floor-${floor.kind}`,
    header,
    el('table', 'agents-table', head, body),
    documentKind === null ? null : documentList(store, documentKind),
  );
}

function alertItem(store: Store, alert: GuardAlert, now: number, open: boolean): HTMLElement {
  const known = store.floorBySlug(alert.floor);
  const floor = known ? floorLabel(known) : alert.floor;
  const agent = store.agents.get(alert.agentKey);
  const count = alert.files.length;

  const level = alertLevel(alert.level);

  const files = el(
    'details',
    'alert-files',
    el('summary', '', plural('table.files', count)),
    el('ul', 'alert-file-list', ...alert.files.map((file) => el('li', '', el('code', '', file)))),
  );
  files.dataset.alert = String(alert.id);
  files.open = open;

  return el(
    'li',
    `alert alert-${alert.level}`,
    level,
    el('span', 'alert-floor', floor),
    files,
    agent ? el('span', 'alert-agent muted', t('table.after', { name: agentName(agent) })) : null,
    el('time', 'alert-time muted', relativeTime(alert.ts, now)),
  );
}

function alertsSection(store: Store, openAlerts: ReadonlySet<number>, now: number): HTMLElement | null {
  const latest = [...store.alerts].sort((a, b) => a.ts - b.ts).slice(-ALERT_COUNT).reverse();
  if (latest.length === 0) return null;
  return el(
    'section',
    'alerts',
    el('h2', 'alerts-title', t('table.alerts')),
    el('ul', 'alert-list', ...latest.map((alert) => alertItem(store, alert, now, openAlerts.has(alert.id)))),
  );
}

export type TableHandle = {
  // Shows the history view and puts the keyboard in its query box; false when this panel has no hub to ask.
  showHistory(): boolean;
  // Shows the history view with a saved search applied; false when this panel has no hub to ask.
  showSearch(saved: SavedSearch): boolean;
  // Shows the live view, where the spend is.
  showNow(): void;
};

export function mountTable(host: HTMLElement, store: Store, api: OfficeApi | null): TableHandle {
  let scheduled = false;
  let scrolledTo: string | null = null;
  const openAlerts = new Set<number>();
  const help = el('details', 'table-help');
  help.open = readHelpOpen();
  const content = el('div', 'table-content');
  const usage = api ? mountUsageBlock(store, api, () => host.classList.contains('active')) : null;
  const nowView = el('div', 'table-now', ...(usage ? [usage] : []), help, content);
  host.replaceChildren(nowView);
  let showHistory = (): boolean => false;
  let showSearch = (_saved: SavedSearch): boolean => false;
  let showNow = (): void => {};
  if (api) {
    const historyHost = el('div', 'table-history');
    const history = mountHistory(historyHost, store, api, {
      openReplay: (sessionId) => window.open(replayHref(sessionId, location), '_blank', 'noopener'),
    });
    const digest = mountDigest(store, api);
    const digestHost = el('div', 'table-digest', digest.root);
    const timeline = mountTimeline(store, api, (filters) => void showSearch({ name: '', filters }));
    const timelineHost = el('div', 'table-timeline', timeline.root);
    const views: readonly { view: TableView; label: MessageKey; button: HTMLButtonElement }[] = [
      { view: 'now', label: 'table.view.now', button: button('', 'table-switch-option') },
      { view: 'history', label: 'table.view.history', button: button('', 'table-switch-option') },
      { view: 'digest', label: 'table.view.digest', button: button('', 'table-switch-option') },
      { view: 'timeline', label: 'table.view.timeline', button: button('', 'table-switch-option') },
    ];
    const switcher = el('div', 'table-switch', ...views.map((item) => item.button));
    switcher.setAttribute('role', 'group');
    let current = readTableView(readJson(VIEW_KEY));
    const paintSwitch = (): void => {
      switcher.setAttribute('aria-label', t('table.view.label'));
      for (const item of views) {
        item.button.textContent = t(item.label);
        item.button.setAttribute('aria-pressed', String(item.view === current));
        item.button.classList.toggle('active', item.view === current);
      }
    };
    const setView = (next: TableView, focus: boolean): void => {
      current = next;
      writeJson(VIEW_KEY, next);
      nowView.hidden = next !== 'now';
      historyHost.hidden = next !== 'history';
      digestHost.hidden = next !== 'digest';
      timelineHost.hidden = next !== 'timeline';
      paintSwitch();
      if (next === 'history') history.activate(focus);
      if (next === 'digest') digest.activate();
      if (next === 'timeline') timeline.activate();
    };
    for (const item of views) item.button.addEventListener('click', () => setView(item.view, item.view === 'history'));
    host.replaceChildren(switcher, nowView, historyHost, digestHost, timelineHost);
    setView(current, false);
    store.watch(['lang'], paintSwitch);
    showHistory = (): boolean => {
      setView('history', true);
      return true;
    };
    showNow = (): void => setView('now', false);
    showSearch = (search: SavedSearch): boolean => {
      setView('history', false);
      history.apply(search);
      return true;
    };
  }

  const render = (): void => {
    const now = store.now();
    const byFloor = new Map<string, AgentView[]>();
    for (const agent of store.visibleAgents()) {
      const list = byFloor.get(agent.floor) ?? [];
      list.push(agent);
      byFloor.set(agent.floor, list);
    }
    const floors = store.floorList();
    const fragment = document.createDocumentFragment();
    const alerts = alertsSection(store, openAlerts, now);
    if (alerts) fragment.append(alerts);
    if (floors.length === 0) {
      fragment.append(el('p', 'placeholder', t('table.waiting')));
      content.replaceChildren(fragment);
      return;
    }
    for (const floor of floors) fragment.append(floorSection(store, floor, byFloor.get(floor.slug) ?? [], now));
    content.replaceChildren(fragment);

    if (store.selectedKey !== scrolledTo) {
      scrolledTo = store.selectedKey;
      content.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      keepFocus(content, render);
    });
  };

  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-key]') : null;
    if (!row || event.target !== row || !row.dataset.key) return;
    event.preventDefault();
    store.select(row.dataset.key);
  });

  host.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const path = target.closest<HTMLElement>('[data-doc]')?.dataset.doc;
    if (path !== undefined) {
      const doc = store.documents.find((item) => item.path === path);
      if (doc) openDocument(store, doc);
      return;
    }
    const key = target.closest<HTMLElement>('tr[data-key]')?.dataset.key;
    if (key) store.select(key);
  });

  host.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (target === help) {
        storeHelpOpen(help.open);
        return;
      }
      if (!(target instanceof HTMLDetailsElement) || target.dataset.alert === undefined) return;
      const id = Number(target.dataset.alert);
      if (target.open) openAlerts.add(id);
      else openAlerts.delete(id);
    },
    true,
  );

  store.watch(['lang'], () => help.replaceChildren(...helpContent()));
  store.watch(['agents', 'floors', 'questions', 'selection', 'tick', 'alerts', 'documents', 'lang', 'orders'], schedule);

  return { showHistory: () => showHistory(), showSearch: (saved) => showSearch(saved), showNow: () => showNow() };
}
