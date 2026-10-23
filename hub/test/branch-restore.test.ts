import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server';
import { commitAll, deliveryRig, newOrder, write, type Rig } from './delivery-rig';
import { git } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
const DAY_MS = 86_400_000;
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

// An order whose folder had a commit of its own and that was deleted from the panel together with its branch.
async function deletedOrder(r: Rig, title: string): Promise<{ branch: string; sha: string }> {
  const card = await newOrder(r, title);
  const path = card.worktree?.path ?? '';
  write(path, `${card.slug}.txt`, title);
  const sha = commitAll(path, title);
  const branch = `encargo/${card.slug}`;
  const removed = await api(r)('DELETE', `/api/worktrees/${card.id}?branch=1&force=1`);
  expect(removed.status).toBe(200);
  expect(git(r.repo, 'branch', '--list', branch)).toBe('');
  return { branch, sha };
}

function activityKeys(r: Rig): string[] {
  return r.h.db
    .query<{ summary: string }, []>("SELECT summary FROM activity_log WHERE agent_key = 'panel' ORDER BY id")
    .all()
    .map((row) => (JSON.parse(row.summary) as { key: string }).key);
}

describe('deleted branches', () => {
  test('every route needs the panel credential', async () => {
    rig = deliveryRig();
    const app = createApp({ office: rig.h.office, port: PORT, key: () => KEY, publicDir: rig.h.root }, () => {});
    for (const [method, path] of [
      ['GET', '/api/floors/mobile/deleted-branches'],
      ['POST', '/api/floors/mobile/deleted-branches/restore'],
    ] as const) {
      const response = await app.request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}` } });
      expect(response.status).toBe(401);
    }
  });

  test('a deleted branch is listed as restorable, newest first, and only for 30 days', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const first = await deletedOrder(rig, 'Pantalla de login');
    rig.h.clock.advance(60_000);
    const second = await deletedOrder(rig, 'Pantalla de ajustes');
    const listed = await call('GET', '/api/floors/mobile/deleted-branches');
    expect(listed.status).toBe(200);
    expect(listed.body.branches).toEqual([
      { floor: 'mobile', branch: second.branch, sha: second.sha, at: rig.h.clock.now, restorable: true, reason: null },
      { floor: 'mobile', branch: first.branch, sha: first.sha, at: rig.h.clock.now - 60_000, restorable: true, reason: null },
    ]);
    expect(await call('GET', '/api/floors/otra/deleted-branches')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.floorNotManaged' } } });
    rig.h.clock.advance(31 * DAY_MS);
    expect((await call('GET', '/api/floors/mobile/deleted-branches')).body.branches).toEqual([]);
  });

  test('restore recreates the branch at its commit, writes the activity line and refuses a second time', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { branch, sha } = await deletedOrder(rig, 'Pantalla de login');
    expect(await call('POST', '/api/floors/mobile/deleted-branches/restore', { branch, sha })).toEqual({ status: 200, body: { ok: true } });
    expect(git(rig.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(sha);
    expect(activityKeys(rig).filter((key) => key.startsWith('hub.act.branch'))).toEqual(['hub.act.branchDeleted', 'hub.act.branchRestored']);
    expect(rig.h.messages).toContainEqual({ type: 'worktrees', floor: 'mobile' });
    expect((await call('GET', '/api/floors/mobile/deleted-branches')).body.branches).toEqual([expect.objectContaining({ branch, sha, restorable: false, reason: 'exists' })]);
    expect(await call('POST', '/api/floors/mobile/deleted-branches/restore', { branch, sha })).toMatchObject({
      status: 409,
      body: { error: { key: 'hub.api.branchRestoreExists' } },
    });
  });

  test('a branch whose commit git no longer has cannot come back', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { branch, sha } = await deletedOrder(rig, 'Pantalla de login');
    git(rig.repo, 'reflog', 'expire', '--expire=now', '--all');
    git(rig.repo, 'gc', '-q', '--prune=now');
    expect(() => git(rig?.repo ?? '', 'cat-file', '-e', sha)).toThrow();
    expect((await call('GET', '/api/floors/mobile/deleted-branches')).body.branches).toEqual([expect.objectContaining({ branch, sha, restorable: false, reason: 'gone' })]);
    expect(await call('POST', '/api/floors/mobile/deleted-branches/restore', { branch, sha })).toMatchObject({
      status: 410,
      body: { error: { key: 'hub.api.branchCommitGone' } },
    });
    expect(git(rig.repo, 'branch', '--list', branch)).toBe('');
  });

  test('bad input is a 400 and a deletion the hub never made is a 404', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { branch, sha } = await deletedOrder(rig, 'Pantalla de login');
    const restore = (body: unknown, floor = 'mobile') => call('POST', `/api/floors/${floor}/deleted-branches/restore`, body);
    for (const body of [{ branch: 'develop', sha }, { branch, sha: sha.slice(0, 7) }, { branch, sha: sha.toUpperCase() }, { branch: '--force', sha }, {}]) {
      expect(await restore(body)).toMatchObject({ status: 400, body: { error: { key: 'hub.api.branchRestoreBad' } } });
    }
    expect(await restore({ branch: 'encargo/otro-1234', sha })).toMatchObject({ status: 404, body: { error: { key: 'hub.api.branchDeletionNotFound' } } });
    expect(await restore({ branch, sha: git(rig.repo, 'rev-parse', 'origin/develop') })).toMatchObject({
      status: 404,
      body: { error: { key: 'hub.api.branchDeletionNotFound' } },
    });
    expect(await restore({ branch, sha }, 'otra')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.floorNotManaged' } } });
    expect(git(rig.repo, 'branch', '--list', 'encargo/*')).toBe('');
  });

  test('older deletions of the same branch are superseded and cannot be restored', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { branch, sha } = await deletedOrder(rig, 'Pantalla de login');
    rig.h.clock.advance(60_000);
    const older = sha;
    const newer = git(rig.repo, 'rev-parse', 'origin/develop');
    const summary = JSON.stringify({ key: 'hub.act.branchDeleted', params: { branch, sha: newer } });
    rig.h.db.query("INSERT INTO activity_log (ts, agent_key, floor, event, summary) VALUES (?, 'panel', 'mobile', 'Worktrees', ?)").run(rig.h.clock.now, summary);
    const listed = (await call('GET', '/api/floors/mobile/deleted-branches')).body.branches as Record<string, any>[];
    expect(listed.map((b) => [b.sha, b.restorable, b.reason])).toEqual([
      [newer, true, null],
      [older, false, 'superseded'],
    ]);
    expect(await call('POST', '/api/floors/mobile/deleted-branches/restore', { branch, sha: older })).toMatchObject({ status: 404 });
  });

  test('the git checks of a listing are cached for 30 seconds', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const { branch, sha } = await deletedOrder(rig, 'Pantalla de login');
    const first = (await call('GET', '/api/floors/mobile/deleted-branches')).body.branches;
    expect(first[0]).toMatchObject({ restorable: true });
    git(rig.repo, 'branch', branch, sha);
    expect((await call('GET', '/api/floors/mobile/deleted-branches')).body.branches[0]).toMatchObject({ restorable: true });
    rig.h.clock.advance(31_000);
    expect((await call('GET', '/api/floors/mobile/deleted-branches')).body.branches[0]).toMatchObject({ restorable: false, reason: 'exists' });
  });
});
