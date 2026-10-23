import type { Actions } from '../actions';
import { button, el } from '../dom';
import { fileStamp, saveFile } from '../download';
import { t } from '../i18n';
import { agentName, floorLabel } from '../labels';
import { readJson, writeJson } from '../prefs';
import type { Store } from '../store';
import type { SessionView } from '../types';
import { BRIEF_DRAFT_KEY, BRIEF_LIMIT, composeBrief, EMPTY_BRIEF, mayReplaceDraft, parseBriefDraft, type BriefFields } from './brief-compose';
import {
  BRIEF_TEMPLATES_KEY,
  fillPlaceholders,
  mergeImported,
  parseTemplates,
  removeTemplate,
  TEMPLATE_NAME_MAX,
  upsertTemplate,
  validTemplateName,
  type BriefTemplate,
} from './brief-templates';
import { orderable, orderableSessions } from './orderable';
import { openSection, panelSection } from './section';

let focusText: (() => void) | null = null;

// Opens the orders section and puts the cursor in its text.
export function focusOrders(): void {
  openSection('orders');
  focusText?.();
}

const DIRECTOR_ROLES: ReadonlySet<string> = new Set(['office-director', 'office:director']);

function sessionLabel(store: Store, session: SessionView): string {
  const name = session.name || session.role || session.agentKey.slice(0, 8);
  const known = store.floorBySlug(session.floor);
  const floor = known ? floorLabel(known) : session.floor;
  return `${name} · ${floor}`;
}

function defaultSession(sessions: readonly SessionView[]): SessionView | undefined {
  return sessions.find((session) => session.role !== null && DIRECTOR_ROLES.has(session.role)) ?? sessions[0];
}

