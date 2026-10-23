import { stateBadge } from '../badge';
import { button, el } from '../dom';
import { t } from '../i18n';
import { canPin, togglePin } from '../pins';
import { agentName, floorLabel, roleLabel } from '../labels';
import type { Store } from '../store';
import { relativeTime } from '../time';

export function mountHeader(host: HTMLElement, store: Store): void {
  store.watch(['selection', 'agents', 'floors', 'tick', 'lang', 'pins', 'mode'], () => {
    const key = store.selectedKey;
    if (key === null) {
      host.replaceChildren(el('p', 'hint muted', t('panel.selectHint')));
      return;
    }
    const agent = store.agents.get(key);
    if (!agent) {
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
    const pin = button(t(pinned ? 'pins.unpin' : 'pins.pin'), `pin-toggle${pinned ? ' active' : ''}`, t(pinned || canPin(store.pins, agent.key) ? 'pins.hint' : 'pins.full'));
    pin.setAttribute('aria-pressed', String(pinned));
    pin.disabled = !pinned && !canPin(store.pins, agent.key);
    pin.hidden = store.replay || agent.endedAt !== null;
    pin.addEventListener('click', () => store.setPins(togglePin(store.pins, agent.key)));
    host.replaceChildren(
      el('div', 'panel-title-row', el('h2', 'panel-title', agentName(agent)), stateBadge(store.shownState(agent)), pin),
      el(
        'div',
        'panel-meta',
        el('span', 'chip', roleLabel(agent.roleKind)),
        el('span', 'chip', floor ? floorLabel(floor) : agent.floor),
        el('span', 'muted', since),
      ),
    );
  });
}
