import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import { hubText } from '../i18n/hub';
import { agentName, floorLabel, roleLabel } from '../labels';
import { memoryKey, type Store } from '../store';
import { relativeTime } from '../time';
import type { FloorKind, FloorView, LessonView, MemoryView, ReportView, RoleId, RoleKind } from '../types';
import { panelSection } from './section';

const MEMORY_KINDS: ReadonlySet<FloorKind> = new Set<FloorKind>(['managed', 'direccion', 'redaccion', 'mantenimiento']);
const REPORT_LIMIT = 50;
const LESSON_MAX_CHARS = 500;

function dateFormat(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(currentLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

type Target = { floor: string; role: RoleId };

function reportItem(report: ReportView, format: Intl.DateTimeFormat): HTMLElement {
  return el(
    'li',
    'history-item',
    el(
      'div',
      'history-head',
      el('span', 'history-date muted', format.format(report.endedAt ?? report.startedAt)),
      el('span', 'history-name', report.name || report.role || report.agentKey.slice(0, 8)),
    ),
    el('p', 'history-summary', (report.summaryText ? hubText(report.summaryText) : report.summary) || t('memory.noSummary')),
  );
}

export function mountMemory(host: HTMLElement, store: Store, api: OfficeApi | null): void {
  host.replaceChildren();
  host.hidden = true;
  if (api === null) return;

  const client = api;
  const count = el('span', 'chip');
  const scope = el('p', 'memory-scope muted');
  const lessonsHost = el('div', 'memory-lessons');
  const text = el('textarea', 'memory-text');
  text.rows = 2;
  text.maxLength = LESSON_MAX_CHARS;
  const add = button('', 'primary');
  const status = el('p', 'memory-status');
  const reportsHost = el('div', 'memory-reports');
  const form = el('div', 'memory-add', text, el('div', 'memory-add-actions', add, status));
  const section = panelSection({ id: 'memory', title: () => t('memory.title'), host });
  section.body.append(scope, lessonsHost, form, reportsHost);

  let target: Target | null = null;
  let scopeText: { role: RoleKind; floor: FloorView } | null = null;
  let data: MemoryView | null = null;
  let failure: string | null = null;
  let seenVersion = 0;
  let ticket = 0;
  let busy = false;
  let editing: number | null = null;
  let editDraft = '';
  let editError = '';

  const versionOf = (current: Target): number => store.memoryVersion.get(memoryKey(current.floor, current.role)) ?? 0;

  const refreshForm = (): void => {
    text.disabled = busy;
    add.disabled = busy || target === null || text.value.trim() === '';
    add.textContent = busy ? t('memory.adding') : t('memory.add');
  };

  const lessonItem = (lesson: LessonView, now: number): HTMLElement => {
    const remove = button('✕', 'lesson-delete', t('memory.delete'));
    remove.addEventListener('click', () => void removeLesson(lesson, remove));
    const edit = button(t('memory.edit'), 'lesson-edit', t('memory.edit'));
    edit.addEventListener('click', () => startEdit(lesson));
    const originText = lesson.origin === 'user' ? t('memory.origin.user') : t('memory.origin.agent');
    const origin = el('span', `chip lesson-origin lesson-origin-${lesson.origin}`, originText);
    const author = lesson.agentKey === null ? undefined : store.agents.get(lesson.agentKey);
    if (author) origin.title = t('memory.sentBy', { name: agentName(author) });
    return el(
      'li',
      'lesson',
      el('div', 'lesson-head', origin, el('time', 'muted', relativeTime(lesson.createdAt, now)), edit, remove),
      editing === lesson.id ? editForm(lesson) : el('p', 'lesson-text', lesson.text),
    );
  };

  const editForm = (lesson: LessonView): HTMLElement => {
    const area = el('textarea', 'memory-text');
    area.rows = 3;
    area.maxLength = LESSON_MAX_CHARS;
    area.value = editDraft;
    area.setAttribute('aria-label', t('memory.editText'));
    const save = button(t('memory.save'), 'primary');
    const cancel = button(t('memory.cancel'));
    const error = el('p', 'memory-status', editError);
    const refresh = (): void => {
      save.disabled = busy || area.value.trim() === '';
    };
    area.addEventListener('input', () => {
      editDraft = area.value;
      refresh();
    });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!save.disabled) void saveEdit(lesson, area, save, error);
      } else if (event.key === 'Escape') {
        stopEdit();
      }
    });
    save.addEventListener('click', () => void saveEdit(lesson, area, save, error));
    cancel.addEventListener('click', stopEdit);
    refresh();
    queueMicrotask(() => area.focus());
    return el('div', 'memory-add', area, el('div', 'memory-add-actions', save, cancel, error));
  };

  const startEdit = (lesson: LessonView): void => {
    editing = lesson.id;
    editDraft = lesson.text;
    editError = '';
    renderLists();
  };

  const stopEdit = (): void => {
    editing = null;
    editError = '';
    renderLists();
  };

  const saveEdit = async (lesson: LessonView, area: HTMLTextAreaElement, save: HTMLButtonElement, error: HTMLElement): Promise<void> => {
    const value = area.value.trim();
    if (busy || value === '') return;
    busy = true;
    save.disabled = true;
    save.textContent = t('memory.saving');
    error.textContent = '';
    const result = await client.editLesson(lesson.id, value);
    busy = false;
    if (result.ok) {
      const updated = result.data.lesson;
      if (data) data = { ...data, lessons: data.lessons.map((item) => (item.id === updated.id ? updated : item)) };
      stopEdit();
    } else {
      editError = result.message;
      save.disabled = false;
      save.textContent = t('memory.save');
      error.textContent = result.message;
    }
    refreshForm();
  };

  const renderLists = (): void => {
    const current = data;
    if (current === null) {
      section.setMeta(null);
      lessonsHost.replaceChildren(
        failure === null ? el('p', 'muted hint', t('memory.loading')) : el('p', 'memory-error hint', failure),
      );
      reportsHost.replaceChildren();
      return;
    }

    const now = store.now();
    const lessons = [...current.lessons].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    count.textContent = String(lessons.length);
    section.setMeta(count);
    const stale = failure === null ? [] : [el('p', 'memory-error hint', t('panel.updateFailed', { error: failure }))];
    lessonsHost.replaceChildren(
      lessons.length > 0
        ? el('ul', 'lesson-list', ...lessons.map((lesson) => lessonItem(lesson, now)))
        : el('p', 'muted hint', t('memory.noLessons')),
      ...stale,
    );

    const reports = [...current.reports].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    const shown = reports.slice(0, REPORT_LIMIT);
    const hidden = reports.length - shown.length;
    const format = dateFormat();
    reportsHost.replaceChildren(
      el('h4', 'report-title', t('memory.reports')),
      shown.length > 0
        ? el(
            'ul',
            'history-list',
            ...shown.map((report) => reportItem(report, format)),
            hidden > 0 ? el('li', 'muted', t('panel.more', { n: hidden })) : null,
          )
        : el('p', 'muted hint', t('memory.noReports')),
    );
  };

  const removeLesson = async (lesson: LessonView, control: HTMLButtonElement): Promise<void> => {
    if (busy || !window.confirm(t('memory.confirmDelete', { text: lesson.text }))) return;
    busy = true;
    control.disabled = true;
    status.textContent = '';
    refreshForm();
    const result = await client.deleteLesson(lesson.id);
    busy = false;
    control.disabled = false;
    if (result.ok) {
      if (data) data = { ...data, lessons: data.lessons.filter((item) => item.id !== lesson.id) };
      renderLists();
    } else {
      status.textContent = result.message;
    }
    refreshForm();
  };

  const submit = async (): Promise<void> => {
    const current = target;
    const lesson = text.value.trim();
    if (current === null || lesson === '' || busy) return;
    busy = true;
    status.textContent = '';
    refreshForm();
    const result = await client.addLesson({ floor: current.floor, role: current.role, text: lesson });
    busy = false;
    if (result.ok) {
      const created = result.data.lesson;
      text.value = '';
      if (data && target === current && !data.lessons.some((item) => item.id === created.id)) {
        data = { ...data, lessons: [...data.lessons, created] };
        renderLists();
      }
    } else {
      status.textContent = result.message;
    }
    refreshForm();
  };

  const load = async (): Promise<void> => {
    const current = target;
    if (current === null) return;
    const mine = ++ticket;
    seenVersion = versionOf(current);
    const result = await client.memory(current.floor, current.role);
    if (mine !== ticket || target !== current) return;
    if (result.ok) {
      data = result.data;
      failure = null;
    } else {
      failure = result.message;
    }
    renderLists();
  };

  const sync = (): void => {
    const key = store.selectedKey;
    const agent = key === null ? undefined : store.agents.get(key);
    const floor = agent ? store.floorBySlug(agent.floor) : undefined;
    if (!agent || agent.roleId === null || agent.roleKind === 'planReviewer' || !floor || !MEMORY_KINDS.has(floor.kind)) {
      ticket += 1;
      target = null;
      data = null;
      failure = null;
      host.hidden = true;
      return;
    }

    scopeText = { role: agent.roleKind, floor };
    relabelScope();
    host.hidden = false;
    if (target !== null && target.floor === agent.floor && target.role === agent.roleId) return;

    target = { floor: agent.floor, role: agent.roleId };
    data = null;
    failure = null;
    text.value = '';
    status.textContent = '';
    editing = null;
    editError = '';
    refreshForm();
    renderLists();
    void load();
  };

  const relabelScope = (): void => {
    if (scopeText === null) return;
    const label = t('memory.scope', { role: roleLabel(scopeText.role), floor: floorLabel(scopeText.floor) });
    if (scope.textContent !== label) scope.textContent = label;
  };

  const relabel = (): void => {
    section.setTitle();
    text.placeholder = t('memory.placeholder', { max: LESSON_MAX_CHARS });
    text.setAttribute('aria-label', t('memory.newLesson'));
    relabelScope();
    refreshForm();
    renderLists();
  };

  text.addEventListener('input', refreshForm);
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  });
  add.addEventListener('click', () => void submit());

  store.watch(['lang'], relabel);
  store.watch(['selection', 'agents', 'floors'], sync);

  store.watch(['memory'], () => {
    if (target !== null && versionOf(target) !== seenVersion) void load();
  });

  store.watch(['connection'], () => {
    if (store.connection === 'online' && target !== null) void load();
  });
}
