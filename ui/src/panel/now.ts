import type { OfficeApi } from '../api';
import { append, button, el, setStateColor } from '../dom';
import { t } from '../i18n';
import { hubText } from '../i18n/hub';
import { AWAY_ICON, contextFill, contextLevel, contextLine, contextOf, doingPhrase, isAway, STATE_COLORS, STATE_ICONS, tokensLine } from '../labels';
import type { Store } from '../store';
import { clockTime, relativeTime } from '../time';
import type { ActivityView, AgentView, TranscriptEntry } from '../types';
import { panelSection } from './section';
import { tailDue, tailIcon, TAIL_LIMIT, type TailMark } from './tail-model';
import { canAskStatus, runSessionAction, stalledText, statusButton } from './session-controls';

const STEP_LIMIT = 5;

type TimeNode = { node: HTMLElement; text: (now: number) => string };

function lastSteps(store: Store, key: string): ActivityView[] {
  const steps: ActivityView[] = [];
  for (let index = store.activity.length - 1; index >= 0 && steps.length < STEP_LIMIT; index -= 1) {
    const entry = store.activity[index];
    if (entry.agentKey === key) steps.push(entry);
  }
  return steps;
}

function stepItem(entry: ActivityView): HTMLElement {
  const dot = el('span', 'now-step-dot');
  if (entry.state) setStateColor(dot, STATE_COLORS[entry.state]);
  else dot.classList.add('now-step-dot-empty');
  return el('li', 'now-step', dot, el('span', 'now-step-text', hubText(entry.summary)), el('time', 'muted', clockTime(entry.ts)));
}

function chips(agent: AgentView, now: number, times: TimeNode[]): HTMLElement | null {
  const items: HTMLElement[] = [];
  if (agent.tool) items.push(el('span', 'chip now-chip', `${t('now.tool')} `, el('code', '', agent.tool)));
  if (agent.file) {
    const file = el('span', 'chip now-chip', `${t('now.file')} `, el('code', '', agent.file));
    file.title = agent.file;
    items.push(file);
  }
  if (agent.lastTest) {
    const { ok, ts, command } = agent.lastTest;
    const when = el('span', 'muted', relativeTime(ts, now));
    times.push({ node: when, text: (at) => relativeTime(ts, at) });
    const test = el('span', `chip now-chip ${ok ? 'now-test-ok' : 'now-test-fail'}`, ok ? '✓ tests ' : '✗ tests ', when);
    test.title = command;
    items.push(test);
  }
  return items.length > 0 ? el('div', 'now-chips', ...items) : null;
}

function tokensRow(agent: AgentView): HTMLElement | null {
  if (!agent.tokens) return null;
  const row = el('p', 'now-tokens muted', tokensLine(agent.tokens));
  row.title = t('tokens.row.hint');
  return row;
}

// The window of the agent: a bar and the numbers, with the source of the measure as a tooltip.
function contextRow(agent: AgentView): HTMLElement | null {
  const context = contextOf(agent);
  if (!context) return null;
  const fill = el('span', 'now-ctx-fill');
  fill.dataset.level = contextLevel(context.usedPct);
  fill.style.width = `${contextFill(context)}%`;
  const row = el('div', 'now-ctx', el('span', 'now-ctx-bar', fill), el('span', 'now-ctx-text muted', contextLine(context)));
  row.title = `${t('context.hint')} ${t(`context.source.${context.source}`)}`;
  return row;
}

function stalledLine(store: Store, agent: AgentView, now: number, times: TimeNode[]): HTMLElement | null {
  const since = agent.stalledSince;
  if (since === null) return null;
  const mark = el('span', 'chip floors-stalled', stalledText(since, now));
  times.push({ node: mark, text: (at) => stalledText(since, at) });
  return el('div', 'now-actions', mark, canAskStatus(store, agent) ? statusButton(agent) : null);
}

type TailState = { key: string; entries: TranscriptEntry[]; failed: boolean } | null;

function tailRow(entry: TranscriptEntry, now: number): HTMLElement {
  return el('li', 'now-tail-row', el('span', 'now-tail-icon', tailIcon(entry.role)), el('span', 'now-tail-text', entry.text), el('time', 'muted', relativeTime(entry.ts, now)));
}

