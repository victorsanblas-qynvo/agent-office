import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointDesk } from '../src/checkpoints';
import { defaultConfig } from '../src/config';
import { openDb } from '../src/db';
import { realPath } from '../src/floors';
import { runGit } from '../src/git';
import { renderHubText } from '../src/render-text';
import { OfficeBus } from '../src/office-bus';
import { OrderStore, type OrderRow } from '../src/order-store';
import type { ShellResult } from '../src/shell';
import type { ActivityView, OfficeConfig } from '../src/types';
import { WorktreeDesk, withExcludes, type WorktreeDeskOpts } from '../src/worktrees';
import { deskRig, type DeskRig } from './desk-rig';
import { git, originAndClone, pushCommit, tempDir, useGitIdentity } from './helpers';

useGitIdentity();

type Rig = {
  desk: WorktreeDesk;
  db: Database;
  bus: OfficeBus;
  store: OrderStore;
  config: OfficeConfig;
  repo: string;
  seed: string;
  origin: string;
  root: string;
  activity: ActivityView[];
  changed: OrderRow[];
  clock: { now: number };
  inside: { paths: string[] };
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function rig(overrides: Partial<WorktreeDeskOpts> = {}, tweak: (config: OfficeConfig) => void = () => {}): Rig {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const { seed, origin, repo } = originAndClone(dir);
  const config = defaultConfig();
  config.floors.mobile = { path: repo, stack: 'generic', managed: true, baseBranch: 'develop' };
  tweak(config);
  const db = openDb(':memory:');
  const store = new OrderStore(db);
  const bus = new OfficeBus(() => {});
  const activity: ActivityView[] = [];
  bus.subscribe((msg) => {
    if (msg.type === 'activity') activity.push(msg.data);
  });
  const changed: OrderRow[] = [];
  const clock = { now: 1_800_000_000_000 };
  const inside = { paths: [] as string[] };
  const desk = new WorktreeDesk({
    store,
    git: runGit,
    now: () => clock.now,
    bus,
    config: () => config,
    hubId: 'hub-test',
    inside: (path) => inside.paths.includes(path),
    changed: (order) => changed.push(order),
    sizeOf: async () => 120,
    ...overrides,
  });
  return { desk, db, bus, store, config, repo, seed, origin, root: dir, activity, changed, clock, inside };
}

function order(r: Rig, slug = 'login-a1b2', floor = 'mobile'): OrderRow {
  return r.store.insert({ slug, floor, title: 'Login', source: 'director', now: r.clock.now });
}

const created = async (r: Rig, row = order(r)) => {
  const result = await r.desk.create(row);
  if (!result.ok) throw new Error(`create failed: ${result.error} ${result.detail}`);
  await result.ready;
  return result.order;
};

function work(path: string, file: string, message: string): void {
  writeFileSync(join(path, file), `${message}\n`);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', message);
}

// The branch lands on develop of the remote the way GitHub would merge it; the clone does not know until it fetches.
function landOnRemote(r: Rig, made: OrderRow, how: 'merge' | 'squash' | 'rebase'): void {
  git(r.seed, 'fetch', '-q', r.repo, made.branch as string);
  if (how === 'merge') git(r.seed, 'merge', '-q', '--no-ff', '-m', 'Merge pull request', 'FETCH_HEAD');
  if (how === 'squash') {
    git(r.seed, 'merge', '-q', '--squash', 'FETCH_HEAD');
    git(r.seed, 'commit', '-q', '-m', 'Squashed pull request');
  }
  if (how === 'rebase') git(r.seed, 'cherry-pick', `${made.base_sha}..FETCH_HEAD`);
  git(r.seed, 'push', '-q', r.origin, 'develop');
}

describe('create', () => {
  test('branches from origin/<base> after a fetch, with the marker and the exclude line', async () => {
    const r = rig();
    const fresh = pushCommit(r.seed, r.origin, 'nuevo.txt', 'x', 'llega a origin');
    const made = await created(r);
    const path = join(realPath(r.repo), '.claude', 'worktrees', 'office-login-a1b2');
    expect(made).toMatchObject({ branch: 'encargo/login-a1b2', base_ref: 'origin/develop', base_sha: fresh, base_stale: 0, worktree_path: path, worktree_state: 'listo' });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(fresh);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('encargo/login-a1b2');
    expect(existsSync(join(path, 'nuevo.txt'))).toBe(true);
    const adminDir = git(path, 'rev-parse', '--absolute-git-dir');
    expect(readFileSync(join(adminDir, 'office-hub'), 'utf8').trim()).toBe('hub-test');
    expect(r.changed.length).toBeGreaterThan(0);
  });

  test('the exclude line is written once however many folders are created', async () => {
    const r = rig();
    await created(r, order(r, 'uno-1111'));
    await created(r, order(r, 'dos-2222'));
    const exclude = readFileSync(join(git(r.repo, 'rev-parse', '--absolute-git-dir'), 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '/.claude/worktrees/')).toHaveLength(1);
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
  });

  test('a failed fetch falls back to the local base and marks it stale', async () => {
    const r = rig();
    git(r.repo, 'branch', 'develop-local', 'origin/develop');
    git(r.repo, 'remote', 'set-url', 'origin', join(r.root, 'does-not-exist.git'));
    r.config.floors.mobile.baseBranch = 'develop';
    git(r.repo, 'branch', '-f', 'develop', 'origin/develop');
    const made = await created(r);
    expect(made).toMatchObject({ base_ref: 'develop', base_stale: 1 });
    expect(made.base_sha).toBe(git(r.repo, 'rev-parse', 'develop'));
  });

  test('a base that does not exist creates nothing', async () => {
    const r = rig();
    r.config.floors.mobile.baseBranch = 'no-existe';
    const result = await r.desk.create(order(r));
    expect(result).toMatchObject({ ok: false, error: 'base' });
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toBe('');
    expect(existsSync(join(r.repo, '.claude'))).toBe(false);
    expect(r.store.bySlug('login-a1b2')?.worktree_path).toBeNull();
  });

  test('an empty repository touches nothing', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const repo = join(dir, 'vacio');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'develop');
    const r = rig({}, (config) => {
      config.floors.mobile.path = repo;
    });
    expect(await r.desk.create(order(r))).toMatchObject({ ok: false, error: 'base' });
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  test('the cap of active folders per floor stops the next one', async () => {
    const r = rig({}, (config) => {
      config.worktrees.maxActivePerFloor = 2;
    });
    await created(r, order(r, 'a-1111'));
    await created(r, order(r, 'b-2222'));
    expect(await r.desk.create(order(r, 'c-3333'))).toMatchObject({ ok: false, error: 'limit', detail: '2' });
    const first = r.store.bySlug('a-1111') as OrderRow;
    r.store.update(first.id, { status: 'hecho' });
    expect((await r.desk.create(r.store.bySlug('c-3333') as OrderRow)).ok).toBe(true);
  });

  test('a branch or folder that already exists is refused', async () => {
    const r = rig();
    git(r.repo, 'branch', 'encargo/login-a1b2', 'origin/develop');
    expect(await r.desk.create(order(r))).toMatchObject({ ok: false, error: 'exists' });
  });

  test('a branch of the order whose tip is not a checkpoint of its parent is refused, and no folder is added on it', async () => {
    const calls: string[][] = [];
    const asked: string[] = [];
    const r = rig({
      git: (cwd, args, ...rest) => {
        calls.push(args);
        return runGit(cwd, args, ...rest);
      },
      forkPoint: (_order, sha) => {
        asked.push(sha);
        return false;
      },
    });
    const tip = git(r.repo, 'rev-parse', 'origin/develop');
    git(r.repo, 'branch', 'encargo/login-a1b2', tip);
    const row = order(r);
    expect(await r.desk.create(row)).toEqual({ ok: false, error: 'exists', detail: 'encargo/login-a1b2' });
    expect(asked).toEqual([tip]);
    expect(calls.filter((args) => args[0] === 'worktree' && args[1] === 'add')).toEqual([]);
    expect(existsSync(r.desk.folderOf('mobile', 'login-a1b2') as string)).toBe(false);
    expect(r.store.get(row.id)).toMatchObject({ worktree_path: null, branch: null });
  });

  test('.worktreeinclude copies only literal entries that git ignores', async () => {
    const r = rig();
    writeFileSync(join(r.repo, '.gitignore'), '.env\nsecrets/\n');
    git(r.repo, 'add', '.gitignore');
    git(r.repo, 'commit', '-q', '-m', 'ignore');
    git(r.repo, 'push', '-q', 'origin', 'HEAD:develop');
    writeFileSync(join(r.repo, '.env'), 'TOKEN=1\n');
    mkdirSync(join(r.repo, 'secrets'));
    writeFileSync(join(r.repo, 'secrets', 'key.pem'), 'k');
    writeFileSync(join(r.repo, 'README.md'), '# cambiado\n');
    writeFileSync(join(r.repo, '.worktreeinclude'), ['# local files', '.env', 'secrets/', 'README.md', '*.pem', '../fuera', '/abs'].join('\n'));
    const made = await created(r);
    const path = made.worktree_path as string;
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(readFileSync(join(path, 'secrets', 'key.pem'), 'utf8')).toBe('k');
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# app\n');
  });

  test('linkDirs links a dependency folder of the main copy', async () => {
    const r = rig({}, (config) => {
      config.floors.mobile.linkDirs = ['vendor'];
    });
    mkdirSync(join(r.repo, 'vendor'));
    writeFileSync(join(r.repo, 'vendor', 'lib.txt'), 'v');
    const made = await created(r);
    const link = join(made.worktree_path as string, 'vendor');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, 'lib.txt'), 'utf8')).toBe('v');
  });

  test('a linked folder is excluded by name, so a checkpoint never commits its symlink', async () => {
    const r = rig({}, (config) => {
      config.floors.mobile.linkDirs = ['node_modules'];
      config.worktrees.maxActivePerFloor = 10;
    });
    pushCommit(r.seed, r.origin, '.gitignore', 'node_modules/\n', 'ignora las dependencias');
    mkdirSync(join(r.repo, 'node_modules'));
    writeFileSync(join(r.repo, 'node_modules', 'dep.js'), 'x');
    const made = await created(r);
    await created(r, order(r, 'otro-c3d4'));
    const exclude = readFileSync(join(r.repo, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude.filter((line) => line === '/node_modules')).toHaveLength(1);
    const path = made.worktree_path as string;
    expect(lstatSync(join(path, 'node_modules')).isSymbolicLink()).toBe(true);
    writeFileSync(join(path, 'a.txt'), 'a');
    const checkpoints = new CheckpointDesk({ db: r.db, store: r.store, git: runGit, now: () => r.clock.now, bus: r.bus, config: () => r.config });
    const result = await checkpoints.commit(made, 'listo', 'listo');
    expect(result).toMatchObject({ committed: true, skipped: [] });
    expect(git(path, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()).toEqual(['.gitignore', 'README.md', 'a.txt']);
  });

  test('the linked dirs live in one tagged block of info/exclude, rewritten when linkDirs change', async () => {
    const r = rig({}, (config) => {
      config.floors.mobile.linkDirs = ['node_modules', 'vendor'];
      config.worktrees.maxActivePerFloor = 10;
    });
    const file = join(r.repo, '.git', 'info', 'exclude');
    writeFileSync(file, '# mio\n/tmp-local\n');
    await created(r, order(r, 'uno-1111'));
    expect(readFileSync(file, 'utf8')).toBe('# mio\n/tmp-local\n/.claude/worktrees/\n# agent-office linkDirs\n/node_modules\n/vendor\n# agent-office linkDirs end\n');
    r.config.floors.mobile.linkDirs = ['vendor'];
    await created(r, order(r, 'dos-2222'));
    expect(readFileSync(file, 'utf8')).toBe('# mio\n/tmp-local\n/.claude/worktrees/\n# agent-office linkDirs\n/vendor\n# agent-office linkDirs end\n');
    r.config.floors.mobile.linkDirs = [];
    await created(r, order(r, 'tres-3333'));
    expect(readFileSync(file, 'utf8')).toBe('# mio\n/tmp-local\n/.claude/worktrees/\n');
  });

  test('withExcludes keeps the lines around the block in place and is idempotent', () => {
    const around = '/a\n# agent-office linkDirs\n/old\n# agent-office linkDirs end\n/b\n/.claude/worktrees/\n';
    const once = withExcludes(around, ['new', 'new']);
    expect(once).toBe('/a\n# agent-office linkDirs\n/new\n# agent-office linkDirs end\n/b\n/.claude/worktrees/\n');
    expect(withExcludes(once, ['new'])).toBe(once);
    expect(withExcludes('', [])).toBe('/.claude/worktrees/\n');
    expect(withExcludes('/x', ['d'])).toBe('/x\n/.claude/worktrees/\n# agent-office linkDirs\n/d\n# agent-office linkDirs end\n');
  });

  test('setup runs in the background: preparando, then listo or error with the tail of its output', async () => {
    let release: (result: ShellResult) => void = () => {};
    const ran: { command: string; cwd: string }[] = [];
    const shell = (command: string, opts: { cwd: string }) =>
      new Promise<ShellResult>((resolve) => {
        ran.push({ command, cwd: opts.cwd });
        release = resolve;
      });
    const r = rig({ shell }, (config) => {
      config.floors.mobile.setup = 'make deps';
    });
    const result = await r.desk.create(order(r));
    if (!result.ok) throw new Error('create');
    expect(result.order.worktree_state).toBe('preparando');
    expect(ran).toEqual([{ command: 'make deps', cwd: result.order.worktree_path as string }]);
    release({ code: 0, timedOut: false, cancelled: false, tail: '', durationMs: 1 });
    expect((await result.ready).worktree_state).toBe('listo');

    const failing = rig(
      { shell: async () => ({ code: 2, timedOut: false, cancelled: false, tail: 'uno\ndos\nno se pudo resolver', durationMs: 1 }) },
      (config) => {
        config.floors.mobile.setup = 'make deps';
      },
    );
    const bad = await failing.desk.create(order(failing));
    if (!bad.ok) throw new Error('create');
    const after = await bad.ready;
    expect(after).toMatchObject({ worktree_state: 'error' });
    expect(after.setup_error).toContain('no se pudo resolver');
    expect(failing.store.get(after.id)?.worktree_state).toBe('error');
  });
});

