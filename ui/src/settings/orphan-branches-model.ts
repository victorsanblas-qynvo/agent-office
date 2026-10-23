import type { OrphanBranchView } from '../types';

// The two commands the panel offers to copy for an orphan branch; the hub only lists names git and validBranch accept.
export function orphanCommands(branch: string, base: string): { delete: string; log: string } {
  return { delete: `git branch -D ${branch}`, log: `git log --oneline ${base}..${branch}` };
}

// «+3 −1» in the order of the sentence: commits only in the branch, then only in the base; «?» where git could not count.
export function aheadBehindText(view: Pick<OrphanBranchView, 'ahead' | 'behind'>): string {
  return `+${view.ahead ?? '?'} −${view.behind ?? '?'}`;
}
