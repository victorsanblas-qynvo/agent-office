import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { captureLesson, listLessons, memoryContext } from '../src/memory';
import { Office, SNAPSHOT_CLOSED_DOCS, recentDocuments } from '../src/office';
import { MAX_STORED_RESPONSE, storedPayload } from '../src/privacy';
import { parseProtocol } from '../src/protocol';
import { prune, pruneInChunks } from '../src/prune';
import { QUESTION_PREFIX } from '../src/state-machine';
import { READ_BUDGET, TokenMeter, projectSlug, type MeterAgent } from '../src/tokens';
import type { DocumentView } from '../src/types';
import { PROFILES_DIR } from '../src/config';
import { loadProfiles } from '../src/profiles';
import { ev, floor, harness, tempDir, type Harness } from './helpers';

const LEAD = '33333333-bbbb-4ccc-8ddd-000000000003';
const DAY = 86_400_000;

let h: Harness | undefined;
let cleanup = (): void => {};
afterEach(() => {
  h?.cleanup();
  h = undefined;
  cleanup();
  cleanup = () => {};
});

function managed(): string {
  h = harness();
  const repo = join(h.root, 'mobile');
  mkdirSync(repo, { recursive: true });
  h.config.floors.mobile = floor(repo);
  return repo;
}

describe('database pragmas', () => {
  test('a file database runs in WAL with synchronous NORMAL', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const db = openDb(join(t.dir, 'office.db'));
    expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(1);
    db.close();
  });
});

