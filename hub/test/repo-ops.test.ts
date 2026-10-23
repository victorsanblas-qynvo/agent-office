import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globMatches, matchesAny } from '../src/glob';
import { runGit } from '../src/git';
import {
  RepoOpError,
  ghOps,
  gitOps,
  numstatPath,
  orderBranch,
  parseNumstat,
  pathspecPath,
  repoPath,
  run,
  runGh,
  validOrderBranch,
  validSha,
  validSlug,
  zList,
} from '../src/repo-ops';
import { git, makeRepo, tempDir, useGitIdentity } from './helpers';

useGitIdentity();

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function temp(): string {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  return dir;
}

describe('validators', () => {
  test('slugs, shas and order branches', () => {
    expect(validSlug('login-a1b2')).toBe(true);
    expect(validSlug('-login')).toBe(false);
    expect(validSlug('Login')).toBe(false);
    expect(validSlug('a/b')).toBe(false);
    expect(validSlug('x'.repeat(62))).toBe(false);
    expect(validSha('abc1234')).toBe(true);
    expect(validSha('abc123')).toBe(false);
    expect(validSha('--output=x')).toBe(false);
    expect(validSha('A'.repeat(40))).toBe(false);
    expect(validOrderBranch('encargo/login-a1b2')).toBe(true);
    expect(validOrderBranch('develop')).toBe(false);
    expect(validOrderBranch('feature/encargo/x')).toBe(false);
    expect(validOrderBranch('encargo/-x')).toBe(false);
    expect(validOrderBranch('encargo/x..y')).toBe(false);
    expect(orderBranch('login-a1b2')).toBe('encargo/login-a1b2');
    expect(() => orderBranch('../x')).toThrow(RepoOpError);
  });

  test('paths stay inside the repository and never look like options', () => {
    expect(repoPath('lib/a.dart')).toBe('lib/a.dart');
    for (const bad of ['', '-rf', '/etc/passwd', '../x', 'a/../../b', 'a\0b']) expect(() => repoPath(bad)).toThrow(RepoOpError);
    const listed = new Set(['lib/a.dart']);
    expect(numstatPath('lib/a.dart', listed)).toBe('lib/a.dart');
    expect(() => numstatPath('lib/b.dart', listed)).toThrow(RepoOpError);
  });

  test('a path read as :(literal) after -- may start with a dash and keeps the other rules', () => {
    expect(pathspecPath('-dash.txt')).toBe('-dash.txt');
    expect(pathspecPath('lib/-x/a b.dart')).toBe('lib/-x/a b.dart');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a\0b', 'x'.repeat(1001)]) expect(() => pathspecPath(bad)).toThrow(RepoOpError);
    expect(() => repoPath('-dash.txt')).toThrow(RepoOpError);
    expect(numstatPath('-dash.txt', new Set(['-dash.txt']))).toBe('-dash.txt');
  });
});

