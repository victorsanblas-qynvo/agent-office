import type { OfficeApi } from '../api';
import { saveFile } from '../download';
import { button, el, setStateColor } from '../dom';
import { currentLang, plural, t, type MessageKey } from '../i18n';
import { hubText } from '../i18n/hub';
import { DOCUMENT_STATUS_COLORS, documentKindFor, documentStatusText } from '../labels';
import type { Store } from '../store';
import type { DocumentAhead, DocumentBase, DocumentKind, DocumentStatus, DocumentView, HubText } from '../types';
import { renderMarkdown } from './markdown';
import { panelSection } from './section';

const SHORT_SHA = 7;
// The hub keeps the sources of a discarded plan this long (OfficeOptions.undoMs).
export const UNDO_MS = 10_000;
const NOT_DISCARDABLE: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['ejecutando', 'cerrado', 'descartado']);

const openAhead = new Set<string>();

let viewerApi: OfficeApi | null = null;
let openViewer: DocumentViewer | null = null;

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(currentLang(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function baseText(base: DocumentBase): string {
  const label = `${base.floor} ${base.ref} @ ${base.sha.slice(0, SHORT_SHA)}`;
  if (!base.stale) return label;
  return `${label} · ${base.date === null ? t('deliverables.notUpdated') : t('deliverables.asOf', { date: shortDate(base.date) })}`;
}

function aheadText(ahead: DocumentAhead, bases: readonly DocumentBase[]): string {
  const ref = bases.find((base) => base.floor === ahead.floor)?.ref ?? t('deliverables.baseBranch');
  const prefix = bases.length > 1 ? `${ahead.floor}: ` : '';
  return `${prefix}${plural('deliverables.ahead', ahead.commits, { ref })}`;
}

function aheadBlock(doc: DocumentView, ahead: DocumentAhead): HTMLElement {
  const text = aheadText(ahead, doc.base);
  const files = ahead.files.length;
  if (files === 0) return el('p', 'doc-line doc-ahead', text);
  const id = `${doc.path}|${ahead.floor}`;
  const details = el(
    'details',
    'doc-line doc-ahead',
    el('summary', '', `${text} · ${plural('table.files', files)}`),
    el('ul', 'doc-files', ...ahead.files.map((file) => el('li', '', el('code', '', file)))),
  );
  details.dataset.ahead = id;
  details.open = openAhead.has(id);
  return details;
}

function metaLines(doc: DocumentView): HTMLElement[] {
  const lines: HTMLElement[] = doc.base.map((base) => el('p', 'doc-line muted', baseText(base)));
  for (const ahead of doc.ahead) {
    if (ahead.commits > 0) lines.push(aheadBlock(doc, ahead));
  }
  if (doc.installedAt.length > 0) {
    const installed = el('p', 'doc-line muted', `${t('deliverables.installedAt')} `);
    doc.installedAt.forEach((place, index) => {
      if (index > 0) installed.append(', ');
      installed.append(el('code', '', place));
    });
    lines.push(installed);
  }
  return lines;
}

export function canDiscard(doc: DocumentView): boolean {
  return doc.kind === 'plan' && !NOT_DISCARDABLE.has(doc.status);
}

function trackAhead(root: HTMLElement): void {
  root.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      const id = target.dataset.ahead;
      if (!id) return;
      if (target.open) openAhead.add(id);
      else openAhead.delete(id);
    },
    true,
  );
}

export function documentBadge(doc: DocumentView, text: string = documentStatusText(doc)): HTMLSpanElement {
  const badge = el('span', 'badge', el('span', 'badge-dot'), text);
  setStateColor(badge, DOCUMENT_STATUS_COLORS[doc.status]);
  return badge;
}

export function documentMarks(doc: DocumentView): HTMLSpanElement {
  const marks = el('span', 'doc-marks');
  if (doc.docType === 'analisis') marks.append(el('span', 'chip doc-type', t('plans.type.analisis')));
  marks.append(documentBadge(doc));
  return marks;
}

export async function discardDocument(
  api: OfficeApi | null,
  store: Store,
  doc: DocumentView,
  control: HTMLButtonElement,
): Promise<boolean> {
  if (api === null || !window.confirm(t('deliverables.confirmDiscard', { title: doc.title }))) return false;
  control.disabled = true;
  const result = await api.discardDocument(doc.path);
  control.disabled = false;
  if (!result.ok) {
    store.toast(result.message, 'error');
    return false;
  }
  store.toast(t('deliverables.discarded', { title: doc.title }), 'ok', {
    ttlMs: UNDO_MS,
    action: { label: t('deliverables.undo'), run: () => void restoreDocument(api, store, doc) },
  });
  return true;
}

