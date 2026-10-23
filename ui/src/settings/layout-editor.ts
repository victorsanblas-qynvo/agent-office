import type { OfficeApi } from '../api';
import { saveFile } from '../download';
import { button, el } from '../dom';
import { t, type MessageKey } from '../i18n';
import { floorLabel, roleLabel } from '../labels';
import { DEFAULT_ROLE_MODELS, PACK_MODELS, ROLE_KINDS, emptyLayouts, withCharacter, withoutPlacement } from '../layouts';
import { DEPTH, HALF_D } from '../scene/constants';
import type { Store } from '../store';
import type { AgentView, LayoutsFile, RoleKind } from '../types';
import { applyDrop, dropSpot, editorView, hitItem, type EditorItem, type EditorKind, type EditorView } from './layout-model';

const CANVAS_MAX_W = 760;
const PADDING = 14;
const TOP = 24;
const SAVE_NOTE_MS = 3500;

const LABELS: Record<EditorKind, MessageKey> = {
  lead: 'settings.layout.item.lead',
  desk: 'settings.layout.item.desk',
  coffee: 'settings.layout.item.coffee',
  meeting: 'settings.layout.item.meeting',
  lab: 'settings.layout.item.lab',
  board: 'settings.layout.item.board',
  printer: 'settings.layout.item.printer',
};

