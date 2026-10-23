import type { OfficeApi } from '../api';
import { append, button, el } from '../dom';
import { t } from '../i18n';
import type { Store } from '../store';
import { relativeTime } from '../time';
import type { OrphanBranchView } from '../types';
import { shortSha } from './deleted-branches-model';
import { aheadBehindText, orphanCommands } from './orphan-branches-model';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// The order branches of a floor that no live order owns, read-only: each row copies the command to inspect or delete it.
export function orphanBranches(floor: string, base: string, store: Store, api: OfficeApi): HTMLElement {
  let views: OrphanBranchView[] | null = null;
  let status: { kind: 'ok' | 'error'; text: string } | null = null;
  const count = el('span', 'chip');
  const body = el('div', 'deleted-branches-body');
  const root = el('details', 'floor-delivery deleted-branches', el('summary', '', t('settings.orphans.title'), ' ', count), body);

  const paint = (): void => {
    count.hidden = views === null || views.length === 0;
    count.textContent = String(views?.length ?? 0);
    const now = store.now();
    const rows = views === null ? [el('p', 'muted', t('board.loading'))] : views.length === 0 ? [el('p', 'muted', t('settings.orphans.empty'))] : views.map((view) => row(view, now));
    body.replaceChildren();
    append(body, [el('p', 'setting-hint muted', t('settings.orphans.hint')), status ? el('p', `settings-status ${status.kind}`, status.text) : null, ...rows]);
  };

  const copier = (label: string, text: string): HTMLButtonElement => {
    const control = button(label, '', text);
    control.addEventListener('click', () => {
      void copy(text).then((ok) => {
        status = ok ? { kind: 'ok', text: t('settings.orphans.copied', { command: text }) } : { kind: 'error', text: t('settings.orphans.copyFailed') };
        paint();
      });
    });
    return control;
  };

  const row = (view: OrphanBranchView, now: number): HTMLElement => {
    const commands = orphanCommands(view.branch, base);
    const owner = view.order ? t('settings.orphans.order', { slug: view.order.slug, status: t(`board.col.${view.order.status}`) }) : t('settings.orphans.noOrder');
    return el(
      'div',
      'setting-row deleted-branch',
      el(
        'span',
        'setting-text',
        el('code', 'setting-label', view.branch),
        el('span', 'setting-hint muted', `${shortSha(view.sha)} · ${relativeTime(view.committedAt, now)} · ${aheadBehindText(view)} · ${owner}`),
      ),
      el('span', 'worktree-actions', copier(t('settings.orphans.copyDelete'), commands.delete), copier(t('settings.orphans.copyLog'), commands.log)),
    );
  };

  const load = async (): Promise<void> => {
    const result = await api.orphanBranches(floor);
    if (result.ok) {
      views = result.data.branches;
      status = null;
    } else {
      views ??= [];
      status = { kind: 'error', text: result.message };
    }
    if (root.isConnected) paint();
  };

  root.addEventListener('toggle', () => {
    if (!root.open) return;
    status = null;
    paint();
    void load();
  });
  paint();
  return root;
}
