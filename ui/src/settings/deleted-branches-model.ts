import type { MessageKey } from '../i18n';
import type { DeletedBranchView } from '../types';

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// Why Restaurar is off for a branch, as a dictionary key; null when it can come back.
export function blockedKey(view: DeletedBranchView): MessageKey | null {
  if (view.restorable) return null;
  return `settings.branches.blocked.${view.reason ?? 'unknown'}`;
}

export const RELOAD_GAP_MS = 10_000;
export const RELOAD_DEBOUNCE_MS = 400;

// How long to wait before reloading the open lists after a worktrees event: the debounce, stretched to keep a gap since the last reload.
export function reloadDelay(lastReload: number, now: number): number {
  return Math.max(RELOAD_DEBOUNCE_MS, lastReload + RELOAD_GAP_MS - now);
}

export function restorableCount(views: readonly DeletedBranchView[]): number {
  return views.filter((view) => view.restorable).length;
}
