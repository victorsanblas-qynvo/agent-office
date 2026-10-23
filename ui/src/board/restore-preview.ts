import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { plural, t } from '../i18n';
import { renderHubText } from '../i18n/hub';
import type { CheckpointView, RestorePreview } from '../types';

const DIRTY_SHOWN = 10;

// Pure: the lines of a preview, and whether the restore may go ahead.
export function previewLines(preview: RestorePreview): { blocked: string | null; dropped: string[]; more: number; dirty: string[]; dirtyMore: number } {
  return {
    blocked: preview.blocked ? renderHubText(t, preview.blocked) : null,
    dropped: preview.dropped,
    more: Math.max(0, preview.droppedTotal - preview.dropped.length),
    dirty: preview.dirty.slice(0, DIRTY_SHOWN),
    dirtyMore: Math.max(0, preview.dirty.length - DIRTY_SHOWN),
  };
}

function previewBody(preview: RestorePreview): HTMLElement[] {
  const lines = previewLines(preview);
  if (lines.blocked !== null) return [el('p', 'order-warning', t('board.points.preview.blocked', { reason: lines.blocked }))];
  const list = (items: string[], extra: number): HTMLElement =>
    el('ul', 'restore-preview-list', ...items.map((item) => el('li', '', item)), extra > 0 ? el('li', 'muted', t('board.points.preview.droppedMore', { n: extra })) : null);
  return [
    el('p', '', lines.dropped.length > 0 ? plural('board.points.preview.dropped', preview.droppedTotal) : t('board.points.preview.noneDropped')),
    lines.dropped.length > 0 ? list(lines.dropped, lines.more) : null,
    preview.stat.files > 0 ? el('p', 'muted', t('board.points.preview.stat', preview.stat)) : null,
    lines.dirty.length > 0 ? el('p', '', t('board.points.preview.dirty')) : null,
    lines.dirty.length > 0 ? list(lines.dirty, lines.dirtyMore) : null,
  ].filter((node): node is HTMLElement => node !== null);
}

// What restoring to a checkpoint would do, read from the hub before the user confirms it.
export function openRestorePreview(host: HTMLElement, api: OfficeApi, orderId: number, point: CheckpointView, n: number, confirm: () => void): void {
  const title = t('board.points.preview.title', { n, sha: point.sha.slice(0, 7) });
  const cancel = button(t('board.points.preview.cancel'));
  const go = button(t('board.points.preview.confirm'), 'primary');
  go.disabled = true;
  const content = el('div', 'restore-preview-body', el('p', 'muted', t('board.loading')));
  const dialog = el('div', 'restore-preview', el('h3', 'new-order-heading', title), el('p', 'muted', t('board.points.restoreAsk', { n, sha: point.sha.slice(0, 7) })), content, el('div', 'new-order-actions', cancel, go));
  const backdrop = el('div', 'dialog-backdrop', dialog);
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);
  const dismiss = (): void => backdrop.remove();
  cancel.addEventListener('click', dismiss);
  go.addEventListener('click', () => {
    dismiss();
    confirm();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });
  host.append(backdrop);
  cancel.focus();
  void api.restorePreview(orderId, point.id).then((result) => {
    if (!backdrop.isConnected) return;
    if (!result.ok) {
      content.replaceChildren(el('p', 'new-order-status error', t('board.points.preview.failed', { error: result.message })));
      return;
    }
    content.replaceChildren(...previewBody(result.data));
    go.disabled = result.data.blocked !== null;
  });
}