describe('a setup that did not finish', () => {
  test('a hub that went down while preparing marks the folder as an error, and resetup brings it back', async () => {
    let calls = 0;
    const shell = async () => {
      calls += 1;
      return { code: 0, timedOut: false, cancelled: false, tail: '', durationMs: 1 };
    };
    const r = rig({ shell }, (config) => {
      config.floors.mobile.setup = 'make deps';
    });
    const made = await created(r);
    r.store.update(made.id, { worktree_state: 'preparando' });
    await r.desk.cleanup();
    expect(r.store.get(made.id)).toMatchObject({ worktree_state: 'error', setup_error: 'interrupted' });
    const back = await r.desk.resetup(made.id);
    expect(back).toMatchObject({ worktree_state: 'listo', setup_error: null });
    expect(calls).toBe(2);
    expect(await r.desk.resetup(999)).toBeNull();
  });

  test('resetup of a floor without setup is just ready, and a failing one stays an error with its tail', async () => {
    const r = rig();
    const made = await created(r);
    r.store.update(made.id, { worktree_state: 'error', setup_error: 'x' });
    expect(await r.desk.resetup(made.id)).toMatchObject({ worktree_state: 'listo' });
    const failing = rig({ shell: async () => ({ code: 3, timedOut: false, cancelled: false, tail: 'nope', durationMs: 1 }) }, (config) => {
      config.floors.mobile.setup = 'make deps';
    });
    const other = await created(failing);
    expect(failing.store.get(other.id)?.worktree_state).toBe('error');
    expect(await failing.desk.resetup(other.id)).toMatchObject({ worktree_state: 'error', setup_error: 'nope' });
  });
});

