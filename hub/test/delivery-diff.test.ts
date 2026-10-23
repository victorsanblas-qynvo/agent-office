import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARE_TTL_MS, MAX_PATCH_BYTES, capPatch } from '../src/delivery-desk';
import { runGit, type GitResult, type GitRunner } from '../src/git';
import { createApp } from '../src/server';
import type { DiffFileStat } from '../src/types';
import { commitAll, deliveryRig, newOrder, write, type Rig } from './delivery-rig';
import { git } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
let rig: Rig | undefined;
afterEach(() => {
  rig?.h.cleanup();
  rig = undefined;
});

function api(r: Rig) {
  const app = createApp({ office: r.h.office, port: PORT, key: () => KEY, publicDir: r.h.root }, () => {});
  return async (path: string) => {
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      method: 'GET',
      headers: { host: `127.0.0.1:${PORT}`, 'x-office-key': KEY },
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
}

async function orderWithFolder(r: Rig): Promise<{ id: number; path: string; baseSha: string }> {
  const card = await newOrder(r);
  return { id: card.id, path: card.worktree?.path ?? '', baseSha: card.baseSha ?? '' };
}

const fileQuery = (path: string) => `path=${encodeURIComponent(path)}`;

type Call = { args: string[]; result: GitResult };

// The real git, with every call and its result recorded; fake answers the calls it wants to answer itself.
function recorder(fake: (args: string[]) => GitResult | null = () => null): { calls: Call[]; git: GitRunner } {
  const calls: Call[] = [];
  const git: GitRunner = async (cwd, args, timeoutMs, input, limits) => {
    const result = fake(args) ?? (await runGit(cwd, args, timeoutMs, input, limits));
    calls.push({ args, result });
    return result;
  };
  return { calls, git };
}

const isNumstat = (args: string[]) => args.includes('--numstat');
const isPatch = (args: string[]) => args[0] === 'diff' && args.some((arg) => arg.startsWith(':(literal)'));

describe('diff of a delivery order', () => {
  test('files, counts, a rename and a binary file against the base of the order', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path, baseSha } = await orderWithFolder(rig);
    write(path, 'lib/login.dart', 'uno\ndos\ntres\n');
    git(path, 'mv', 'README.md', 'LEEME.md');
    writeFileSync(join(path, 'logo.png'), Buffer.from([0, 137, 80, 78, 71, 0, 255]));
    const first = commitAll(path, 'login');
    write(path, 'lib/login.dart', 'uno\ndos y medio\ntres\ncuatro\n');
    const head = commitAll(path, 'login otra vez');
    expect(first).not.toBe(head);

    const diff = await call(`/api/board/orders/${id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ base: baseSha, head, truncated: false, totals: { files: 3, adds: 4, dels: 0 } });
    const byPath = Object.fromEntries((diff.body.files as DiffFileStat[]).map((file) => [file.path, file]));
    expect(byPath).toEqual({
      'lib/login.dart': { path: 'lib/login.dart', oldPath: null, adds: 4, dels: 0, binary: false },
      'LEEME.md': { path: 'LEEME.md', oldPath: 'README.md', adds: 0, dels: 0, binary: false },
      'logo.png': { path: 'logo.png', oldPath: null, adds: null, dels: null, binary: true },
    });
  });

  test('a merged order still shows its own commits', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path, baseSha } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    const head = commitAll(path, 'a');
    git(rig.repo, 'update-ref', 'refs/remotes/origin/develop', head);

    const diff = await call(`/api/board/orders/${id}/diff`);
    expect(diff.body).toMatchObject({ base: baseSha, head, totals: { files: 1, adds: 1, dels: 0 } });
  });

  test('more than 300 files are cut to 300 and the totals count them all', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    for (let i = 0; i < 301; i += 1) write(path, `many/f${String(i).padStart(3, '0')}.txt`, `${i}\n`);
    commitAll(path, 'muchos');

    const diff = await call(`/api/board/orders/${id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.files).toHaveLength(300);
    expect(diff.body).toMatchObject({ truncated: true, totals: { files: 301, adds: 301, dels: 0 } });
  });

  test('the patch of one file, a rename and a large one cut at a line', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'lib/login.dart', 'uno\ndos\n');
    git(path, 'mv', 'README.md', 'LEEME.md');
    write(path, 'big.txt', Array.from({ length: 20_000 }, (_, i) => `línea ${String(i).padStart(5, '0')} con algo de texto`).join('\n'));
    commitAll(path, 'login');

    const one = await call(`/api/board/orders/${id}/diff/file?${fileQuery('lib/login.dart')}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ path: 'lib/login.dart', truncated: false, binary: false });
    expect(one.body.patch).toContain('+++ b/lib/login.dart');
    expect(one.body.patch).toContain('+dos\n');

    const renamed = await call(`/api/board/orders/${id}/diff/file?${fileQuery('LEEME.md')}`);
    expect(renamed.body.patch).toContain('rename from README.md');

    const big = await call(`/api/board/orders/${id}/diff/file?${fileQuery('big.txt')}`);
    expect(big.status).toBe(200);
    expect(big.body.truncated).toBe(true);
    const patch = big.body.patch as string;
    expect(Buffer.byteLength(patch)).toBeLessThanOrEqual(400 * 1024);
    expect(Buffer.byteLength(patch)).toBeGreaterThan(390 * 1024);
    expect(patch.endsWith('\n')).toBe(true);
    expect(patch.split('\n').at(-2)).toMatch(/^\+línea \d{5} con algo de texto$/);
  });

  test('a path outside the diff, a missing path, unknown orders and orders without a branch', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    commitAll(path, 'a');

    expect(await call(`/api/board/orders/${id}/diff/file?${fileQuery('README.md')}`)).toMatchObject({ status: 400, body: { error: { key: 'hub.api.diffPath' } } });
    expect(await call(`/api/board/orders/${id}/diff/file?${fileQuery('../a.txt')}`)).toMatchObject({ status: 400, body: { error: { key: 'hub.api.diffPath' } } });
    expect(await call(`/api/board/orders/${id}/diff/file`)).toMatchObject({ status: 400, body: { error: { key: 'hub.api.pathRequired' } } });
    expect(await call('/api/board/orders/abc/diff')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.badId' } } });
    expect(await call('/api/board/orders/9999/diff')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
    expect(await call(`/api/board/orders/9999/diff/file?${fileQuery('a.txt')}`)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });

    rig.h.db.query('UPDATE orders SET branch = NULL, worktree_path = NULL, worktree_state = NULL WHERE id = ?').run(id);
    expect(await call(`/api/board/orders/${id}/diff`)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.orderNoBranch' } } });
    expect(await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.orderNoBranch' } } });
  });

  test('a patch of 2 MB is read only up to its cap and comes back truncated', async () => {
    const { calls, git: recorded } = recorder();
    rig = deliveryRig({ office: { git: recorded } });
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'huge.txt', `${'y'.repeat(99)}\n`.repeat(20_000));
    commitAll(path, 'enorme');

    const huge = await call(`/api/board/orders/${id}/diff/file?${fileQuery('huge.txt')}`);
    expect(huge.status).toBe(200);
    expect(huge.body.truncated).toBe(true);
    expect(Buffer.byteLength(huge.body.patch as string)).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    const read = calls.find((c) => isPatch(c.args))?.result;
    expect(read?.cut).toBe(true);
    expect(Buffer.byteLength(read?.stdout ?? '')).toBeLessThanOrEqual(MAX_PATCH_BYTES + 64 * 1024);
  });

  test('the clicks on the files of an order reuse its comparison until it ages or the branch moves', async () => {
    const { calls, git: recorded } = recorder();
    rig = deliveryRig({ office: { git: recorded } });
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    write(path, 'b.txt', 'b\n');
    commitAll(path, 'a y b');
    calls.length = 0;
    const numstats = () => calls.filter((c) => isNumstat(c.args)).length;
    const branchReads = () => calls.filter((c) => c.args[0] === 'rev-parse' && c.args.some((arg) => arg.startsWith('encargo/'))).length;

    expect((await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`)).status).toBe(200);
    expect((await call(`/api/board/orders/${id}/diff/file?${fileQuery('b.txt')}`)).status).toBe(200);
    expect(numstats()).toBe(1);
    expect(branchReads()).toBe(2);
    expect(calls.filter((c) => c.args[0] === 'merge-base' || c.args.some((arg) => arg.startsWith('origin/'))).length).toBe(2);

    rig.h.clock.advance(COMPARE_TTL_MS - 1);
    expect((await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`)).status).toBe(200);
    expect(numstats()).toBe(1);
    rig.h.clock.advance(1);
    expect((await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`)).status).toBe(200);
    expect(numstats()).toBe(2);

    write(path, 'c.txt', 'c\n');
    const head = commitAll(path, 'c');
    const added = await call(`/api/board/orders/${id}/diff/file?${fileQuery('c.txt')}`);
    expect(added).toMatchObject({ status: 200, body: { path: 'c.txt' } });
    expect(numstats()).toBe(3);
    expect((await call(`/api/board/orders/${id}/diff`)).body).toMatchObject({ head, totals: { files: 3 } });
    expect(numstats()).toBe(3);
  });

  test('the patch keeps a/ and b/, no colour and no textconv whatever the repository config says', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    git(rig.repo, 'config', 'diff.noprefix', 'true');
    git(rig.repo, 'config', 'diff.mnemonicPrefix', 'true');
    git(rig.repo, 'config', 'color.ui', 'always');
    git(rig.repo, 'config', 'diff.shout.textconv', 'tr a-z A-Z <');
    writeFileSync(join(rig.repo, '.git', 'info', 'attributes'), '*.txt diff=shout\n');
    write(path, 'a.txt', 'hola\n');
    commitAll(path, 'a');
    const plain = git(path, 'diff', 'HEAD~1', 'HEAD');
    for (const seen of ['+++ a.txt', 'HOLA', '\u001b[']) expect(plain).toContain(seen);

    const one = await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`);
    expect(one.status).toBe(200);
    const patch = one.body.patch as string;
    expect(patch).toContain('diff --git a/a.txt b/a.txt');
    expect(patch).toContain('+++ b/a.txt');
    expect(patch).toContain('+hola\n');
    expect(patch).not.toContain('\u001b[');
    expect((await call(`/api/board/orders/${id}/diff`)).body).toMatchObject({ totals: { files: 1, adds: 1, dels: 0 } });
  });

  test('a name that starts with a dash, one with accents and one with a space open, and a binary file says so', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, '-dash.txt', 'guion\n');
    write(path, 'lib/café ñandú.dart', 'acentos\n');
    write(path, 'con espacio.txt', 'espacio\n');
    writeFileSync(join(path, 'logo.png'), Buffer.from([0, 137, 80, 78, 71, 0, 255]));
    commitAll(path, 'nombres');

    const diff = await call(`/api/board/orders/${id}/diff`);
    expect((diff.body.files as DiffFileStat[]).map((file) => file.path).sort()).toEqual(['-dash.txt', 'con espacio.txt', 'lib/café ñandú.dart', 'logo.png']);
    for (const [name, line] of [['-dash.txt', '+guion\n'], ['lib/café ñandú.dart', '+acentos\n'], ['con espacio.txt', '+espacio\n']] as const) {
      const one = await call(`/api/board/orders/${id}/diff/file?${fileQuery(name)}`);
      expect(one).toMatchObject({ status: 200, body: { path: name, truncated: false, binary: false } });
      expect(one.body.patch).toContain(line);
    }
    const binary = await call(`/api/board/orders/${id}/diff/file?${fileQuery('logo.png')}`);
    expect(binary).toMatchObject({ status: 200, body: { path: 'logo.png', binary: true, truncated: false } });
    expect(binary.body.patch).toContain('Binary files');
  });

  test('an order whose folder was removed but whose branch was kept still shows its diff', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    const head = commitAll(path, 'a');
    expect((await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`)).status).toBe(200);
    git(rig.repo, 'worktree', 'remove', '--force', path);

    expect((await call(`/api/board/orders/${id}/diff`)).body).toMatchObject({ head, totals: { files: 1, adds: 1, dels: 0 } });
    const one = await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`);
    expect(one.status).toBe(200);
    expect(one.body.patch).toContain('+a\n');
  });

  test('a base that moved on without the branch shows only the commits of the order', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path, baseSha } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    const head = commitAll(path, 'a');
    git(rig.repo, 'checkout', '-q', '-b', 'avance', baseSha);
    write(rig.repo, 'otro.txt', 'otro\n');
    write(rig.repo, 'README.md', '# app\notra\n');
    const tip = commitAll(rig.repo, 'avance de develop');
    git(rig.repo, 'update-ref', 'refs/remotes/origin/develop', tip);

    const diff = await call(`/api/board/orders/${id}/diff`);
    expect(diff.body).toMatchObject({ base: tip, head, totals: { files: 1, adds: 1, dels: 0 } });
    expect((diff.body.files as DiffFileStat[]).map((file) => file.path)).toEqual(['a.txt']);
    const one = await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`);
    expect(one.body.patch).not.toContain('otro');
  });

  test('a git that times out is a 500', async () => {
    let slow: (args: string[]) => boolean = () => false;
    const { git: recorded } = recorder((args) => (slow(args) ? { code: 143, stdout: 'diff --git a/a.txt', stderr: '' } : null));
    rig = deliveryRig({ office: { git: recorded } });
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    commitAll(path, 'a');

    slow = isPatch;
    expect(await call(`/api/board/orders/${id}/diff/file?${fileQuery('a.txt')}`)).toMatchObject({ status: 500, body: { error: { key: 'hub.api.diffFailed' } } });
    rig.h.clock.advance(COMPARE_TTL_MS);
    slow = isNumstat;
    expect(await call(`/api/board/orders/${id}/diff`)).toMatchObject({ status: 500, body: { error: { key: 'hub.api.diffFailed' } } });
  });

  test('a branch git cannot compare is a 500', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id } = await orderWithFolder(rig);
    rig.h.db.query("UPDATE orders SET base_ref = NULL, base_sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE id = ?").run(id);
    expect(await call(`/api/board/orders/${id}/diff`)).toMatchObject({ status: 500, body: { error: { key: 'hub.api.diffFailed' } } });
  });
});

