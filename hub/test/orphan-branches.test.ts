import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server';
import { deliveryRig, newOrder, type Rig } from './delivery-rig';
import { git, pushCommit } from './helpers';

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
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, 'x-office-key': KEY } });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
}

// A branch with n commits of its own on top of origin/develop, made without touching the working tree.
function branchAhead(r: Rig, name: string, n: number): string {
  let tip = git(r.repo, 'rev-parse', 'origin/develop');
  const tree = git(r.repo, 'rev-parse', 'origin/develop^{tree}');
  for (let i = 0; i < n; i++) tip = git(r.repo, 'commit-tree', tree, '-p', tip, '-m', `${name} ${i}`);
  git(r.repo, 'branch', name, tip);
  return tip;
}

describe('orphan branches', () => {
  test('the route needs the panel credential', async () => {
    rig = deliveryRig();
    const app = createApp({ office: rig.h.office, port: PORT, key: () => KEY, publicDir: rig.h.root }, () => {});
    const response = await app.request(`http://127.0.0.1:${PORT}/api/floors/mobile/orphan-branches`, { headers: { host: `127.0.0.1:${PORT}` } });
    expect(response.status).toBe(401);
  });

  test('an unknown floor is a 404', async () => {
    rig = deliveryRig();
    expect(await api(rig)('/api/floors/otra/orphan-branches')).toMatchObject({ status: 404, body: { error: { key: 'hub.api.floorNotManaged' } } });
  });

  test('the branch of a live order is left out and one without order is listed with ahead and behind', async () => {
    rig = deliveryRig();
    const call = api(rig);
    const card = await newOrder(rig, 'Pantalla de login');
    const tip = branchAhead(rig, 'encargo/huerfana-1', 2);
    pushCommit(rig.seed, rig.origin, 'nuevo.txt', 'x', 'avanza develop');
    git(rig.repo, 'fetch', '-q', 'origin');
    const listed = await call('/api/floors/mobile/orphan-branches');
    expect(listed.status).toBe(200);
    expect(listed.body.branches).toEqual([{ branch: 'encargo/huerfana-1', sha: tip, committedAt: expect.any(Number), ahead: 2, behind: 1, order: null }]);
    expect(listed.body.branches.map((b: { branch: string }) => b.branch)).not.toContain(`encargo/${card.slug}`);
  });

  test('a discarded order with its folder retired lists its branch with the order', async () => {
    rig = deliveryRig();
    const card = await newOrder(rig, 'Pantalla de ajustes');
    rig.h.db.query("UPDATE orders SET status = 'descartado', worktree_state = 'retirado' WHERE id = ?").run(card.id);
    const listed = await api(rig)('/api/floors/mobile/orphan-branches');
    expect(listed.body.branches).toMatchObject([{ branch: `encargo/${card.slug}`, ahead: 0, behind: 0, order: { slug: card.slug, status: 'descartado' } }]);
    rig.h.db.query('UPDATE orders SET removed_at = 1 WHERE id = ?').run(card.id);
    rig.h.clock.advance(31_000);
    expect((await api(rig)('/api/floors/mobile/orphan-branches')).body.branches).toMatchObject([{ order: { slug: card.slug } }]);
  });

  test('a delivered order with its folder retired lists its branch, a delivered one with its folder is left out', async () => {
    rig = deliveryRig();
    const card = await newOrder(rig, 'Pantalla de perfil');
    rig.h.db.query("UPDATE orders SET status = 'hecho', worktree_state = 'retirado' WHERE id = ?").run(card.id);
    const listed = await api(rig)('/api/floors/mobile/orphan-branches');
    expect(listed.body.branches).toMatchObject([{ branch: `encargo/${card.slug}`, order: { slug: card.slug, status: 'hecho' } }]);
    rig.h.db.query("UPDATE orders SET worktree_state = 'activo' WHERE id = ?").run(card.id);
    rig.h.clock.advance(31_000);
    expect((await api(rig)('/api/floors/mobile/orphan-branches')).body.branches).toEqual([]);
  });

  test('a tag with the name of an order branch does not change the listed name', async () => {
    rig = deliveryRig();
    branchAhead(rig, 'encargo/etiquetada', 1);
    git(rig.repo, 'tag', 'encargo/etiquetada', 'origin/develop');
    const listed = await api(rig)('/api/floors/mobile/orphan-branches');
    expect(listed.body.branches.map((b: { branch: string }) => b.branch)).toEqual(['encargo/etiquetada']);
  });

  test('a name that is not a valid branch name is ignored', async () => {
    rig = deliveryRig();
    branchAhead(rig, 'encargo/ñu', 1);
    branchAhead(rig, 'encargo/buena', 1);
    const listed = await api(rig)('/api/floors/mobile/orphan-branches');
    expect(listed.body.branches.map((b: { branch: string }) => b.branch)).toEqual(['encargo/buena']);
  });

  test('the list is kept for 30 seconds', async () => {
    rig = deliveryRig();
    const call = api(rig);
    branchAhead(rig, 'encargo/primera', 1);
    expect((await call('/api/floors/mobile/orphan-branches')).body.branches).toHaveLength(1);
    branchAhead(rig, 'encargo/segunda', 1);
    rig.h.clock.advance(29_000);
    expect((await call('/api/floors/mobile/orphan-branches')).body.branches).toHaveLength(1);
    rig.h.clock.advance(1_000);
    expect((await call('/api/floors/mobile/orphan-branches')).body.branches).toHaveLength(2);
  });

  test('listing writes nothing to the repository', async () => {
    rig = deliveryRig();
    branchAhead(rig, 'encargo/sola', 1);
    const before = git(rig.repo, 'for-each-ref');
    await api(rig)('/api/floors/mobile/orphan-branches');
    expect(git(rig.repo, 'for-each-ref')).toBe(before);
  });
});