async function restoreDocument(api: OfficeApi, store: Store, doc: DocumentView): Promise<void> {
  const result = await api.restoreDocument(doc.path);
  if (result.ok) store.toast(t('deliverables.restored', { title: doc.title }), 'ok');
  else store.toast(result.message, 'error');
}

export async function downloadDocument(api: OfficeApi | null, store: Store, doc: DocumentView, control: HTMLButtonElement): Promise<void> {
  if (api === null) return;
  control.disabled = true;
  const result = await api.documentContent(doc.path);
  control.disabled = false;
  if (!result.ok) {
    store.toast(result.message, 'error');
    return;
  }
  if (result.data.notice) {
    store.toast(hubText(result.data.notice), 'error');
    return;
  }
  saveFile(`${doc.slug}.md`, result.data.markdown, 'text/markdown');
}

class DocumentViewer {
  private readonly backdrop: HTMLElement;
  private readonly title = el('h2', 'modal-title');
  private readonly badge = el('span', 'modal-badge');
  private readonly meta = el('div', 'modal-meta');
  private readonly body = el('div', 'modal-body');
  private readonly discard = button('', 'doc-discard');
  private readonly close = button('');
  private readonly previousFocus: Element | null = document.activeElement;
  private stopWatching: () => void = () => {};
  private stopRelabel: () => void = () => {};
  private notice: { key: MessageKey } | { hub: HubText } | null = null;
  private ticket = 0;

  constructor(
    private readonly store: Store,
    private doc: DocumentView,
  ) {
    this.title.id = 'document-title';
    const dialog = el(
      'div',
      'modal',
      el(
        'header',
        'modal-head',
        el('div', 'modal-heading', this.title, this.badge),
        el('div', 'modal-actions', this.discard, this.close),
      ),
      this.meta,
      this.body,
    );
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', this.title.id);
    this.backdrop = el('div', 'modal-backdrop', dialog);

    trackAhead(this.meta);
    this.discard.addEventListener('click', () => void this.discardCurrent());
    this.close.addEventListener('click', () => this.dispose());
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.dispose();
    });
    document.addEventListener('keydown', this.onKey, true);
    document.body.append(this.backdrop);
    this.close.focus();
    this.stopWatching = store.watch(['documents'], () => this.sync());
    this.stopRelabel = store.watch(['lang'], () => this.relabel());
    void this.loadContent();
  }

  dispose(): void {
    this.stopWatching();
    this.stopRelabel();
    document.removeEventListener('keydown', this.onKey, true);
    this.backdrop.remove();
    if (openViewer === this) openViewer = null;
    if (this.previousFocus instanceof HTMLElement) this.previousFocus.focus();
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    this.dispose();
  };

  private sync(): void {
    const next = this.store.documents.find((item) => item.path === this.doc.path);
    if (next) {
      const changed = next.updatedAt !== this.doc.updatedAt;
      this.doc = next;
      if (changed) void this.loadContent();
    }
    this.renderHead();
  }

  private relabel(): void {
    this.discard.textContent = t('deliverables.discard');
    this.close.textContent = t('deliverables.close');
    if (this.notice !== null) this.showNotice(this.notice);
    this.renderHead();
  }

  // Notices instead of the document (own or from the hub) are kept so a language change can repaint them.
  private showNotice(notice: { key: MessageKey } | { hub: HubText }): void {
    this.notice = notice;
    this.body.replaceChildren(
      'key' in notice ? el('p', 'muted hint', t(notice.key)) : el('p', 'doc-notice hint', hubText(notice.hub)),
    );
  }

  private renderHead(): void {
    const { doc } = this;
    this.title.textContent = doc.title;
    this.badge.replaceChildren(documentMarks(doc));
    this.meta.replaceChildren(el('code', 'doc-path muted', doc.path), ...metaLines(doc));
    this.discard.hidden = viewerApi === null || !canDiscard(doc);
  }

  private async loadContent(): Promise<void> {
    const api = viewerApi;
    const mine = ++this.ticket;
    if (api === null) {
      this.showNotice({ key: 'deliverables.noHub' });
      return;
    }
    if (this.body.childElementCount === 0) this.showNotice({ key: 'deliverables.loading' });
    const result = await api.documentContent(this.doc.path);
    if (mine !== this.ticket) return;
    if (result.ok && result.data.notice) {
      this.showNotice({ hub: result.data.notice });
      return;
    }
    const scroll = this.body.scrollTop;
    const content = result.ok ? renderMarkdown(result.data.markdown) : el('p', 'doc-error hint', result.message);
    this.notice = null;
    this.body.replaceChildren(content);
    this.body.scrollTop = scroll;
  }

  private async discardCurrent(): Promise<void> {
    if (await discardDocument(viewerApi, this.store, this.doc, this.discard)) this.dispose();
  }
}

