import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import type { Store } from '../store';
import type { OrderView } from '../types';
import { ghCommand } from './gh-command';

// Copies with the clipboard API, or with the selection of the textarea where the browser does not allow it.
async function copy(source: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(source.value);
    return true;
  } catch {
    source.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

function field(id: string, label: string, value: string, rows: number, store: Store): HTMLElement {
  const area = el('textarea', 'pr-draft-text');
  area.readOnly = true;
  area.rows = rows;
  area.value = value;
  area.spellcheck = false;
  area.setAttribute('aria-labelledby', id);
  const copyButton = button(t('board.pr.copy'));
  copyButton.addEventListener('click', () => {
    void copy(area).then((done) => store.toast(t(done ? 'board.pr.copied' : 'board.pr.copyFailed'), done ? 'ok' : 'error'));
  });
  const caption = el('span', '', label);
  caption.id = id;
  return el('div', 'pr-draft-field', el('div', 'pr-draft-label', caption, copyButton), area);
}

function ghField(draft: { title: string; body: string }, order: OrderView | undefined, store: Store): HTMLElement {
  const area = el('textarea', 'pr-draft-text');
  area.readOnly = true;
  area.rows = 6;
  area.spellcheck = false;
  area.value = ghCommand(draft, order?.base ?? null, order?.branch ?? null);
  const copyButton = button(t('board.pr.copyGh'));
  copyButton.addEventListener('click', () => {
    void copy(area).then((done) => store.toast(t(done ? 'board.pr.copied' : 'board.pr.copyFailed'), done ? 'ok' : 'error'));
  });
  return el('div', 'pr-draft-field', el('div', 'pr-draft-label', el('span', '', t('board.pr.gh')), copyButton), area);
}

// The title and the description of the pull request of an order, read only and ready to copy.
export function openPrDraft(host: HTMLElement, store: Store, api: OfficeApi, orderId: number): void {
  const close = button(t('board.pr.close'));
  const content = el('div', 'pr-draft-content', el('p', 'muted', t('board.loading')));
  const dialog = el('div', 'pr-draft', el('h3', 'new-order-heading', t('board.pr.heading')), content, el('div', 'new-order-actions', close));
  const backdrop = el('div', 'dialog-backdrop', dialog);
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', t('board.pr.heading'));
  const dismiss = (): void => backdrop.remove();
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });
  host.append(backdrop);
  close.focus();
  void api.orderPrDraft(orderId, currentLang()).then((result) => {
    if (!backdrop.isConnected) return;
    content.replaceChildren(
      ...(result.ok
        ? [field('pr-draft-title', t('board.pr.title'), result.data.title, 1, store), field('pr-draft-body', t('board.pr.body'), result.data.body, 16, store), ghField(result.data, store.orders.find((o) => o.id === orderId), store)]
        : [el('p', 'new-order-status error', result.message)]),
    );
  });
}