describe('byPath', () => {
  test('finds the order whose folder holds the cwd and nothing else', async () => {
    const r = rig();
    const made = await created(r);
    const path = made.worktree_path as string;
    expect(r.desk.byPath(path)?.id).toBe(made.id);
    expect(r.desk.byPath(join(path, 'lib', 'src'))?.id).toBe(made.id);
    expect(r.desk.byPath(`${path}-otro`)).toBeNull();
    expect(r.desk.byPath(r.repo)).toBeNull();
    expect(r.desk.byPath(null)).toBeNull();
  });
});

describe('list', () => {
  test('reports ahead, behind, dirt, size and whether the branch is merged', async () => {
    const r = rig();
    const made = await created(r);
    const path = made.worktree_path as string;
    writeFileSync(join(path, 'feature.txt'), 'f');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'trabajo');
    pushCommit(r.seed, r.origin, 'otro.txt', 'o', 'avanza la base');
    git(r.repo, 'fetch', '-q', 'origin');
    writeFileSync(join(path, 'sin-guardar.txt'), 'x');
    const { worktrees, totalKb } = await r.desk.list('mobile');
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({
      slug: 'login-a1b2',
      branch: 'encargo/login-a1b2',
      base: 'origin/develop',
      ahead: 1,
      behind: 1,
      dirty: true,
      merged: false,
      sizeKb: 120,
      state: 'listo',
      pending: false,
    });
    expect(totalKb).toBe(120);
    expect((await r.desk.list('otra')).worktrees).toEqual([]);
  });

  test('a branch already in the base is merged, and a hecho one past the retention without a merge waits for a decision', async () => {
    const r = rig();
    const merged = await created(r, order(r, 'fusionado-1111'));
    const open = await created(r, order(r, 'abierto-2222'));
    work(merged.worktree_path as string, 'm.txt', 'fusionado');
    landOnRemote(r, merged, 'merge');
    git(r.repo, 'fetch', '-q', 'origin');
    writeFileSync(join(open.worktree_path as string, 'f.txt'), 'f');
    git(open.worktree_path as string, 'add', '.');
    git(open.worktree_path as string, 'commit', '-q', '-m', 'trabajo');
    r.store.update(merged.id, { status: 'hecho', updated_at: r.clock.now - 10 * 86_400_000 });
    r.store.update(open.id, { status: 'hecho', updated_at: r.clock.now - 10 * 86_400_000 });
    const views = (await r.desk.list('mobile')).worktrees;
    expect(views.find((v) => v.slug === 'fusionado-1111')).toMatchObject({ merged: true, pending: false });
    expect(views.find((v) => v.slug === 'abierto-2222')).toMatchObject({ merged: false, pending: true });
    r.desk.keep(open.id);
    expect((await r.desk.list('mobile')).worktrees.find((v) => v.slug === 'abierto-2222')).toMatchObject({ pending: false, kept: true });
  });
});

