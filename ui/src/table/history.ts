import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { t, type MessageKey } from '../i18n';
import { hubText } from '../i18n/hub';
import { agentName, floorLabel } from '../labels';
import type { Store } from '../store';
import { clockTime } from '../time';
import type { SearchHit, SearchKind } from '../types';
import { saveFile } from '../download';
import { readJson, writeJson } from '../prefs';
import { historyFilename, historyRows, historyToCsv, historyToJson } from './history-export';

export const VIEW_KEY = 'agent-office.table.view';
export const PAGE_SIZE = 40;
export const SEARCH_DELAY_MS = 250;

export type TableView = 'now' | 'history' | 'digest' | 'timeline';

export function readTableView(raw: unknown): TableView {
  return raw === 'history' || raw === 'digest' || raw === 'timeline' ? raw : 'now';
}

export const HISTORY_KINDS: readonly SearchKind[] = ['activity', 'message', 'chat', 'agent'];

const KIND_LABEL: Record<SearchKind, MessageKey> = {
  activity: 'history.kind.activity',
  message: 'history.kind.message',
  chat: 'history.kind.chat',
  agent: 'history.kind.agent',
};

export type HistoryFilters = { q: string; floor: string; agent: string; kind: '' | SearchKind; from: string; to: string };

export const EMPTY_FILTERS: HistoryFilters = { q: '', floor: '', agent: '', kind: '', from: '', to: '' };

export const SAVED_KEY = 'agent-office.savedSearches';
export const SAVED_MAX = 20;
export const SAVED_NAME_MAX = 60;

export type SavedSearch = { name: string; filters: HistoryFilters };

function savedFilters(raw: unknown): HistoryFilters | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const text = (key: keyof HistoryFilters): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const kind = text('kind');
  return {
    q: text('q'),
    floor: text('floor'),
    agent: text('agent'),
    kind: HISTORY_KINDS.find((item) => item === kind) ?? '',
    from: dayBound(text('from'), false) === null ? '' : text('from'),
    to: dayBound(text('to'), true) === null ? '' : text('to'),
  };
}

// Pure: the saved searches in a stored value, dropping what is not one, repeating a name or going past the limit.
export function parseSaved(raw: unknown): SavedSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedSearch[] = [];
  for (const item of raw) {
    if (out.length >= SAVED_MAX) break;
    if (typeof item !== 'object' || item === null) continue;
    const { name, filters } = item as { name?: unknown; filters?: unknown };
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    const parsed = savedFilters(filters);
    if (trimmed === '' || trimmed.length > SAVED_NAME_MAX || parsed === null || out.some((saved) => saved.name === trimmed)) continue;
    out.push({ name: trimmed, filters: parsed });
  }
  return out;
}

// Pure: the list with a search saved under its name, replacing the one with that name; a new name when the list is full leaves it as it was.
export function upsertSaved(list: readonly SavedSearch[], name: string, filters: HistoryFilters): SavedSearch[] {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > SAVED_NAME_MAX) return [...list];
  const entry: SavedSearch = { name: trimmed, filters: { ...filters } };
  if (list.some((saved) => saved.name === trimmed)) return list.map((saved) => (saved.name === trimmed ? entry : saved));
  return list.length >= SAVED_MAX ? [...list] : [...list, entry];
}

// Pure: the filters a saved search puts on the form.
export function applySaved(filters: HistoryFilters, saved: SavedSearch): HistoryFilters {
  return { ...filters, ...saved.filters };
}

export function readSaved(): SavedSearch[] {
  return parseSaved(readJson(SAVED_KEY));
}

export function writeSaved(list: readonly SavedSearch[]): void {
  writeJson(SAVED_KEY, list);
}

// Pure: the first or the last millisecond of a YYYY-MM-DD day in local time, null when it is not a date.
export function dayBound(value: string, end: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = end ? new Date(year, month, day, 23, 59, 59, 999) : new Date(year, month, day, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) || date.getMonth() !== month ? null : date.getTime();
}

