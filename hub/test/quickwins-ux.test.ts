import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDocsRepo } from '../src/docs-repo';
import { realPath } from '../src/floors';
import { DISCARDED_MARK, GHOST_MS, GHOST_TOOL_MS, withoutDiscardMark } from '../src/office';
import { startServer } from '../src/server';
import type { HookMeta } from '../src/types';
import { ev, floor, git, harness, useGitIdentity, type Harness } from './helpers';

useGitIdentity();

const PLAN = 'redaccion/planes/login.md';
const KEY = 'u'.repeat(64);
const LEAD = '44444444-bbbb-4ccc-8ddd-000000000004';
const DIRECTOR = '55555555-dddd-4eee-8fff-000000000005';
const MIN = 60_000;

let h: Harness;
afterEach(() => h?.cleanup());

function plansOffice(extra: Parameters<typeof harness>[0] = {}): string {
  h = harness({
    ...extra,
    configure: (config) => {
      config.departments = { redaccion: true, mantenimiento: false };
    },
  });
  const docs = realPath(join(h.root, 'docs'));
  ensureDocsRepo(docs);
  mkdirSync(join(docs, 'redaccion', 'planes'), { recursive: true });
  writeFileSync(join(docs, PLAN), '# Login con Apple\n\n## Pasos\n1. migración\n');
  h.office.refreshDocuments();
  return docs;
}

const doc = () => h.office.documents().find((d) => d.path === PLAN);
const removals = (): string[] => {
  const calls: string[] = [];
  (h.office as unknown as { sync: { remove: (slug: string) => Promise<void> } }).sync.remove = async (slug) => void calls.push(slug);
  return calls;
};

