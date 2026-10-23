import type { OfficeApi } from '../api';
import { el } from '../dom';
import { t } from '../i18n';
import { agentName, floorLabel } from '../labels';
import type { Store } from '../store';
import type { AgentTimeline } from '../types';
import { readJson, writeJson } from '../prefs';
import type { HistoryFilters } from './history';
import { hourTicks, layoutSegments, PX_PER_HOUR, readTimelineHours, segmentColor, segmentFilters, TIMELINE_HOURS } from './timeline-model';

// Pure over the store: the agent's name when the office knows it, else the start of its key.
export function timelineAgentName(store: Pick<Store, 'agents'>, key: string): string {
  const agent = store.agents.get(key);
  return agent ? agentName(agent) : key.slice(0, 8);
}

const HOURS_KEY = 'agent-office.table.timeline.hours';

export function mountTimeline(store: Store, api: OfficeApi, openHistory: (filters: HistoryFilters) => void): { root: HTMLElement; activate(): void } {
  let hours = readTimelineHours(readJson(HOURS_KEY));
  let agents: AgentTimeline[] | null = null;
  let until = store.now();
  let failure: string | null = null;
  let seq = 0;

  const picks = TIMELINE_HOURS.map((value) => ({ value, button: el('button', 'table-switch-option') }));
  for (const pick of picks) pick.button.type = 'button';
  const selector = el('div', 'table-switch timeline-hours', ...picks.map((pick) => pick.button));
  selector.setAttribute('role', 'group');
  const body = el('div', 'timeline-body');
  const root = el('section', 'timeline', el('header', 'timeline-head', selector), body);

  const floorName = (slug: string): string => {
    const known = store.floorBySlug(slug);
    return known ? floorLabel(known) : slug;
  };

  function paintStrip(): HTMLElement {
    const from = until - hours * 3_600_000;
    const width = hours * PX_PER_HOUR;
    const axis = el('div', 'timeline-axis');
    axis.style.width = `${width}px`;
    for (const tick of hourTicks(from, until, width)) {
      const mark = el('span', 'timeline-tick', tick.label);
      mark.style.left = `${tick.left}px`;
      axis.append(mark);
    }
    const rows: HTMLElement[] = [el('div', 'timeline-row', el('div', 'timeline-name'), axis)];
    let floor: string | null = null;
    for (const agent of agents ?? []) {
      if (agent.floor !== floor) {
        floor = agent.floor;
        rows.push(el('div', 'timeline-floor', floorName(floor)));
      }
      const lane = el('div', 'timeline-lane');
      lane.style.width = `${width}px`;
      for (const segment of agent.segments) {
        const placed = layoutSegments([segment], from, until, width)[0];
        if (!placed) continue;
        const bar = el('button', 'timeline-bar');
        bar.type = 'button';
        bar.addEventListener('click', () => openHistory(segmentFilters(agent.agent, segment)));
        bar.style.left = `${placed.left}px`;
        bar.style.width = `${placed.width}px`;
        bar.style.background = segmentColor(placed.state);
        bar.title = placed.title;
        lane.append(bar);
      }
      rows.push(el('div', 'timeline-row', el('div', 'timeline-name', timelineAgentName(store, agent.agent)), lane));
    }
    return el('div', 'timeline-strip', ...rows);
  }

  function render(): void {
    selector.setAttribute('aria-label', t('timeline.hours.label'));
    for (const pick of picks) {
      pick.button.textContent = t('timeline.hours', { n: pick.value });
      pick.button.setAttribute('aria-pressed', String(pick.value === hours));
      pick.button.classList.toggle('active', pick.value === hours);
    }
    if (agents === null) body.replaceChildren(el('p', 'muted', failure ?? t('timeline.loading')));
    else if (agents.length === 0) body.replaceChildren(el('p', 'muted', t('timeline.empty')));
    else body.replaceChildren(paintStrip());
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    agents = null;
    failure = null;
    render();
    const result = await api.timeline(hours);
    if (mine !== seq) return;
    if (result.ok) {
      agents = result.data.agents;
      until = store.now();
    } else failure = t('timeline.error', { error: result.message });
    render();
  }

  picks.forEach((pick) =>
    pick.button.addEventListener('click', () => {
      if (hours === pick.value) return;
      hours = pick.value;
      writeJson(HOURS_KEY, hours);
      void load();
    }),
  );
  store.watch(['lang', 'floors'], render);
  render();
  return { root, activate: () => void load() };
}