// Pure: the path of GET /api/search for some filters and the cursor of the page after the last one seen.
export function searchPath(filters: HistoryFilters, before: string | null, limit: number = PAGE_SIZE): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set('q', q);
  if (filters.floor) params.set('floor', filters.floor);
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.kind) params.set('kind', filters.kind);
  const from = dayBound(filters.from, false);
  const to = dayBound(filters.to, true);
  if (from !== null) params.set('from', String(from));
  if (to !== null) params.set('to', String(to));
  if (before) params.set('before', before);
  params.set('limit', String(limit));
  return `/api/search?${params.toString()}`;
}

export function hitKey(hit: Pick<SearchHit, 'kind' | 'id'>): string {
  return `${hit.kind}:${hit.id}`;
}

// Pure: the next page after the ones already shown, without repeating a hit the cursor let through twice.
export function mergeHits(shown: readonly SearchHit[], page: readonly SearchHit[]): SearchHit[] {
  const seen = new Set(shown.map(hitKey));
  const out = [...shown];
  for (const hit of page) {
    if (seen.has(hitKey(hit))) continue;
    seen.add(hitKey(hit));
    out.push(hit);
  }
  return out;
}

// Pure: where the replay button of a hit goes. The page keeps the 3D view of the one that opens it.
export function replayHref(sessionId: string, current: { pathname: string; search: string }): string {
  const params = new URLSearchParams();
  params.set('replay', `/api/replay/${encodeURIComponent(sessionId)}`);
  params.set('compress', '1');
  if (new URLSearchParams(current.search).get('view') === '3d') params.set('view', '3d');
  return `${current.pathname}?${params.toString()}`;
}

