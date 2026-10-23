import { validBranch } from './config';
import { runCommand, type GitLimits, type GitResult, type GitRunner } from './git';

// The delivery cycle runs git and gh with values that come from the database, the panel or an agent. Nothing
// here builds a shell line: every function returns a fixed argv after checking each value, so a value can
// never become an option or reach outside the repository.
export class RepoOpError extends Error {}

export const ORDER_BRANCH_PREFIX = 'encargo/';
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const MAX_PATH = 1000;

export function validSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

export function validSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

// Any branch the hub may read or name as a base.
export function validRef(value: unknown): value is string {
  return validBranch(value);
}

// The only branches the hub writes to: the ones it created for an order.
export function validOrderBranch(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ORDER_BRANCH_PREFIX) && validBranch(value) && validSlug(value.slice(ORDER_BRANCH_PREFIX.length));
}

export function orderBranch(slug: string): string {
  if (!validSlug(slug)) throw new RepoOpError(`slug no válido: ${slug}`);
  return `${ORDER_BRANCH_PREFIX}${slug}`;
}

function ref(value: string, what: string): string {
  if (!validRef(value)) throw new RepoOpError(`${what} no válida: ${value}`);
  return value;
}

function sha(value: string): string {
  if (!validSha(value)) throw new RepoOpError(`sha no válido: ${value}`);
  return value;
}

function writable(branch: string): string {
  if (!validOrderBranch(branch)) throw new RepoOpError(`solo se escribe en ramas encargo/<slug>: ${branch}`);
  return branch;
}

// A path inside the repository: relative, no .. and not an option.
export function repoPath(value: string): string {
  if (value.startsWith('-')) throw new RepoOpError(`ruta no válida: ${value}`);
  return pathspecPath(value);
}

// A path that only ever goes after -- as :(literal)<path>: git cannot read it as an option, so it may start with -.
export function pathspecPath(value: string): string {
  if (!value || value.length > MAX_PATH || value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) {
    throw new RepoOpError(`ruta no válida: ${value}`);
  }
  return value;
}

// A folder outside the repository (a worktree): absolute and not an option.
export function absolutePath(value: string): string {
  if (!value || value.length > MAX_PATH || !value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) {
    throw new RepoOpError(`carpeta no válida: ${value}`);
  }
  return value;
}

// Paths that appear in the numstat of the order: the diff of a file is only asked for one the order changed.
export function numstatPath(value: string, inNumstat: ReadonlySet<string>): string {
  if (!inNumstat.has(value)) throw new RepoOpError(`la ruta no está en el diff: ${value}`);
  return pathspecPath(value);
}

// The output of a diff the hub parses or shows, whatever the user's config says about colour, external
// drivers, textconv filters or prefixes.
const PINNED_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
// Two of these diffs are equal text only when every file goes between the same blobs, binary ones included.
const EXACT_DIFF = [...PINNED_DIFF, '--no-renames', '--full-index', '--binary'];

function literal(paths: readonly string[]): string[] {
  return paths.map((path) => `:(literal)${pathspecPath(path)}`);
}