describe('undo of a discard', () => {
  test('withoutDiscardMark strips the paragraph that markDiscardedFile adds and nothing else', () => {
    const body = '# Plan\n\ntexto\n';
    expect(withoutDiscardMark(`${DISCARDED_MARK} desde el panel el 2026-10-16 10:00. No se continúa: otro slug.\n\n${body}`)).toBe(body);
    expect(withoutDiscardMark(body)).toBe(body);
    expect(withoutDiscardMark(`${DISCARDED_MARK} solo la marca`)).toBe('');
  });

  test('restoring a discarded plan strips the mark, commits, cancels the removal and logs it', async () => {
    const UNDO_MS = 61_234;
    const docs = plansOffice({ undoMs: UNDO_MS });
    const removed = removals();
    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = realSet(fn, ms, ...rest);
      if (ms === UNDO_MS) armed.push(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(handle);
      return realClear(handle);
    }) as typeof clearTimeout;
    try {
      await restoreFlow(docs, removed, armed, cleared);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  async function restoreFlow(docs: string, removed: string[], armed: unknown[], cleared: unknown[]): Promise<void> {
    chmodSync(join(docs, PLAN), 0o640);
    expect(await h.office.discardDocument(PLAN)).toBe('ok');
    await h.office.idle();
    expect(doc()?.status).toBe('descartado');
    expect(readFileSync(join(docs, PLAN), 'utf8')).toStartWith(DISCARDED_MARK);
    expect(statSync(join(docs, PLAN)).mode & 0o777).toBe(0o640);
    expect(await h.office.restoreDocument(PLAN)).toBe('ok');
    await h.office.idle();
    expect(doc()?.status).toBe('borrador');
    expect(readFileSync(join(docs, PLAN), 'utf8')).toBe('# Login con Apple\n\n## Pasos\n1. migración\n');
    expect(statSync(join(docs, PLAN)).mode & 0o777).toBe(0o640);
    expect(git(docs, 'log', '-1', '--format=%s')).toBe('redaccion: login restaurado');
    expect(h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.planRestored', params: { path: PLAN } });
    expect(armed).toHaveLength(1);
    expect(cleared).toContain(armed[0]);
    expect(removed).toEqual([]);
    expect(await h.office.restoreDocument(PLAN)).toBe('not-discarded');
    expect(await h.office.restoreDocument('redaccion/planes/nada.md')).toBe('not-found');
  }

  test('a discard that is not undone removes its sources after the window', async () => {
    plansOffice({ undoMs: 40 });
    const removed = removals();
    expect(await h.office.discardDocument(PLAN)).toBe('ok');
    expect(removed).toEqual([]);
    await Bun.sleep(150);
    await h.office.idle();
    expect(removed).toEqual(['login']);
  });

  test('with no window the sources go before the answer', async () => {
    plansOffice({ undoMs: 0 });
    const removed = removals();
    expect(await h.office.discardDocument(PLAN)).toBe('ok');
    expect(removed).toEqual(['login']);
  });
});

describe('restore route', () => {
  let docs = '';
  let base = '';
  let stop = () => {};
  const headers = { 'Content-Type': 'application/json', 'X-Office-Key': KEY };
  const call = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  beforeAll(async () => {
    docs = plansOffice({ undoMs: 60_000 });
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = Number(probe.port);
    probe.stop(true);
    base = `http://127.0.0.1:${port}`;
    mkdirSync(join(h.root, 'public'), { recursive: true });
    ({ stop } = startServer({ office: h.office, port, key: () => KEY, publicDir: join(h.root, 'public') }));
  });

  afterAll(() => {
    stop();
    h.cleanup();
  });

  test('answers 400 without a path, 404 for an unknown plan, 409 when it is not discarded and 200 when it is', async () => {
    expect((await call('/api/documents/restore', {})).status).toBe(400);
    expect((await call('/api/documents/restore', { path: 'redaccion/planes/nada.md' })).status).toBe(404);
    const notDiscarded = await call('/api/documents/restore', { path: PLAN });
    expect(notDiscarded.status).toBe(409);
    expect(await notDiscarded.json()).toEqual({ error: { key: 'hub.api.planNotDiscarded' } });
    expect((await call('/api/documents/discard', { path: PLAN })).status).toBe(200);
    expect(readFileSync(join(docs, PLAN), 'utf8')).toStartWith(DISCARDED_MARK);
    expect((await call('/api/documents/restore', { path: PLAN })).status).toBe(200);
    expect(doc()?.status).toBe('borrador');
    expect((await fetch(`${base}/api/documents/restore`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  test('a decision that is already being sent answers 409 planBusy', async () => {
    const original = h.office.decidePlan.bind(h.office);
    h.office.decidePlan = async () => 'busy';
    try {
      const res = await call('/api/documents/decide', { path: PLAN, decision: 'ejecutar' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { key: 'hub.api.planBusy' } });
    } finally {
      h.office.decidePlan = original;
    }
  });
});

describe('a second click on Ejecutar', () => {
  test('sends one order and the other call answers busy', async () => {
    const sent: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const docs = plansOffice({
      deliverFn: async (_socket, payload) => {
        sent.push(payload);
        await gate;
      },
    });
    h.db.query('INSERT INTO documents (path, kind, slug, round, delivered_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(PLAN, 'plan', 'login', 1, 1);
    h.office.refreshDocuments();
    expect(doc()?.status).toBe('entregado');
    const socket = join(h.root, 'director.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(DIRECTOR, h.workspace, 'SessionStart', {}), { socket, token: 'tok', role: 'office-director', name: 'director' });
    const first = h.office.decidePlan(PLAN, 'ejecutar');
    const second = h.office.decidePlan(PLAN, 'ejecutar');
    expect(await second).toBe('busy');
    release();
    expect(await first).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`${docs}/${PLAN}`);
    expect(doc()?.status).toBe('ejecutando');
    expect(await h.office.decidePlan(PLAN, 'ejecutar')).toBe('invalid-state');
  });
});

describe('ghost sessions', () => {
  const quiet: HookMeta = { socket: null, token: null, role: null, name: 'sesion-fantasma' };
  const sessionOf = (id: string) => h.office.snapshot().sessions.find((s) => s.sessionId === id);

  function start(): string {
    h = harness();
    const repo = join(h.root, 'mobile');
    mkdirSync(repo, { recursive: true });
    h.config.floors.mobile = floor(repo);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), quiet);
    return repo;
  }

  test('silent for 31 minutes with no socket ends the session as a ghost, and any event revives it', () => {
    const repo = start();
    h.clock.advance(GHOST_MS - MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).toBeNull();
    h.clock.advance(2 * MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).not.toBeNull();
    expect(h.db.query<{ ended_at: number | null }, []>('SELECT ended_at FROM sessions').get()?.ended_at).not.toBeNull();
    expect(h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.sessionGhost', params: { who: 'sesion-fantasma', minutes: 31 } });
    h.office.ingest(ev(LEAD, repo, 'Notification', { message: 'sigo aquí' }));
    expect(sessionOf(LEAD)?.endedAt).toBeNull();
    expect(h.db.query<{ ended_at: number | null }, []>('SELECT ended_at FROM sessions').get()?.ended_at).toBeNull();
    h.clock.advance(MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).toBeNull();
  });

  test('a Bash open for 45 minutes is not a ghost', () => {
    const repo = start();
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'build-1', tool_input: { command: 'flutter build ios' } }));
    h.clock.advance(45 * MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).toBeNull();
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'build-1', tool_input: { command: 'flutter build ios' } }));
    h.clock.advance(GHOST_MS + MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).not.toBeNull();
  });

  test('a Bash open for 5 hours is a ghost', () => {
    const repo = start();
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'build-2', tool_input: { command: 'flutter build ios' } }));
    h.clock.advance(GHOST_TOOL_MS - MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).toBeNull();
    h.clock.advance(5 * 60 * MIN - GHOST_TOOL_MS + MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).not.toBeNull();
  });

  test('a session with a live socket is never a ghost', () => {
    h = harness();
    const repo = join(h.root, 'mobile');
    mkdirSync(repo, { recursive: true });
    h.config.floors.mobile = floor(repo);
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), { ...quiet, socket });
    h.clock.advance(3 * 60 * MIN);
    h.office.tick();
    expect(sessionOf(LEAD)?.endedAt).toBeNull();
    expect(existsSync(socket)).toBe(true);
  });
});

