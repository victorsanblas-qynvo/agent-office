import type { OfficeApi } from '../api';
import { el } from '../dom';
import { plural, t } from '../i18n';
import type { Store } from '../store';
import { relativeTime } from '../time';
import type { FlakyCheckView } from '../types';
import { FLAKY_DAYS, topFlaky } from './flaky-checks-model';

// The checks of a floor that failed and then passed on the same commit in the last two weeks, loaded when the block opens.
export function flakyChecks(floor: string, store: Store, api: OfficeApi): HTMLElement {
  const count = el('span', 'chip');
  const body = el('div', 'deleted-branches-body');
  const root = el('details', 'floor-delivery deleted-branches', el('summary', '', t('settings.flaky.title'), ' ', count), body);
  let views: FlakyCheckView[] | null = null;
  let failure: string | null = null;

  const paint = (): void => {
    const top = views ? topFlaky(views) : [];
    count.hidden = top.length === 0;
    count.textContent = String(top.length);
    const now = store.now();
    const rows =
      failure !== null
        ? [el('p', 'settings-status error', failure)]
        : views === null
          ? [el('p', 'muted', t('board.loading'))]
          : top.length === 0
            ? [el('p', 'muted', t('settings.flaky.empty', { days: FLAKY_DAYS }))]
            : top.map((view) =>
                el(
                  'div',
                  'setting-row deleted-branch',
                  el('span', 'setting-text', el('code', 'setting-label', view.check), el('span', 'setting-hint muted', t('settings.flaky.last', { when: relativeTime(view.lastAt, now) }))),
                  el('span', 'chip', plural('settings.flaky.count', view.flakyCount)),
                ),
              );
    body.replaceChildren(el('p', 'setting-hint muted', t('settings.flaky.hint', { days: FLAKY_DAYS })), ...rows);
  };

  const load = async (): Promise<void> => {
    const result = await api.flakyChecks(floor, FLAKY_DAYS);
    if (result.ok) {
      views = result.data.flaky;
      failure = null;
    } else {
      failure = result.message;
    }
    if (root.isConnected) paint();
  };

  root.addEventListener('toggle', () => {
    if (!root.open) return;
    paint();
    void load();
  });
  paint();
  return root;
}
