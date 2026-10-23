import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import { floorLabel, formatTokens } from '../labels';
import type { Store } from '../store';
import type { DigestCounts, DigestFloor, OfficeDigest, WeekDigest } from '../types';
import { digestText, weekDigestText } from './digest-text';

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

// Pure: the 7 days that end on `today`, as the from and to of a week request.
export function weekOf(today: string): { from: string; to: string } {
  return { from: shiftDay(today, -6), to: today };
}

export function mountDigest(store: Store, api: OfficeApi): { root: HTMLElement; activate(): void } {
  let day = dayOf(new Date(store.now()));
  let digest: OfficeDigest | null = null;
  let week: WeekDigest | null = null;
  let mode: 'day' | 'week' = 'day';
  let failure: string | null = null;
  let seq = 0;

  const modeDay = button('', 'table-switch-option');
  const modeWeek = button('', 'table-switch-option');
  const modes = el('div', 'table-switch digest-mode', modeDay, modeWeek);
  modes.setAttribute('role', 'group');
  const prev = button('‹', 'digest-step');
  const next = button('›', 'digest-step');
  const label = el('strong', 'digest-day');
  const copy = button('', 'digest-copy');
  const body = el('div', 'digest-body');
  const root = el('section', 'digest', el('header', 'digest-head', modes, prev, label, next, copy), body);

  const floorName = (slug: string): string => {
    const known = store.floorBySlug(slug);
    return known ? floorLabel(known) : slug;
  };

  const dayCard = (floor: DigestFloor): HTMLElement =>
    el(
      'article',
      'digest-floor',
      el('h3', 'digest-floor-name', floorName(floor.floor)),
      el('ul', 'digest-stats', ...stats({ ...floor, delivered: floor.delivered.length })),
      floor.delivered.length > 0 ? el('ul', 'digest-orders', ...floor.delivered.map((order) => el('li', '', order.title))) : null,
    );

  function paintDay(data: OfficeDigest): HTMLElement[] {
    if (data.floors.length === 0) return [el('p', 'muted', t('digest.empty'))];
    return [...data.floors.map(dayCard), el('article', 'digest-floor digest-total', el('h3', 'digest-floor-name', t('digest.totals')), el('ul', 'digest-stats', ...stats(data.totals)))];
  }

  function paintWeek(data: WeekDigest): HTMLElement[] {
    if (data.floors.length === 0) return [el('p', 'muted', t('digest.emptyWeek'))];
    return [
      ...data.floors.map(dayCard),
      el('article', 'digest-floor digest-total', el('h3', 'digest-floor-name', t('digest.totals')), el('ul', 'digest-stats', ...stats(data.totals))),
      el(
        'article',
        'digest-floor',
        el('h3', 'digest-floor-name', t('digest.byDay')),
        el(
          'ul',
          'digest-days',
          ...data.days.map((one) => el('li', 'digest-day-row', el('strong', '', one.day), ' ', el('ul', 'digest-stats', ...stats(one.totals)))),
        ),
      ),
    ];
  }

  function render(): void {
    const today = dayOf(new Date(store.now()));
    const weekly = mode === 'week';
    const ready = weekly ? week !== null : digest !== null;
    modes.setAttribute('aria-label', t('digest.mode.label'));
    for (const [item, key, own] of [[modeDay, 'digest.mode.day', 'day'], [modeWeek, 'digest.mode.week', 'week']] as const) {
      item.textContent = t(key);
      item.setAttribute('aria-pressed', String(mode === own));
      item.classList.toggle('active', mode === own);
    }
    label.textContent = weekly ? t('digest.range', weekOf(today)) : day;
    prev.setAttribute('aria-label', t('digest.prev'));
    next.setAttribute('aria-label', t('digest.next'));
    prev.hidden = weekly;
    next.hidden = weekly;
    next.disabled = day >= today;
    copy.textContent = t('digest.copy');
    copy.disabled = !ready;
    if (digest && !weekly) body.replaceChildren(...paintDay(digest));
    else if (week && weekly) body.replaceChildren(...paintWeek(week));
    else body.replaceChildren(el('p', 'muted', failure ?? t('digest.loading')));
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    digest = null;
    week = null;
    failure = null;
    render();
    if (mode === 'week') {
      const range = weekOf(dayOf(new Date(store.now())));
      const result = await api.weekDigest(range.from, range.to);
      if (mine !== seq) return;
      if (result.ok) week = result.data;
      else failure = t('digest.error', { error: result.message });
    } else {
      const result = await api.digest(day);
      if (mine !== seq) return;
      if (result.ok) digest = result.data;
      else failure = t('digest.error', { error: result.message });
    }
    render();
  }

  function go(to: string): void {
    day = to;
    void load();
  }

  const setMode = (to: 'day' | 'week'): void => {
    if (mode === to) return;
    mode = to;
    void load();
  };
  modeDay.addEventListener('click', () => setMode('day'));
  modeWeek.addEventListener('click', () => setMode('week'));
  prev.addEventListener('click', () => go(shiftDay(day, -1)));
  next.addEventListener('click', () => {
    if (!next.disabled) go(shiftDay(day, 1));
  });
  copy.addEventListener('click', () => {
    const text = mode === 'week' ? (week ? weekDigestText(week, currentLang(), floorName) : null) : digest ? digestText(digest, currentLang(), floorName) : null;
    if (text === null) return;
    void navigator.clipboard
      .writeText(text)
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