describe('pull request draft of a delivery order', () => {
  test('commit subjects, diff totals and the language of the headings', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\nb\n');
    commitAll(path, 'feat: add a');
    write(path, 'b.txt', 'b\n');
    commitAll(path, 'fix: add b');

    const es = await call(`/api/board/orders/${id}/pr-draft`);
    expect(es.status).toBe(200);
    expect(es.body.title).toBe('Pantalla de login');
    expect(es.body.body).toContain('- feat: add a\n- fix: add b');
    expect(es.body.body).toContain('## Resumen');
    expect(es.body.body).toContain('2 archivos, +3 −0');
    const en = await call(`/api/board/orders/${id}/pr-draft?lang=en`);
    expect(en.body.body).toContain('## Summary');
    expect(en.body.body).toContain('2 files, +3 −0');
  });

  test('checks of an older commit carry a notice; checks of the head do not', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id, path } = await orderWithFolder(rig);
    write(path, 'a.txt', 'a\n');
    const head = commitAll(path, 'feat: add a');
    const insertRun = (sha: string): void => {
      const runId = Number(
        rig!.h.db
          .query("INSERT INTO check_runs (order_id, floor, slug, sha, trigger, status, started_at) VALUES (?, 'mobile', 'login', ?, 'listo', 'passed', 1)")
          .run(id, sha).lastInsertRowid,
      );
      rig!.h.db.query("INSERT INTO checks (run_id, floor, slug, name, command, status, duration_ms) VALUES (?, 'mobile', 'login', 'analyze', 'x', 'passed', 1500)").run(runId);
    };
    insertRun('1234567890abcdef1234567890abcdef12345678');
    const stale = await call(`/api/board/orders/${id}/pr-draft`);
    expect(stale.body.body).toContain('## Comprobaciones\n\n> Estas comprobaciones son de un commit anterior (1234567)\n\n| Comprobación');
    expect(stale.body.body).toContain('| analyze | verde | 1.5 s |');
    expect((await call(`/api/board/orders/${id}/pr-draft?lang=en`)).body.body).toContain('> These checks are from an earlier commit (1234567)');
    insertRun(`${head}-dirty`);
    expect((await call(`/api/board/orders/${id}/pr-draft`)).body.body).toContain(`(${head.slice(0, 7)}-dirty)`);
    insertRun(head);
    expect((await call(`/api/board/orders/${id}/pr-draft`)).body.body).not.toContain('commit anterior');
  });

  test('past the commit cap the more-count comes from rev-list, not from the log', async () => {
    const subjects = Array.from({ length: 500 }, (_, i) => `commit ${i}`).join('\n');
    const { calls, git: recorded } = recorder((args) =>
      args[0] === 'log' && args.includes('--format=%s')
        ? { code: 0, stdout: subjects, stderr: '' }
        : args[0] === 'rev-list' && args.includes('--no-merges')
          ? { code: 0, stdout: '812\n', stderr: '' }
          : null,
    );
    rig = deliveryRig({ office: { git: recorded } });
    const call = api(rig);
    const { id } = await orderWithFolder(rig);
    const draft = await call(`/api/board/orders/${id}/pr-draft`);
    expect(draft.body.body).toContain('- …y 762 más');
    expect(calls.some((entry) => entry.args[0] === 'rev-list' && entry.args.includes('--count') && entry.args.includes('--no-merges'))).toBe(true);
  });

  test('bad id, unknown order and an order without a branch', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { id } = await orderWithFolder(rig);
    expect(await call('/api/board/orders/abc/pr-draft')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.badId' } } });
    expect(await call('/api/board/orders/9999/pr-draft')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
    rig.h.db.query('UPDATE orders SET branch = NULL, worktree_path = NULL, worktree_state = NULL WHERE id = ?').run(id);
    expect(await call(`/api/board/orders/${id}/pr-draft`)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.orderNoBranch' } } });
  });
});

describe('capPatch', () => {
  test('keeps a small patch and cuts a large one at the end of a line without breaking a character', () => {
    expect(capPatch('a\nb\n', 10)).toEqual({ patch: 'a\nb\n', truncated: false });
    expect(capPatch('ab\ncd\nef\n', 7)).toEqual({ patch: 'ab\ncd\n', truncated: true });
    expect(capPatch('añ\nñññ\n', 6)).toEqual({ patch: 'añ\n', truncated: true });
    expect(capPatch('x'.repeat(20), 5)).toEqual({ patch: '', truncated: true });
  });
});
