import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, plural, t } from '../i18n';
import { hubText } from '../i18n/hub';
import { floorLabel, formatTokens, tokenParts, tokenWritten } from '../labels';
import type { Store } from '../store';
import type { HubText, TokenRow, UsageDay, UsageRange, UsageSummary } from '../types';
import { mountUsageCard } from '../usage-card';

export const SPEND_REFRESH_MS = 60_000;

const RANGES: readonly { range: UsageRange; label: 'usage.spend.today' | 'usage.spend.week' }[] = [
  { range: 'today', label: 'usage.spend.today' },
  { range: 'week', label: 'usage.spend.week' },
];

export function spendDue(now: number, loadedAt: number | null, visible: boolean, loading: boolean): boolean {
  if (!visible || loading) return false;
  return loadedAt === null || now - loadedAt >= SPEND_REFRESH_MS;
}

export type DayBar = { day: string; label: string; value: number; pct: number; isToday: boolean };

export type PlanRow = { key: string; tokens: number; other: boolean };

const PLAN_ROWS = 5;

function dayKey(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function dayBars(byDay: readonly UsageDay[], now: number): DayBar[] {
  const today = dayKey(new Date(now));
  const max = Math.max(0, ...byDay.map((entry) => entry.tokens));
  return byDay.map(({ day, tokens }) => {
    const [year, month, date] = day.split('-').map(Number);
    return {
      day,
      label: new Date(year, month - 1, date).toLocaleDateString(currentLang(), { weekday: 'short' }),
      value: tokens,
      pct: max > 0 ? (tokens / max) * 100 : 0,
      isToday: day === today,
    };
  });
}

export function planRows(rows: readonly TokenRow[]): PlanRow[] {
  const sized = rows.map((row) => ({ key: row.key, tokens: row.tokens.input + row.tokens.cacheRead + row.tokens.cacheCreate + row.tokens.output }));
  sized.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
  const top = sized.slice(0, PLAN_ROWS).map((row) => ({ ...row, other: false }));
  const rest = sized.slice(PLAN_ROWS);
  if (rest.length === 0) return top;
  return [...top, { key: '', tokens: rest.reduce((sum, row) => sum + row.tokens, 0), other: true }];
}

function dayChart(byDay: readonly UsageDay[], now: number): HTMLElement {
  const cols = dayBars(byDay, now).map((bar) => {
    const text = `${bar.label}: ${formatTokens(bar.value)}`;
    const fill = el('span', bar.isToday ? 'usage-day-fill today' : 'usage-day-fill');
    fill.style.height = `${bar.pct}%`;
    const col = el('div', 'usage-day', el('span', 'usage-day-track', fill), el('span', 'usage-day-label', bar.label));
    col.title = `${text} (${bar.value})`;
    col.setAttribute('role', 'img');
    col.setAttribute('aria-label', `${text} (${bar.value})`);
    return col;
  });
  return el('div', 'usage-spend-group', el('h3', 'section-title', t('usage.spend.byDay')), el('div', 'usage-days', ...cols));
}

function planList(rows: readonly TokenRow[]): HTMLElement {
  const items = planRows(rows).map((row) => {
    const name = row.other ? t('usage.spend.otherPlans') : row.key;
    const label = el('span', 'usage-spend-name', name);
    label.title = name;
    return el('li', '', label, el('span', 'num', formatTokens(row.tokens)));
  });
  return el(
    'div',
    'usage-spend-group',
    el('h3', 'section-title', t('usage.spend.byPlan')),
    items.length > 0 ? el('ul', 'usage-plans', ...items) : el('p', 'muted hint', t('usage.spend.empty')),
  );
}

function headCell(label: string, numeric: boolean): HTMLElement {
  return el('th', numeric ? 'num' : '', label);
}

function tableRow(name: string, row: Pick<TokenRow, 'tokens' | 'agents'>): HTMLElement {
  const cell = (value: string): HTMLElement => el('td', 'num', value);
  const label = el('td', 'usage-spend-name', name);
  label.title = name;
  return el(
    'tr',
    '',
    label,
    cell(String(row.agents)),
    cell(String(row.tokens.turns)),
    cell(formatTokens(row.tokens.cacheRead)),
    cell(formatTokens(tokenWritten(row.tokens))),
    cell(formatTokens(row.tokens.output)),
  );
}

function spendTable(title: string, rows: readonly TokenRow[], nameOf: (key: string) => string): HTMLElement {
  const head = el(
    'tr',
    '',
    headCell(t('usage.spend.col.name'), false),
    headCell(t('usage.spend.col.agents'), true),
    headCell(t('usage.spend.col.turns'), true),
    headCell(t('usage.spend.col.read'), true),
    headCell(t('usage.spend.col.written'), true),
    headCell(t('usage.spend.col.output'), true),
  );
  const body = rows.map((row) => tableRow(nameOf(row.key), row));
  return el(
    'div',
    'usage-spend-group',
    el('h3', 'section-title', title),
    body.length > 0
      ? el('table', 'usage-spend-table', el('thead', '', head), el('tbody', '', ...body))
      : el('p', 'muted hint', t('usage.spend.empty')),
  );
}

export function mountUsageBlock(store: Store, api: OfficeApi, visible: () => boolean): HTMLElement {
  let range: UsageRange = 'today';
  let summary: UsageSummary | null = null;
  let failure: string | null = null;
  let loadedAt: number | null = null;
  let loading = false;
  let seq = 0;

  const title = el('h2', 'usage-spend-title');
  const buttons = RANGES.map(({ range: value }) => {
    const node = button('');
    node.addEventListener('click', () => {
      if (range === value) return;
      range = value;
      summary = null;
      render();
      void load();
    });
    return node;
  });
  const top = el('div', 'usage-spend-top');
  const tables = el('div', 'usage-spend-tables');
  const card = mountUsageCard(store);
  const root = el(
    'section',
    'usage-spend',
    el('header', 'usage-spend-head', title, el('div', 'usage-range', ...buttons)),
    top,
    tables,
  );

  const roleName = (key: string): string =>
    key === '' ? t('usage.spend.noRole') : hubText({ key: `hub.role.${key}` } as unknown as HubText);
  const floorName = (slug: string): string => {
    const known = store.floorBySlug(slug);
    return known ? floorLabel(known) : slug;
  };

  function render(): void {
    title.textContent = t('usage.spend.title');
    title.title = t('usage.spend.hint');
    RANGES.forEach(({ range: value, label }, index) => {
      buttons[index].textContent = t(label);
      buttons[index].setAttribute('aria-pressed', String(value === range));
    });
    const total = summary
      ? el(
          'p',
          'usage-spend-total',
          el('span', 'usage-spend-total-label', t('usage.spend.total')),
          ' ',
          el('span', 'muted', `${plural('usage.spend.agents', summary.total.agents)} · ${tokenParts(summary.total.tokens)}`),
        )
      : el('p', 'muted usage-spend-total', failure ?? t('usage.spend.loading'));
    top.replaceChildren(total, card.root);
    if (!summary) {
      tables.replaceChildren();
      return;
    }
    tables.replaceChildren(
      ...(range === 'week' ? [dayChart(summary.byDay, store.now())] : []),
      spendTable(t('usage.spend.byRole'), summary.byRole, roleName),
      spendTable(t('usage.spend.byModel'), summary.byModel, (key) => key || '—'),
      spendTable(t('usage.spend.byFloor'), summary.byFloor, floorName),
      planList(summary.byPlan),
    );
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    const asked = range;
    loading = true;
    const result = await api.usageSummary(asked);
    if (mine !== seq) return;
    loading = false;
    loadedAt = store.now();
    if (result.ok) {
      summary = result.data;
      failure = null;
    } else {
      summary = null;
      failure = t('usage.spend.error', { error: result.message });
    }
    render();
  }

  store.watch(['lang', 'floors'], render);
  store.watch(['tick'], () => {
    if (spendDue(store.now(), loadedAt, visible(), loading)) void load();
  });
  return root;
}
