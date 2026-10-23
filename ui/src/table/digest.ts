import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import { floorLabel, formatTokens } from '../labels';
import type { Store } from '../store';
import type { DigestCounts, OfficeDigest } from '../types';
import { digestText } from './digest-text';

const pad = (value: number): string => String(value).padStart(2, '0');

export function dayOf(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// Pure: the day before or after a YYYY-MM-DD day.
export function shiftDay(day: string, by: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return dayOf(new Date(year, month - 1, date + by));
}

function stat(label: string, value: string | number): HTMLElement {
  return el('li', 'digest-stat', el('span', 'muted', label), ' ', el('strong', '', String(value)));
}

function stats(c: DigestCounts & { delivered?: number }): HTMLElement[] {
  return [
    ...(c.delivered ? [stat(t('digest.delivered'), c.delivered)] : []),
    ...(c.blocked ? [stat(t('digest.blocked'), c.blocked)] : []),
    ...(c.redRuns ? [stat(t('digest.red'), c.redRuns)] : []),
    ...(c.greenRuns ? [stat(t('digest.green'), c.greenRuns)] : []),
    ...(c.plans.approved ? [stat(t('digest.plansApproved'), c.plans.approved)] : []),
    ...(c.plans.noAgreement ? [stat(t('digest.plansNoAgreement'), c.plans.noAgreement)] : []),
    ...(c.lessons ? [stat(t('digest.lessons'), c.lessons)] : []),
    ...(c.tokens ? [stat(t('digest.tokens'), formatTokens(c.tokens))] : []),
  ];
}

export function mountDigest(store: Store, api: OfficeApi): { root: HTMLElement; activate(): void } {
  let day = dayOf(new Date(store.now()));
  let digest: OfficeDigest | null = null;
  let failure: string | null = null;
  let seq = 0;

  const prev = button('‹', 'digest-step');
  const next = button('›', 'digest-step');
  const label = el('strong', 'digest-day');
  const copy = button('', 'digest-copy');
  const body = el('div', 'digest-body');
  const root = el('section', 'digest', el('header', 'digest-head', prev, label, next, copy), body);

  const floorName = (slug: string): string => {
    const known = store.floorBySlug(slug);
    return known ? floorLabel(known) : slug;
  };

  function render(): void {
    const today = dayOf(new Date(store.now()));
    label.textContent = day;
    prev.setAttribute('aria-label', t('digest.prev'));
    next.setAttribute('aria-label', t('digest.next'));
    next.disabled = day >= today;
    copy.textContent = t('digest.copy');
    copy.disabled = !digest;
    if (!digest) {
      body.replaceChildren(el('p', 'muted', failure ?? t('digest.loading')));
      return;
    }
    if (digest.floors.length === 0) {
      body.replaceChildren(el('p', 'muted', t('digest.empty')));
      return;
    }
    body.replaceChildren(
      ...digest.floors.map((floor) =>
        el(
          'article',
          'digest-floor',
          el('h3', 'digest-floor-name', floorName(floor.floor)),
          el('ul', 'digest-stats', ...stats({ ...floor, delivered: floor.delivered.length })),
          floor.delivered.length > 0 ? el('ul', 'digest-orders', ...floor.delivered.map((order) => el('li', '', order.title))) : null,
        ),
      ),
      el('article', 'digest-floor digest-total', el('h3', 'digest-floor-name', t('digest.totals')), el('ul', 'digest-stats', ...stats(digest.totals))),
    );
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    digest = null;
    failure = null;
    render();
    const result = await api.digest(day);
    if (mine !== seq) return;
    if (result.ok) digest = result.data;
    else failure = t('digest.error', { error: result.message });
    render();
  }

  function go(to: string): void {
    day = to;
    void load();
  }

  prev.addEventListener('click', () => go(shiftDay(day, -1)));
  next.addEventListener('click', () => {
    if (!next.disabled) go(shiftDay(day, 1));
  });
  copy.addEventListener('click', () => {
    if (!digest) return;
    void navigator.clipboard
      .writeText(digestText(digest, currentLang(), floorName))
      .then(() => {
        copy.textContent = t('digest.copied');
        window.setTimeout(render, 1500);
      })
      .catch(() => {
        copy.textContent = t('digest.copyFailed');
        window.setTimeout(render, 1500);
      });
  });
  store.watch(['lang', 'floors'], render);
  render();
  return { root, activate: () => void load() };
}
