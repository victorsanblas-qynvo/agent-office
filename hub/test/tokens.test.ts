import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES_DIR } from '../src/config';
import { openDb } from '../src/db';
import { ensureDocsRepo } from '../src/docs-repo';
import { realPath } from '../src/floors';
import { Office } from '../src/office';
import { loadProfiles } from '../src/profiles';
import { startServer } from '../src/server';
import {
  MAX_LINE,
  localDay,
  parseChunk,
  planSlugIn,
  planSlugOf,
  projectSlug,
  TokenMeter,
  zeroTotals,
  type MeterAgent,
  type PlanSubject,
} from '../src/tokens';
import type { HookMeta, TokenTotals, TokensEvent } from '../src/types';
import { ev, floor, harness, tempDir, useGitIdentity, type Harness } from './helpers';

useGitIdentity();

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const LEAD = '22222222-bbbb-4ccc-8ddd-000000000002';
const REDACCION_LEAD = 'dddddddd-0000-4000-8000-000000000001';
const leadMeta: HookMeta = { socket: null, token: null, role: 'office-lead-mobile', name: 'lead-mobile' };
const redaccionMeta: HookMeta = { socket: null, token: null, role: 'office-lead-redaccion', name: 'lead-redaccion' };
const PLAN = 'redaccion/planes/login.md';

type Use = { input?: number; cacheRead?: number; cacheCreate?: number; model?: string; at?: string | number; pad?: number };

