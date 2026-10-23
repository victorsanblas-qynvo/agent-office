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

export function restorableCount(views: readonly DeletedBranchView[]): number {
  return views.filter((view) => view.restorable).length;
}