export const gitOps = {
  fetch: (base: string): string[] => ['fetch', '--quiet', 'origin', ref(base, 'rama')],
  verify: (name: string): string[] => ['rev-parse', '--verify', '--quiet', `${ref(name, 'rama')}^{commit}`],
  head: (): string[] => ['rev-parse', 'HEAD'],
  commonDir: (): string[] => ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  gitDir: (): string[] => ['rev-parse', '--path-format=absolute', '--git-dir'],
  worktreeAdd: (branch: string, path: string, baseSha: string): string[] => ['worktree', 'add', '-q', '-b', writable(branch), absolutePath(path), sha(baseSha)],
  worktreeRemove: (path: string, force: boolean): string[] => ['worktree', 'remove', ...(force ? ['--force'] : []), absolutePath(path)],
  worktreePrune: (): string[] => ['worktree', 'prune'],
  worktreeList: (): string[] => ['worktree', 'list', '--porcelain'],
  branchDelete: (branch: string, force: boolean): string[] => ['branch', force ? '-D' : '-d', writable(branch)],
  // Deletes the branch only while it still points at the commit that was judged.
  branchDeleteAt: (branch: string, tip: string): string[] => ['update-ref', '-d', `refs/heads/${writable(branch)}`, sha(tip)],
  // Creates the branch only while no branch of that name exists (the zero old value).
  branchCreateAt: (branch: string, tip: string): string[] => ['update-ref', `refs/heads/${writable(branch)}`, sha(tip), '0'.repeat(40)],
  commitExists: (commit: string): string[] => ['rev-parse', '--verify', '--quiet', `${sha(commit)}^{commit}`],
  branchTip: (branch: string): string[] => ['rev-parse', '--verify', '--quiet', `refs/heads/${ref(branch, 'rama')}^{commit}`],
  branchExists: (branch: string): string[] => ['rev-parse', '--verify', '--quiet', `refs/heads/${ref(branch, 'rama')}`],
  status: (): string[] => ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'],
  addFromStdin: (): string[] => ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
  stagedNames: (): string[] => ['diff', '--cached', '--name-only', '-z'],
  commit: (message: string): string[] => {
    if (!message || message.length > 300 || message.includes('\0')) throw new RepoOpError('mensaje de commit no válido');
    return ['commit', '-q', '-m', message];
  },
  aheadBehind: (base: string, head: string): string[] => ['rev-list', '--left-right', '--count', `${sha(base)}...${sha(head)}`],
  isAncestor: (ancestor: string, descendant: string): string[] => ['merge-base', '--is-ancestor', sha(ancestor), ref(descendant, 'rama')],
  cherry: (upstream: string, head: string, limit: string): string[] => ['cherry', sha(upstream), sha(head), sha(limit)],
  diffPatch: (base: string, head: string, paths: readonly string[] = []): string[] => ['diff', ...EXACT_DIFF, sha(base), sha(head), '--', ...literal(paths)],
  commitPatch: (commit: string, paths: readonly string[] = []): string[] => ['diff', ...EXACT_DIFF, `${sha(commit)}^`, sha(commit), '--', ...literal(paths)],
  logPatches: (base: string, head: string, paths: readonly string[] = []): string[] => [
    'log',
    '-p',
    '--no-merges',
    ...EXACT_DIFF,
    '--format=commit %H',
    `${sha(base)}..${sha(head)}`,
    '--',
    ...literal(paths),
  ],
  patchIds: (): string[] => ['patch-id', '--stable'],
  diffNames: (baseSha: string, head: string): string[] => ['diff', '--name-only', '-z', sha(baseSha), sha(head), '--'],
  diffNumstat: (base: string, head: string): string[] => ['diff', ...PINNED_DIFF, '-z', '--numstat', '--find-renames', `${sha(base)}...${sha(head)}`, '--'],
  diffFile: (base: string, head: string, path: string, oldPath: string | null = null): string[] => [
    'diff',
    ...PINNED_DIFF,
    '--find-renames',
    `${sha(base)}...${sha(head)}`,
    '--',
    ...(oldPath !== null && oldPath !== path ? [`:(literal)${pathspecPath(oldPath)}`] : []),
    `:(literal)${pathspecPath(path)}`,
  ],
  logSubjects: (base: string, head: string, max: number): string[] => [
    'log',
    '--no-color',
    '--no-show-signature',
    '--no-merges',
    '--reverse',
    `--max-count=${Math.max(1, Math.min(500, Math.trunc(max)))}`,
    '--format=%s',
    `${sha(base)}..${sha(head)}`,
    '--',
  ],
  revCount: (base: string, head: string): string[] => ['rev-list', '--count', '--no-merges', `${sha(base)}..${sha(head)}`, '--'],
  show: (revision: string, path: string): string[] => ['show', `${sha(revision)}:${repoPath(path)}`],
  checkIgnore: (): string[] => ['check-ignore', '-z', '--stdin'],
  logOneLine: (baseSha: string, branch: string, max: number): string[] => [
    'log',
    `--max-count=${Math.max(1, Math.min(200, Math.trunc(max)))}`,
    '--format=%h %s',
    `${sha(baseSha)}..${writable(branch)}`,
  ],
};

export const ghOps = {
  authStatus: (): string[] => ['auth', 'status'],
  prCreate: (branch: string, base: string, title: string): string[] => {
    if (!title || title.length > 256 || title.startsWith('-')) throw new RepoOpError('título de PR no válido');
    return ['pr', 'create', '--head', writable(branch), '--base', ref(base, 'rama'), '--title', title, '--body-file', '-'];
  },
};

export type GhRunner = (cwd: string, args: string[], timeoutMs?: number, input?: string) => Promise<GitResult>;

export const runGh: GhRunner = (cwd, args, timeoutMs = 60_000, input) =>
  runCommand(['gh', ...args], {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
    input,
    timeoutMs,
  });

// Runs a constructor from this module; a value the constructor refuses comes back as a failed result.
export async function run(runner: GitRunner, cwd: string, build: () => string[], timeoutMs?: number, input?: string, limits?: GitLimits): Promise<GitResult> {
  let argv: string[];
  try {
    argv = build();
  } catch (error) {
    if (error instanceof RepoOpError) return { code: -1, stdout: '', stderr: error.message };
    throw error;
  }
  return runner(cwd, argv, timeoutMs, input, limits);
}

// NUL-separated names of git -z, without the empty tail.
export function zList(stdout: string): string[] {
  return stdout.split('\0').filter((name) => name !== '');
}

export type NumstatEntry = { path: string; oldPath: string | null; adds: number | null; dels: number | null; binary: boolean };

// git diff -z --numstat: "adds\tdels\tpath\0", or "adds\tdels\t\0old\0new\0" for a rename; a binary file counts "-\t-".
export function parseNumstat(stdout: string): NumstatEntry[] {
  const parts = stdout.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i] ?? '');
    if (!match) continue;
    let path = match[3] ?? '';
    let oldPath: string | null = null;
    if (path === '') {
      oldPath = parts[i + 1] ?? '';
      path = parts[i + 2] ?? '';
      i += 2;
      if (!oldPath || !path) continue;
    }
    const adds = match[1] === '-' ? null : Number(match[1]);
    const dels = match[2] === '-' ? null : Number(match[2]);
    entries.push({ path, oldPath, adds, dels, binary: adds === null && dels === null });
  }
  return entries;
}
