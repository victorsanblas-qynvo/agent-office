import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit, type GitRunner } from '../src/git';
import { orderSlug } from '../src/orders';
import { resetText } from '../src/checkpoint-restore';
import { createApp } from '../src/server';
import type { CheckpointView, OrderView } from '../src/types';
import { DEV, checksConfig, deliveryRig, leadMessages, newOrder, orderOf, write, type Rig, type RigOptions } from './delivery-rig';
import { ev, git } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
let rig: Rig | undefined;
afterEach(() => {
  rig?.h.cleanup();
  rig = undefined;
});

function api(r: Rig) {
  const app = createApp({ office: r.h.office, port: PORT, key: () => KEY, publicDir: r.h.root }, () => {});
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'x-office-key': KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
}

// A git runner that holds the first call of a command until it is let go, and logs every command it runs.
function gatedGit(command: string) {
  const log: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached = () => {};
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  let armed = false;
  const runner: GitRunner = async (cwd, args, timeoutMs, input, limits) => {
    log.push(args[0] ?? '');
    if (armed && args[0] === command) {
      armed = false;
      reached();
      await held;
    }
    return runGit(cwd, args, timeoutMs, input, limits);
  };
  return { runner, log, arm: () => (armed = true), arrived, release: () => release() };
}

type Card = { card: OrderView; folder: string };

async function card(options: RigOptions = {}, title?: string): Promise<Card> {
  rig = rig ?? deliveryRig({ configure: checksConfig(['uno', 'exit 0']), ...options });
  const created = await newOrder(rig, title);
  return { card: created, folder: created.worktree?.path ?? '' };
}

// A checkpoint the way the hub makes them: a run of the checks over a folder with changes.
async function point(r: Rig, id: number, folder: string, files: Record<string, string>): Promise<CheckpointView> {
  for (const [file, content] of Object.entries(files)) write(folder, file, content);
  const started = await r.h.office.runOrderChecks(id, 'panel');
  if (!started?.ok) throw new Error('the checks did not start');
  await started.done;
  const newest = r.h.office.orderCheckpoints(id)?.checkpoints[0];
  if (!newest) throw new Error('no checkpoint');
  return newest;
}

const head = (folder: string) => git(folder, 'rev-parse', 'HEAD');
const reset = (r: Rig, id: number, cp: number, body: Record<string, unknown> = {}) => api(r)('POST', `/api/board/orders/${id}/checkpoints/${cp}/reset`, body);
const fork = (r: Rig, id: number, cp: number, body: Record<string, unknown> = {}) => api(r)('POST', `/api/board/orders/${id}/checkpoints/${cp}/fork`, body);
const baseOf = (r: Rig, slug: string) => r.h.db.query<{ base_sha: string }, [string]>('SELECT base_sha FROM orders WHERE slug = ?').get(slug)?.base_sha ?? '';
const undo = (r: Rig, id: number, safetyRef: unknown) => api(r)('POST', `/api/board/orders/${id}/checkpoints/undo-reset`, { safetyRef });

