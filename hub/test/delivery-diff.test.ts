import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capPatch } from '../src/delivery-desk';
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
    expect(es.body.body).toContain('- fix: add b\n- feat: add a');
    expect(es.body.body).toContain('## Resumen');
    expect(es.body.body).toContain('2 archivos, +3 −0');
    const en = await call(`/api/board/orders/${id}/pr-draft?lang=en`);
    expect(en.body.body).toContain('## Summary');
    expect(en.body.body).toContain('2 files, +3 −0');
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