describe('ingest transaction', () => {
  test('every write of an event happens in one transaction and the nested ones become savepoints', () => {
    const repo = managed();
    const seen: boolean[] = [];
    h!.office.subscribe((msg) => {
      if (msg.type === 'agent') seen.push(h!.db.inTransaction);
    });
    const meta = { socket: null, token: null, role: 'office-lead-mobile', name: 'lead-mobile' };
    h!.office.ingest(ev(LEAD, repo, 'SessionStart', {}), meta);
    h!.office.ingest(ev(LEAD, repo, 'Stop', { last_assistant_message: 'listo' }), meta);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(h!.db.inTransaction).toBe(false);
    // The Stop saved a report through its own (nested) transaction.
    expect(h!.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
    expect(h!.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(2);
  });

  test('an error in the middle of an event leaves none of its writes', () => {
    const repo = managed();
    const meta = { socket: null, token: null, role: 'office-lead-mobile', name: 'lead-mobile' };
    h!.office.ingest(ev(LEAD, repo, 'SessionStart', {}), meta);
    const before = h!.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n;
    const office = h!.office as unknown as { pushActivity: () => void };
    office.pushActivity = () => {
      throw new Error('boom');
    };
    expect(() => h!.office.ingest(ev(LEAD, repo, 'Notification', { message: 'x' }), meta)).toThrow('boom');
    expect(h!.db.inTransaction).toBe(false);
    expect(h!.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(before);
  });
});

describe('questions left pending', () => {
  test('start releases the pending rows of a previous run', () => {
    managed();
    const insert = h!.db.query("INSERT INTO questions (id, session_id, agent_key, floor, payload, status, created_at) VALUES (?, 's', 'a', 'f', '[]', ?, 1)");
    insert.run('q-pending', 'pending');
    insert.run('q-answered', 'answered');
    h!.office.start();
    const rows = h!.db.query<{ id: string; status: string; resolved_at: number | null }, []>('SELECT id, status, resolved_at FROM questions ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'q-answered', status: 'answered', resolved_at: null },
      { id: 'q-pending', status: 'released', resolved_at: h!.clock.now },
    ]);
  });
});

describe('protocol prefixes', () => {
  test('PLAN and PREGUNTA are recognised in lowercase', () => {
    expect(parseProtocol('plan: redaccion/planes/x.md — resumen')).toMatchObject({ kind: 'plan', target: 'redaccion/planes/x.md' });
    expect(parseProtocol('pregunta: ¿sí o no?')).toMatchObject({ kind: 'question' });
    expect(QUESTION_PREFIX.test('Pregunta: ¿sí?')).toBe(true);
    expect(QUESTION_PREFIX.test('preguntar algo')).toBe(false);
  });
});

describe('memory order', () => {
  test('a lesson of the user survives the cap of the context block', () => {
    const db = openDb(':memory:');
    const limits = { maxLessons: 50, maxLessonsPerSession: 50, maxContextChars: 400 } as never;
    captureLesson(db, { floor: 'mobile', role: 'dev', text: 'Nunca uses pumpAndSettle en los flow tests', origin: 'user', agentKey: null, now: 1 }, limits);
    for (let i = 0; i < 20; i += 1) {
      captureLesson(db, { floor: 'mobile', role: 'dev', text: `Lección del agente número ${i} con texto de relleno suficiente`, origin: 'agent', agentKey: `a${i}`, now: 10 + i }, limits);
    }
    const plain = listLessons(db, 'mobile', 'dev');
    expect(plain[0]?.origin).toBe('agent');
    const first = listLessons(db, 'mobile', 'dev', { userFirst: true });
    expect(first[0]).toMatchObject({ origin: 'user' });
    const context = (lessons: typeof first) => memoryContext({ roleLabel: 'desarrollador', floorLabel: 'la planta mobile', lessons, reports: [], maxChars: 400 });
    expect(context(first)).toContain('pumpAndSettle');
    expect(context(plain)).not.toContain('pumpAndSettle');
  });
});

describe('retention in slices', () => {
  test('pruneInChunks deletes in slices, yields between them and removes what prune removes', async () => {
    const now = 1_800_000_000_000;
    const old = now - 20 * DAY;
    const fill = (db: ReturnType<typeof openDb>) => {
      const insert = db.query('INSERT INTO events (ts, session_id, agent_key, floor, event) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < 7; i += 1) insert.run(old, 's', 'a', 'f', 'Stop');
      insert.run(now - DAY, 's', 'a', 'f', 'Stop');
      db.query("INSERT INTO questions (id, session_id, agent_key, floor, payload, status, created_at) VALUES ('q', 's', 'a', 'f', '[]', 'pending', ?)").run(old);
    };
    const whole = openDb(':memory:');
    fill(whole);
    const sliced = openDb(':memory:');
    fill(sliced);
    let yields = 0;
    const removed = await pruneInChunks(sliced, now, 14, { chunk: 2, yieldLoop: async () => void (yields += 1) });
    expect(removed).toBe(prune(whole, now, 14));
    expect(removed).toBe(7);
    expect(yields).toBeGreaterThanOrEqual(3);
    expect(sliced.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(1);
    expect(sliced.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM questions').get()?.n).toBe(1);
  });

  test('pruneInChunks normalizes a zero or fractional chunk', async () => {
    const now = 1_800_000_000_000;
    const old = now - 20 * DAY;
    const filled = () => {
      const db = openDb(':memory:');
      const insert = db.query('INSERT INTO events (ts, session_id, agent_key, floor, event) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < 5; i += 1) insert.run(old, 's', 'a', 'f', 'Stop');
      return db;
    };
    const count = (db: ReturnType<typeof openDb>) => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n;

    const zero = filled();
    expect(await pruneInChunks(zero, now, 14, { chunk: 0, yieldLoop: async () => {} })).toBe(5);
    expect(count(zero)).toBe(0);

    const fraction = filled();
    expect(await pruneInChunks(fraction, now, 14, { chunk: 2.9, yieldLoop: async () => {} })).toBe(5);
    expect(count(fraction)).toBe(0);
  });
});

describe('stored tool responses', () => {
  test('a response over 8 KB is stored as its head with the original size', () => {
    const big = 'x'.repeat(MAX_STORED_RESPONSE * 3);
    const stored = JSON.parse(storedPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { content: big } }, 'managed') ?? '{}');
    expect(stored.tool_name).toBe('Read');
    expect(stored.tool_response).toMatchObject({ truncated: true });
    expect(stored.tool_response.bytes).toBeGreaterThan(MAX_STORED_RESPONSE * 3);
    expect(Buffer.byteLength(stored.tool_response.head)).toBeLessThanOrEqual(MAX_STORED_RESPONSE);
    const small = JSON.parse(storedPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }, 'managed') ?? '{}');
    expect(small.tool_response).toEqual({ exit_code: 0 });
    expect(storedPayload({ session_id: 's', hook_event_name: 'Stop' }, 'managed')).not.toContain('tool_response');
  });
});

describe('meter reads in slices', () => {
  test('5 MB of transcript are read in slices of 2 MB while the agent is behind', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const home = join(t.dir, 'claude-home');
    const cwd = join(t.dir, 'repo');
    const dir = join(home, 'projects', projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const main = join(dir, 'sess-1.jsonl');
    const row = (i: number) =>
      `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-16T12:00:00.000Z', message: { id: `m${i}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'x'.repeat(1000) }], usage: { input_tokens: 1, output_tokens: 2 } } })}\n`;
    const lines = Array.from({ length: 5000 }, (_, i) => row(i));
    writeFileSync(main, lines.join(''));
    const db = openDb(':memory:');
    const meter = new TokenMeter({ db, claudeHome: home, now: () => Date.now(), onRead: () => {} });
    const agent: MeterAgent = { key: 'sess-1', sessionId: 'sess-1', floor: 'mobile', roleId: 'lead', name: 'lead-mobile', cwd, plan: null };
    const offset = () => db.query<{ byte_offset: number }, []>('SELECT byte_offset FROM token_cursor').get()?.byte_offset ?? 0;
    const total = lines.join('').length;
    expect(total).toBeGreaterThan(5 * 1024 * 1024);
    expect(READ_BUDGET).toBe(2 * 1024 * 1024);
    meter.readNow(agent);
    expect(offset()).toBeLessThanOrEqual(READ_BUDGET + 70_000);
    expect(offset()).toBeGreaterThan(READ_BUDGET - 5000);
    expect(meter.behind('sess-1')).toBe(true);
    meter.readNow(agent);
    expect(offset()).toBeLessThanOrEqual(2 * READ_BUDGET + 140_000);
    expect(meter.behind('sess-1')).toBe(true);
    meter.readNow(agent);
    expect(offset()).toBe(total);
    expect(meter.behind('sess-1')).toBe(false);
    expect(meter.totals('sess-1')?.turns).toBe(5000);
  });

  test('schedule keeps reading behind the loop until the agent has caught up', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const home = join(t.dir, 'claude-home');
    const cwd = join(t.dir, 'repo');
    const dir = join(home, 'projects', projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const line = (i: number) => `${JSON.stringify({ type: 'assistant', message: { id: `m${i}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'y'.repeat(1000) }], usage: { input_tokens: 1, output_tokens: 2 } } })}\n`;
    writeFileSync(join(dir, 'sess-1.jsonl'), Array.from({ length: 4500 }, (_, i) => line(i)).join(''));
    const db = openDb(':memory:');
    const meter = new TokenMeter({ db, claudeHome: home, now: () => Date.now(), onRead: () => {} });
    const agent: MeterAgent = { key: 'sess-1', sessionId: 'sess-1', floor: 'mobile', roleId: 'lead', name: 'lead-mobile', cwd, plan: null };
    await meter.schedule(agent);
    expect(meter.behind('sess-1')).toBe(true);
    const start = Date.now();
    while (meter.behind('sess-1') && Date.now() - start < 3000) await Bun.sleep(5);
    expect(meter.behind('sess-1')).toBe(false);
    expect(meter.totals('sess-1')?.turns).toBe(4500);
  });
});