describe('restore to a checkpoint', () => {
  test('moves HEAD to the checkpoint, keeps the ignored files and the old HEAD under a safety ref', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { '.gitignore': 'ignorado.txt\nnode_modules/\n', 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    write(folder, 'ignorado.txt', 'local');
    write(folder, 'node_modules/x/index.js', 'x');
    write(folder, 'c.txt', 'sin guardar');
    write(folder, 'a.txt', 'uno cambiado');

    const result = await reset(r, c.id, p1.id);

    const ref = `refs/office/${c.slug}/before-reset-${r.h.clock.now}`;
    expect(result).toEqual({ status: 200, body: { ok: true, safetyRef: ref, head: p1.sha } });
    expect(head(folder)).toBe(p1.sha);
    expect(git(folder, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(folder, 'a.txt'), 'utf8')).toBe('uno');
    expect(existsSync(join(folder, 'b.txt'))).toBe(false);
    expect(existsSync(join(folder, 'c.txt'))).toBe(false);
    expect(readFileSync(join(folder, 'ignorado.txt'), 'utf8')).toBe('local');
    expect(existsSync(join(folder, 'node_modules/x/index.js'))).toBe(true);

    expect(git(folder, 'log', '-1', '--format=%s', ref)).toBe(`encargo(${c.slug}): antes de restaurar`);
    expect(git(folder, 'rev-parse', `${ref}^`)).toBe(p2.sha);
    expect(git(folder, 'show', `${ref}:c.txt`)).toBe('sin guardar');
    expect(git(folder, 'show', `${ref}:a.txt`)).toBe('uno cambiado');
    expect(git(folder, 'rev-parse', `refs/heads/${c.branch}`)).toBe(p1.sha);

    expect(r.h.office.orderCheckpoints(c.id)?.checkpoints.map((p) => p.reason)).toEqual(['restaurar', 'panel', 'panel']);
    expect(r.h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.checkpointReset', params: { slug: c.slug, n: 1, ref } });
    const told = leadMessages(r).at(-1) ?? '';
    expect(told).toStartWith(`[Agent Office] RESTAURADO encargo/${c.slug}: la carpeta ${folder} vuelve al punto 1 (${p1.sha.slice(0, 7)} `);
    expect(told).toContain(`Lo que había queda en ${ref}; para deshacerlo, pídeselo al usuario (Deshacer en el panel)`);
    expect(told).not.toContain('git reset');
  });

  test('the text for the lead never tells it to reset the folder itself', () => {
    const order = { slug: 'login-a1b2', worktree_path: '/r/.claude/worktrees/office-login-a1b2' } as Parameters<typeof resetText>[0];
    expect(resetText(order, { id: 1, sha: 'a'.repeat(40), label: 'listo', n: 1 }, 'refs/office/login-a1b2/before-reset-1')).not.toContain('git reset');
  });

  test('lists the safety refs of the order, newest first, and any of them can be gone back to', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    expect((await api(r)('GET', `/api/board/orders/${c.id}/checkpoints`)).body.safetyRefs).toEqual([]);
    const first = await reset(r, c.id, p1.id);
    const second = await undo(r, c.id, first.body.safetyRef);
    expect(second.status).toBe(200);

    const listed = await api(r)('GET', `/api/board/orders/${c.id}/checkpoints`);

    expect(listed.status).toBe(200);
    expect(listed.body.safetyRefs).toEqual([
      { ref: second.body.safetyRef, sha: p1.sha, at: r.h.clock.now + 1 },
      { ref: first.body.safetyRef, sha: p2.sha, at: r.h.clock.now },
    ]);
    expect((await undo(r, c.id, second.body.safetyRef)).body).toMatchObject({ ok: true, head: p1.sha });
    expect(head(folder)).toBe(p1.sha);
  });

  test('undo takes the folder back to the HEAD it had, and leaves the one it replaces under a new ref', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    const first = await reset(r, c.id, p1.id);
    expect(first.status).toBe(200);
    expect(git(folder, 'rev-parse', first.body.safetyRef)).toBe(p2.sha);
    expect(r.h.office.orderCheckpoints(c.id)?.checkpoints).toHaveLength(2);

    const back = await undo(r, c.id, first.body.safetyRef);

    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ ok: true, head: p2.sha });
    expect(back.body.safetyRef).not.toBe(first.body.safetyRef);
    expect(git(folder, 'rev-parse', back.body.safetyRef)).toBe(p1.sha);
    expect(head(folder)).toBe(p2.sha);
    expect(readFileSync(join(folder, 'b.txt'), 'utf8')).toBe('dos');
    expect(r.h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({
      key: 'hub.act.checkpointResetUndone',
      params: { slug: c.slug, target: first.body.safetyRef, ref: back.body.safetyRef },
    });
    expect(leadMessages(r).at(-1)).toContain(`se deshace la restauración y la carpeta ${folder} vuelve a ${p2.sha.slice(0, 7)}`);
  });

  test('undo only takes a safety ref of this order that exists', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    await point(r, c.id, folder, { 'a.txt': 'uno' });
    expect(await undo(r, c.id, 'refs/heads/develop')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.safetyRefInvalid' } } });
    expect(await undo(r, c.id, 'refs/office/otro-a1b2/before-reset-1')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.safetyRefInvalid' } } });
    expect(await undo(r, c.id, 42)).toMatchObject({ status: 400, body: { error: { key: 'hub.api.safetyRefInvalid' } } });
    expect(await undo(r, c.id, `refs/office/${c.slug}/before-reset-1`)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.safetyRefNotFound' } } });
  });
});