describe('remove', () => {
  test('a merged branch goes with its folder, even when the main copy is on another branch', async () => {
    const r = rig();
    const made = await created(r);
    work(made.worktree_path as string, 'f.txt', 'trabajo');
    landOnRemote(r, made, 'merge');
    git(r.repo, 'fetch', '-q', 'origin');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('ok');
    expect(existsSync(made.worktree_path as string)).toBe(false);
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toBe('');
    expect(r.store.get(made.id)).toMatchObject({ worktree_state: 'retirado' });
    expect(r.desk.byPath(made.worktree_path)).toBeNull();
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('not-found');
  });

  test('an unmerged branch needs force to be deleted, and the folder stays until then', async () => {
    const r = rig();
    const made = await created(r);
    const path = made.worktree_path as string;
    writeFileSync(join(path, 'f.txt'), 'f');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'trabajo sin fusionar');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('unmerged');
    expect(existsSync(path)).toBe(true);
    expect(await r.desk.remove(made.id, { deleteBranch: false, force: false })).toBe('ok');
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toContain('encargo/login-a1b2');

    const other = await created(r, order(r, 'otro-3333'));
    writeFileSync(join(other.worktree_path as string, 'g.txt'), 'g');
    git(other.worktree_path as string, 'add', '.');
    git(other.worktree_path as string, 'commit', '-q', '-m', 'más trabajo');
    expect(await r.desk.remove(other.id, { deleteBranch: true, force: true })).toBe('ok');
    expect(git(r.repo, 'branch', '--list', 'encargo/otro-3333')).toBe('');
  });

  test('a dirty folder needs force, and a folder with a session inside is busy', async () => {
    const r = rig();
    const made = await created(r);
    const path = made.worktree_path as string;
    writeFileSync(join(path, 'sin-guardar.txt'), 'x');
    expect(await r.desk.remove(made.id, { deleteBranch: false, force: false })).toBe('dirty');
    r.inside.paths.push(path);
    expect(await r.desk.remove(made.id, { deleteBranch: false, force: true })).toBe('busy');
    expect(existsSync(path)).toBe(true);
    r.inside.paths.length = 0;
    expect(await r.desk.remove(made.id, { deleteBranch: false, force: true })).toBe('ok');
    expect(existsSync(path)).toBe(false);
  });

  test('a branch without commits of its own goes with its folder without force', async () => {
    const r = rig();
    const made = await created(r);
    git(r.repo, 'checkout', '-q', '-b', 'otra', 'origin/develop');
    git(r.repo, 'commit', '-q', '--allow-empty', '-m', 'la copia principal avanza');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('ok');
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toBe('');
  });

  test('a folder somebody deleted by hand keeps an unmerged branch unless forced', async () => {
    const r = rig();
    const made = await created(r);
    work(made.worktree_path as string, 'f.txt', 'trabajo');
    await runGit(r.repo, ['worktree', 'remove', '--force', made.worktree_path as string]);
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('failed');
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toContain('encargo/login-a1b2');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: true })).toBe('ok');
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toBe('');
  });

  test('a folder somebody deleted by hand is retired without errors', async () => {
    const r = rig();
    const made = await created(r);
    await runGit(r.repo, ['worktree', 'remove', '--force', made.worktree_path as string]);
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('ok');
  });

  test('removeAll retires every folder of a floor and dirtyIn names the ones with unsaved changes', async () => {
    const r = rig();
    const a = await created(r, order(r, 'a-1111'));
    await created(r, order(r, 'b-2222'));
    writeFileSync(join(a.worktree_path as string, 'x.txt'), 'x');
    expect(await r.desk.dirtyIn('mobile')).toEqual(['a-1111']);
    expect(await r.desk.removeAll('mobile', true)).toBe(2);
    expect(await r.desk.dirtyIn('mobile')).toEqual([]);
  });
});