// Pure: lower case without accents, the way the hub's index sees a text.
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Pure: whether every word of the query starts a word of the text (the client-side twin of the hub's prefix match).
export function matchesQuery(text: string, query: string): boolean {
  const words = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return true;
  const have = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.every((word) => have.some((candidate) => candidate.startsWith(word)));
}

function dateTime(ts: number): string {
  const date = new Date(ts);
  const day = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `${day} ${clockTime(ts)}`;
}

// activate: the view just came up; with focus, the query box takes the keyboard.
export type HistoryHandle = { activate(focus: boolean): void; apply(saved: SavedSearch): void };

export type HistoryHooks = { openReplay(sessionId: string): void };

export function mountHistory(host: HTMLElement, store: Store, api: OfficeApi, hooks: HistoryHooks): HistoryHandle {
  let filters: HistoryFilters = { ...EMPTY_FILTERS };
  let hits: SearchHit[] = [];
  let next: string | null = null;
  let indexed = true;
  let loading = false;
  let failure: string | null = null;
  let generation = 0;
  let timer: number | undefined;
  let loadedOnce = false;

  const query = el('input');
  query.type = 'text';
  query.autocomplete = 'off';
  query.className = 'history-query';
  const floorSelect = el('select', 'history-select');
  const agentSelect = el('select', 'history-select');
  const kindSelect = el('select', 'history-select');
  const fromInput = el('input', 'history-date');
  fromInput.type = 'date';
  const toInput = el('input', 'history-date');
  toInput.type = 'date';
  const labels = {
    floor: el('label', 'history-field'),
    agent: el('label', 'history-field'),
    kind: el('label', 'history-field'),
    from: el('label', 'history-field'),
    to: el('label', 'history-field'),
  };
  const filterBar = el('div', 'history-filters');
  const exportCsv = button('CSV', 'history-export');
  const exportJson = button('JSON', 'history-export');
  const saveSearch = button('', 'history-save');
  const savedRow = el('div', 'history-saved');
  const status = el('p', 'muted history-status');
  const list = el('ul', 'history-list');
  const more = button('', 'history-more');
  const sentinel = el('div', 'history-sentinel', more);
  host.replaceChildren(query, filterBar, savedRow, status, list, sentinel);

  const option = (value: string, label: string): HTMLOptionElement => {
    const node = el('option', '', label);
    node.value = value;
    return node;
  };

  const paintAgents = (): void => {
    const agents = [...store.agents.values()].sort((a, b) => agentName(a).localeCompare(agentName(b)));
    agentSelect.replaceChildren(option('', t('history.filter.agent.all')), ...agents.map((agent) => option(agent.key, agentName(agent))));
    agentSelect.value = filters.agent;
  };

  const paintFilters = (): void => {
    query.value = filters.q;
    query.placeholder = t('history.query.placeholder');
    query.setAttribute('aria-label', t('history.query.label'));
    floorSelect.replaceChildren(option('', t('history.filter.floor.all')), ...store.floorList().map((floor) => option(floor.slug, floorLabel(floor))));
    floorSelect.value = filters.floor;
    paintAgents();
    kindSelect.replaceChildren(option('', t('history.kind.all')), ...HISTORY_KINDS.map((kind) => option(kind, t(KIND_LABEL[kind]))));
    kindSelect.value = filters.kind;
    fromInput.value = filters.from;
    toInput.value = filters.to;
    labels.floor.replaceChildren(el('span', 'muted', t('history.filter.floor')), floorSelect);
    labels.agent.replaceChildren(el('span', 'muted', t('history.filter.agent')), agentSelect);
    labels.kind.replaceChildren(el('span', 'muted', t('history.filter.kind')), kindSelect);
    labels.from.replaceChildren(el('span', 'muted', t('history.filter.from')), fromInput);
    labels.to.replaceChildren(el('span', 'muted', t('history.filter.to')), toInput);
    saveSearch.textContent = t('history.saved.save');
    saveSearch.title = t('history.saved.save.hint');
    filterBar.replaceChildren(labels.floor, labels.agent, labels.kind, labels.from, labels.to, exportCsv, exportJson, saveSearch);
  };

  const hitRow = (hit: SearchHit): HTMLElement => {
    const known = hit.agent ? store.agents.get(hit.agent) : undefined;
    const who = known ? agentName(known) : (hit.agent ?? '');
    const head = el(
      'div',
      'history-head',
      el('time', 'muted', dateTime(hit.ts)),
      el('span', `chip history-kind history-kind-${hit.kind}`, t(KIND_LABEL[hit.kind])),
      hit.floor ? el('span', 'muted', hit.floor) : null,
      who ? el('span', 'history-agent', who) : null,
    );
    const row = el('li', 'history-hit', head, el('p', 'history-text', hubText(hit.text)));
    if (hit.sessionId) {
      const replay = button(t('history.replay'), 'history-replay', t('history.replay.hint'));
      replay.addEventListener('click', (event) => {
        event.stopPropagation();
        hooks.openReplay(hit.sessionId as string);
      });
      head.append(replay);
    }
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const pick = (): void => {
      if (hit.agent && store.agents.has(hit.agent)) store.select(hit.agent);
      else store.toast(t('history.agentGone'), 'info');
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      pick();
    });
    return row;
  };

  const paintList = (): void => {
    list.replaceChildren(...hits.map(hitRow));
    more.textContent = t('history.more');
    sentinel.hidden = next === null;
    more.disabled = loading;
    const hint = t(next === null ? 'history.export.hint' : 'history.export.partial', { n: hits.length });
    for (const control of [exportCsv, exportJson]) {
      control.disabled = hits.length === 0;
      control.title = hint;
    }
    if (failure !== null) status.textContent = t('history.failed', { error: failure });
    else if (loading && hits.length === 0) status.textContent = t('history.loading');
    else if (hits.length === 0 && loadedOnce) status.textContent = t('history.empty');
    else status.textContent = !indexed && filters.q.trim() ? t('history.noIndex') : '';
    status.hidden = status.textContent === '';
  };

  const load = async (append: boolean): Promise<void> => {
    if (loading && append) return;
    const mine = ++generation;
    loading = true;
    failure = null;
    if (!append) {
      hits = [];
      next = null;
    }
    paintList();
    const result = await api.search(searchPath(filters, append ? next : null));
    if (mine !== generation) return;
    loading = false;
    loadedOnce = true;
    if (result.ok) {
      hits = append ? mergeHits(hits, result.data.hits) : result.data.hits;
      next = result.data.next;
      indexed = result.data.indexed;
    } else {
      failure = result.message;
      next = null;
    }
    paintList();
  };

  const refilter = (delay: number): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(false), delay);
  };

  let saved = readSaved();

  const apply = (search: SavedSearch): void => {
    filters = applySaved(filters, search);
    paintFilters();
    refilter(0);
  };

  const paintSaved = (): void => {
    savedRow.hidden = saved.length === 0;
    savedRow.replaceChildren(
      ...saved.map((search) => {
        const open = button(search.name, 'history-saved-open', t('history.saved.apply', { name: search.name }));
        open.addEventListener('click', () => apply(search));
        const remove = button('×', 'history-saved-remove', t('history.saved.delete', { name: search.name }));
        remove.setAttribute('aria-label', t('history.saved.delete', { name: search.name }));
        remove.addEventListener('click', () => {
          if (!window.confirm(t('history.saved.deleteAsk', { name: search.name }))) return;
          saved = saved.filter((item) => item.name !== search.name);
          writeSaved(saved);
          paintSaved();
        });
        return el('span', 'chip history-saved-chip', open, remove);
      }),
    );
  };

  saveSearch.addEventListener('click', () => {
    saved = readSaved();
    const typed = window.prompt(t('history.saved.name', { max: SAVED_NAME_MAX }), filters.q.trim().slice(0, SAVED_NAME_MAX));
    const name = typed?.trim() ?? '';
    if (name === '') return;
    if (name.length > SAVED_NAME_MAX) {
      store.toast(t('history.saved.tooLong', { max: SAVED_NAME_MAX }), 'error');
      return;
    }
    const next = upsertSaved(saved, name, filters);
    if (!next.some((item) => item.name === name)) {
      store.toast(t('history.saved.full', { max: SAVED_MAX }), 'error');
      return;
    }
    saved = next;
    writeSaved(saved);
    paintSaved();
    store.toast(t('history.saved.done', { name }), 'ok');
  });

  query.addEventListener('input', () => {
    filters = { ...filters, q: query.value };
    refilter(SEARCH_DELAY_MS);
  });
  floorSelect.addEventListener('change', () => {
    filters = { ...filters, floor: floorSelect.value };
    refilter(0);
  });
  agentSelect.addEventListener('change', () => {
    filters = { ...filters, agent: agentSelect.value };
    refilter(0);
  });
  kindSelect.addEventListener('change', () => {
    filters = { ...filters, kind: kindSelect.value as HistoryFilters['kind'] };
    refilter(0);
  });
  fromInput.addEventListener('change', () => {
    filters = { ...filters, from: fromInput.value };
    refilter(0);
  });
  toInput.addEventListener('change', () => {
    filters = { ...filters, to: toInput.value };
    refilter(0);
  });
  const exportHits = (ext: 'csv' | 'json'): void => {
    const rows = historyRows(hits, (key) => {
      const agent = store.agents.get(key);
      return agent && { name: agentName(agent), role: agent.role ?? '' };
    });
    const csv = ext === 'csv';
    saveFile(historyFilename(ext, new Date()), csv ? historyToCsv(rows) : historyToJson(rows), csv ? 'text/csv' : 'application/json');
  };
  exportCsv.addEventListener('click', () => exportHits('csv'));
  exportJson.addEventListener('click', () => exportHits('json'));
  more.addEventListener('click', () => void load(true));
  agentSelect.addEventListener('mousedown', paintAgents);

  // Infinite scroll: the sentinel under the list asks for the next page when it comes into view.
  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && next !== null && !loading) void load(true);
    });
    observer.observe(sentinel);
  }

  paintFilters();
  paintSaved();
  paintList();
  store.watch(['lang', 'floors'], () => {
    paintFilters();
    paintSaved();
    paintList();
  });

  return {
    activate(focus: boolean): void {
      if (!loadedOnce && !loading) void load(false);
      paintAgents();
      if (!focus) return;
      query.focus();
      query.select();
    },
    apply(search: SavedSearch): void {
      saved = readSaved();
      paintSaved();
      apply(search);
    },
  };
}
