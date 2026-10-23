export type Editor = 'vscode' | 'cursor' | 'zed' | 'none';

export const EDITORS: readonly Editor[] = ['vscode', 'cursor', 'zed', 'none'];

const SCHEMES: Record<Exclude<Editor, 'none'>, string> = { vscode: 'vscode', cursor: 'cursor', zed: 'zed' };

// A link that opens `path` (relative to the worktree `root`) in the editor; null when there is nowhere safe to point.
export function editorLink(editor: Editor, root: string | null | undefined, path: string, line?: number): string | null {
  if (editor === 'none' || !root || !root.startsWith('/')) return null;
  if (path === '' || path.startsWith('/')) return null;
  const segments = path.split('/');
  if (segments.includes('..')) return null;
  const parts = [...root.split('/'), ...segments].filter((part) => part !== '' && part !== '.');
  const target = parts.map(encodeURIComponent).join('/');
  const suffix = line !== undefined && Number.isInteger(line) && line > 0 ? `:${line}` : '';
  return `${SCHEMES[editor]}://file/${target}${suffix}`;
}
