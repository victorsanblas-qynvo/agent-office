import { stateBadge } from '../badge';
import { button, el } from '../dom';
import { t } from '../i18n';
import { canPin, togglePin } from '../pins';
import { agentName, floorLabel, roleLabel } from '../labels';
import type { Store } from '../store';
import { relativeTime } from '../time';

export type HeaderFacts = {
  lang: string;
  key: string;
  name: string;
  state: string;
  role: string;
  floor: string;
  ended: boolean;
  pinned: boolean;
  pinnable: boolean;
  replay: boolean;
};

// Everything the header draws except the "since" text, which the clock patches alone.
export function headerSignature(facts: HeaderFacts): string {
  return JSON.stringify(Object.values(facts));
}

export function mountHeader(host: HTMLElement, store: Store): void {
  let signature = '';
  let sinceNode: HTMLElement | null = null;
  store.watch(['selection', 'agents', 'floors', 'tick', 'lang', 'pins', 'mode'], () => {
    const key = store.selectedKey;
    if (key === null) {
      signature = '';
      sinceNode = null;
      host.replaceChildren(el('p', 'hint muted', t('panel.selectHint')));
      return;
    }
    const agent = store.agents.get(key);
    if (!agent) {
      signature = '';
      sinceNode = null;
      host.replaceChildren(el('h2', 'panel-title', key.slice(0, 8)), el('p', 'hint muted', t('panel.unavailable')));
      return;
    }
    const floor = store.floorBySlug(agent.floor);
    const now = store.now();
    const since =
      agent.endedAt !== null
        ? t('panel.ended', { time: relativeTime(agent.endedAt, now) })
        : t('panel.since', { time: relativeTime(agent.stateSince, now) });
    const pinned = store.pins.includes(agent.key);
    const pinnable = pinned || canPin(store.pins, agent.key, store.agents);
    const state = store.shownState(agent);
    const next = headerSignature({
      lang: store.lang,
      key: agent.key,
      name: agentName(agent),
      state,
      role: roleLabel(agent.roleKind),
      floor: floor ? floorLabel(floor) : agent.floor,
      ended: agent.endedAt !== null,
      pinned,
      pinnable,
      replay: store.replay,
    });
    if (next === signature && sinceNode) {
      sinceNode.textContent = since;
      return;
    }
    signature = next;
    const pin = button(t(pinned ? 'pins.unpin' : 'pins.pin'), `pin-toggle${pinned ? ' active' : ''}`, t(pinnable ? 'pins.hint' : 'pins.full'));
    pin.setAttribute('aria-pressed', String(pinned));
    pin.disabled = !pinnable;
    pin.hidden = store.replay || agent.endedAt !== null;
    pin.addEventListener('click', () => store.setPins(togglePin(store.pins, agent.key, store.agents)));
    sinceNode = el('span', 'muted', since);
    host.replaceChildren(
      el('div', 'panel-title-row', el('h2', 'panel-title', agentName(agent)), stateBadge(state), pin),
      el('div', 'panel-meta', el('span', 'chip', roleLabel(agent.roleKind)), el('span', 'chip', floor ? floorLabel(floor) : agent.floor), sinceNode),
    );
  });
}
