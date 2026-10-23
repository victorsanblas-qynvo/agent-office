import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkipped, statusPaths } from '../src/checkpoints';
import { deskRig, type DeskRig } from './desk-rig';
import { git } from './helpers';

let rig: DeskRig | undefined;
afterEach(() => {
  rig?.cleanup();
  rig = undefined;
});

const write = (r: DeskRig, file: string, content: string | Buffer) => writeFileSync(join(r.path, file), content);
const rows = (r: DeskRig) => r.store.get(r.order.id);

describe('commit', () => {
  test('a clean folder makes no commit and no row', async () => {
    rig = deskRig();
    const before = git(rig.path, 'rev-parse', 'HEAD');
    const result = await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(result).toEqual({ sha: before, committed: false, failed: false, skipped: [] });
    expect(rig.checkpoints.list(rig.order.id)).toEqual([]);
  });

  test('changes become one commit named after the order with a row for its sha', async () => {
    rig = deskRig();
    write(rig, 'a.txt', 'a');
    write(rig, 'b.txt', 'b');
    rmSync(join(rig.path, 'README.md'));
    const result = await rig.checkpoints.commit(rig.order, 'comprobar', 'comprobación (comprobar)');
    expect(result).toMatchObject({ committed: true, failed: false, skipped: [] });
    expect(result.sha).toBe(git(rig.path, 'rev-parse', 'HEAD'));
    expect(git(rig.path, 'log', '-1', '--format=%s')).toBe('encargo(login-a1b2): comprobación (comprobar)');
    expect(git(rig.path, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort()).toEqual(['A\ta.txt', 'A\tb.txt', 'D\tREADME.md']);
    expect(git(rig.path, 'status', '--porcelain')).toBe('');
    expect(rig.checkpoints.list(rig.order.id)).toEqual([{ id: 1, sha: result.sha as string, reason: 'comprobar', label: 'comprobación (comprobar)', createdAt: rig.clock.now }]);
  });

  test('a second checkpoint without changes adds nothing', async () => {
    rig = deskRig();
    write(rig, 'a.txt', 'a');
    await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(rig.checkpoints.list(rig.order.id)).toHaveLength(1);
  });

  test('files over the size cap or matching a skip glob stay out and are remembered', async () => {
    rig = deskRig({ configure: (config) => (config.checkpoints.maxFileKb = 1) });
    write(rig, 'small.txt', 'ok');
    write(rig, 'big.bin', Buffer.alloc(2048, 1));
    write(rig, 'debug.log', 'trace');
    write(rig, 'Screenshot 2026-10-17 at 10.00.png', 'png');
    const result = await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(result.committed).toBe(true);
    expect(result.skipped.map((file) => file.path).sort()).toEqual(['Screenshot 2026-10-17 at 10.00.png', 'big.bin', 'debug.log']);
    expect(git(rig.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('small.txt');
    expect(git(rig.path, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()).toEqual(['Screenshot 2026-10-17 at 10.00.png', 'big.bin', 'debug.log']);
    expect(parseSkipped(rows(rig)?.skipped_files ?? null)).toEqual(expect.arrayContaining([{ path: 'debug.log', size: 5, mtime: expect.any(Number) }]));
    const note = rig.activity.find((a) => typeof a.summary !== 'string' && a.summary.key === 'hub.act.checkpointSkipped');
    expect(JSON.stringify(note?.summary)).toContain('big.bin');
  });

  test('only skipped files changed: nothing to commit, the skipped list is kept', async () => {
    rig = deskRig();
    write(rig, 'debug.log', 'trace');
    const result = await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(result).toMatchObject({ committed: false, failed: false });
    expect(result.skipped).toHaveLength(1);
    expect(rig.checkpoints.list(rig.order.id)).toEqual([]);
  });

  test('dirtyFiles discounts skipped files that are unchanged and counts them again when they change', async () => {
    rig = deskRig();
    write(rig, 'debug.log', 'trace');
    write(rig, 'a.txt', 'a');
    expect(rig.checkpoints.dirtyFiles(rig.order)?.sort()).toEqual(['a.txt', 'debug.log']);
    await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(rig.checkpoints.dirtyFiles(rig.order)).toEqual([]);
    write(rig, 'debug.log', 'trace, now longer');
    expect(rig.checkpoints.dirtyFiles(rig.order)).toEqual(['debug.log']);
    await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(rig.checkpoints.dirtyFiles(rig.order)).toEqual([]);
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(join(rig.path, 'debug.log'), future, future);
    expect(rig.checkpoints.dirtyFiles(rig.order)).toEqual(['debug.log']);
  });

  test('a symlink that points outside the folder stays out and is remembered, one that points inside is committed', async () => {
    rig = deskRig();
    const outside = join(rig.root, 'deps');
    mkdirSync(outside);
    write(rig, '.gitignore', 'node_modules/\n');
    symlinkSync(outside, join(rig.path, 'node_modules'), 'dir');
    symlinkSync('README.md', join(rig.path, 'LEEME.md'));
    const result = await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(result.committed).toBe(true);
    expect(result.skipped.map((file) => file.path)).toEqual(['node_modules']);
    expect(git(rig.path, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()).toEqual(['.gitignore', 'LEEME.md', 'README.md']);
    expect(rig.checkpoints.dirtyFiles(rig.order)).toEqual([]);
  });

  test('a commit hook that fails leaves the changes, reports it and says so', async () => {
    rig = deskRig();
    const hook = join(git(rig.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks', 'pre-commit');
    await Bun.$`mkdir -p ${join(hook, '..')}`;
    writeFileSync(hook, '#!/bin/sh\necho "no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    write(rig, 'a.txt', 'a');
    const before = git(rig.path, 'rev-parse', 'HEAD');
    const result = await rig.checkpoints.commit(rig.order, 'listo', 'listo');
    expect(result).toMatchObject({ committed: false, failed: true, sha: before });
    expect(rig.checkpoints.list(rig.order.id)).toEqual([]);
    expect(rig.checkpoints.dirtyFiles(rig.order)).toEqual(['a.txt']);
    expect(rig.activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.checkpointFailed', params: { slug: 'login-a1b2' } });
  });

  test('an order without a folder does nothing', async () => {
    rig = deskRig();
    const ghost = rig.store.update(rig.order.id, { worktree_path: null }) as typeof rig.order;
    expect(await rig.checkpoints.commit(ghost, 'listo', 'listo')).toEqual({ sha: null, committed: false, failed: false, skipped: [] });
    expect(rig.checkpoints.dirtyFiles(ghost)).toBeNull();
  });

  test('statusPaths reads the NUL separated entries', () => {
    expect(statusPaths(' M lib/a.dart\0?? new file.txt\0 D gone.txt\0')).toEqual(['lib/a.dart', 'new file.txt', 'gone.txt']);
    expect(statusPaths('')).toEqual([]);
    expect(parseSkipped('no json')).toEqual([]);
    expect(parseSkipped('[{"path":"a","size":1,"mtime":2},{"x":1}]')).toEqual([{ path: 'a', size: 1, mtime: 2 }]);
  });
});