describe('what stops a restore', () => {
  test('a run of checks in progress', async () => {
    const { card: c, folder } = await card({ configure: checksConfig(['lento', 'sleep 5']) });
    const r = rig as Rig;
    write(folder, 'a.txt', 'uno');
    const started = await r.h.office.runOrderChecks(c.id, 'panel');
    const p1 = r.h.office.orderCheckpoints(c.id)?.checkpoints[0] as CheckpointView;
    const before = head(folder);
    expect(await reset(r, c.id, p1.id)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreChecksRunning' } } });
    expect(head(folder)).toBe(before);
    r.h.office.cancelOrderChecks(c.id);
    if (started?.ok) await started.done;
  });

  test('a checkpoint of another order, or one that does not exist', async () => {
    const { card: a, folder: aFolder } = await card();
    const { card: b, folder: bFolder } = await card({}, 'Pantalla de ajustes');
    const r = rig as Rig;
    await point(r, a.id, aFolder, { 'a.txt': 'uno' });
    const theirs = await point(r, b.id, bFolder, { 'b.txt': 'dos' });
    expect(await reset(r, a.id, theirs.id)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.checkpointNotFound' } } });
    expect(await reset(r, a.id, 999)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.checkpointNotFound' } } });
    expect(await reset(r, 999, theirs.id)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
    expect(await api(r)('POST', `/api/board/orders/${a.id}/checkpoints/x/reset`, {})).toMatchObject({ status: 400, body: { error: { key: 'hub.api.badId' } } });
  });

  test('a checkpoint no longer on the branch', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    expect((await reset(r, c.id, p1.id)).status).toBe(200);
    expect(await reset(r, c.id, p2.id)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.checkpointNotOnBranch' } } });
    expect(head(folder)).toBe(p1.sha);
  });

  test('an order with a PR', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    const before = head(folder);
    r.h.db.query("UPDATE orders SET pr_url = 'https://example.test/pr/1', pr_state = 'open' WHERE id = ?").run(c.id);
    expect(await reset(r, c.id, p1.id, { force: true })).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restorePrOpen' } } });
    expect(await undo(r, c.id, `refs/office/${c.slug}/before-reset-1`)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restorePrOpen' } } });
    expect(head(folder)).toBe(before);
  });

  test('an order already done, until the user confirms it', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    r.h.db.query("UPDATE orders SET status = 'hecho' WHERE id = ?").run(c.id);
    expect(await reset(r, c.id, p1.id)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreDone' } } });
    expect(head(folder)).toBe(p2.sha);
    const forced = await reset(r, c.id, p1.id, { force: true });
    expect(forced.status).toBe(200);
    expect(head(folder)).toBe(p1.sha);
    expect(await undo(r, c.id, forced.body.safetyRef)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreDone' } } });
    expect((await api(r)('POST', `/api/board/orders/${c.id}/checkpoints/undo-reset`, { safetyRef: forced.body.safetyRef, force: true })).status).toBe(200);
    expect(head(folder)).toBe(p2.sha);
  });

  test('an order without a folder', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    r.h.db.query("UPDATE orders SET worktree_state = 'retirado' WHERE id = ?").run(c.id);
    expect(await reset(r, c.id, p1.id)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreNoFolder' } } });
  });

  test('an agent with an open turn inside the folder, until its turn ends', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    r.h.office.ingest(ev(DEV, folder, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(folder, 'b.txt') } }));
    const refused = await reset(r, c.id, p1.id);
    expect(refused).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreBusy' } } });
    expect(refused.body.error.params.who).toBeTruthy();
    r.h.office.ingest(ev(DEV, folder, 'Stop'));
    expect((await reset(r, c.id, p1.id)).status).toBe(200);
  });

  test('files the checkpoints leave out, which the restore would delete', async () => {
    const { card: c, folder } = await card({ configure: (config) => { checksConfig(['uno', 'exit 0'])(config); config.checkpoints.maxFileKb = 1; } });
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    writeFileSync(join(folder, 'grande.bin'), Buffer.alloc(2048, 1));
    const before = head(folder);
    expect(await reset(r, c.id, p1.id)).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreLeftovers', params: { files: 'grande.bin' } } } });
    expect(head(folder)).toBe(before);
    expect(existsSync(join(folder, 'grande.bin'))).toBe(true);
  });
});

describe('the turn of the order', () => {
  test('a restore asked while a check start commits waits for it, and then sees its run', async () => {
    const gate = gatedGit('commit');
    const { card: c, folder } = await card({ office: { git: gate.runner } });
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const floor = r.h.config.floors.mobile;
    if (floor) floor.checks = [{ name: 'lento', command: 'sleep 5' }];
    write(folder, 'b.txt', 'dos');
    gate.arm();
    const starting = r.h.office.runOrderChecks(c.id, 'panel');
    await gate.arrived;
    const resetting = reset(r, c.id, p1.id);
    await Bun.sleep(100);
    expect(gate.log.filter((command) => command === 'reset' || command === 'update-ref' || command === 'clean')).toEqual([]);
    gate.release();
    const started = await starting;
    expect(await resetting).toMatchObject({ status: 409, body: { error: { key: 'hub.api.restoreChecksRunning' } } });
    expect(head(folder)).toBe(r.h.office.orderCheckpoints(c.id)?.checkpoints[0]?.sha as string);
    expect(git(folder, 'show', 'HEAD:b.txt')).toBe('dos');
    expect(gate.log).not.toContain('reset');
    r.h.office.cancelOrderChecks(c.id);
    if (started?.ok) await started.done;
  });

  test('a check start asked while a restore resets waits for it, and checks the restored HEAD', async () => {
    const gate = gatedGit('reset');
    const { card: c, folder } = await card({ office: { git: gate.runner } });
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    gate.arm();
    const resetting = reset(r, c.id, p1.id);
    await gate.arrived;
    const mark = gate.log.length;
    const starting = r.h.office.runOrderChecks(c.id, 'panel');
    await Bun.sleep(100);
    expect(gate.log.slice(mark)).toEqual([]);
    gate.release();
    expect((await resetting).status).toBe(200);
    const started = await starting;
    if (!started?.ok) throw new Error('the checks did not start');
    expect((await started.done).sha).toBe(p1.sha);
  });
});

describe('fork from a checkpoint', () => {
  test('makes a pending child order whose folder leaves from the checkpoint and leaves the source as it was', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    const before = { head: head(folder), branch: git(r.repo, 'rev-parse', `refs/heads/${c.branch}`), points: r.h.office.orderCheckpoints(c.id), status: orderOf(r, c.slug).status };
    const short = p1.sha.slice(0, 7);

    const forked = await api(r)('POST', `/api/board/orders/${c.id}/checkpoints/${p1.id}/fork`, {});

    expect(forked.status).toBe(200);
    const order = forked.body.order as OrderView;
    expect(order).toMatchObject({ status: 'pendiente', floor: 'mobile', parentId: c.id, title: `${c.title} @${short}`, source: 'panel-lead' });
    expect(order.description).toStartWith(`Bifurcación de encargo/${c.slug} en el punto 1 (${short} `);
    await r.h.office.idle();
    const ready = orderOf(r, order.slug);
    const forkFolder = ready.worktree?.path ?? '';
    expect(ready).toMatchObject({ status: 'pendiente', baseSha: orderOf(r, c.slug).baseSha, base: 'origin/develop', branch: `encargo/${order.slug}` });
    expect(git(r.repo, 'rev-parse', `refs/heads/encargo/${order.slug}`)).toBe(p1.sha);
    expect(ready.worktree).toMatchObject({ state: 'listo', stale: false });
    expect(head(forkFolder)).toBe(p1.sha);
    expect(readFileSync(join(forkFolder, 'a.txt'), 'utf8')).toBe('uno');
    expect(existsSync(join(forkFolder, 'b.txt'))).toBe(false);
    expect(leadMessages(r).some((m) => m.includes(`CARPETA: encargo/${order.slug}`))).toBe(true);

    expect(head(folder)).toBe(before.head);
    expect(git(r.repo, 'rev-parse', `refs/heads/${c.branch}`)).toBe(before.branch);
    expect(r.h.office.orderCheckpoints(c.id)).toEqual(before.points);
    expect(orderOf(r, c.slug).status).toBe(before.status);
  });

  test('takes a title, and refuses a checkpoint of another order or a bad way', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const call = api(r);
    expect(await call('POST', `/api/board/orders/${c.id}/checkpoints/${p1.id}/fork`, { title: 'Otro intento' })).toMatchObject({ status: 200, body: { order: { title: 'Otro intento', parentId: c.id } } });
    expect(await call('POST', `/api/board/orders/${c.id}/checkpoints/999/fork`, {})).toMatchObject({ status: 404, body: { error: { key: 'hub.api.checkpointNotFound' } } });
    expect(await call('POST', `/api/board/orders/${c.id}/checkpoints/${p1.id}/fork`, { via: 'nadie' })).toMatchObject({ status: 400, body: { error: { key: 'hub.api.boardFields' } } });
    expect(await call('POST', `/api/board/orders/${c.id}/checkpoints/${p1.id}/fork`, { via: 'director' })).toMatchObject({ status: 400, body: { error: { key: 'hub.api.forkViaLead' } } });
    expect(await call('POST', `/api/board/orders/${c.id}/checkpoints/${p1.id}/fork`, { title: 'x'.repeat(121) })).toMatchObject({ status: 400, body: { error: { key: 'hub.api.boardFields' } } });
    await r.h.office.idle();
  });
});