function mountComposer(insert: (text: string) => void, currentFloor: () => string | null): { node: HTMLElement; relabel: () => void } {
  const stored = parseBriefDraft(readJson(BRIEF_DRAFT_KEY));
  const fields: BriefFields = { ...stored };
  const toggle = button('');
  const labels = {
    title: el('span', 'field-label muted'),
    what: el('span', 'field-label muted'),
    criteria: el('span', 'field-label muted'),
    outOfScope: el('span', 'field-label muted'),
  };
  const inputs = {
    title: el('input', 'orders-brief-input'),
    what: el('textarea', 'orders-brief-input'),
    criteria: el('textarea', 'orders-brief-input'),
    outOfScope: el('textarea', 'orders-brief-input'),
  };
  inputs.what.rows = 2;
  inputs.criteria.rows = 2;
  inputs.outOfScope.rows = 2;
  const previewLabel = el('span', 'field-label muted');
  const preview = el('pre', 'orders-brief-preview');
  const count = el('span', 'orders-status');
  const insertButton = button('', 'primary');
  const templateSelect = el('select', 'orders-select');
  const saveTemplate = button('');
  const deleteTemplate = button('');
  const exportTemplates = button('');
  const importTemplates = button('');
  const importInput = el('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.hidden = true;
  const templateStatus = el('span', 'orders-status');
  const form = el('div', 'orders-brief');
  form.hidden = true;
  const keys = ['title', 'what', 'criteria', 'outOfScope'] as const;
  form.append(
    el('div', 'orders-actions', templateSelect, saveTemplate, deleteTemplate),
    el('div', 'orders-actions', exportTemplates, importTemplates, importInput, templateStatus),
    ...keys.map((key) => el('label', 'field', labels[key], inputs[key])),
    el('div', 'field', previewLabel, preview),
    el('div', 'orders-actions', insertButton, count),
  );
  for (const key of keys) inputs[key].value = fields[key];

  const saveDraft = (): void => {
    try {
      if (keys.every((key) => fields[key] === '')) localStorage.removeItem(BRIEF_DRAFT_KEY);
      else localStorage.setItem(BRIEF_DRAFT_KEY, JSON.stringify(fields));
    } catch {
      // Blocked storage: the draft lasts for this session only.
    }
  };

  let templates: BriefTemplate[] = parseTemplates(readJson(BRIEF_TEMPLATES_KEY));

  const hasText = (): boolean => keys.some((key) => fields[key].trim() !== '');

  const renderTemplates = (selected = ''): void => {
    const placeholder = el('option', '', t('orders.template.placeholder'));
    placeholder.value = '';
    templateSelect.replaceChildren(
      placeholder,
      ...templates.map((template) => {
        const option = el('option', '', template.name);
        option.value = template.name;
        return option;
      }),
    );
    templateSelect.value = templates.some((template) => template.name === selected) ? selected : '';
    deleteTemplate.disabled = templateSelect.value === '';
    exportTemplates.disabled = templates.length === 0;
  };

  const storeTemplates = (next: BriefTemplate[], selected = ''): void => {
    templates = next;
    writeJson(BRIEF_TEMPLATES_KEY, templates);
    renderTemplates(selected);
  };

  const setFields = (next: BriefFields): void => {
    for (const key of keys) {
      fields[key] = next[key];
      inputs[key].value = next[key];
    }
    saveDraft();
    update();
  };

  const update = (): void => {
    const brief = composeBrief(fields);
    preview.textContent = brief.text;
    count.textContent = t('orders.brief.count', { n: brief.length, max: BRIEF_LIMIT });
    count.classList.toggle('error', brief.over);
    insertButton.disabled = !brief.valid;
  };

  for (const key of keys) {
    inputs[key].addEventListener('input', () => {
      fields[key] = inputs[key].value;
      saveDraft();
      update();
    });
  }
  templateSelect.addEventListener('change', () => {
    const template = templates.find((item) => item.name === templateSelect.value);
    deleteTemplate.disabled = template === undefined;
    templateStatus.textContent = '';
    if (!template) return;
    if (hasText() && !window.confirm(t('orders.template.replace'))) {
      templateSelect.value = '';
      deleteTemplate.disabled = true;
      return;
    }
    setFields(template.fields);
  });
  saveTemplate.addEventListener('click', () => {
    const name = (window.prompt(t('orders.template.name', { max: TEMPLATE_NAME_MAX }), templateSelect.value) ?? '').trim();
    if (name === '') return;
    if (!validTemplateName(name)) {
      templateStatus.textContent = t('orders.template.nameInvalid', { max: TEMPLATE_NAME_MAX });
      return;
    }
    if (templates.some((item) => item.name === name) && !window.confirm(t('orders.template.overwrite', { name }))) return;
    storeTemplates(upsertTemplate(templates, { name, fields }, Date.now()), name);
    templateStatus.textContent = t('orders.template.saved', { name });
  });
  deleteTemplate.addEventListener('click', () => {
    const name = templateSelect.value;
    if (name === '' || !window.confirm(t('orders.template.delete', { name }))) return;
    storeTemplates(removeTemplate(templates, name));
    templateStatus.textContent = '';
  });
  exportTemplates.addEventListener('click', () => {
    saveFile(`agent-office-templates-${fileStamp(new Date())}.json`, JSON.stringify(templates, null, 2), 'application/json');
  });
  importTemplates.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    void file
      .text()
      .then((text) => {
        const raw: unknown = JSON.parse(text);
        const imported = parseTemplates(raw);
        if (imported.length === 0 || (Array.isArray(raw) && imported.length < raw.length && !window.confirm(t('orders.template.importPartial', { n: imported.length })))) {
          if (imported.length === 0) templateStatus.textContent = t('orders.template.importInvalid');
          return;
        }
        const merged = mergeImported(templates, imported);
        if (merged.conflicts.length > 0 && !window.confirm(t('orders.template.importOverwrite', { names: merged.conflicts.join(', ') }))) return;
        storeTemplates(merged.list);
        templateStatus.textContent = t('orders.template.imported', { n: imported.length });
      })
      .catch(() => {
        templateStatus.textContent = t('orders.template.importInvalid');
      });
  });
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
  });
  insertButton.addEventListener('click', () => {
    const brief = composeBrief(fillPlaceholders(fields, { floor: currentFloor(), now: new Date() }));
    if (!brief.valid) return;
    insert(brief.text);
    for (const key of keys) {
      fields[key] = EMPTY_BRIEF[key];
      inputs[key].value = '';
    }
    saveDraft();
    form.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    update();
  });

  const relabel = (): void => {
    toggle.textContent = t('orders.brief.toggle');
    labels.title.textContent = t('orders.brief.title');
    labels.what.textContent = t('orders.brief.what');
    labels.criteria.textContent = t('orders.brief.criteria');
    labels.outOfScope.textContent = t('orders.brief.outOfScope');
    previewLabel.textContent = t('orders.brief.preview');
    insertButton.textContent = t('orders.brief.insert');
    saveTemplate.textContent = t('orders.template.save');
    deleteTemplate.textContent = t('orders.template.remove');
    exportTemplates.textContent = t('orders.template.export');
    importTemplates.textContent = t('orders.template.import');
    renderTemplates(templateSelect.value);
    update();
  };
  toggle.setAttribute('aria-expanded', 'false');
  relabel();
  return { node: el('div', 'orders-composer', toggle, form), relabel };
}