describe('cleanup', () => {
  test('removes clean folders of this hub that no order owns, and only reports dirty and foreign ones', async () => {
    const r = rig();
    const root = join(realPath(r.repo), '.claude', 'worktrees');
    const make = async (name: string, marker: string | null) => {
      const path = join(root, name);
      mkdirSync(root, { recursive: true });
      git(r.repo, 'worktree', 'add', '-q', '-b', `rama-${name}`, path, 'origin/develop');
      if (marker) writeFileSync(join(git(path, 'rev-parse', '--absolute-git-dir'), 'office-hub'), `${marker}\n`);
      return path;
    };
    const ownClean = await make('office-huerfano-1', 'hub-test');
    const ownDirty = await make('office-sucio-2', 'hub-test');
    writeFileSync(join(ownDirty, 'cambios.txt'), 'x');
    const foreign = await make('office-ajeno-3', 'otro-hub');
    const unmarked = await make('office-sin-marca-4', null);
    const user = join(r.root, 'carpeta-del-usuario');
    git(r.repo, 'worktree', 'add', '-q', '-b', 'rama-usuario', user, 'origin/develop');

    const owned = await created(r, order(r, 'con-tarjeta-5'));
    await r.desk.cleanup();
    expect(existsSync(ownClean)).toBe(false);
    for (const kept of [ownDirty, foreign, unmarked, user, owned.worktree_path as string]) expect(existsSync(kept)).toBe(true);
    const note = r.activity.find((a) => typeof a.summary !== 'string' && a.summary.key === 'hub.act.worktreesOrphan');
    expect(note?.summary).toMatchObject({ params: { n: 3 } });
    expect(JSON.stringify(note?.summary)).toContain('office-sucio-2');
  });

  test('a repository without folders of ours is left alone', async () => {
    const r = rig();
    await r.desk.cleanup();
    expect(r.activity).toEqual([]);
    expect(existsSync(join(r.repo, '.claude'))).toBe(false);
  });
});

describe('expire', () => {
  const DAY = 86_400_000;

  test('retires merged and discarded folders past the retention, keeps dirty ones and counts the unmerged hecho', async () => {
    const r = rig({}, (config) => {
      config.worktrees.maxActivePerFloor = 10;
    });
    const old = r.clock.now - 10 * DAY;
    const mergedDone = await created(r, order(r, 'fusionado-1111'));
    const discarded = await created(r, order(r, 'descartado-2222'));
    const dirty = await created(r, order(r, 'sucio-3333'));
    const unmerged = await created(r, order(r, 'sin-fusionar-4444'));
    const fresh = await created(r, order(r, 'reciente-5555'));
    writeFileSync(join(dirty.worktree_path as string, 'x.txt'), 'x');
    writeFileSync(join(unmerged.worktree_path as string, 'f.txt'), 'f');
    git(unmerged.worktree_path as string, 'add', '.');
    git(unmerged.worktree_path as string, 'commit', '-q', '-m', 'sin fusionar');
    r.store.update(mergedDone.id, { status: 'hecho', updated_at: old });
    r.store.update(discarded.id, { status: 'descartado', updated_at: old });
    r.store.update(dirty.id, { status: 'descartado', updated_at: old });
    r.store.update(unmerged.id, { status: 'hecho', updated_at: old });
    r.store.update(fresh.id, { status: 'hecho', updated_at: r.clock.now - DAY });

    const result = await r.desk.expire();
    expect(result).toMatchObject({ removed: 2, pending: 1 });
    expect(existsSync(mergedDone.worktree_path as string)).toBe(false);
    expect(existsSync(discarded.worktree_path as string)).toBe(false);
    for (const kept of [dirty, unmerged, fresh]) expect(existsSync(kept.worktree_path as string)).toBe(true);
    expect(git(r.repo, 'branch', '--list', 'encargo/fusionado-1111')).toBe('');
    const pending = r.activity.find((a) => typeof a.summary !== 'string' && a.summary.key === 'hub.act.worktreesPending');
    expect(pending?.summary).toMatchObject({ params: { n: 1, sizeKb: 120 } });
  });

  test('every folder counts for the total, decided or not, and past the warning it is reported', async () => {
    const r = rig({ sizeOf: async () => 6 * 1024 * 1024 }, (config) => {
      config.worktrees.warnTotalGb = 10;
    });
    await created(r, order(r, 'a-1111'));
    await created(r, order(r, 'b-2222'));
    const result = await r.desk.expire();
    expect(result.totalKb).toBe(12 * 1024 * 1024);
    const heavy = r.activity.find((a) => typeof a.summary !== 'string' && a.summary.key === 'hub.act.worktreesHeavy');
    expect(heavy?.summary).toMatchObject({ params: { gb: 12, max: 10 } });
  });

  test('a branch without commits of its own is not merged, and its folder still goes when it expires', async () => {
    const r = rig();
    const made = await created(r);
    r.store.update(made.id, { status: 'hecho', updated_at: r.clock.now - 10 * DAY });
    expect((await r.desk.list('mobile')).worktrees[0]).toMatchObject({ ahead: 0, merged: false, pending: false });
    expect(await r.desk.expire()).toMatchObject({ removed: 1, pending: 0 });
    expect(existsSync(made.worktree_path as string)).toBe(false);
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toBe('');
  });

  test('a merge done on the remote after the folder was made counts once expire fetches, one fetch per floor and base', async () => {
    const fetches: string[] = [];
    const r = rig(
      {
        git: (cwd, args, ...rest) => {
          if (args[0] === 'fetch') fetches.push(`${cwd} ${args.at(-1)}`);
          return runGit(cwd, args, ...rest);
        },
      },
      (config) => {
        config.worktrees.maxActivePerFloor = 10;
      },
    );
    const old = r.clock.now - 10 * DAY;
    const merged = await created(r, order(r, 'fusionado-1111'));
    const open = await created(r, order(r, 'abierto-2222'));
    work(merged.worktree_path as string, 'm.txt', 'fusionado');
    work(open.worktree_path as string, 'a.txt', 'abierto');
    landOnRemote(r, merged, 'merge');
    r.store.update(merged.id, { status: 'hecho', updated_at: old });
    r.store.update(open.id, { status: 'hecho', updated_at: old });
    expect((await r.desk.list('mobile')).worktrees.find((v) => v.slug === 'fusionado-1111')).toMatchObject({ merged: false, pending: true });

    fetches.length = 0;
    expect(await r.desk.expire()).toMatchObject({ removed: 1, pending: 1 });
    expect(fetches).toEqual([`${realPath(r.repo)} develop`]);
    expect(existsSync(merged.worktree_path as string)).toBe(false);
    expect(existsSync(open.worktree_path as string)).toBe(true);
    expect(git(r.repo, 'branch', '--list', 'encargo/fusionado-1111')).toBe('');
    expect(git(r.repo, 'branch', '--list', 'encargo/*')).toContain('encargo/abierto-2222');
  });

  test('a squash merge and a rebase merge on the remote are merged too', async () => {
    const r = rig({}, (config) => {
      config.worktrees.maxActivePerFloor = 10;
    });
    const squashed = await created(r, order(r, 'aplastado-1111'));
    const rebased = await created(r, order(r, 'rebasado-2222'));
    const open = await created(r, order(r, 'abierto-3333'));
    for (const made of [squashed, rebased, open]) {
      work(made.worktree_path as string, `${made.slug}-1.txt`, `${made.slug} uno`);
      work(made.worktree_path as string, `${made.slug}-2.txt`, `${made.slug} dos`);
    }
    pushCommit(r.seed, r.origin, 'otro.txt', 'o', 'avanza la base');
    landOnRemote(r, squashed, 'squash');
    landOnRemote(r, rebased, 'rebase');
    git(r.repo, 'fetch', '-q', 'origin');
    const views = (await r.desk.list('mobile')).worktrees;
    expect(views.find((v) => v.slug === 'aplastado-1111')).toMatchObject({ merged: true });
    expect(views.find((v) => v.slug === 'rebasado-2222')).toMatchObject({ merged: true });
    expect(views.find((v) => v.slug === 'abierto-3333')).toMatchObject({ merged: false });
  });

  test('a fetch that fails changes nothing and does not throw', async () => {
    const r = rig({}, (config) => {
      config.worktrees.maxActivePerFloor = 10;
    });
    const old = r.clock.now - 10 * DAY;
    const known = await created(r, order(r, 'conocido-1111'));
    const remote = await created(r, order(r, 'remoto-2222'));
    work(known.worktree_path as string, 'k.txt', 'conocido');
    work(remote.worktree_path as string, 'r.txt', 'remoto');
    landOnRemote(r, known, 'merge');
    git(r.repo, 'fetch', '-q', 'origin');
    landOnRemote(r, remote, 'merge');
    git(r.repo, 'remote', 'set-url', 'origin', join(r.root, 'does-not-exist.git'));
    r.store.update(known.id, { status: 'hecho', updated_at: old });
    r.store.update(remote.id, { status: 'hecho', updated_at: old });

    expect(await r.desk.expire()).toMatchObject({ removed: 1, pending: 1 });
    expect(existsSync(known.worktree_path as string)).toBe(false);
    expect(existsSync(remote.worktree_path as string)).toBe(true);
    expect(r.store.get(remote.id)).toMatchObject({ status: 'hecho', worktree_state: 'listo', base_stale: 0 });
    expect((await r.desk.list('mobile')).worktrees.find((v) => v.slug === 'remoto-2222')).toMatchObject({ merged: false, pending: true });
  });
});

