import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { t, type MessageKey, type Params } from '../i18n';
import { hubText } from '../i18n/hub';
import { floorKindLabel, stackLabel } from '../labels';
import type { Store } from '../store';
import type { DocumentStatus, HubText, SettingsView } from '../types';
import { deliveryEditor, type DeliveryContext } from './floor-delivery';
import { deliverySwitch } from './floor-delivery-switch';
import type { FloorDeliveryDraft } from './floor-delivery-model';
import { deletedBranches, deletedBranchesContext, reloadOpen } from './deleted-branches';
import { mountDiagnosticsPanel } from './diagnostics';
import { mountWorktreesPanel } from './worktrees-panel';

type ProjectFloor = SettingsView['floors'][number];

type Outcome = { kind: 'ok' | 'error'; key: MessageKey; params?: Params } | { kind: 'ok'; hub: HubText } | { kind: 'error'; text: string };

const CLOSED: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['cerrado', 'descartado']);

function textInput(className: string): HTMLInputElement {
  const input = el('input', className);
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

export function mountProjects(host: HTMLElement, store: Store, api: OfficeApi | null): void {
  host.replaceChildren();
  host.hidden = api === null;
  if (api === null) return;

  const client = api;
  const title = el('h2', 'settings-title');
  const hint = el('p', 'settings-hint muted');
  const pathInput = textInput('project-path');
  const slugInput = textInput('project-slug');
  const add = button('', 'primary');
  const status = el('p', 'settings-status');
  const list = el('div', 'project-list');
  host.append(el('section', 'settings-section', title, hint, el('div', 'project-form', pathInput, slugInput, add), status, list));
  mountWorktreesPanel(host, store, client);
  mountDiagnosticsPanel(host, client);
  const delivery: DeliveryContext = { store, api: client, drafts: new Map<string, FloorDeliveryDraft>(), open: new Set<string>() };
  const branches = deletedBranchesContext(store, client);

  let busy = false;
  let deleting: string | null = null;
  let outcome: Outcome | null = null;

  const openPlans = (slug: string): string[] =>
    store.documents
      .filter((doc) => doc.kind === 'plan' && !CLOSED.has(doc.status) && doc.base.some((base) => base.floor === slug))
      .map((doc) => doc.title);

  const showStatus = (): void => {
    status.textContent = outcome === null ? '' : 'text' in outcome ? outcome.text : 'hub' in outcome ? hubText(outcome.hub) : t(outcome.key, outcome.params);
    status.className = outcome === null ? 'settings-status' : `settings-status ${outcome.kind}`;
  };

  const refreshForm = (): void => {
    pathInput.disabled = busy;
    slugInput.disabled = busy;
    add.disabled = busy || pathInput.value.trim() === '';
    add.textContent = busy && deleting === null ? t('settings.floors.adding') : t('settings.floors.add');
  };

  const row = (floor: ProjectFloor): HTMLElement => {
    const remove = button(deleting === floor.slug ? t('settings.floors.deleting') : t('settings.floors.delete'), 'project-delete');
    remove.setAttribute('aria-label', t('settings.floors.deleteLabel', { slug: floor.slug }));
    remove.disabled = busy;
    remove.addEventListener('click', () => void removeFloor(floor.slug));
    const header = el(
      'div',
      'setting-row',
      el(
        'span',
        'setting-text',
        el(
          'span',
          'setting-label',
          floor.slug,
          el('span', 'chip', stackLabel(floor.stack)),
          floor.managed ? null : el('span', 'chip', floorKindLabel('observed')),
        ),
        el('code', 'setting-path muted', floor.path),
      ),
      remove,
    );
    if (!floor.managed) return el('div', 'project-item', header);
    return el(
      'div',
      'project-item',
      header,
      deliverySwitch(floor, delivery),
      floor.delivery ? deliveryEditor(floor, delivery) : el('p', 'setting-hint muted delivery-off', t('settings.delivery.off')),
      deletedBranches(floor.slug, branches),
    );
  };

  const renderList = (): void => {
    const floors = store.settings?.floors ?? [];
    list.replaceChildren(...(floors.length > 0 ? floors.map(row) : [el('p', 'muted', t('settings.floors.empty'))]));
  };

  const relabel = (): void => {
    title.textContent = t('settings.floors.title');
    hint.textContent = t('settings.floors.hint');
    pathInput.placeholder = t('settings.floors.path');
    pathInput.setAttribute('aria-label', t('settings.floors.path'));
    slugInput.placeholder = t('settings.floors.slug');
    slugInput.setAttribute('aria-label', t('settings.floors.slug'));
    refreshForm();
    showStatus();
    renderList();
  };

  const run = async (action: () => Promise<Outcome>, slug: string | null): Promise<void> => {
    busy = true;
    deleting = slug;
    outcome = null;
    relabel();
    outcome = await action();
    busy = false;
    deleting = null;
    relabel();
  };

  const submit = async (): Promise<void> => {
    const path = pathInput.value.trim();
    if (busy || path === '') return;
    const slug = slugInput.value.trim();
    await run(async () => {
      const result = await client.addFloor(slug ? { path, slug } : { path });
      if (!result.ok) return { kind: 'error', text: result.message };
      pathInput.value = '';
      slugInput.value = '';
      return { kind: 'ok', hub: result.data.note };
    }, null);
  };

  const removeFloor = async (slug: string): Promise<void> => {
    if (busy) return;
    const plans = openPlans(slug);
    const message = [
      t('settings.floors.confirm', { slug }),
      plans.length > 0 ? t('settings.floors.openPlans', { plans: plans.join(', ') }) : null,
      t('settings.floors.typeSlug', { slug }),
    ]
      .filter((part) => part !== null)
      .join('\n\n');
    const typed = window.prompt(message);
    if (typed === null) return;
    if (typed.trim() !== slug) {
      outcome = { kind: 'error', key: 'settings.floors.mismatch' };
      showStatus();
      return;
    }
    await run(async () => {
      let result = await client.deleteFloor(slug);
      if (!result.ok && result.key === 'hub.floors.dirtyWorktrees' && window.confirm(t('settings.floors.forceAsk', { reason: result.message }))) {
        result = await client.deleteFloor(slug, true);
      }
      if (!result.ok) return { kind: 'error', text: result.message };
      return { kind: 'ok', key: 'settings.floors.removed', params: { slug } };
    }, slug);
  };

  pathInput.addEventListener('input', refreshForm);
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });
  slugInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });
  add.addEventListener('click', () => void submit());

  store.watch(['lang'], relabel);
  store.watch(['settings', 'documents'], renderList);
  let timer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe((topics) => {
    if (!topics.has('worktrees')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => reloadOpen(branches), 400);
  });
}