type Drag = { item: EditorItem; dx: number; dz: number; x: number; z: number };

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function modelName(model: string): string {
  return model.replace(/^[^/]+\//, '').replace(/\.glb$/, '');
}

// The layout section of the settings: the floor from above with the desks and furniture to drag, what the
// roles wear, and the layout as a file to take away or bring back. It keeps its state across the rebuilds of the
// form, so the settings page builds it once. With no hub (a replay) it only shows.
export class LayoutEditor {
  readonly root: HTMLElement;
  private readonly canvas = el('canvas', 'layout-canvas');
  private readonly floorSelect = el('select', 'setting-mode');
  private readonly status = el('span', 'settings-status');
  private readonly empty = el('p', 'settings-hint muted');
  private readonly reset = button('');
  private readonly exportButton = button('');
  private readonly importButton = button('');
  private readonly fileInput = el('input');
  private readonly characters = el('div', 'role-grid layout-characters');
  private readonly title = el('h2', 'settings-title');
  private readonly hint = el('p', 'settings-hint muted');
  private readonly floorLabel = el('span', 'setting-label');
  private readonly charTitle = el('h3', 'layout-subtitle');
  private readonly charHint = el('p', 'settings-hint muted');
  private readonly selects = new Map<RoleKind, HTMLSelectElement>();
  private slug: string | null = null;
  private view: EditorView | null = null;
  private drag: Drag | null = null;
  private draft: LayoutsFile = emptyLayouts();
  private saving = false;
  private queued: LayoutsFile | null = null;
  private note: ReturnType<typeof setTimeout> | undefined;
  private customModels: string[] = [];
  private ratio = 1;
  private cssW = 1;

  constructor(
    private readonly store: Store,
    private readonly api: OfficeApi | null,
  ) {
    this.canvas.setAttribute('role', 'img');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.hidden = true;
    const floorRow = el('label', 'setting-row', el('span', 'setting-text', this.floorLabel), this.floorSelect);
    const actions = el('div', 'layout-actions', this.reset, this.exportButton, this.importButton, this.fileInput, this.status);
    this.root = el('section', 'settings-section layout-section', this.title, this.hint, floorRow, this.canvas, this.empty, actions, this.charTitle, this.charHint, this.characters);

    this.floorSelect.addEventListener('change', () => {
      this.slug = this.floorSelect.value;
      this.redraw();
    });
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.reset.addEventListener('click', () => {
      if (this.slug !== null) void this.commit(withoutPlacement(this.draft, this.slug));
    });
    this.exportButton.addEventListener('click', () => this.download());
    this.importButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => void this.upload());
    store.watch(['layouts', 'floors', 'agents', 'lang', 'mode'], () => this.sync());
    new ResizeObserver(() => this.paint()).observe(this.root);
    void this.loadCustom();
  }

  private get editable(): boolean {
    return this.api !== null;
  }

  private sync(): void {
    if (!this.saving && this.queued === null) this.draft = this.store.layouts;
    this.labels();
    this.fillFloors();
    this.fillCharacters();
    this.redraw();
  }

  private labels(): void {
    this.title.textContent = t('settings.layout.title');
    this.hint.textContent = t(this.editable ? 'settings.layout.hint' : 'settings.layout.readonly');
    this.floorLabel.textContent = t('settings.layout.floor');
    this.floorSelect.setAttribute('aria-label', t('settings.layout.floor'));
    this.reset.textContent = t('settings.layout.reset');
    this.exportButton.textContent = t('settings.layout.export');
    this.importButton.textContent = t('settings.layout.import');
    this.charTitle.textContent = t('settings.layout.characters');
    this.charHint.textContent = t('settings.layout.charactersHint');
    this.reset.disabled = !this.editable;
    this.importButton.disabled = !this.editable;
    this.canvas.style.cursor = this.editable ? 'grab' : 'default';
  }

  private fillFloors(): void {
    const floors = this.store.floorList();
    const previous = this.slug;
    this.floorSelect.replaceChildren(...floors.map((floor) => new Option(floorLabel(floor), floor.slug)));
    this.slug = floors.some((floor) => floor.slug === previous) ? previous : (floors[0]?.slug ?? null);
    if (this.slug !== null) this.floorSelect.value = this.slug;
    this.floorSelect.disabled = floors.length === 0;
  }

  private fillCharacters(): void {
    const rows: HTMLElement[] = [];
    this.selects.clear();
    for (const role of ROLE_KINDS) {
      const select = el('select', 'role-model');
      select.setAttribute('aria-label', t('settings.layout.aria.model', { role: roleLabel(role) }));
      select.append(new Option(t('settings.layout.modelDefault', { name: modelName(DEFAULT_ROLE_MODELS[role]) }), ''));
      for (const model of PACK_MODELS) select.append(new Option(modelName(model), model));
      for (const model of this.customModels) select.append(new Option(t('settings.layout.modelCustom', { name: modelName(model) }), model));
      const chosen = this.draft.all?.characters?.[role] ?? '';
      if (chosen !== '' && ![...select.options].some((option) => option.value === chosen)) select.append(new Option(modelName(chosen), chosen));
      select.value = chosen;
      select.disabled = !this.editable;
      select.addEventListener('change', () => void this.commit(withCharacter(this.draft, role, select.value === '' ? null : select.value)));
      this.selects.set(role, select);
      rows.push(el('span', 'role-name', roleLabel(role)), el('div', 'role-model-cell', select));
    }
    this.characters.replaceChildren(...rows);
  }

  private async loadCustom(): Promise<void> {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}assets/characters/custom/index.json`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) return;
      const names: unknown = await response.json();
      if (Array.isArray(names)) this.customModels = names.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9_-]+\.glb$/.test(name)).map((name) => `custom/${name}`);
    } catch {
      this.customModels = [];
    }
    this.fillCharacters();
  }

  private agentsByFloor(): Map<string, AgentView[]> {
    const byFloor = new Map<string, AgentView[]>();
    for (const agent of this.store.officeAgents()) {
      const list = byFloor.get(agent.floor) ?? [];
      list.push(agent);
      byFloor.set(agent.floor, list);
    }
    return byFloor;
  }

  // The same order the scene gives the desks: the order in which the agents first showed up, which here is the
  // order of the store.
  private order(): (key: string) => number {
    const seen = new Map<string, number>([...this.store.agents.keys()].map((key, index) => [key, index]));
    return (key) => seen.get(key) ?? 0;
  }

  private redraw(): void {
    const floors = this.store.floorList();
    const floor = floors.find((item) => item.slug === this.slug);
    if (!floor) {
      this.view = null;
      this.canvas.hidden = true;
      this.empty.hidden = true;
      return;
    }
    this.canvas.hidden = false;
    this.view = editorView(floor, floors, this.agentsByFloor(), this.order(), this.draft);
    const noDesks = !this.view.items.some((item) => item.kind === 'desk' || item.kind === 'lead');
    this.empty.hidden = !noDesks;
    this.empty.textContent = t('settings.layout.noDesks');
    this.paint();
  }

  private paint(): void {
    const view = this.view;
    if (!view) return;
    const available = Math.max(240, Math.min(CANVAS_MAX_W, this.root.clientWidth || CANVAS_MAX_W));
    const scale = (available - PADDING * 2) / view.width;
    const cssW = Math.round(view.width * scale + PADDING * 2);
    const cssH = Math.round(DEPTH * scale + PADDING + TOP);
    const dpr = window.devicePixelRatio || 1;
    this.ratio = scale;
    this.cssW = cssW;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.setAttribute('aria-label', t('settings.layout.canvas'));
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const surface = cssVar('--surface-2', '#1e252e');
    const border = cssVar('--border', '#2a333f');
    const text = cssVar('--text', '#e6edf3');
    const muted = cssVar('--muted', '#8b97a6');
    const accent = cssVar('--accent', '#4f7cff');
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = surface;
    ctx.fillRect(PADDING, TOP, view.width * scale, DEPTH * scale);
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.strokeRect(PADDING, TOP, view.width * scale, DEPTH * scale);
    ctx.fillStyle = muted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(t('settings.layout.wall'), PADDING, TOP - 7);
    for (const item of view.items) this.drawItem(ctx, item, scale, item.kind === 'lead' || item.kind === 'desk' ? accent : muted, text, 0.28);
    if (this.drag) {
      const { item, x, z } = this.drag;
      this.drawItem(ctx, { ...item, x, z }, scale, accent, text, 0.55);
    }
  }

  private px(x: number, z: number, width: number, scale: number): { left: number; top: number } {
    return { left: PADDING + (x + width / 2) * scale, top: TOP + (z + HALF_D) * scale };
  }

  private drawItem(ctx: CanvasRenderingContext2D, item: EditorItem, scale: number, color: string, text: string, alpha: number): void {
    const view = this.view;
    if (!view) return;
    const { left, top } = this.px(item.x, item.z, view.width, scale);
    const w = item.w * scale;
    const d = item.d * scale;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(left - w / 2, top - d / 2, w, d);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left - w / 2, top - d / 2, w, d);
    ctx.fillStyle = text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (item.kind !== 'desk') {
      const name = t(LABELS[item.kind]);
      ctx.fillText(w < 54 ? name.slice(0, 1) : name, left, top, Math.max(w - 4, 14));
    }
    ctx.textAlign = 'start';
  }

  // The pointer in metres of the floor.
  private world(event: PointerEvent): { x: number; z: number } | null {
    const view = this.view;
    if (!view) return null;
    const box = this.canvas.getBoundingClientRect();
    const k = box.width > 0 ? this.cssW / box.width : 1;
    const x = ((event.clientX - box.left) * k - PADDING) / this.ratio - view.width / 2;
    const z = ((event.clientY - box.top) * k - TOP) / this.ratio - HALF_D;
    return { x, z };
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.editable || this.view === null || event.button !== 0) return;
    const at = this.world(event);
    if (!at) return;
    const item = hitItem(this.view.items, at.x, at.z);
    if (!item) return;
    this.drag = { item, dx: item.x - at.x, dz: item.z - at.z, x: item.x, z: item.z };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
    this.paint();
  };

  private readonly onMove = (event: PointerEvent): void => {
    const at = this.world(event);
    if (!at) return;
    if (!this.drag) {
      if (this.editable && this.view) this.canvas.style.cursor = hitItem(this.view.items, at.x, at.z) ? 'grab' : 'default';
      return;
    }
    this.drag.x = at.x + this.drag.dx;
    this.drag.z = this.drag.item.kind === 'board' ? this.drag.item.z : at.z + this.drag.dz;
    this.paint();
  };

  private readonly onUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || !this.view || this.slug === null) return;
    this.drag = null;
    this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grab';
    const next = applyDrop(this.draft, this.slug, drag.item, dropSpot(drag.x, drag.z, this.view.width));
    void this.commit(next);
  };

  private readonly onCancel = (): void => {
    this.drag = null;
    this.paint();
  };

  // Shows the change at once and sends it; if the hub refuses, the layout it has comes back.
  private async commit(next: LayoutsFile): Promise<void> {
    if (!this.api) return;
    this.draft = next;
    this.redraw();
    this.fillCharacters();
    if (this.saving) {
      this.queued = next;
      return;
    }
    this.saving = true;
    this.setStatus(t('settings.layout.saving'), '');
    let current: LayoutsFile | null = next;
    while (current) {
      this.queued = null;
      const result = await this.api.saveLayouts(current);
      if (!result.ok) {
        this.queued = null;
        this.setStatus(t('settings.layout.saveFailed', { error: result.message }), 'error');
        this.saving = false;
        this.draft = this.store.layouts;
        this.redraw();
        this.fillCharacters();
        return;
      }
      current = this.queued;
    }
    this.saving = false;
    this.setStatus(t('settings.layout.saved'), 'ok', SAVE_NOTE_MS);
    this.draft = this.store.layouts;
    this.redraw();
    this.fillCharacters();
  }

  private setStatus(text: string, kind: '' | 'ok' | 'error', clearAfter = 0): void {
    clearTimeout(this.note);
    this.status.textContent = text;
    this.status.className = kind ? `settings-status ${kind}` : 'settings-status';
    if (clearAfter > 0) this.note = setTimeout(() => this.setStatus('', ''), clearAfter);
  }

  private download(): void {
    saveFile('layouts.json', `${JSON.stringify(this.store.layouts, null, 2)}\n`, 'application/json');
  }

  private async upload(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file || !this.editable) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this.setStatus(t('settings.layout.importBad'), 'error');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.setStatus(t('settings.layout.importBad'), 'error');
      return;
    }
    await this.commit(parsed as LayoutsFile);
  }
}