describe('the base of a fork', () => {
  test('stays the base of the parent: the check files it changed before the checkpoint count as touched', async () => {
    const { card: c, folder } = await card({ configure: (config) => { checksConfig(['uno', 'exit 0'])(config); if (config.floors.mobile) config.floors.mobile.checkFiles = ['ci.sh']; } });
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'ci.sh': 'exit 0\n', 'a.txt': 'uno' });
    const forked = await fork(r, c.id, p1.id);
    expect(forked.status).toBe(200);
    await r.h.office.idle();
    const child = orderOf(r, forked.body.order.slug);
    expect(baseOf(r, child.slug)).toBe(baseOf(r, c.slug));

    const started = await r.h.office.runOrderChecks(child.id, 'panel');
    if (!started?.ok) throw new Error('the checks did not start');
    await started.done;

    expect(orderOf(r, child.slug).checks?.touched).toEqual(['ci.sh']);
    expect(await api(r)('POST', `/api/board/orders/${child.id}/move`, { to: 'hecho' })).toMatchObject({ status: 409, body: { error: { key: 'hub.api.moveNeedsForce' } } });
  });

  test('counts the commits of the parent up to the checkpoint as its own, so its branch is not deleted as merged', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    const forked = await fork(r, c.id, p1.id);
    await r.h.office.idle();
    const child = orderOf(r, forked.body.order.slug);
    const own = Number(git(r.repo, 'rev-list', '--count', `${baseOf(r, c.slug)}..${p1.sha}`));
    expect(own).toBeGreaterThan(0);

    const view = (await r.h.office.listWorktrees('mobile')).worktrees.find((w) => w.orderId === child.id);

    expect(view).toMatchObject({ ahead: own, behind: 0, baseSha: baseOf(r, c.slug), merged: false });
    expect(head(child.worktree?.path ?? '')).toBe(p1.sha);
    expect(await r.h.office.removeWorktree(child.id, { deleteBranch: true, force: false })).toBe('unmerged');
    expect(git(r.repo, 'rev-parse', `refs/heads/encargo/${child.slug}`)).toBe(p1.sha);
  });

  test('is the merge-base with the base when the base of the parent is not behind the checkpoint', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const original = baseOf(r, c.slug);
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    r.h.db.query('UPDATE orders SET base_sha = ? WHERE id = ?').run(p2.sha, c.id);
    const forked = await fork(r, c.id, p1.id);
    expect(forked.status).toBe(200);
    await r.h.office.idle();
    expect(baseOf(r, forked.body.order.slug)).toBe(original);
  });

  test('a branch of that name that already exists stops the fork', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const elsewhere = baseOf(r, c.slug);
    const taken = `encargo/${orderSlug('Otro intento', 'aaaa')}`;
    git(r.repo, 'branch', taken, elsewhere);
    const random = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const refused = await fork(r, c.id, p1.id, { title: 'Otro intento' });
      expect(refused).toMatchObject({ status: 409, body: { error: { key: 'hub.api.forkBranchExists', params: { branch: taken } } } });
    } finally {
      random.mockRestore();
    }
    await r.h.office.idle();
    expect(git(r.repo, 'rev-parse', `refs/heads/${taken}`)).toBe(elsewhere);
    expect(r.h.office.snapshot().orders.some((o) => o.title === 'Otro intento')).toBe(false);
  });
});

