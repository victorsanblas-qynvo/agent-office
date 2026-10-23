import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import { floorLabel } from '../labels';
import type { Store } from '../store';
import type { DeliveryMetrics, DeliveryStats } from '../types';
import { DEFAULT_METRIC_DAYS, METRIC_DAYS, metricCells, type MetricDays } from './metrics-model';

export function mountMetrics(store: Store, api: OfficeApi): { root: HTMLElement; activate(): void } {
  let days: MetricDays = DEFAULT_METRIC_DAYS;
  let data: DeliveryMetrics | null = null;
  let failure: string | null = null;
  let seq = 0;

  const picker = el('div', 'table-switch metrics-days');
  picker.setAttribute('role', 'group');
  const choices = METRIC_DAYS.map((value) => ({ value, button: button('', 'table-switch-option') }));
  picker.append(...choices.map((choice) => choice.button));
  const title = el('h3', 'digest-floor-name');
  const body = el('div', 'metrics-body');
  const root = el('section', 'digest-floor metrics', el('header', 'metrics-head', title, picker), body);

  const floorName = (slug: string): string => {
    const known = store.floorBySlug(slug);
    return known ? floorLabel(known) : slug;
  };

  const row = (name: string, stats: DeliveryStats, total = false): HTMLElement => {
    const cells = metricCells(stats, currentLang());
    return el(
      'tr',
      total ? 'metrics-total' : '',
      el('th', '', name),
      el('td', '', cells.delivered),
      el('td', '', cells.median),
      el('td', '', cells.p90),
      el('td', '', cells.reopened),
      el('td', '', cells.firstGreen),
      el('td', '', cells.runs),
    );
  };

  function render(): void {
    title.textContent = t('metrics.title');
    picker.setAttribute('aria-label', t('metrics.days.label'));
    for (const choice of choices) {
      choice.button.textContent = t('metrics.days.option', { n: choice.value });
      choice.button.setAttribute('aria-pressed', String(days === choice.value));
      choice.button.classList.toggle('active', days === choice.value);
    }
    if (!data) {
      body.replaceChildren(el('p', 'muted', failure ?? t('metrics.loading')));
      return;
    }
    if (data.floors.length === 0) {
      body.replaceChildren(el('p', 'muted', t('metrics.empty', { n: data.days })));
      return;
    }
    const heads = ['metrics.floor', 'metrics.delivered', 'metrics.median', 'metrics.p90', 'metrics.reopened', 'metrics.firstGreen', 'metrics.runs'] as const;
    body.replaceChildren(
      el(
        'table',
        'metrics-table',
        el('thead', '', el('tr', '', ...heads.map((key) => el('th', '', t(key))))),
        el('tbody', '', ...data.floors.map((floor) => row(floorName(floor.floor), floor)), row(t('digest.totals'), data.totals, true)),
      ),
    );
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    data = null;
    failure = null;
    render();
    const result = await api.deliveryMetrics(days);
    if (mine !== seq) return;
    if (result.ok) data = result.data;
    else failure = t('metrics.error', { error: result.message });
    render();
  }

  for (const choice of choices) {
    choice.button.addEventListener('click', () => {
      if (days === choice.value) return;
      days = choice.value;
      void load();
    });
  }
  store.watch(['lang', 'floors'], render);
  render();
  return { root, activate: () => void load() };
}
