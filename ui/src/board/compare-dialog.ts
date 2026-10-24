import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { t } from '../i18n';
import type { Store } from '../store';
import type { OrderView } from '../types';
import { compareOrders, fileSets, type CompareSide, type FileSets } from './compare-model';

function fileList(label: string, paths: string[]): HTMLElement {
  return el(
    'section',
    'compare-files',
    el('h4', 'compare-files-title', t('board.compare.files', { label, n: paths.length })),
    paths.length > 0 ? el('ul', 'restore-preview-list', ...paths.map((path) => el('li', '', path))) : el('p', 'muted', t('board.compare.noFiles')),
  );
}

function body(a: CompareSide, b: CompareSide, store: Store): HTMLElement[] {
  const rows = compareOrders(a, b, store.now());
  const table = el(
    'div',
    'compare-grid',
    el('span', 'muted', ''),
    el('b', '', t('board.compare.original', { slug: a.order.slug })),
    el('b', '', t('board.compare.fork', { slug: b.order.slug })),
    ...rows.flatMap((row) => [el('span', 'muted', row.label), el('span', '', row.a), el('span', '', row.b)]),
  );
  if (!a.diff || !b.diff) return [table, el('p', 'muted', t('board.compare.noDiff'))];
  const sets: FileSets = fileSets(a.diff.files.map((file) => file.path), b.diff.files.map((file) => file.path));
  return [
    table,
    fileList(t('board.compare.onlyOriginal'), sets.onlyA),
    fileList(t('board.compare.onlyFork'), sets.onlyB),
    fileList(t('board.compare.both'), sets.both),
  ];
}

// Read-only side by side of a fork and the order it came from.
export function openCompare(host: HTMLElement, store: Store, api: OfficeApi, fork: OrderView, original: OrderView): void {
  const title = t('board.compare.title', { fork: fork.slug, original: original.slug });
  const close = button(t('board.drawer.close'));
  const content = el('div', 'restore-preview-body', el('p', 'muted', t('board.loading')));
  const dialog = el('div', 'restore-preview compare', el('h3', 'new-order-heading', title), content, el('div', 'new-order-actions', close));
  const backdrop = el('div', 'dialog-backdrop', dialog);
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);
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
  const load = async (order: OrderView): Promise<CompareSide> => {
    const [diff, spend] = await Promise.all([api.orderDiff(order.id), api.orderSpend(order.id)]);
    return { order, diff: diff.ok ? diff.data : null, spend: spend.ok ? spend.data : null };
  };
  void Promise.all([load(original), load(fork)]).then(([a, b]) => {
    if (!backdrop.isConnected) return;
    content.replaceChildren(...body(a, b, store));
  });
}