describe('restart of a quiet director', () => {
  test('a session that only sent events for a day is still restored: updated_at moves at most once a minute', () => {
    const repo = managed();
    const socket = join(h!.root, 'director.sock');
    writeFileSync(socket, '');
    const meta = { socket, token: 'tok', role: 'office-lead-mobile', name: 'lead-mobile' };
    h!.office.ingest(ev(LEAD, repo, 'SessionStart', {}), meta);
    const persisted = () => h!.db.query<{ updated_at: number }, []>('SELECT updated_at FROM sessions').get()?.updated_at;
    const start = h!.clock.now;
    h!.clock.advance(30_000);
    h!.office.ingest(ev(LEAD, repo, 'Notification', { message: 'a' }));
    expect(persisted()).toBe(start);
    h!.clock.advance(31_000);
    h!.office.ingest(ev(LEAD, repo, 'Notification', { message: 'b' }));
    expect(persisted()).toBe(h!.clock.now);
    for (let i = 0; i < 23; i += 1) {
      h!.clock.advance(60 * 60_000);
      h!.office.ingest(ev(LEAD, repo, 'Notification', { message: 'c' }));
    }
    h!.clock.advance(2 * 60 * 60_000);
    const restarted = new Office({
      hubId: 'hub-test',
      db: h!.db,
      config: h!.config,
      profiles: loadProfiles(PROFILES_DIR),
      workspaceDir: h!.workspace,
      claudeHome: join(h!.root, 'claude-home'),
      gitRoot: (cwd) => cwd,
      now: () => h!.clock.now,
    });
    expect(restarted.snapshot().sessions.map((s) => s.sessionId)).toEqual([LEAD]);
  });
});