function line(id: string, output: number, use: Use = {}): string {
  const at = use.at ?? '2026-10-16T12:00:00.000Z';
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: typeof at === 'number' ? new Date(at).toISOString() : at,
    message: {
      id,
      model: use.model ?? SONNET,
      content: [{ type: 'text', text: 'x'.repeat(use.pad ?? 0) }],
      usage: {
        input_tokens: use.input ?? 2,
        cache_creation_input_tokens: use.cacheCreate ?? 100,
        cache_read_input_tokens: use.cacheRead ?? 1000,
        output_tokens: output,
      },
    },
  })}\n`;
}

const bytes = (...lines: string[]): Buffer => Buffer.from(lines.join(''));
const FRESH: { lastMsgId: string | null; lastOut: number } = { lastMsgId: null, lastOut: 0 };
const NOW = Date.parse('2026-10-16T12:30:00.000Z');

function sum(parts: Iterable<TokenTotals>): TokenTotals {
  const total = zeroTotals();
  for (const t of parts) {
    total.turns += t.turns;
    total.input += t.input;
    total.cacheRead += t.cacheRead;
    total.cacheCreate += t.cacheCreate;
    total.output += t.output;
  }
  return total;
}

describe('parseChunk', () => {
  test('one turn per message id with the last output_tokens', () => {
    const r = parseChunk(bytes(line('m1', 8), line('m1', 8), line('m1', 8), line('m1', 703)), FRESH, NOW);
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0].tokens).toEqual({ turns: 1, input: 2, cacheRead: 1000, cacheCreate: 100, output: 703 });
    expect(r.lastMsgId).toBe('m1');
    expect(r.lastOut).toBe(703);
  });

  test('a new id adds a turn with its own input and cache values', () => {
    const r = parseChunk(bytes(line('m1', 5, { cacheRead: 10 }), line('m2', 7, { cacheRead: 20 })), FRESH, NOW);
    expect(r.deltas[0].tokens).toEqual({ turns: 2, input: 4, cacheRead: 30, cacheCreate: 200, output: 12 });
    expect(r.lastMsgId).toBe('m2');
  });

  test('the day is that of the line timestamp, not of the reading', () => {
    const late = new Date(2026, 9, 15, 23, 59, 0).getTime();
    const next = new Date(2026, 9, 16, 0, 1, 0).getTime();
    const r = parseChunk(bytes(line('m1', 5, { at: late }), line('m2', 5, { at: next })), FRESH, next + 60_000);
    expect(r.deltas.map((d) => [d.day, d.tokens.turns])).toEqual([
      ['2026-10-15', 1],
      ['2026-10-16', 1],
    ]);
  });

  test('a line without a timestamp falls on the day of the reading', () => {
    const raw = JSON.stringify({ type: 'assistant', message: { id: 'm1', model: SONNET, usage: { input_tokens: 1, output_tokens: 2 } } });
    const r = parseChunk(Buffer.from(`${raw}\n`), FRESH, NOW);
    expect(r.deltas.map((d) => d.day)).toEqual([localDay(NOW)]);
    expect(r.deltas[0].tokens).toMatchObject({ turns: 1, input: 1, output: 2 });
  });

  test('a message split between two reads adds only the difference', () => {
    const first = parseChunk(bytes(line('m1', 8), line('m1', 8)), FRESH, NOW);
    expect(first.deltas[0].tokens).toMatchObject({ turns: 1, output: 8 });
    const second = parseChunk(bytes(line('m1', 703)), first, NOW);
    expect(second.deltas[0].tokens).toEqual({ turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 695 });
    expect(second.lastOut).toBe(703);
    const lower = parseChunk(bytes(line('m1', 100)), second, NOW);
    expect(lower.deltas[0].tokens.output).toBe(0);
    expect(lower.lastOut).toBe(703);
  });

  test('an incomplete last line is left for the next read', () => {
    const whole = bytes(line('m1', 5), line('m2', 6));
    const cut = whole.subarray(0, whole.length - 20);
    const first = parseChunk(cut, FRESH, NOW);
    expect(first.deltas[0].tokens.turns).toBe(1);
    expect(first.consumed).toBe(line('m1', 5).length);
    expect(parseChunk(whole.subarray(0, first.consumed), FRESH, NOW).consumed).toBe(first.consumed);
    const second = parseChunk(whole.subarray(first.consumed), first, NOW);
    expect(second.deltas[0].tokens).toMatchObject({ turns: 1, output: 6 });
    expect(parseChunk(Buffer.from('{"type":"assistant"'), FRESH, NOW)).toMatchObject({ consumed: 0, deltas: [] });
  });

  test('synthetic, malformed, id-less and non-assistant lines are skipped', () => {
    const noId = JSON.stringify({ type: 'assistant', message: { model: SONNET, usage: { output_tokens: 9 } } });
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'usage' } });
    const r = parseChunk(
      bytes(line('s1', 9, { model: '<synthetic>' }), '{"type":"assistant","usage": nope\n', `${noId}\n`, `${user}\n`, '\n', line('m1', 3)),
      FRESH,
      NOW,
    );
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0].tokens).toMatchObject({ turns: 1, output: 3 });
    expect(r.skipped).toBe(0);
  });

  test('a line over the limit is skipped and counted', () => {
    const r = parseChunk(bytes(line('m1', 3), line('big', 9, { pad: MAX_LINE + 10 }), line('m2', 4)), FRESH, NOW);
    expect(r.deltas[0].tokens).toMatchObject({ turns: 2, output: 7 });
    expect(r.skipped).toBe(1);
  });

  test('the real parallel-tool transcript adds up like a plain per-message.id computation, however it is cut', () => {
    const raw = readFileSync(join(import.meta.dir, 'fixtures', 'transcript-parallel.jsonl'));
    const lines = raw
      .toString('utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { message: { id: string; usage: Record<string, number> } });
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(Object.keys(lines[0]).sort()).toEqual(['message', 'timestamp', 'type']);
    expect(Object.keys(lines[0].message).sort()).toEqual(['id', 'model', 'usage']);
    const byId = new Map<string, { input: number; cacheRead: number; cacheCreate: number; output: number }>();
    for (const { message } of lines) {
      const u = message.usage;
      const seen = byId.get(message.id);
      if (!seen) byId.set(message.id, { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheCreate: u.cache_creation_input_tokens, output: u.output_tokens });
      else seen.output = Math.max(seen.output, u.output_tokens);
    }
    expect(byId.size).toBeLessThan(lines.length);
    const expected = sum([...byId.values()].map((v) => ({ turns: 1, ...v })));

    const whole = parseChunk(raw, FRESH, NOW);
    expect(whole.consumed).toBe(raw.length);
    expect(sum(whole.deltas.map((d) => d.tokens))).toEqual(expected);

    for (const size of [97, 777, 4096]) {
      let cursor = { ...FRESH };
      let pending = Buffer.alloc(0);
      const parts: TokenTotals[] = [];
      for (let at = 0; at < raw.length; at += size) {
        const buf = Buffer.concat([pending, raw.subarray(at, at + size)]);
        const r = parseChunk(buf, cursor, NOW);
        parts.push(...r.deltas.map((d) => d.tokens));
        cursor = { lastMsgId: r.lastMsgId, lastOut: r.lastOut };
        pending = buf.subarray(r.consumed);
      }
      expect(sum(parts), `cut every ${size} bytes`).toEqual(expected);
    }
  });
});

describe('plans', () => {
  const subject = (over: Partial<PlanSubject>): PlanSubject => ({ name: null, roleId: null, floorKind: 'managed', planSlug: null, ...over });

  test('planSlugIn reads the slug from a path in a message', () => {
    expect(planSlugIn('Ejecuta el plan redaccion/planes/login-apple.md ya')).toBe('login-apple');
    expect(planSlugIn('mira /docs/redaccion/planes/a_b-2.md')).toBe('a_b-2');
    expect(planSlugIn('redaccion/historial/login.md')).toBeNull();
    expect(planSlugIn(null)).toBeNull();
  });

  test('planSlugOf by role', () => {
    const lead = subject({ roleId: 'lead', planSlug: 'login' });
    expect(planSlugOf(subject({ roleId: 'redactor', name: 'redactor-login-apple', floorKind: 'redaccion' }), null)).toBe('login-apple');
    expect(planSlugOf(subject({ roleId: 'revisor-planes', name: 'revisor-planes-login-apple-r2', floorKind: 'redaccion' }), null)).toBe('login-apple');
    expect(planSlugOf(subject({ roleId: 'director', planSlug: 'login', floorKind: 'direccion' }), null)).toBeNull();
    expect(planSlugOf(subject({ roleId: 'lead', planSlug: 'login', floorKind: 'redaccion' }), null)).toBeNull();
    expect(planSlugOf(subject({ roleId: 'artesano', name: 'artesano-pdf', floorKind: 'mantenimiento' }), null)).toBeNull();
    expect(planSlugOf(subject({ roleId: 'revisor-skills', name: 'revisor-skills-pdf-r1', floorKind: 'mantenimiento' }), null)).toBeNull();
    expect(planSlugOf(lead, null)).toBe('login');
    expect(planSlugOf(subject({ roleId: 'dev' }), lead)).toBe('login');
    expect(planSlugOf(subject({ roleId: 'tester', planSlug: 'otro' }), lead)).toBe('otro');
    expect(planSlugOf(subject({ roleId: 'reviewer' }), subject({ roleId: 'lead', planSlug: 'login', floorKind: 'redaccion' }))).toBeNull();
    expect(planSlugOf(subject({ roleId: 'dev' }), null)).toBeNull();
  });
});

describe('TokenMeter', () => {
  let cleanup = (): void => {};
  afterEach(() => cleanup());

  function meter(): {
    meter: TokenMeter;
    db: ReturnType<typeof openDb>;
    home: string;
    cwd: string;
    events: TokensEvent[];
    clock: { now: number };
    main: string;
    agent: MeterAgent;
  } {
    const t = tempDir();
    cleanup = t.cleanup;
    const home = join(t.dir, 'claude-home');
    const cwd = join(t.dir, 'repo');
    const dir = join(home, 'projects', projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const db = openDb(':memory:');
    const events: TokensEvent[] = [];
    const clock = { now: NOW };
    const m = new TokenMeter({ db, claudeHome: home, now: () => clock.now, onRead: (e) => events.push(e) });
    const agent: MeterAgent = { key: 'sess-1', sessionId: 'sess-1', floor: 'mobile', roleId: 'lead', name: 'lead-mobile', cwd, plan: null };
    return { meter: m, db, home, cwd, events, clock, main: join(dir, 'sess-1.jsonl'), agent };
  }

  const rows = (db: ReturnType<typeof openDb>) =>
    db.query<{ day: string; model: string; plan_slug: string; turns: number; output: number }, []>('SELECT day, model, plan_slug, turns, output FROM token_usage ORDER BY day, model, plan_slug').all();

  test('rebuilds the main transcript from the launch cwd and reads only what is new', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10) + line('b', 20));
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toEqual({ turns: 2, input: 4, cacheRead: 2000, cacheCreate: 200, output: 30 });
    expect(m.events).toHaveLength(1);
    expect(m.events[0]).toMatchObject({ agentKey: 'sess-1', plan: null });
    m.meter.readNow(m.agent);
    expect(m.events).toHaveLength(1);
    appendFileSync(m.main, line('c', 5));
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')?.turns).toBe(3);
    expect(rows(m.db)).toEqual([{ day: localDay(Date.parse('2026-10-16T12:00:00.000Z')), model: SONNET, plan_slug: '', turns: 3, output: 35 }]);
  });

  test('keeps one row per day, agent, model and plan', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10) + line('b', 20, { model: OPUS }) + line('c', 30, { at: '2026-10-14T12:00:00.000Z' }));
    m.meter.readNow(m.agent, 'login');
    expect(rows(m.db).map((r) => [r.day === localDay(Date.parse('2026-10-14T12:00:00.000Z')), r.model, r.plan_slug, r.turns])).toEqual([
      [true, SONNET, 'login', 1],
      [false, OPUS, 'login', 1],
      [false, SONNET, 'login', 1],
    ]);
  });

  test('resumes from the stored cursor in a new meter without duplicating', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10) + line('b', 20));
    m.meter.readNow(m.agent);
    const again = new TokenMeter({ db: m.db, claudeHome: m.home, now: () => NOW, onRead: () => {} });
    expect(again.totals('sess-1')?.turns).toBe(2);
    again.readNow(m.agent);
    expect(again.totals('sess-1')?.turns).toBe(2);
    appendFileSync(m.main, line('c', 5));
    again.readNow(m.agent);
    expect(again.totals('sess-1')).toMatchObject({ turns: 3, output: 35 });
  });

  test('a message left half written between two reads is completed from the cursor', () => {
    const m = meter();
    const text = line('a', 8) + line('a', 703);
    writeFileSync(m.main, text.slice(0, line('a', 8).length) + text.slice(line('a', 8).length, -15));
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toMatchObject({ turns: 1, output: 8 });
    writeFileSync(m.main, text);
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toMatchObject({ turns: 1, output: 703 });
  });

  test('a file smaller than the cursor starts over', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10) + line('b', 20));
    m.meter.readNow(m.agent);
    writeFileSync(m.main, line('z', 7));
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toMatchObject({ turns: 3, output: 37 });
  });

  test('a giant line is skipped and counted', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10) + line('big', 99, { pad: MAX_LINE + 100 }) + line('b', 20));
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toMatchObject({ turns: 2, output: 30 });
    expect(m.db.query<{ skipped_lines: number }, []>('SELECT skipped_lines FROM token_cursor').get()?.skipped_lines).toBe(1);
  });

  test('a path seen in a hook wins and a subagent is rebuilt from the main one by id', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10));
    const subs = join(m.home, 'projects', projectSlug(m.cwd), 'sess-1', 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, 'agent-a1.jsonl'), line('s1', 3));
    const sub: MeterAgent = { ...m.agent, key: 'a1', roleId: 'dev', name: 'dev-mobile' };
    m.meter.readNow(sub);
    expect(m.meter.totals('a1')).toMatchObject({ turns: 1, output: 3 });
    const seen = join(m.home, 'projects', 'otro', 'seen.jsonl');
    mkdirSync(join(m.home, 'projects', 'otro'), { recursive: true });
    writeFileSync(seen, line('x', 50) + line('y', 60));
    m.meter.noteAgent('sess-1', seen);
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toMatchObject({ turns: 2, output: 110 });
  });

  test('a teammate without an id is found by the name in its meta.json, the newest file first', () => {
    const m = meter();
    writeFileSync(m.main, line('a', 10));
    const subs = join(m.home, 'projects', projectSlug(m.cwd), 'sess-1', 'subagents');
    mkdirSync(subs, { recursive: true });
    for (const [file, name, seconds] of [
      ['agent-adev-mobile-old', 'dev-mobile', 1000],
      ['agent-adev-mobile-new', 'dev-mobile', 2000],
      ['agent-atester-mobile-x', 'tester-mobile', 3000],
    ] as const) {
      writeFileSync(join(subs, `${file}.jsonl`), line(file, file.endsWith('old') ? 1 : 4));
      writeFileSync(join(subs, `${file}.meta.json`), JSON.stringify({ name }));
      utimesSync(join(subs, `${file}.jsonl`), seconds, seconds);
    }
    m.meter.readNow({ ...m.agent, key: 'dev-mobile@session-22222222', roleId: 'dev', name: 'dev-mobile' });
    expect(m.meter.totals('dev-mobile@session-22222222')).toMatchObject({ turns: 1, output: 4 });
  });

  test('finds the main transcript of a session in any project folder as a last resort', () => {
    const m = meter();
    const other = join(m.home, 'projects', 'otra-carpeta');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'sess-1.jsonl'), line('a', 10));
    m.meter.readNow({ ...m.agent, cwd: null });
    expect(m.meter.totals('sess-1')?.turns).toBe(1);
  });

  test('a path outside projects, a symlink out of it and a non-jsonl file are ignored', () => {
    const m = meter();
    const outside = join(m.home, 'fuera.jsonl');
    writeFileSync(outside, line('a', 10));
    const link = join(m.home, 'projects', projectSlug(m.cwd), 'sess-1.jsonl');
    symlinkSync(outside, link);
    m.meter.noteAgent('sess-1', outside);
    m.meter.noteSession('sess-1', outside);
    m.meter.readNow(m.agent);
    expect(m.meter.totals('sess-1')).toBeNull();
    const text = join(m.home, 'projects', 'otro.txt');
    writeFileSync(text, line('a', 10));
    m.meter.noteAgent('sess-1', text);
    m.meter.readNow(m.agent);
    expect(rows(m.db)).toEqual([]);
  });

  test('summary groups today and the last week by role, model, floor and plan', () => {
    const m = meter();
    const day = (back: number): number => {
      const d = new Date(NOW);
      d.setDate(d.getDate() - back);
      return d.getTime();
    };
    writeFileSync(m.main, line('a', 100, { at: NOW }) + line('b', 50, { at: day(3), model: OPUS }) + line('c', 1, { at: day(8) }));
    m.meter.readNow(m.agent);
    const subs = join(m.home, 'projects', projectSlug(m.cwd), 'sess-1', 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, 'agent-a1.jsonl'), line('s', 400, { at: NOW, cacheRead: 0, cacheCreate: 0 }));
    m.meter.readNow({ ...m.agent, key: 'a1', roleId: 'dev', name: 'dev-mobile', floor: 'web' }, 'login');

    const today = m.meter.summary('today');
    expect(today).toMatchObject({ range: 'today', from: localDay(NOW), to: localDay(NOW) });
    expect(today.total).toEqual({ tokens: { turns: 2, input: 4, cacheRead: 1000, cacheCreate: 100, output: 500 }, agents: 2 });
    expect(today.byRole.map((r) => [r.key, r.tokens.turns, r.agents])).toEqual([
      ['lead', 1, 1],
      ['dev', 1, 1],
    ]);
    expect(today.byModel.map((r) => r.key)).toEqual([SONNET]);
    expect(today.byFloor.map((r) => r.key)).toEqual(['mobile', 'web']);
    expect(today.byPlan.map((r) => [r.key, r.tokens.output])).toEqual([['login', 400]]);

    const week = m.meter.summary('week');
    expect(week.from).toBe(localDay(day(6)));
    expect(week.total.tokens).toMatchObject({ turns: 3, output: 550 });
    expect(week.byModel.map((r) => [r.key, r.tokens.output])).toEqual([
      [SONNET, 500],
      [OPUS, 50],
    ]);
  });

  test('summary byDay zero-fills seven local days oldest first and buckets across midnight', () => {
    const m = meter();
    const local = (back: number, hour: number, minute: number): number => {
      const d = new Date(NOW);
      d.setDate(d.getDate() - back);
      d.setHours(hour, minute, 0, 0);
      return d.getTime();
    };
    const plain = { input: 0, cacheRead: 0, cacheCreate: 0 };
    writeFileSync(
      m.main,
      line('a', 10, { at: local(2, 23, 59), ...plain }) + line('b', 20, { at: local(1, 0, 1), ...plain }) + line('c', 5, { at: NOW, ...plain }) + line('d', 99, { at: local(9, 12, 0), ...plain }),
    );
    m.meter.readNow(m.agent);

    const week = m.meter.summary('week');
    const days = Array.from({ length: 7 }, (_, i) => localDay(local(6 - i, 12, 0)));
    expect(week.byDay.map((d) => d.day)).toEqual(days);
    expect(week.byDay.map((d) => d.tokens)).toEqual([0, 0, 0, 0, 10, 20, 5]);

    expect(m.meter.summary('today').byDay).toEqual([{ day: localDay(NOW), tokens: 5 }]);
  });
});

describe('Office', () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  const homeDir = (): string => join(h.root, 'claude-home');
  const agent = (key: string) => h.office.snapshot().agents.find((a) => a.key === key);
  const usage = () =>
    h.db
      .query<{ agent_key: string; day: string; model: string; plan_slug: string; turns: number; output: number }, []>(
        'SELECT agent_key, day, model, plan_slug, turns, output FROM token_usage ORDER BY agent_key, plan_slug, model',
      )
      .all();
  const tokenMessages = () => h.messages.flatMap((m) => (m.type === 'tokens' ? [m.data] : []));
  const slow = (): Promise<void> => h.office.idle();

  function mainFile(cwd: string, session: string): string {
    const dir = join(homeDir(), 'projects', projectSlug(cwd));
    mkdirSync(join(dir, session, 'subagents'), { recursive: true });
    return join(dir, `${session}.jsonl`);
  }

  function managed(): string {
    h = harness();
    const repo = join(h.root, 'mobile');
    mkdirSync(repo, { recursive: true });
    h.config.floors.mobile = floor(repo);
    return repo;
  }

  function departments(): string {
    h = harness({
      configure: (config) => {
        config.departments = { redaccion: true, mantenimiento: true };
      },
    });
    const docs = realPath(join(h.root, 'docs'));
    ensureDocsRepo(docs);
    mkdirSync(join(docs, 'redaccion', 'planes'), { recursive: true });
    writeFileSync(join(docs, PLAN), '# Login con Apple\n\n## Contexto\nmobile develop @ abc1234\n');
    h.office.refreshDocuments();
    return docs;
  }

  function spawn(session: string, cwd: string, name: string, type: string, id: string, agentId: string): void {
    h.office.ingest(ev(session, cwd, 'PreToolUse', { tool_name: 'Agent', tool_use_id: id, tool_input: { name, subagent_type: type, prompt: '…' } }));
    h.office.ingest(ev(session, cwd, 'SubagentStart', { agent_id: agentId, agent_type: name }));
  }

  test('SubagentStop with its transcript path emits tokens and fills AgentView and DocumentView', async () => {
    const docs = departments();
    const cwd = join(docs, 'redaccion');
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SessionStart', {}), redaccionMeta);
    spawn(REDACCION_LEAD, cwd, 'redactor-login', 'office-redactor', 'call-red', 'ared-1');
    const sub = join(homeDir(), 'projects', 'elsewhere', 'agent-ared-1.jsonl');
    mkdirSync(join(homeDir(), 'projects', 'elsewhere'), { recursive: true });
    writeFileSync(sub, line('a', 10, { model: SONNET }) + line('b', 30, { model: OPUS }));
    h.messages.length = 0;
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SubagentStop', { agent_id: 'ared-1', agent_type: 'redactor-login', agent_transcript_path: sub }));
    expect(h.messages.some((m) => m.type === 'tokens')).toBe(false);
    await slow();

    const expected = { turns: 2, input: 4, cacheRead: 2000, cacheCreate: 200, output: 40 };
    expect(tokenMessages()).toMatchObject([{ agentKey: 'ared-1', tokens: expected, plan: { slug: 'login', tokens: expected } }]);
    expect(agent('ared-1')?.tokens).toEqual(expected);
    expect(h.office.documents().find((d) => d.path === PLAN)?.tokens).toEqual(expected);
    expect(h.office.snapshot().documents.find((d) => d.path === PLAN)?.tokens).toEqual(expected);
    expect(usage().map((r) => [r.agent_key, r.model, r.plan_slug, r.turns, r.output])).toEqual([
      ['ared-1', OPUS, 'login', 1, 30],
      ['ared-1', SONNET, 'login', 1, 10],
    ]);
    expect(h.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM events WHERE payload LIKE ?').get('%.jsonl%')?.n).toBe(0);

    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SubagentStop', { agent_id: 'ared-1', agent_type: 'redactor-login', agent_transcript_path: sub }));
    await slow();
    expect(usage().reduce((n, r) => n + r.turns, 0)).toBe(2);
    expect(tokenMessages()).toHaveLength(1);
  });

  test('the report carries the totals when read and the stored one does not', async () => {
    const docs = departments();
    const cwd = join(docs, 'redaccion');
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SessionStart', {}), redaccionMeta);
    spawn(REDACCION_LEAD, cwd, 'redactor-login', 'office-redactor', 'call-red', 'ared-1');
    const sub = mainFile(cwd, REDACCION_LEAD).replace('.jsonl', '/subagents/agent-ared-1.jsonl');
    writeFileSync(sub, line('a', 10));
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SubagentStop', { agent_id: 'ared-1', agent_type: 'redactor-login' }));
    await slow();
    expect(h.office.report('ared-1')?.tokens).toMatchObject({ turns: 1, output: 10 });
    const stored = h.db.query<{ data: string }, []>("SELECT data FROM reports WHERE agent_key = 'ared-1'").get();
    if (stored) expect(JSON.parse(stored.data).tokens).toBeNull();
  });

  test('an observed floor leaves no rows, no cursor and no message', async () => {
    h = harness();
    const repo = join(h.root, 'kapper');
    mkdirSync(repo, { recursive: true });
    const file = mainFile(repo, 'obs-1');
    writeFileSync(file, line('a', 10));
    h.office.ingest(ev('obs-1', repo, 'SessionStart', { transcript_path: file }));
    h.office.ingest(ev('obs-1', repo, 'Stop', { transcript_path: file }));
    h.clock.advance(120_000);
    h.office.tick();
    await slow();
    expect(usage()).toEqual([]);
    expect(h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM token_cursor').get()?.n).toBe(0);
    expect(tokenMessages()).toEqual([]);
    expect(agent('obs-1')?.tokens).toBeNull();
  });

  test('a retired reviewer keeps counting what it spends after the verdict', async () => {
    const docs = departments();
    const cwd = join(docs, 'redaccion');
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SessionStart', {}), redaccionMeta);
    spawn(REDACCION_LEAD, cwd, 'redactor-login', 'office-redactor', 'call-red', 'ared-1');
    spawn(REDACCION_LEAD, cwd, 'revisor-planes-login-r1', 'office-revisor-planes', 'call-rev', 'arev-1');
    const sub = mainFile(cwd, REDACCION_LEAD).replace('.jsonl', '/subagents/agent-arev-1.jsonl');
    writeFileSync(sub, line('a', 10));
    const say = (to: string, message: string) =>
      h.office.ingest(ev(REDACCION_LEAD, cwd, 'PreToolUse', { agent_id: 'arev-1', agent_type: 'revisor-planes-login-r1', tool_name: 'SendMessage', tool_input: { to, message } }));
    say('team-lead', `REVISAR: ${PLAN} ronda 1`);
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'PreToolUse', { agent_id: 'ared-1', agent_type: 'redactor-login', tool_name: 'SendMessage', tool_input: { to: 'team-lead', message: `REVISAR: ${PLAN} ronda 1` } }));
    say('redactor-login', `APROBADO: ${PLAN} ronda 1 — nota 9/10 — ok`);
    await slow();
    expect(usage().map((r) => [r.agent_key, r.turns, r.plan_slug])).toEqual([['arev-1', 1, 'login']]);
    appendFileSync(sub, line('b', 25));
    h.office.ingest(ev(REDACCION_LEAD, cwd, 'SubagentStop', { agent_id: 'arev-1', agent_type: 'revisor-planes-login-r1' }));
    await slow();
    expect(agent('arev-1')?.tokens).toMatchObject({ turns: 2, output: 35 });
  });

  test('a restart resumes from the cursor without duplicating', async () => {
    const repo = managed();
    const file = mainFile(repo, LEAD);
    writeFileSync(file, line('a', 10) + line('b', 20));
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { transcript_path: file }), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'Stop', { transcript_path: file }));
    await slow();
    expect(agent(LEAD)?.tokens).toMatchObject({ turns: 2, output: 30 });

    const restarted = new Office({
      hubId: 'hub-test',
      db: h.db,
      config: h.config,
      profiles: loadProfiles(PROFILES_DIR),
      workspaceDir: h.workspace,
      claudeHome: homeDir(),
      gitRoot: (cwd) => cwd,
      now: () => h.clock.now,
    });
    h.office = restarted;
    restarted.ingest(ev(LEAD, repo, 'Stop', {}), leadMeta);
    await slow();
    expect(usage().reduce((n, r) => n + r.turns, 0)).toBe(2);
    appendFileSync(file, line('c', 5));
    restarted.ingest(ev(LEAD, repo, 'Stop', {}), leadMeta);
    await slow();
    expect(usage().reduce((n, r) => [n[0] + r.turns, n[1] + r.output], [0, 0])).toEqual([3, 35]);
  });

  test('a lead that changes plan splits its rows: what was spent stays with the previous plan', async () => {
    const repo = managed();
    const file = mainFile(repo, LEAD);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { transcript_path: file }), leadMeta);
    writeFileSync(file, line('a', 10));
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'Ejecuta redaccion/planes/uno.md' }));
    appendFileSync(file, line('b', 20));
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'Ahora redaccion/planes/dos.md' }));
    appendFileSync(file, line('c', 40));
    h.office.ingest(ev(LEAD, repo, 'Stop', {}));
    await slow();
    expect(usage().map((r) => [r.plan_slug, r.turns, r.output])).toEqual([
      ['', 1, 10],
      ['dos', 1, 40],
      ['uno', 1, 20],
    ]);
  });

  test('a dev inherits the plan the lead was given and a message to it can override', async () => {
    const repo = managed();
    const file = mainFile(repo, LEAD);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { transcript_path: file }), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'Ejecuta redaccion/planes/uno.md' }));
    spawn(LEAD, repo, 'dev-mobile', 'office-dev-mobile', 'call-dev', 'adev-1');
    spawn(LEAD, repo, 'tester-mobile', 'office-tester-mobile', 'call-test', 'atest-1');
    const subs = file.replace('.jsonl', '/subagents');
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'tester-mobile', message: 'Prueba redaccion/planes/dos.md' } }));
    writeFileSync(join(subs, 'agent-adev-1.jsonl'), line('d', 12));
    writeFileSync(join(subs, 'agent-atest-1.jsonl'), line('t', 8));
    h.office.ingest(ev(LEAD, repo, 'SubagentStop', { agent_id: 'adev-1', agent_type: 'dev-mobile' }));
    h.office.ingest(ev(LEAD, repo, 'SubagentStop', { agent_id: 'atest-1', agent_type: 'tester-mobile' }));
    await slow();
    expect(usage().map((r) => [r.agent_key, r.plan_slug])).toEqual([
      ['adev-1', 'uno'],
      ['atest-1', 'dos'],
    ]);
  });

  test('tick reads a live agent that has had events since the last read, once a minute', async () => {
    const repo = managed();
    const file = mainFile(repo, LEAD);
    writeFileSync(file, line('a', 10));
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { transcript_path: file }), leadMeta);
    h.clock.advance(1000);
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(repo, 'a.dart') } }));
    h.office.tick();
    expect(agent(LEAD)?.tokens).toBeNull();
    h.clock.advance(60_000);
    h.office.tick();
    expect(agent(LEAD)?.tokens).toMatchObject({ turns: 1, output: 10 });
    appendFileSync(file, line('b', 5));
    h.clock.advance(60_000);
    h.office.tick();
    expect(agent(LEAD)?.tokens?.turns).toBe(1);
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(repo, 'a.dart') } }));
    h.clock.advance(60_000);
    h.office.tick();
    expect(agent(LEAD)?.tokens?.turns).toBe(2);
  });

  test('the statusline usage feed gives the meter a main transcript path', async () => {
    const repo = managed();
    const dir = join(homeDir(), 'projects', 'elsewhere');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'main.jsonl');
    writeFileSync(file, line('a', 10));
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingestUsage({ session_id: LEAD, transcript_path: file, rate_limits: {} });
    h.office.ingest(ev(LEAD, repo, 'Stop', {}));
    await slow();
    expect(agent(LEAD)?.tokens).toMatchObject({ turns: 1, output: 10 });
  });
});

describe('GET /api/usage/summary', () => {
  const KEY = 'u'.repeat(64);
  let h: Harness;
  let stop = (): void => {};
  afterEach(() => {
    stop();
    h?.cleanup();
  });

  async function boot(): Promise<string> {
    h = harness();
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = Number(probe.port);
    probe.stop(true);
    const publicDir = join(h.root, 'public');
    mkdirSync(publicDir, { recursive: true });
    ({ stop } = startServer({ office: h.office, port, key: () => KEY, publicDir }));
    return `http://127.0.0.1:${port}`;
  }

  test('answers the summary for today and the week, 400 for another range and 401 without the key', async () => {
    const base = await boot();
    const headers = { 'X-Office-Key': KEY };
    h.db
      .query(
        `INSERT INTO token_usage (day, agent_key, session_id, floor, role_id, model, plan_slug, turns, input, cache_read, cache_create, output, updated_at)
         VALUES (?, 'a', 's', 'mobile', 'dev', ?, '', 2, 4, 100, 10, 50, 1)`,
      )
      .run(localDay(h.clock.now), SONNET);
    const today = await fetch(`${base}/api/usage/summary?range=today`, { headers });
    expect(today.status).toBe(200);
    expect(await today.json()).toMatchObject({
      range: 'today',
      total: { tokens: { turns: 2, output: 50 }, agents: 1 },
      byRole: [{ key: 'dev', agents: 1 }],
      byModel: [{ key: SONNET }],
      byFloor: [{ key: 'mobile' }],
      byDay: [{ tokens: expect.any(Number) }],
      byPlan: [],
    });
    expect(((await (await fetch(`${base}/api/usage/summary?range=week`, { headers })).json()) as { range: string }).range).toBe('week');
    const bad = await fetch(`${base}/api/usage/summary?range=month`, { headers });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { key: 'hub.api.usageRange' } });
    expect((await fetch(`${base}/api/usage/summary?range=today`)).status).toBe(401);
  });
});