describe('a branch is only deleted on facts git confirmed', () => {
  const DAY = 86_400_000;
  const failing =
    (command: string, also: (args: string[]) => boolean = () => false): WorktreeDeskOpts['git'] =>
    (cwd, args, ...rest) =>
      args[0] === command || also(args) ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: bad object' }) : runGit(cwd, args, ...rest);
  const branchOf = (r: Rig, made: OrderRow) => git(r.repo, 'branch', '--list', made.branch as string);
  const keyed = (r: Rig, key: string) => r.activity.filter((a) => typeof a.summary !== 'string' && a.summary.key === key);

  test('a rev-list that fails leaves an unmerged branch and its folder alone', async () => {
    const r = rig({ git: failing('rev-list') });
    const made = await created(r);
    work(made.worktree_path as string, 'f.txt', 'trabajo sin fusionar');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('unmerged');
    expect(existsSync(made.worktree_path as string)).toBe(true);
    expect(branchOf(r, made)).toContain('encargo/login-a1b2');
    expect((await r.desk.list('mobile')).worktrees[0]).toMatchObject({ merged: false });
  });

  test('expire keeps the folder and the branch of a row whose facts git could not confirm, and says so once', async () => {
    const r = rig({ git: failing('rev-list') }, (config) => {
      config.worktrees.maxActivePerFloor = 10;
    });
    const old = r.clock.now - 10 * DAY;
    const done = await created(r, order(r, 'hecho-1111'));
    const discarded = await created(r, order(r, 'descartado-2222'));
    for (const made of [done, discarded]) work(made.worktree_path as string, `${made.slug}.txt`, made.slug);
    r.store.update(done.id, { status: 'hecho', updated_at: old });
    r.store.update(discarded.id, { status: 'descartado', updated_at: old });
    expect(await r.desk.expire()).toMatchObject({ removed: 0 });
    for (const made of [done, discarded]) {
      expect(existsSync(made.worktree_path as string)).toBe(true);
      expect(branchOf(r, made)).toContain(made.branch as string);
    }
    const notes = keyed(r, 'hub.act.worktreesUnknown');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.summary).toMatchObject({ params: { n: 2 } });
  });

  test('without the sha it started from a branch is undecided, even with no commits of its own', async () => {
    const r = rig();
    const made = await created(r);
    r.store.update(made.id, { base_sha: null, status: 'hecho', updated_at: r.clock.now - 10 * DAY });
    expect((await r.desk.list('mobile')).worktrees[0]).toMatchObject({ merged: false, pending: true });
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('unmerged');
    expect(branchOf(r, made)).toContain('encargo/login-a1b2');
  });

  test('a folder whose HEAD left the branch for the base is not merged, and expire keeps both', async () => {
    const r = rig();
    const made = await created(r);
    const path = made.worktree_path as string;
    work(path, 'f.txt', 'trabajo sin fusionar');
    const tip = git(path, 'rev-parse', 'HEAD');
    git(path, 'checkout', '-q', '--detach', 'origin/develop');
    r.store.update(made.id, { status: 'hecho', updated_at: r.clock.now - 10 * DAY });
    expect((await r.desk.list('mobile')).worktrees[0]).toMatchObject({ merged: false, pending: true });
    expect(await r.desk.expire()).toMatchObject({ removed: 0 });
    expect(existsSync(path)).toBe(true);
    expect(git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2')).toBe(tip);
  });

  test('a squash on the remote followed by a whitespace-only commit is not merged', async () => {
    const r = rig();
    const made = await created(r);
    const path = made.worktree_path as string;
    writeFileSync(join(path, 'a.txt'), 'uno dos\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'uno dos');
    landOnRemote(r, made, 'squash');
    writeFileSync(join(path, 'a.txt'), 'uno  dos\n');
    git(path, 'commit', '-q', '-am', 'espacios');
    git(r.repo, 'fetch', '-q', 'origin');
    r.store.update(made.id, { status: 'hecho', updated_at: r.clock.now - 10 * DAY });
    expect((await r.desk.list('mobile')).worktrees[0]).toMatchObject({ merged: false, pending: true });
    await r.desk.expire();
    expect(branchOf(r, made)).toContain('encargo/login-a1b2');
  });

  test('a squash followed by a binary change is not merged, and a squash with a binary file still is', async () => {
    const r = rig({}, (config) => {
      config.worktrees.maxActivePerFloor = 10;
    });
    const changed = await created(r, order(r, 'binario-1111'));
    const landed = await created(r, order(r, 'aplastado-2222'));
    for (const made of [changed, landed]) {
      const path = made.worktree_path as string;
      writeFileSync(join(path, `${made.slug}.txt`), `${made.slug}\n`);
      writeFileSync(join(path, `${made.slug}.bin`), new Uint8Array([0, 1, 2, 3, 255]));
      git(path, 'add', '.');
      git(path, 'commit', '-q', '-m', made.slug);
      landOnRemote(r, made, 'squash');
    }
    writeFileSync(join(changed.worktree_path as string, 'binario-1111.bin'), new Uint8Array([0, 1, 2, 4, 255]));
    git(changed.worktree_path as string, 'commit', '-q', '-am', 'otro binario');
    git(r.repo, 'fetch', '-q', 'origin');
    const views = (await r.desk.list('mobile')).worktrees;
    expect(views.find((v) => v.slug === 'binario-1111')).toMatchObject({ merged: false });
    expect(views.find((v) => v.slug === 'aplastado-2222')).toMatchObject({ merged: true });
  });

  test('a branch that moves after it was judged is not deleted, and its folder is still retired', async () => {
    let late = '';
    let repo = '';
    const r = rig({
      git: async (cwd, args, ...rest) => {
        if (args[0] === 'worktree' && args[1] === 'remove' && late) await runGit(repo, ['update-ref', 'refs/heads/encargo/login-a1b2', late]);
        return runGit(cwd, args, ...rest);
      },
    });
    repo = r.repo;
    const made = await created(r);
    work(made.worktree_path as string, 'f.txt', 'trabajo');
    landOnRemote(r, made, 'merge');
    git(r.repo, 'fetch', '-q', 'origin');
    const tip = git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2');
    late = git(r.repo, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'llega tarde');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('branch-moved');
    expect(git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2')).toBe(late);
    expect(r.store.get(made.id)?.worktree_state).toBe('retirado');
    expect(keyed(r, 'hub.act.branchDeleted')).toHaveLength(0);
    const moved = keyed(r, 'hub.act.branchMoved');
    expect(moved).toHaveLength(1);
    expect(moved[0]?.summary).toMatchObject({ params: { branch: 'encargo/login-a1b2', sha: late } });
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: true })).toBe('not-found');
    expect(git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2')).toBe(late);
  });

  test('a branch git cannot delete stays at its tip, and its folder already gone is still retired', async () => {
    const r = rig({ git: failing('update-ref') });
    const made = await created(r);
    const path = made.worktree_path as string;
    work(path, 'f.txt', 'trabajo');
    landOnRemote(r, made, 'merge');
    git(r.repo, 'fetch', '-q', 'origin');
    const tip = git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('failed');
    expect(existsSync(path)).toBe(false);
    expect(r.store.get(made.id)?.worktree_state).toBe('retirado');
    expect(git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2')).toBe(tip);
    expect(keyed(r, 'hub.act.branchDeleted')).toHaveLength(0);
    expect(keyed(r, 'hub.act.branchMoved')).toHaveLength(0);
  });

  test('a deleted branch leaves a line with its sha and the command that brings it back', async () => {
    const r = rig();
    const made = await created(r);
    work(made.worktree_path as string, 'f.txt', 'trabajo');
    landOnRemote(r, made, 'merge');
    git(r.repo, 'fetch', '-q', 'origin');
    const tip = git(r.repo, 'rev-parse', 'refs/heads/encargo/login-a1b2');
    expect(await r.desk.remove(made.id, { deleteBranch: true, force: false })).toBe('ok');
    expect(branchOf(r, made)).toBe('');
    const receipts = keyed(r, 'hub.act.branchDeleted');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.summary).toMatchObject({ params: { branch: 'encargo/login-a1b2', sha: tip } });
    expect(renderHubText(receipts[0]?.summary)).toContain(`git branch encargo/login-a1b2 ${tip}`);
  });
});

