import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDocsRepo } from '../src/docs-repo';
import type { FloorAdmin } from '../src/floor-admin';
import { startServer } from '../src/server';
import type { SettingsService } from '../src/settings';
import { settingsView } from '../src/settings';
import { floor, harness, useGitIdentity } from './helpers';

useGitIdentity();
const KEY = 'v'.repeat(64);

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

describe('hub server v2 routes', () => {
  const h = harness({
    deliverFn: async () => {},
    configure: (config) => {
      config.departments = { redaccion: true, mantenimiento: true };
    },
  });
  const repo = join(h.root, 'mobile');
  const docs = join(h.root, 'docs');
  const updates: unknown[] = [];
  const settings: SettingsService = {
    view: () => settingsView(h.config),
    update: (raw) => {
      updates.push(raw);
      return raw && typeof raw === 'object' && 'roles' in raw
        ? { ok: true, regenerated: 11, note: [{ key: 'hub.settings.saved' }] }
        : { ok: false, error: [{ key: 'hub.settings.noChanges' }] };
    },
  };
  const floorCalls: unknown[] = [];
  const floors: FloorAdmin = {
    add: (raw) => {
      floorCalls.push(raw);
      return raw && typeof raw === 'object' && 'path' in raw
        ? { ok: true, slug: 'web', path: '/tmp/web', stack: 'node', startCommand: 'claude', note: { key: 'hub.floors.added', params: { slug: 'web', startCommand: 'claude' } } }
        : { ok: false, status: 400, error: { key: 'hub.floors.pathRequired' } };
    },
    remove: async (slug) => {
      floorCalls.push(slug);
      return { ok: false, status: 404, error: { key: 'hub.floors.notFound', params: { slug } } };
    },
  };
  let base = '';
  let stop = () => {};
  const headers = { 'Content-Type': 'application/json', 'X-Office-Key': KEY };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    mkdirSync(repo, { recursive: true });
    ensureDocsRepo(docs);
    h.config.floors.mobile = floor(repo);
    const publicDir = join(h.root, 'public');
    mkdirSync(publicDir, { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    ({ stop } = startServer({ office: h.office, port, key: () => KEY, publicDir, settings, floors }));
  });

  afterAll(() => {
    stop();
    h.cleanup();
  });

  test('health answers without the key and says nothing else', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('a starting lead receives its memory as additional context', async () => {
    h.office.addLesson({ floor: 'mobile', role: 'lead', text: 'Pide siempre el contrato a backend antes de repartir' });
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { ...headers, 'X-Office-Role': 'office-lead-mobile', 'X-Office-Name': 'lead-mobile' },
      body: JSON.stringify({ session_id: 'lead-1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(body.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(body.hookSpecificOutput.additionalContext).toContain('Pide siempre el contrato');
    const quiet = await call('POST', '/events', { session_id: 'lead-1', cwd: repo, hook_event_name: 'Stop' });
    expect(await quiet.text()).toBe('');
  });

  test('/events denies a read over the cap only to a verdict role, with a PreToolUse permission decision', async () => {
    h.config.review.maxReviewerReads = 1;
    const read = (session: string, role: string) =>
      fetch(`${base}/events`, {
        method: 'POST',
        headers: { ...headers, 'X-Office-Role': role },
        body: JSON.stringify({ session_id: session, cwd: join(docs, 'redaccion'), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(docs, 'x.md') } }),
      });
    expect(await (await read('rev-1', 'office-revisor-planes')).text()).toBe('');
    const denied = await read('rev-1', 'office-revisor-planes');
    expect(denied.headers.get('content-type')).toContain('application/json');
    expect(await denied.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Límite de lecturas: llevas 1 (review.maxReviewerReads)'),
      },
    });
    for (let i = 0; i < 3; i++) expect(await (await read('lead-red-1', 'office-lead-redaccion')).text()).toBe('');
    h.config.review.maxReviewerReads = 30;
  });

  test('the guard blocks a department write outside its folder', async () => {
    const event = (file: string) => ({
      session_id: 'red-1',
      cwd: join(docs, 'redaccion'),
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file, content: 'x' },
    });
    const blocked = await fetch(`${base}/guard`, {
      method: 'POST',
      headers: { ...headers, 'X-Office-Role': 'office-lead-redaccion' },
      body: JSON.stringify(event(join(repo, 'lib', 'a.dart'))),
    });
    expect(await blocked.text()).toStartWith('block:Guardia de Agent Office');
    const allowed = await call('POST', '/guard', event(join(docs, 'redaccion', 'planes', 'x.md')));
    expect(await allowed.text()).toBe('pass');
    expect((await fetch(`${base}/guard`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  test('/hook answers pass with the memory of a starting lead and 401 without the key', async () => {
    const hook = (body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${base}/hook`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const res = await hook(
      { session_id: 'lead-hook-1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' },
      { 'X-Office-Role': 'office-lead-mobile', 'X-Office-Name': 'lead-mobile' },
    );
    const [first, ...rest] = (await res.text()).split('\n');
    expect(first).toBe('pass');
    const body = JSON.parse(rest.join('\n')) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(body.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(body.hookSpecificOutput.additionalContext).toContain('Pide siempre el contrato');
    expect(await (await hook({ session_id: 'lead-hook-1', cwd: repo, hook_event_name: 'Stop' })).text()).toBe('pass');
    expect(await (await hook('nada')).text()).toBe('pass');
    expect((await fetch(`${base}/hook`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  test('/hook records the event and applies the guard in the same request', async () => {
    const pre = (tool: string, file: string) =>
      fetch(`${base}/hook`, {
        method: 'POST',
        headers: { ...headers, 'X-Office-Role': 'office-lead-redaccion' },
        body: JSON.stringify({ session_id: 'red-hook-1', cwd: join(docs, 'redaccion'), hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file, content: 'x' } }),
      });
    const blocked = await (await pre('Write', '/etc/x.md')).text();
    expect(blocked).toStartWith('block:Guardia de Agent Office');
    expect(blocked).not.toContain('\n');
    expect(h.office.snapshot().agents.find((a) => a.key === 'red-hook-1')?.tool).toBe('Write');
    expect(await (await pre('Read', join(docs, 'redaccion', 'planes', 'x.md'))).text()).toBe('pass');
    expect(h.office.snapshot().agents.find((a) => a.key === 'red-hook-1')?.tool).toBe('Read');
  });

  test('/hook passes the read cap denial through and TaskCompleted goes through the gate', async () => {
    h.config.review.maxReviewerReads = 1;
    const read = () =>
      fetch(`${base}/hook`, {
        method: 'POST',
        headers: { ...headers, 'X-Office-Role': 'office-revisor-planes' },
        body: JSON.stringify({ session_id: 'rev-hook-1', cwd: join(docs, 'redaccion'), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(docs, 'x.md') } }),
      });
    expect(await (await read()).text()).toBe('pass');
    const denied = (await (await read()).text()).split('\n');
    expect(denied[0]).toBe('pass');
    expect(JSON.parse(denied.slice(1).join('\n')).hookSpecificOutput.permissionDecision).toBe('deny');
    h.config.review.maxReviewerReads = 30;
    const done = await call('POST', '/hook', { session_id: 'solo-1', cwd: repo, hook_event_name: 'TaskCompleted', task_id: '1', task_subject: 'x' });
    expect(await done.text()).toBe('pass');
  });

  test('orders reach only sessions of the office', async () => {
    const personal = join(h.root, 'personal');
    mkdirSync(personal, { recursive: true });
    const socket = join(h.root, 'me.sock');
    writeFileSync(socket, '');
    const start = (sessionId: string, cwd: string, extra: Record<string, string> = {}) =>
      fetch(`${base}/events`, {
        method: 'POST',
        headers: { ...headers, 'X-Office-Socket': socket, 'X-Office-Token': 'tok', ...extra },
        body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
      });
    await start('me-1', personal);
    const refused = await call('POST', '/api/orders', { sessionId: 'me-1', text: 'hola' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { key: 'hub.api.sessionNotOffice' } });
    await start('me-2', repo);
    expect((await call('POST', '/api/orders', { sessionId: 'me-2', text: 'hola' })).status).toBe(403);
    await start('lead-2', repo, { 'X-Office-Role': 'office-lead-mobile', 'X-Office-Name': 'lead-mobile' });
    expect((await call('POST', '/api/orders', { sessionId: 'lead-2', text: 'hola' })).status).toBe(200);
  });

  test('status and relaunch refuse sessions outside the office', async () => {
    const socket = join(h.root, 'me-4.sock');
    writeFileSync(socket, '');
    await fetch(`${base}/events`, {
      method: 'POST',
      headers: { ...headers, 'X-Office-Socket': socket, 'X-Office-Token': 'tok' },
      body: JSON.stringify({ session_id: 'me-4', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }),
    });
    for (const action of ['status', 'relaunch']) {
      const res = await call('POST', `/api/sessions/me-4/${action}`, {});
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { key: 'hub.api.sessionNotOffice' } });
    }
  });

  test('settings go through the settings service', async () => {
    const view = (await (await call('GET', '/api/settings')).json()) as { departments: { redaccion: boolean } };
    expect(view.departments.redaccion).toBe(true);
    const saved = await call('POST', '/api/settings', { roles: { dev: { model: 'haiku' } } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, regenerated: 11, note: [{ key: 'hub.settings.saved' }] });
    const refused = await call('POST', '/api/settings', { nada: true });
    expect(refused.status).toBe(400);
    expect(updates).toHaveLength(2);
  });

  test('floors are added and deleted through the floor admin', async () => {
    const created = await call('POST', '/api/floors', { path: '/tmp/web' });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ ok: true, slug: 'web' });
    const refused = await call('POST', '/api/floors', {});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ ok: false, error: { key: 'hub.floors.pathRequired' } });
    const missing = await call('DELETE', '/api/floors/x');
    expect(missing.status).toBe(404);
    expect(floorCalls).toEqual([{ path: '/tmp/web' }, {}, 'x']);
    expect((await fetch(`${base}/api/floors`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/floors/x`, { method: 'DELETE' })).status).toBe(401);
  });

  test('memory: list, add, refuse duplicates and delete', async () => {
    expect((await call('GET', '/api/memory/mobile/jefe')).status).toBe(400);
    const added = await call('POST', '/api/memory', { floor: 'mobile', role: 'tester', text: 'Arranca el emulador antes de los flow tests' });
    expect(added.status).toBe(200);
    const { lesson } = (await added.json()) as { lesson: { id: number; origin: string } };
    expect(lesson.origin).toBe('user');
    expect((await call('POST', '/api/memory', { floor: 'mobile', role: 'tester', text: 'arranca el emulador antes de los flow tests' })).status).toBe(409);
    const view = (await (await call('GET', '/api/memory/mobile/tester')).json()) as { lessons: { id: number }[]; reports: unknown[] };
    expect(view.lessons.map((l) => l.id)).toEqual([lesson.id]);
    expect(await (await call('DELETE', `/api/memory/${lesson.id}`)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/api/memory/${lesson.id}`)).status).toBe(404);
    expect((await call('DELETE', '/api/memory/abc')).status).toBe(400);
    for (const bad of ['1e2', '0x10', '%207', '-3', '1.5', '1234567890123456']) {
      expect((await call('DELETE', `/api/memory/${bad}`)).status).toBe(400);
    }
  });

  test('reports, documents and sources answer with clear errors', async () => {
    const missing = await call('GET', '/api/reports/nadie');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: unknown }).error).toEqual({ key: 'hub.api.noReport' });
    const live = await call('GET', '/api/reports/lead-1');
    expect(((await live.json()) as { agentKey: string }).agentKey).toBe('lead-1');
    expect(await (await call('GET', '/api/documents')).json()).toEqual([]);
    expect((await call('GET', '/api/documents/content?path=redaccion/planes/x.md')).status).toBe(404);
    expect((await call('POST', '/api/documents/discard', {})).status).toBe(400);
    expect((await call('POST', '/api/documents/discard', { path: 'redaccion/planes/x.md' })).status).toBe(404);
    const bad = await call('POST', '/api/redaccion/sync', { slug: 'Mal', floors: [] });
    expect(bad.status).toBe(400);
    const text = await call('POST', '/api/redaccion/sync?format=text', { slug: 'x', floors: [] });
    expect(await text.text()).toStartWith('ERROR:');
  });

  test('plan decisions validate the request, the state and the director, and discard explains its 409', async () => {
    const path = 'redaccion/planes/viaje.md';
    writeFileSync(join(docs, path), '# Viaje\n');
    h.db.query("INSERT INTO documents (path, kind, slug, round, delivered_at, updated_at) VALUES (?, 'plan', 'viaje', 2, 1, 1)").run(path);
    h.office.refreshDocuments();
    const decide = (body: unknown) => call('POST', '/api/documents/decide', body);
    expect((await decide({ path })).status).toBe(400);
    expect((await decide({ decision: 'aparcar' })).status).toBe(400);
    expect((await decide({ path, decision: 'borrar' })).status).toBe(400);
    expect((await decide({ path: 'redaccion/planes/nada.md', decision: 'aparcar' })).status).toBe(404);
    const invalid = await decide({ path, decision: 'cerrar' });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toEqual({ error: { key: 'hub.api.planBadState' } });
    const noDirector = await decide({ path, decision: 'ejecutar' });
    expect(noDirector.status).toBe(409);
    expect(await noDirector.json()).toEqual({ error: { key: 'hub.api.directorClosed' } });
    const parked = await decide({ path, decision: 'aparcar' });
    expect(parked.status).toBe(200);
    expect(await parked.json()).toEqual({ ok: true });
    expect(h.office.documents().find((d) => d.path === path)?.status).toBe('aparcado');
    h.db.query("UPDATE documents SET decision = 'ejecutar' WHERE path = ?").run(path);
    h.office.refreshDocuments();
    const discard = await call('POST', '/api/documents/discard', { path });
    expect(discard.status).toBe(409);
    expect(await discard.json()).toEqual({ error: { key: 'hub.api.planClosed' } });
  });
});