describe('TokenMeter.orderSpend', () => {
  const FOLDER = '/work/mobile--login';
  const when = Date.parse('2026-10-16T12:00:00.000Z');

  function rig() {
    const db = openDb(':memory:');
    const session = (id: string, cwd: string): void => {
      db.query('INSERT INTO sessions (session_id, cwd, floor, role, name, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, cwd, 'mobile', null, null, when, when);
    };
    const usage = (agent: string, sessionId: string, role: string, model: string, plan: string, output: number): void => {
      db.query(
        `INSERT INTO token_usage (day, agent_key, session_id, floor, role_id, name, model, plan_slug, turns, input, cache_read, cache_create, output, updated_at)
         VALUES ('2026-10-16', ?, ?, 'mobile', ?, NULL, ?, ?, 1, 1, 10, 4, ?, ?)`,
      ).run(agent, sessionId, role, model, plan, output, when);
    };
    const meter = new TokenMeter({ db, claudeHome: '/nowhere', now: () => when, onRead: () => {} });
    return { session, usage, meter };
  }

  test('adds the rows of the order plan and of the sessions inside its folder, and nothing else', () => {
    const { session, usage, meter } = rig();
    session('lead', '/work/mobile');
    session('dev', `${FOLDER}/lib`);
    session('other', '/work/mobile--login-2');
    session('stray', '/work/mobile--pagos');
    usage('lead', 'lead', 'lead', OPUS, 'encargo/login', 100);
    usage('dev', 'dev', 'dev', SONNET, '', 200);
    usage('other', 'other', 'dev', SONNET, '', 300);
    usage('stray', 'stray', 'dev', SONNET, 'encargo/pagos', 400);
    usage('lead2', 'lead', 'lead', OPUS, 'encargo/pagos', 500);

    const spend = meter.orderSpend({ slug: 'login', worktreePath: FOLDER });
    expect(spend).toEqual({
      tokens: 115 + 215,
      byModel: [
        { model: SONNET, tokens: 215 },
        { model: OPUS, tokens: 115 },
      ],
      byRole: [
        { role: 'dev', tokens: 215 },
        { role: 'lead', tokens: 115 },
      ],
      sessions: 2,
      basis: 'plan+folder',
    });
  });

  test('an order without a folder counts only its plan, and one without rows costs nothing', () => {
    const { usage, meter } = rig();
    usage('lead', 'lead', 'lead', OPUS, 'encargo/login', 100);
    expect(meter.orderSpend({ slug: 'login', worktreePath: null }).tokens).toBe(115);
    expect(meter.orderSpend({ slug: 'nada', worktreePath: null })).toEqual({ tokens: 0, byModel: [], byRole: [], sessions: 0, basis: 'plan+folder' });
  });
});