describe('git argv constructors', () => {
  test('writes only reach encargo/ branches', () => {
    expect(gitOps.branchDelete('encargo/x', false)).toEqual(['branch', '-d', 'encargo/x']);
    expect(gitOps.branchDelete('encargo/x', true)).toEqual(['branch', '-D', 'encargo/x']);
    expect(() => gitOps.branchDelete('develop', true)).toThrow(RepoOpError);
    expect(() => gitOps.branchDelete('-D', false)).toThrow(RepoOpError);
    expect(() => gitOps.worktreeAdd('develop', '/tmp/x', 'abcdef1')).toThrow(RepoOpError);
  });

  test('values that start with a dash are refused everywhere', () => {
    expect(() => gitOps.fetch('--upload-pack=x')).toThrow(RepoOpError);
    expect(() => gitOps.verify('-x')).toThrow(RepoOpError);
    expect(() => gitOps.worktreeAdd('encargo/x', '-x', 'abcdef1')).toThrow(RepoOpError);
    expect(() => gitOps.worktreeAdd('encargo/x', 'relative', 'abcdef1')).toThrow(RepoOpError);
    expect(() => gitOps.worktreeAdd('encargo/x', '/tmp/x', '--detach')).toThrow(RepoOpError);
    expect(() => gitOps.diffNames('abcdef1', '-p')).toThrow(RepoOpError);
    expect(() => gitOps.show('abcdef1', '-x')).toThrow(RepoOpError);
    expect(() => gitOps.commit('')).toThrow(RepoOpError);
    expect(() => gitOps.worktreeRemove('/tmp/x/../y', false)).toThrow(RepoOpError);
  });

  test('the fixed argv of the common operations', () => {
    expect(gitOps.fetch('develop')).toEqual(['fetch', '--quiet', 'origin', 'develop']);
    expect(gitOps.worktreeAdd('encargo/x', '/r/.claude/worktrees/office-x', 'abcdef1')).toEqual([
      'worktree', 'add', '-q', '-b', 'encargo/x', '/r/.claude/worktrees/office-x', 'abcdef1',
    ]);
    expect(gitOps.aheadBehind('abcdef1', 'encargo/x')).toEqual(['rev-list', '--left-right', '--count', 'abcdef1...encargo/x']);
    expect(gitOps.addFromStdin()).toEqual(['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
    expect(gitOps.logOneLine('abcdef1', 'encargo/x', 9999)).toContain('--max-count=200');
  });

  test('run turns a refused value into a failed result instead of throwing', async () => {
    const calls: string[][] = [];
    const runner = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };
    const refused = await run(runner, '/r', () => gitOps.branchDelete('develop', true));
    expect(refused.code).toBe(-1);
    expect(refused.stderr).toContain('encargo/');
    expect(calls).toEqual([]);
    expect((await run(runner, '/r', () => gitOps.head())).code).toBe(0);
    expect(calls).toEqual([['rev-parse', 'HEAD']]);
  });

  test('the diff of an order compares from the merge base and reads every path literally', () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const pinned = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
    expect(gitOps.diffNumstat(base, head)).toEqual(['diff', ...pinned, '-z', '--numstat', '--find-renames', `${base}...${head}`, '--']);
    expect(gitOps.diffFile(base, head, 'lib/a.dart')).toEqual(['diff', ...pinned, '--find-renames', `${base}...${head}`, '--', ':(literal)lib/a.dart']);
    expect(gitOps.diffFile(base, head, 'lib/b.dart', 'lib/a.dart').slice(-2)).toEqual([':(literal)lib/a.dart', ':(literal)lib/b.dart']);
    expect(gitOps.diffFile(base, head, ':!x').at(-1)).toBe(':(literal):!x');
    expect(gitOps.diffFile(base, head, '-dash.txt', '--old').slice(-2)).toEqual([':(literal)--old', ':(literal)-dash.txt']);
    expect(() => gitOps.diffNumstat('develop', head)).toThrow(RepoOpError);
    expect(() => gitOps.diffNumstat(base, '--output=x')).toThrow(RepoOpError);
    expect(() => gitOps.diffFile(base, head, '../x')).toThrow(RepoOpError);
    expect(() => gitOps.diffFile(base, head, 'a', '/etc/passwd')).toThrow(RepoOpError);
  });

  test('the commit log of an order is oldest first, without merges, signatures or colour', () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    expect(gitOps.logSubjects(base, head, 9999)).toEqual([
      'log',
      '--no-color',
      '--no-show-signature',
      '--no-merges',
      '--reverse',
      '--max-count=500',
      '--format=%s',
      `${base}..${head}`,
      '--',
    ]);
    expect(gitOps.revCount(base, head)).toEqual(['rev-list', '--count', '--no-merges', `${base}..${head}`, '--']);
    expect(() => gitOps.revCount('develop', head)).toThrow(RepoOpError);
    expect(() => gitOps.revCount(base, '--all')).toThrow(RepoOpError);
  });

  test('parseNumstat reads counts, renames and binaries of a -z numstat', () => {
    const stdout = ['3\t1\tlib/a.dart', '-\t-\tlogo.png', '0\t0\t', 'old name.txt', 'new\tname.txt', '12\t0\tb.txt', ''].join('\0');
    expect(parseNumstat(stdout)).toEqual([
      { path: 'lib/a.dart', oldPath: null, adds: 3, dels: 1, binary: false },
      { path: 'logo.png', oldPath: null, adds: null, dels: null, binary: true },
      { path: 'new\tname.txt', oldPath: 'old name.txt', adds: 0, dels: 0, binary: false },
      { path: 'b.txt', oldPath: null, adds: 12, dels: 0, binary: false },
    ]);
    expect(parseNumstat('')).toEqual([]);
  });

  test('a real numstat of a branch shows the rename and the binary file', async () => {
    const root = temp();
    const repo = makeRepo(root, 'repo', { 'old.txt': 'uno\ndos\ntres\ncuatro\n', 'keep.txt': 'a\n' });
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'inicio');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'mv', 'old.txt', 'new.txt');
    writeFileSync(join(repo, 'keep.txt'), 'a\nb\n');
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'cambios');
    const head = git(repo, 'rev-parse', 'HEAD');
    const numstat = await run(runGit, repo, () => gitOps.diffNumstat(base, head));
    expect(numstat.code).toBe(0);
    expect(parseNumstat(numstat.stdout).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'keep.txt', oldPath: null, adds: 1, dels: 0, binary: false },
      { path: 'logo.bin', oldPath: null, adds: null, dels: null, binary: true },
      { path: 'new.txt', oldPath: 'old.txt', adds: 0, dels: 0, binary: false },
    ]);
    const patch = await run(runGit, repo, () => gitOps.diffFile(base, head, 'new.txt', 'old.txt'));
    expect(patch.stdout).toContain('rename from old.txt');
    expect(patch.stdout).toContain('rename to new.txt');
  });

  test('zList drops the empty tail of a NUL list', () => {
    expect(zList('a\0b c\0')).toEqual(['a', 'b c']);
    expect(zList('')).toEqual([]);
  });

  test('runGit feeds the input to stdin and a real worktree add stays on its branch', async () => {
    const root = temp();
    const repo = makeRepo(root, 'repo', { 'a.txt': 'a\n' });
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'inicio');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    const added = await runGit(repo, gitOps.addFromStdin(), 10_000, 'b.txt\0');
    expect(added.code).toBe(0);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('b.txt');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const wt = join(root, 'wt');
    const created = await run(runGit, repo, () => gitOps.worktreeAdd('encargo/x', wt, sha));
    expect(created.code).toBe(0);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('encargo/x');
  });

  test('runGit with a cap stops reading a large output, kills git and says it cut it', async () => {
    const root = temp();
    const repo = makeRepo(root, 'repo', { 'big.txt': `${'x'.repeat(99)}\n`.repeat(50_000) });
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'inicio');
    const whole = await runGit(repo, ['show', 'HEAD:big.txt']);
    expect(whole).toMatchObject({ code: 0 });
    expect(whole.stdout.length).toBe(5_000_000);
    expect(whole.cut).toBeUndefined();
    const cut = await runGit(repo, ['show', 'HEAD:big.txt'], 10_000, undefined, { maxStdoutBytes: 100_000 });
    expect(cut).toMatchObject({ code: 0, cut: true });
    expect(Buffer.byteLength(cut.stdout)).toBeLessThanOrEqual(100_000);
    expect(Buffer.byteLength(cut.stdout)).toBeGreaterThan(90_000);
    const small = await runGit(repo, ['rev-parse', 'HEAD'], 10_000, undefined, { maxStdoutBytes: 100_000 });
    expect(small).toMatchObject({ code: 0, stdout: `${git(repo, 'rev-parse', 'HEAD')}\n` });
    expect(small.cut).toBeUndefined();
  });

  test('a cap cuts a multibyte character out instead of breaking it', async () => {
    const root = temp();
    const repo = makeRepo(root, 'repo', { 'n.txt': 'ñ'.repeat(10_000) });
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'inicio');
    const cut = await runGit(repo, ['show', 'HEAD:n.txt'], 10_000, undefined, { maxStdoutBytes: 1001 });
    expect(cut).toMatchObject({ code: 0, cut: true, stdout: 'ñ'.repeat(500) });
  });

  test('runGit ignores a GIT_DIR or GIT_INDEX_FILE of the environment and reads the repository of cwd', async () => {
    const root = temp();
    const repo = makeRepo(root, 'repo', { 'a.txt': 'a\n' });
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'inicio');
    const other = makeRepo(root, 'other', { 'b.txt': 'b\n' });
    git(other, 'init', '-q', '-b', 'main');
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'] as const;
    const previous = names.map((name) => process.env[name]);
    Object.assign(process.env, {
      GIT_DIR: join(other, '.git'),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'),
    });
    try {
      expect(await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatchObject({ code: 0, stdout: 'develop\n' });
      expect(await runGit(repo, ['ls-files'])).toMatchObject({ code: 0, stdout: 'a.txt\n' });
    } finally {
      names.forEach((name, i) => {
        const value = previous[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});

describe('gh', () => {
  test('prCreate reads the body from stdin and is refused for other branches', () => {
    expect(ghOps.prCreate('encargo/x', 'develop', 'Login')).toEqual([
      'pr', 'create', '--head', 'encargo/x', '--base', 'develop', '--title', 'Login', '--body-file', '-',
    ]);
    expect(() => ghOps.prCreate('develop', 'develop', 'x')).toThrow(RepoOpError);
    expect(() => ghOps.prCreate('encargo/x', 'develop', '--web')).toThrow(RepoOpError);
  });

  test('runGh sends the body by stdin to the gh found on PATH and disables prompts', async () => {
    const root = temp();
    const bin = join(root, 'bin');
    makeRepo(root, 'bin');
    const out = join(root, 'seen.txt');
    const script = join(bin, 'gh');
    writeFileSync(script, `#!/bin/sh\nprintf '%s|' "$@" > ${out}\nprintf 'prompt=%s|' "$GH_PROMPT_DISABLED" >> ${out}\ncat >> ${out}\nprintf 'https://github.com/o/r/pull/1\\n'\n`);
    chmodSync(script, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ''}`;
    try {
      const result = await runGh(root, ghOps.prCreate('encargo/x', 'develop', 'Login'), 10_000, 'cuerpo de la PR');
      expect(result).toMatchObject({ code: 0, stdout: 'https://github.com/o/r/pull/1\n' });
    } finally {
      process.env.PATH = previous;
    }
    expect(readFileSync(out, 'utf8')).toBe('pr|create|--head|encargo/x|--base|develop|--title|Login|--body-file|-|prompt=1|cuerpo de la PR');
  });

  test('runGh without gh installed is a failed result', async () => {
    const previous = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      expect((await runGh('/', ['auth', 'status'])).code).not.toBe(0);
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe('glob', () => {
  test('a pattern without a slash matches the name anywhere, ** crosses folders and * does not', () => {
    expect(globMatches('*.log', 'a/b/debug.log')).toBe(true);
    expect(globMatches('tsconfig*.json', 'packages/x/tsconfig.build.json')).toBe(true);
    expect(globMatches('vitest.config.*', 'vitest.config.ts')).toBe(true);
    expect(globMatches('lib/*.dart', 'lib/a.dart')).toBe(true);
    expect(globMatches('lib/*.dart', 'lib/src/a.dart')).toBe(false);
    expect(globMatches('lib/**/*.dart', 'lib/src/deep/a.dart')).toBe(true);
    expect(globMatches('Screenshot*', 'Screenshot 2026-10-17 at 10.00.png')).toBe(true);
    expect(globMatches('a?.txt', 'ab.txt')).toBe(true);
    expect(globMatches('a.b', 'axb')).toBe(false);
    expect(matchesAny(['*.dump', '*.log'], 'x/y.log')).toBe(true);
    expect(matchesAny([], 'x')).toBe(false);
  });
});