describe('preview of a restore', () => {
  const preview = (r: Rig, id: number, cp: number) => api(r)('GET', `/api/board/orders/${id}/checkpoints/${cp}/preview`);
  const refs = (folder: string) => git(folder, 'for-each-ref', '--format=%(refname) %(objectname)');

  test('lists the commits dropped oldest first, the diff stat and the files saved first, and writes nothing', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos\ntres' });
    write(folder, 'c.txt', 'sin guardar');
    write(folder, 'a.txt', 'uno cambiado');
    const status = git(folder, 'status', '--porcelain');
    const before = { head: head(folder), refs: refs(folder), checkpoints: r.h.office.orderCheckpoints(c.id)?.checkpoints.length, told: leadMessages(r).length };

    const result = await preview(r, c.id, p1.id);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      dropped: [`encargo(${c.slug}): comprobación (panel)`],
      droppedTotal: 1,
      stat: { files: 1, adds: 2, dels: 0 },
      dirty: ['a.txt', 'c.txt'],
      blocked: null,
    });
    expect(head(folder)).toBe(before.head);
    expect(head(folder)).toBe(p2.sha);
    expect(refs(folder)).toBe(before.refs);
    expect(git(folder, 'status', '--porcelain')).toBe(status);
    expect(r.h.office.orderCheckpoints(c.id)?.checkpoints.length).toBe(before.checkpoints);
    expect(leadMessages(r)).toHaveLength(before.told);
  });

  test('a checkpoint at HEAD drops nothing', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    await point(r, c.id, folder, { 'a.txt': 'uno' });
    const p2 = await point(r, c.id, folder, { 'b.txt': 'dos' });
    expect((await preview(r, c.id, p2.id)).body).toEqual({ dropped: [], droppedTotal: 0, stat: { files: 0, adds: 0, dels: 0 }, dirty: [], blocked: null });
  });

  test('says why a restore is blocked and leaves the lists empty', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    await point(r, c.id, folder, { 'b.txt': 'dos' });
    r.h.db.query("UPDATE orders SET pr_url = 'https://example.test/pr/1', pr_state = 'open' WHERE id = ?").run(c.id);
    expect(await preview(r, c.id, p1.id)).toEqual({
      status: 200,
      body: { dropped: [], droppedTotal: 0, stat: { files: 0, adds: 0, dels: 0 }, dirty: [], blocked: { key: 'hub.api.restorePrOpen' } },
    });
  });

  test('an order already done is not blocked, a missing order or checkpoint is a 404 and a bad id a 400', async () => {
    const { card: c, folder } = await card();
    const r = rig as Rig;
    const p1 = await point(r, c.id, folder, { 'a.txt': 'uno' });
    r.h.db.query("UPDATE orders SET status = 'hecho' WHERE id = ?").run(c.id);
    expect((await preview(r, c.id, p1.id)).body.blocked).toBeNull();
    expect(await preview(r, c.id, 9999)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.checkpointNotFound' } } });
    expect(await preview(r, 9999, p1.id)).toMatchObject({ status: 404, body: { error: { key: 'hub.api.orderNotFound' } } });
    expect(await api(r)('GET', `/api/board/orders/${c.id}/checkpoints/abc/preview`)).toMatchObject({ status: 400, body: { error: { key: 'hub.api.badId' } } });
  });
});

describe('routes', () => {
  test('need the panel credential', async () => {
    rig = deliveryRig();
    const app = createApp({ office: rig.h.office, port: PORT, key: () => KEY, publicDir: rig.h.root }, () => {});
    for (const path of ['/api/board/orders/1/checkpoints/1/reset', '/api/board/orders/1/checkpoints/undo-reset', '/api/board/orders/1/checkpoints/1/fork']) {
      const response = await app.request(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { host: `127.0.0.1:${PORT}` } });
      expect(response.status).toBe(401);
    }
    const response = await app.request(`http://127.0.0.1:${PORT}/api/board/orders/1/checkpoints/1/preview`, { headers: { host: `127.0.0.1:${PORT}` } });
    expect(response.status).toBe(401);
  });
});