describe('snapshot of documents', () => {
  const view = (n: number, status: DocumentView['status']): DocumentView => ({
    path: `redaccion/planes/p${n}.md`,
    kind: 'plan',
    slug: `p${n}`,
    title: `p${n}`,
    docType: 'implementacion',
    status,
    round: 0,
    maxRounds: 3,
    score: null,
    updatedAt: 1000 - n,
    deliveredAt: null,
    decidedAt: null,
    base: [],
    ahead: [],
    installedAt: [],
    tokens: null,
  });

  test('keeps every open document and the 100 most recent closed or discarded ones', () => {
    const docs = [
      ...Array.from({ length: 130 }, (_, i) => view(i, i % 2 === 0 ? 'cerrado' : 'descartado')),
      view(900, 'revision'),
      view(901, 'aparcado'),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
    const kept = recentDocuments(docs);
    expect(kept.filter((d) => d.status === 'cerrado' || d.status === 'descartado')).toHaveLength(SNAPSHOT_CLOSED_DOCS);
    expect(kept.filter((d) => d.status === 'revision' || d.status === 'aparcado')).toHaveLength(2);
    expect(kept.map((d) => d.slug)).not.toContain('p129');
    expect(kept.map((d) => d.slug)).toContain('p0');
  });

  test('the snapshot of the office applies the cap and the documents route does not', () => {
    h = harness({
      configure: (config) => {
        config.departments = { redaccion: true, mantenimiento: false };
      },
    });
    const plans = join(h.root, 'docs', 'redaccion', 'planes');
    mkdirSync(plans, { recursive: true });
    const insert = h.db.query('INSERT INTO documents (path, kind, slug, round, closed_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)');
    for (let i = 0; i < 110; i += 1) {
      writeFileSync(join(plans, `cerrado-${i}.md`), `# Cerrado ${i}\n`);
      insert.run(`redaccion/planes/cerrado-${i}.md`, 'plan', `cerrado-${i}`);
    }
    writeFileSync(join(plans, 'abierto.md'), '# Abierto\n');
    h.office.refreshDocuments();
    expect(h.office.documents()).toHaveLength(111);
    const snapshot = h.office.snapshot().documents;
    expect(snapshot).toHaveLength(SNAPSHOT_CLOSED_DOCS + 1);
    expect(snapshot.some((d) => d.slug === 'abierto')).toBe(true);
  });
});