describe('a folder whose checks are running', () => {
  // A check that only ends when released, or cancelled through its signal.
  function heldChecks(): { shell: WorktreeDeskOpts['shell']; release: () => void } {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const shell: WorktreeDeskOpts['shell'] = (_command, opts) =>
      new Promise<ShellResult>((resolve) => {
        const done = (cancelled: boolean) => resolve({ code: cancelled ? null : 0, timedOut: false, cancelled, tail: '', durationMs: 1 });
        opts.signal?.addEventListener('abort', () => done(true));
        void gate.then(() => done(false));
      });
    return { shell, release: () => release() };
  }

  function deskOver(d: DeskRig): WorktreeDesk {
    return new WorktreeDesk({
      store: d.store,
      git: runGit,
      now: () => d.clock.now,
      bus: new OfficeBus(() => {}),
      config: () => d.config,
      hubId: 'hub-test',
      inside: () => false,
      changed: () => {},
      sizeOf: async () => 1,
      exclusive: (id, task) => d.checks.exclusive(id, task),
      running: (id) => d.checks.isRunning(id),
      cancelChecks: (id) => {
        d.checks.cancel(id);
      },
    });
  }

  test('is busy for a removal without force, and expire leaves it for another day', async () => {
    const held = heldChecks();
    const d = deskRig({ checks: held.shell });
    cleanups.push(d.cleanup);
    const desk = deskOver(d);
    const started = await d.checks.start(d.order.id, 'panel');
    if (!started.ok) throw new Error(started.reason);
    expect(await desk.remove(d.order.id, { deleteBranch: false, force: false })).toBe('busy');
    expect(existsSync(d.path)).toBe(true);
    d.store.update(d.order.id, { status: 'descartado', updated_at: d.clock.now - 10 * 86_400_000 });
    expect(await desk.expire()).toMatchObject({ removed: 0 });
    expect(existsSync(d.path)).toBe(true);

    held.release();
    expect((await started.done).status).toBe('passed');
    expect(await desk.expire()).toMatchObject({ removed: 1 });
    expect(existsSync(d.path)).toBe(false);
  });

  test('a forced removal waits for the cancelled run to end, or for the timeout, before removing the folder', async () => {
    for (const stuck of [false, true]) {
      let finish = () => {};
      const gate = new Promise<void>((resolve) => (finish = resolve));
      const shell: WorktreeDeskOpts['shell'] = (_command, opts) =>
        new Promise<ShellResult>((resolve) => {
          const end = () => resolve({ code: null, timedOut: false, cancelled: true, tail: '', durationMs: 1 });
          opts.signal?.addEventListener('abort', () => void gate.then(end));
        });
      const d = deskRig({ checks: shell });
      cleanups.push(d.cleanup);
      const desk = new WorktreeDesk({
        store: d.store,
        git: runGit,
        now: () => d.clock.now,
        bus: new OfficeBus(() => {}),
        config: () => d.config,
        hubId: 'hub-test',
        inside: () => false,
        changed: () => {},
        sizeOf: async () => 1,
        exclusive: (id, task) => d.checks.exclusive(id, task),
        running: (id) => d.checks.isRunning(id),
        cancelChecks: (id) => d.checks.cancelAndWait(id),
        cancelWaitMs: 50,
      });
      const started = await d.checks.start(d.order.id, 'panel');
      if (!started.ok) throw new Error(started.reason);
      let removed = false;
      const removing = desk.remove(d.order.id, { deleteBranch: false, force: true }).then((r) => {
        removed = true;
        return r;
      });
      if (stuck) {
        expect(await removing).toBe('ok');
        expect(existsSync(d.path)).toBe(false);
        finish();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(removed).toBe(false);
        expect(existsSync(d.path)).toBe(true);
        finish();
        expect(await removing).toBe('ok');
        expect(existsSync(d.path)).toBe(false);
      }
      await started.done;
    }
  });

  test('a forced removal of the floor waits for the start still committing, then cancels the run and removes the folder', async () => {
    const held = heldChecks();
    let commitHeld: (() => void) | null = null;
    let reached = () => {};
    const atCommit = new Promise<void>((resolve) => (reached = resolve));
    const d = deskRig({
      checks: held.shell,
      checkpoints: {
        git: async (cwd, args, ...rest) => {
          if (args[0] === 'commit' && commitHeld === null) {
            await new Promise<void>((resolve) => {
              commitHeld = resolve;
              reached();
            });
          }
          return runGit(cwd, args, ...rest);
        },
      },
    });
    cleanups.push(d.cleanup);
    const desk = deskOver(d);
    writeFileSync(join(d.path, 'nuevo.txt'), 'x');
    const starting = d.checks.start(d.order.id, 'listo');
    await atCommit;
    let settled = false;
    const removing = desk.removeAll('mobile', true).then((n) => {
      settled = true;
      return n;
    });
    await Bun.sleep(50);
    expect(settled).toBe(false);
    expect(existsSync(d.path)).toBe(true);

    (commitHeld as (() => void) | null)?.();
    const started = await starting;
    if (!started.ok) throw new Error(started.reason);
    expect(await removing).toBe(1);
    expect(existsSync(d.path)).toBe(false);
    expect((await started.done).status).toBe('cancelled');
    expect(d.notified).toEqual([]);
  });
});