export function mountNow(host: HTMLElement, store: Store, api: OfficeApi | null): void {
  let times: TimeNode[] = [];
  const section = panelSection({ id: 'now', title: () => t('now.title'), host });
  let tail: TailState = null;
  let mark: TailMark | null = null;
  let loading = false;
  let tailHidden = false;
  const tailTitle = el('summary', 'now-tail-title section-title');
  const tailReload = button('', 'session-action');
  const tailList = el('div', 'now-tail-list');
  const tailBox = el('details', 'now-tail', tailTitle, el('div', 'now-tail-actions', tailReload), tailList);
  tailBox.hidden = true;

  const paintTail = (key: string | null): void => {
    const shown = tail !== null && tail.key === key ? tail : null;
    tailBox.hidden = shown === null || (shown.entries.length === 0 && !shown.failed && tailHidden);
    tailTitle.textContent = t('now.tail.title');
    tailReload.textContent = t('now.tail.reload');
    if (shown === null) return;
    const now = store.now();
    tailList.replaceChildren(
      shown.failed
        ? el('p', 'muted hint', t('now.tail.error'))
        : shown.entries.length > 0
          ? el('ul', 'now-tail-rows', ...shown.entries.map((entry) => tailRow(entry, now)))
          : el('p', 'muted hint', t('now.tail.empty')),
    );
  };
  const loadTail = async (agent: AgentView): Promise<void> => {
    if (!api || loading) return;
    loading = true;
    mark = { key: agent.key, stateSince: agent.stateSince, at: store.now() };
    const result = await api.tail(agent.sessionId, TAIL_LIMIT);
    loading = false;
    if (store.selectedKey !== agent.key) return;
    tailHidden = result.ok && result.data.hidden === true;
    tail = { key: agent.key, entries: result.ok ? result.data.entries : [], failed: !result.ok };
    paintTail(agent.key);
  };

  store.watch(['selection', 'agents', 'activity', 'lang'], () => {
    times = [];
    const key = store.selectedKey;
    const agent = key === null ? undefined : store.agents.get(key);
    if (key === null || !agent) {
      host.hidden = true;
      tail = null;
      mark = null;
      section.body.replaceChildren();
      section.setMeta(null);
      return;
    }
    host.hidden = false;
    const now = store.now();
    const state = store.shownState(agent);
    const away = isAway(agent);
    const icon = el('span', 'now-icon', agent.away && agent.endedAt === null ? AWAY_ICON : STATE_ICONS[state]);
    setStateColor(icon, away && agent.endedAt === null ? 'var(--muted)' : STATE_COLORS[state]);
    const sinceTs = agent.endedAt ?? agent.stateSince;
    const format = (time: string): string => t(agent.endedAt !== null ? 'panel.ended' : 'panel.since', { time });
    const since = el('p', 'now-since muted', format(relativeTime(sinceTs, now)));
    times.push({ node: since, text: (at) => format(relativeTime(sinceTs, at)) });
    const steps = lastSteps(store, key);
    const doing = doingPhrase(agent, state);
    section.setTitle();
    section.setMeta(doing);
    section.root.classList.toggle('now-away', away);
    section.body.replaceChildren();
    append(section.body, [
      el('div', 'now-head', icon, el('div', 'now-headline', el('p', 'now-title', doing), since)),
      chips(agent, now, times),
      contextRow(agent),
      tokensRow(agent),
      stalledLine(store, agent, now, times),
      agent.task ? el('p', 'now-task', el('span', 'muted', `${t('now.task')} `), agent.task) : null,
      el('h4', 'now-steps-title section-title', t('now.steps')),
      steps.length > 0 ? el('ul', 'now-steps', ...steps.map(stepItem)) : el('p', 'muted hint', t('now.noActivity')),
      tailBox,
    ]);
    const mainAgent = api !== null && agent.key === agent.sessionId;
    if (!mainAgent) tailBox.hidden = true;
    else {
      paintTail(key);
      if (tailDue(mark, key, agent.stateSince, now)) void loadTail(agent);
    }
  });

  tailReload.addEventListener('click', () => {
    const key = store.selectedKey;
    const agent = key === null ? undefined : store.agents.get(key);
    if (agent) void loadTail(agent);
  });

  host.addEventListener('click', (event) => {
    const action = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null;
    if (action) void runSessionAction(api, store, action);
  });

  store.watch(['tick'], () => {
    if (host.hidden) return;
    const now = store.now();
    for (const { node, text } of times) node.textContent = text(now);
  });
}