export function mountOrders(host: HTMLElement, store: Store, actions: Actions): void {
  const select = el('select', 'orders-select');
  const textarea = el('textarea', 'orders-text');
  textarea.rows = 3;
  const send = button('', 'primary');
  const status = el('p', 'orders-status');
  const targetLabel = el('span', 'field-label muted');

  const section = panelSection({ id: 'orders', title: () => t('orders.title'), host });
  const composer = mountComposer(
    (text) => {
    if (!mayReplaceDraft(textarea.value, () => window.confirm(t('orders.brief.replace')))) return;
    textarea.value = text;
    textarea.focus();
    refresh();
    },
    () => {
      const session = store.sessions.get(select.value);
      const known = session ? store.floorBySlug(session.floor) : undefined;
      return known ? floorLabel(known) : null;
    },
  );
  section.body.append(el('label', 'field', targetLabel, select), textarea, el('div', 'orders-actions', send, status), composer.node);

  focusText = () => textarea.focus();

  let busy = false;
  let manualChoice = false;
  let preselect: string | null = null;
  let assistKey: string | null = null;
  let prefillText: string | null = null;
  let signature: string | null = null;
  let sent = false;

  const eligible = (): SessionView[] => orderableSessions(store.sessions.values());

  const refresh = (): void => {
    const enabled = actions.ordersEnabled;
    textarea.disabled = !enabled || busy;
    select.disabled = !enabled || busy || select.options.length === 0;
    send.disabled = !enabled || busy || textarea.value.trim() === '' || select.value === '';
    send.textContent = busy ? t('panel.sending') : t('orders.send');
    section.setMeta(select.selectedOptions[0]?.textContent ?? null);
  };

  const syncSessions = (): void => {
    const sessions = eligible();
    const previous = select.value;
    const next = sessions.map((session) => `${session.sessionId}|${sessionLabel(store, session)}`).join('\n');
    if (next !== signature) {
      signature = next;
      select.replaceChildren(
        ...sessions.map((session) => {
          const option = el('option', '', sessionLabel(store, session));
          option.value = session.sessionId;
          return option;
        }),
      );
    }
    const ids = new Set(sessions.map((session) => session.sessionId));
    let desired = defaultSession(sessions)?.sessionId ?? '';
    if (manualChoice && ids.has(previous)) desired = previous;
    else if (preselect !== null && ids.has(preselect)) desired = preselect;
    select.value = desired;
  };

  const endAssist = (): void => {
    if (prefillText !== null) {
      if (textarea.value === prefillText) textarea.value = '';
      else manualChoice = true;
    }
    prefillText = null;
    preselect = null;
    assistKey = null;
  };

  const syncBlockedAssist = (): void => {
    const agent = store.selectedKey === null ? undefined : store.agents.get(store.selectedKey);
    const blocked = agent !== undefined && store.shownState(agent) === 'blocked';
    section.setForced(blocked);
    if (!agent || !blocked) {
      if (assistKey !== null) endAssist();
      return;
    }
    if (assistKey === agent.key) return;
    if (assistKey !== null) endAssist();
    assistKey = agent.key;
    if (textarea.value.trim() !== '') return;
    const session = store.sessions.get(agent.sessionId);
    manualChoice = false;
    preselect = session && orderable(session) ? session.sessionId : null;
    prefillText = t('orders.blockReply', { name: agentName(agent) });
    textarea.value = prefillText;
  };

  const sync = (): void => {
    syncBlockedAssist();
    syncSessions();
    refresh();
  };

  const submit = async (): Promise<void> => {
    const text = textarea.value.trim();
    const sessionId = select.value;
    if (busy || !actions.ordersEnabled || text === '' || sessionId === '') return;
    busy = true;
    sent = false;
    status.textContent = '';
    status.classList.remove('error');
    refresh();
    const result = await actions.order({ sessionId, text });
    busy = false;
    if (result.ok) {
      textarea.value = '';
      prefillText = null;
      sent = true;
      status.textContent = t('toast.orderSent');
    } else {
      status.textContent = result.message;
      status.classList.add('error');
    }
    refresh();
  };

  select.addEventListener('change', () => {
    manualChoice = true;
    refresh();
  });
  textarea.addEventListener('input', refresh);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  });
  send.addEventListener('click', () => void submit());

  const relabel = (): void => {
    section.setTitle();
    targetLabel.textContent = t('orders.target');
    composer.relabel();
    textarea.placeholder = actions.ordersEnabled ? t('orders.placeholder') : t('orders.disabled');
    if (sent) status.textContent = t('toast.orderSent');
  };
  store.watch(['lang'], relabel);

  store.watch(['selection', 'agents', 'sessions', 'floors', 'mode', 'lang'], sync);
}