export function closeDocument(): boolean {
  if (openViewer === null) return false;
  openViewer.dispose();
  return true;
}

export function openDocument(store: Store, doc: DocumentView): void {
  openViewer?.dispose();
  openViewer = new DocumentViewer(store, doc);
}

function card(store: Store, doc: DocumentView): HTMLElement {
  const root = el(
    'article',
    `doc doc-${doc.status}`,
    el('div', 'doc-head', button(doc.title, 'doc-title'), documentMarks(doc)),
    ...metaLines(doc),
  );
  root.dataset.path = doc.path;
  root.title = doc.path;
  const actions = el('div', 'doc-actions');
  if (viewerApi !== null) {
    const download = button(t('deliverables.download'), 'doc-download', t('deliverables.downloadTitle', { file: `${doc.slug}.md` }));
    download.addEventListener('click', () => void downloadDocument(viewerApi, store, doc, download));
    actions.append(download);
  }
  if (canDiscard(doc)) {
    const discard = button(t('deliverables.discard'), 'doc-discard');
    discard.addEventListener('click', () => void discardDocument(viewerApi, store, doc, discard));
    actions.append(discard);
  }
  if (actions.childElementCount > 0) root.append(actions);
  return root;
}

function watchApprovals(store: Store): void {
  const known = new Map<string, DocumentStatus>();
  const announced = new Set<string>();
  store.watch(['documents'], () => {
    for (const doc of store.documents) {
      const before = known.get(doc.path);
      const becameDelivered = doc.kind === 'plan' && doc.status === 'entregado' && before !== undefined && before !== 'entregado';
      if (becameDelivered) {
        store.toast(t('deliverables.delivered', { title: doc.title }), 'ok');
        continue;
      }
      const becameApproved = doc.status === 'aprobado' && before !== undefined && before !== 'aprobado';
      if (!becameApproved || announced.has(doc.path)) continue;
      announced.add(doc.path);
      store.toast(t(doc.kind === 'plan' ? 'deliverables.planApproved' : 'deliverables.skillApproved', { title: doc.title }), 'ok');
    }
    known.clear();
    for (const doc of store.documents) known.set(doc.path, doc.status);
    for (const path of announced) {
      if (!known.has(path)) announced.delete(path);
    }
  });
}

export function mountDeliverables(host: HTMLElement, store: Store, api: OfficeApi | null): void {
  viewerApi = api;
  host.replaceChildren();
  host.hidden = true;
  let kind: DocumentKind | null = null;
  const section = panelSection({
    id: 'deliverables',
    title: () => t(kind === 'skill' ? 'deliverables.title.skill' : 'deliverables.title.plan'),
    host,
  });
  const count = el('span', 'chip');
  trackAhead(host);
  watchApprovals(store);

  let signature = '';

  section.body.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('.doc-discard, .doc-download, summary, .doc-files')) return;
    const path = target.closest<HTMLElement>('.doc')?.dataset.path;
    const doc = path === undefined ? undefined : store.documents.find((item) => item.path === path);
    if (doc) openDocument(store, doc);
  });

  store.watch(['selection', 'agents', 'floors', 'documents', 'lang'], () => {
    const key = store.selectedKey;
    const agent = key === null ? undefined : store.agents.get(key);
    const floor = agent ? store.floorBySlug(agent.floor) : undefined;
    kind = floor ? documentKindFor(floor.kind) : null;
    if (kind === null) {
      signature = '';
      host.hidden = true;
      section.body.replaceChildren();
      return;
    }

    host.hidden = false;
    const shown = kind;
    const documents = store.documents.filter((doc) => doc.kind === shown).sort((a, b) => b.updatedAt - a.updatedAt);
    const next = JSON.stringify([store.lang, kind, documents]);
    if (next === signature) return;
    signature = next;

    section.setTitle();
    count.textContent = String(documents.length);
    section.setMeta(count);
    section.body.replaceChildren(
      documents.length > 0
        ? el('div', 'doc-list', ...documents.map((doc) => card(store, doc)))
        : el('p', 'muted hint', t(kind === 'plan' ? 'table.docs.noPlans' : 'table.docs.noSkills')),
    );
  });
}
