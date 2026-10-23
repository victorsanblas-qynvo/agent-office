import type { OfficeApi } from '../api';
import { append, button, el } from '../dom';
import { plural, t } from '../i18n';
import type { Store } from '../store';
import { relativeTime } from '../time';
import type { DeletedBranchView } from '../types';
import { blockedKey, restorableCount, shortSha } from './deleted-branches-model';

type FloorBranches = { views: DeletedBranchView[] | null; busy: boolean; status: { kind: 'ok' | 'error'; text: string } | null };

// Survives the rebuilds of the project list: which floors are open and what each one loaded.
export type DeletedBranchesContext = {
  store: Store;
  api: OfficeApi;
  open: Set<string>;
  floors: Map<string, FloorBranches>;
  reload: Map<string, () => Promise<void>>;
};

export function deletedBranchesContext(store: Store, api: OfficeApi): DeletedBranchesContext {
  return { store, api, open: new Set<string>(), floors: new Map<string, FloorBranches>(), reload: new Map<string, () => Promise<void>>() };
}

// A folder deleted with its branch, or a branch restored, changes the open lists.
export function reloadOpen(ctx: DeletedBranchesContext): void {
  for (const floor of ctx.open) void ctx.reload.get(floor)?.();
}

// The order branches the hub deleted on a floor, each with a Restaurar while its name is free and git keeps the commit.
export function deletedBranches(floor: string, ctx: DeletedBranchesContext): HTMLElement {
  const state = (): FloorBranches => {
    let found = ctx.floors.get(floor);
    if (!found) {
      found = { views: null, busy: false, status: null };
      ctx.floors.set(floor, found);
    }
    return found;
  };
  const count = el('span', 'chip');
  const body = el('div', 'deleted-branches-body');
  const root = el('details', 'floor-delivery deleted-branches', el('summary', '', t('settings.branches.title'), ' ', count), body);

  const paint = (): void => {
    const { views, busy, status } = state();
    const restorable = views ? restorableCount(views) : 0;
    count.hidden = restorable === 0;
    count.textContent = plural('settings.branches.count', restorable);
    const now = ctx.store.now();
    const rows = views === null ? [el('p', 'muted', t('board.loading'))] : views.length === 0 ? [el('p', 'muted', t('settings.branches.empty'))] : views.map((view) => row(view, now, busy));
    body.replaceChildren();
    append(body, [el('p', 'setting-hint muted', t('settings.branches.hint')), status ? el('p', `settings-status ${status.kind}`, status.text) : null, ...rows]);
  };

  const row = (view: DeletedBranchView, now: number, busy: boolean): HTMLElement => {
    const blocked = blockedKey(view);
    const restore = button(t('settings.branches.restore'), '', blocked ? t(blocked) : '');
    restore.disabled = busy || blocked !== null;
    restore.setAttribute('aria-label', t('settings.branches.restoreLabel', { branch: view.branch }));
    restore.addEventListener('click', () => void restoreBranch(view));
    return el(
      'div',
      'setting-row deleted-branch',
      el('span', 'setting-text', el('code', 'setting-label', view.branch), el('span', 'setting-hint muted', `${shortSha(view.sha)} · ${relativeTime(view.at, now)}`)),
      el('span', 'worktree-actions', restore),
    );
  };

  const load = async (): Promise<void> => {
    const result = await ctx.api.deletedBranches(floor);
    const current = state();
    if (result.ok) current.views = result.data.branches;
    else {
      current.views ??= [];
      current.status = { kind: 'error', text: result.message };
    }
    if (root.isConnected) paint();
  };

  const restoreBranch = async (view: DeletedBranchView): Promise<void> => {
    const current = state();
    if (current.busy) return;
    current.busy = true;
    current.status = null;
    paint();
    const result = await ctx.api.restoreBranch(floor, view.branch, view.sha);
    current.busy = false;
    current.status = result.ok ? { kind: 'ok', text: t('settings.branches.restored', { branch: view.branch, sha: shortSha(view.sha) }) } : { kind: 'error', text: result.message };
    await load();
  };

  ctx.reload.set(floor, load);
  root.open = ctx.open.has(floor);
  root.addEventListener('toggle', () => {
    if (!root.open) {
      ctx.open.delete(floor);
      return;
    }
    ctx.open.add(floor);
    state().status = null;
    paint();
    void load();
  });
  paint();
  return root;
}
