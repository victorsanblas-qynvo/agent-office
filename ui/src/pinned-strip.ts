import { button, el, setStateColor } from './dom';
import { t } from './i18n';
import { agentName, contextOf, STATE_COLORS, stateLabel } from './labels';
import { pinnedRows } from './pins';
import type { Store } from './store';
import type { AgentState, AgentView } from './types';

type Face = { agent: AgentView; state: AgentState };

export function pinSignature(lang: string, faces: readonly Face[]): string {
  return JSON.stringify([lang, faces.map(({ agent, state }) => [agent.key, agentName(agent), state, agent.openTool ?? agent.tool, Math.round(contextOf(agent)?.usedPct ?? -1)])]);
}

// The pinned agents as chips in the header: state, what tool is open and how full the context is. A click selects the agent.
export function mountPinnedStrip(store: Store, onPick: (key: string) => void): HTMLElement {
  const root = el('div', 'pinned-strip');
  root.setAttribute('role', 'group');
  let signature = '';

  store.watch(['agents', 'lang', 'pins', 'mode'], () => {
    const faces = store.replay ? [] : pinnedRows(store.agents, store.pins).map((agent) => ({ agent, state: store.shownState(agent) }));
    root.hidden = faces.length === 0;
    const next = pinSignature(store.lang, faces);
    if (next === signature) return;
    signature = next;
    root.setAttribute('aria-label', t('pins.label'));
    root.replaceChildren(
      ...faces.map(({ agent, state }) => {
        const chip = button('', 'pinned-chip');
        setStateColor(chip, STATE_COLORS[state]);
        chip.title = `${stateLabel(state)} · ${t('pins.title')}`;
        chip.dataset.key = agent.key;
        const tool = agent.openTool ?? agent.tool;
        const context = contextOf(agent);
        chip.append(el('span', 'pinned-dot'), el('span', 'pinned-name', agentName(agent)));
        if (tool) chip.append(el('span', 'pinned-tool muted', tool));
        if (context) chip.append(el('span', 'pinned-ctx muted', `${Math.round(context.usedPct)}%`));
        chip.addEventListener('click', () => onPick(agent.key));
        return chip;
      }),
    );
  });
  return root;
}