describe('author of a chat message', () => {
  const lead: HookMeta = { socket: null, token: 'tok-lead', role: 'office-lead-mobile', name: 'lead-mobile' };
  let repo = '';

  function team(): void {
    h = harness();
    repo = join(h.root, 'mobile');
    mkdirSync(repo, { recursive: true });
    h.config.floors.mobile = floor(repo);
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), { ...lead, socket });
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'call-1', tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile' } }), lead);
    h.office.ingest(
      ev(LEAD, repo, 'PostToolUse', {
        tool_name: 'Agent',
        tool_use_id: 'call-1',
        tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile' },
        tool_response: { status: 'teammate_spawned', agentId: 'adev-1' },
      }),
      lead,
    );
    h.office.ingest(ev(LEAD, repo, 'SubagentStart', { agent_id: 'adev-1', agent_type: 'office-dev-mobile' }));
    const other = join(h.root, 'backend');
    mkdirSync(other, { recursive: true });
    h.config.floors.backend = floor(other);
    h.office.ingest(ev('66666666-bbbb-4ccc-8ddd-000000000006', other, 'SessionStart', {}), { socket, token: 'tok-backend', role: 'office-lead-backend', name: 'lead-backend' });
  }

  const post = (meta: HookMeta, from?: string, cwd = repo) => h.office.postChat({ channel: 'mobile', kind: 'texto', text: 'hola', from, cwd }, meta);

  test('the token names the session; --de may name that session or one of its agents', () => {
    team();
    expect(post(lead)).toMatchObject({ ok: true, message: { authorKey: LEAD, authorName: 'lead-mobile' } });
    expect(post({ ...lead, name: 'cualquier-cosa' })).toMatchObject({ ok: true, message: { authorKey: LEAD, authorName: 'lead-mobile' } });
    expect(post(lead, 'lead-mobile')).toMatchObject({ ok: true, message: { authorKey: LEAD } });
    expect(post(lead, 'dev-mobile')).toMatchObject({ ok: true, message: { authorKey: 'adev-1', authorName: 'dev-mobile', roleId: 'dev' } });
  });

  test('an unknown token, a name that is not of the session and a session of another floor are refused', () => {
    team();
    const refused = { ok: false, status: 403, error: { key: 'hub.api.chatSessionUnknown' } };
    expect(post({ ...lead, token: 'tok-falso' })).toMatchObject(refused);
    expect(post({ ...lead, token: 'tok-falso' }, 'dev-mobile')).toMatchObject(refused);
    expect(post(lead, 'lead-backend')).toMatchObject(refused);
    expect(post(lead, 'usuario')).toMatchObject(refused);
    expect(post({ ...lead, token: 'tok-backend' }, 'dev-mobile')).toMatchObject(refused);
    expect(post({ ...lead, token: 'tok-backend' })).toMatchObject(refused);
  });

  test('without a token the declared name still signs, but --de is refused', () => {
    team();
    const noToken: HookMeta = { ...lead, token: null };
    expect(post(noToken)).toMatchObject({ ok: true, message: { authorName: 'lead-mobile' } });
    expect(post(noToken, 'dev-mobile')).toMatchObject({ ok: false, status: 403, error: { key: 'hub.api.chatSessionUnknown' } });
  });
});
