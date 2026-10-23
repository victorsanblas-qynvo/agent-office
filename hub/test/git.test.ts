import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSync, runCommand, runGit } from '../src/git';
import { runGh } from '../src/repo-ops';
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The pid a command wrote, and whether it is still running a second later.
async function survivor(pidFile: string): Promise<boolean> {
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(pid).toBeGreaterThan(0);
  cleanups.push(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const until = Date.now() + 1000;
  while (alive(pid) && Date.now() < until) await Bun.sleep(25);
  return alive(pid);
}

// A command that leaves a child holding its stdout and stderr and writes that child's pid.
function hanging(pidFile: string): string {
  return `sleep 30 & echo $! > '${pidFile}'; sleep 30`;
}

describe('process group', () => {
  test('a timeout returns in time and takes down a child that holds the pipes', async () => {
    const pidFile = join(temp(), 'pid');
    const started = Date.now();
    const result = await runCommand(['/bin/sh', '-c', hanging(pidFile)], { env: process.env, timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.code).not.toBe(0);
    expect(await survivor(pidFile)).toBe(false);
  }, 10_000);

  test('a cap stops reading, says it cut and takes down the whole group', async () => {
    const pidFile = join(temp(), 'pid');
    const started = Date.now();
    const result = await runCommand(['/bin/sh', '-c', `sleep 30 & echo $! > '${pidFile}'; yes`], {
      env: process.env,
      timeoutMs: 10_000,
      maxStdoutBytes: 1000,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ code: 0, cut: true, stdout: 'y\n'.repeat(500) });
    expect(await survivor(pidFile)).toBe(false);
  }, 10_000);

  test('runGit times out on a git whose child keeps the pipes open', async () => {
    const root = temp();
    const repo = makeRepo(root, 'repo');
    git(repo, 'init', '-q', '-b', 'develop');
    const pidFile = join(root, 'pid');
    const started = Date.now();
    const result = await runGit(repo, ['-c', `alias.hang=!${hanging(pidFile)}`, 'hang'], 500);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.code).not.toBe(0);
    expect(await survivor(pidFile)).toBe(false);
  }, 10_000);

  test('runGh times out on a gh whose child keeps the pipes open', async () => {
    const root = temp();
    const bin = makeRepo(root, 'bin');
    const pidFile = join(root, 'pid');
    const script = join(bin, 'gh');
    writeFileSync(script, `#!/bin/sh\n${hanging(pidFile)}\n`);
    chmodSync(script, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ''}`;
    const started = Date.now();
    try {
      const result = await runGh(root, ['auth', 'status'], 500);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result.code).not.toBe(0);
    } finally {
      process.env.PATH = previous;
    }
    expect(await survivor(pidFile)).toBe(false);
  }, 10_000);
});

describe('gitSync', () => {
  test('ignores a GIT_DIR or GIT_INDEX_FILE of the environment and reads the repository of cwd', () => {
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
      expect(gitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatchObject({ code: 0, stdout: 'develop\n' });
      expect(gitSync(repo, ['ls-files'])).toMatchObject({ code: 0, stdout: 'a.txt\n' });
    } finally {
      names.forEach((name, i) => {
        const value = previous[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});
