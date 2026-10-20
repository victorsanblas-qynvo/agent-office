import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRunner } from '../src/git';
import { GAP_MS, MAX_REPLAY_EVENTS, SKIP_MS, buildRecording, compressed, eventOf, type ReplayDeps } from '../src/replay-build';
import { createApp } from '../src/server';
import type { AgentView, HookMeta, Recording, ServerMessage } from '../src/types';
import { PROFILES_DIR } from '../src/config';
import { loadProfiles } from '../src/profiles';
import { ev, floor, harness, tempDir, type Harness } from './helpers';

const LEAD = '22222222-bbbb-4ccc-8ddd-000000000002';
const leadMeta: HookMeta = { socket: null, token: null, role: 'office-lead-mobile', name: 'lead-mobile' };

let h: Harness;
afterEach(() => h?.cleanup());

function spies() {
  const calls: string[] = [];
  const git: GitRunner = async (_cwd, args) => {
    calls.push(`git ${args.join(' ')}`);
    return { code: 1, stdout: '', stderr: '' };
  };
  return {
    calls,
    git,
    deliverFn: async () => void calls.push('deliver'),
    tmux: async () => (calls.push('tmux'), { code: 1, stdout: '' }),
  };
}

function depsOf(h: Harness, extra: Partial<ReplayDeps> = {}): ReplayDeps {
  return { config: h.config, profiles: loadProfiles(PROFILES_DIR), workspaceDir: h.workspace, hubId: 'hub-test', ...extra };
}

// A managed team that edits, runs tests and finishes, plus a personal session on a repo of nobody's.
function playOffice(): { repo: string; observed: string } {
  h = harness();
  const repo = join(h.root, 'mobile');
  const observed = join(h.root, 'kapper');
  mkdirSync(repo, { recursive: true });
  mkdirSync(observed, { recursive: true });
  h.config.floors.mobile = floor(repo, true, 'flutter');
  const step = (e: ReturnType<typeof ev>, meta?: HookMeta) => {
    h.clock.advance(1500);
    h.office.ingest(e, meta);
  };
  step(ev(LEAD, repo, 'SessionStart', { source: 'startup', agent_type: 'office-lead-mobile' }), leadMeta);
  step(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'pantalla de viajes' }), leadMeta);
  step(
    ev(LEAD, repo, 'PreToolUse', {
      tool_name: 'Agent',
      tool_use_id: 'call-dev',
      tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile', description: 'pantalla de viajes', prompt: '...' },
    }),
    leadMeta,
  );
  step(ev(LEAD, repo, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'call-dev', tool_input: {}, tool_response: { agentId: 'dev-1' } }), leadMeta);
  step(ev(LEAD, repo, 'PreToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Edit', tool_input: { file_path: join(repo, 'lib', 'viajes.dart') } }));
  step(ev(LEAD, repo, 'PostToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Edit', tool_input: { file_path: join(repo, 'lib', 'viajes.dart') } }));
  step(ev(LEAD, repo, 'PreToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'flutter test' } }));
  step(ev(LEAD, repo, 'PostToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'flutter test' }, tool_response: { stdout: 'All tests passed!' } }));
  step(ev(LEAD, repo, 'SubagentStop', { agent_id: 'dev-1', agent_type: 'office-dev-mobile' }));
  step(ev('obs-1', observed, 'SessionStart', { source: 'startup' }));
  step(ev('obs-1', observed, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(observed, 'main.py') } }));
  step(ev('obs-1', observed, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'o1', tool_input: { command: 'cat secreto.txt' }, tool_response: { stdout: 'x' } }));
  return { repo, observed };
}

// The last word of each agent in a recording: the initial snapshot, then every agent message.
function finalAgents(recording: Recording): Map<string, AgentView> {
  const out = new Map<string, AgentView>();
  for (const { msg } of recording.messages) {
    if (msg.type === 'snapshot') for (const agent of msg.data.agents) out.set(agent.key, agent);
    else if (msg.type === 'agent') out.set(msg.data.key, msg.data);
    else if (msg.type === 'agent-gone') out.delete(msg.key);
  }
  return out;
}

const shape = (a: AgentView) => ({ key: a.key, state: a.state, role: a.role, floor: a.floor, parentKey: a.parentKey, detail: a.detail, roleKind: a.roleKind });

describe('buildRecording', () => {
  test('a managed session replays to the same agents and states as the live office', async () => {
    playOffice();
    const rig = spies();
    const built = await buildRecording(h.db, LEAD, depsOf(h, rig));
    if (!built.ok) throw new Error(built.reason);
    expect(built.recording.version).toBe(1);
    expect(built.recording.messages[0]).toMatchObject({ t: 0, msg: { type: 'snapshot' } });
    const replayed = finalAgents(built.recording);
    const live = h.office.snapshot().agents.filter((agent) => agent.sessionId === LEAD);
    expect(live.length).toBeGreaterThanOrEqual(2);
    for (const agent of live) expect(shape(replayed.get(agent.key) as AgentView), agent.key).toEqual(shape(agent));
    expect(built.recording.messages.some(({ msg }) => msg.type === 'activity')).toBe(true);
  });

  test('time inside the recording is the time between the stored events', async () => {
    playOffice();
    const built = await buildRecording(h.db, LEAD, depsOf(h, spies()));
    if (!built.ok) throw new Error(built.reason);
    const first = h.db.query<{ ts: number }, [string]>('SELECT MIN(ts) AS ts FROM events WHERE session_id = ?').get(LEAD)?.ts;
    const last = h.db.query<{ ts: number }, [string]>('SELECT MAX(ts) AS ts FROM events WHERE session_id = ?').get(LEAD)?.ts;
    expect(built.recording.startedAt).toBe(first as number);
    const ts = built.recording.messages.map((entry) => entry.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(Math.max(...ts)).toBe((last as number) - (first as number));
  });

  test('an observed session has no payload: its events are rebuilt and the floor stays gray', async () => {
    playOffice();
    const payload = h.db.query<{ payload: string | null }, []>("SELECT payload FROM events WHERE session_id = 'obs-1' LIMIT 1").get();
    expect(payload?.payload).toBeNull();
    const built = await buildRecording(h.db, 'obs-1', depsOf(h, spies()));
    if (!built.ok) throw new Error(built.reason);
    const agent = finalAgents(built.recording).get('obs-1');
    expect(agent?.floor).toBe('kapper');
    const floors = built.recording.messages.flatMap(({ msg }) => (msg.type === 'floors' ? [msg.data] : msg.type === 'snapshot' ? [msg.data.floors] : [])).at(-1);
    expect(floors?.find((f) => f.slug === 'kapper')?.kind).toBe('observed');
    expect(JSON.stringify(built.recording)).not.toContain('secreto');
    expect(shape(agent as AgentView)).toEqual(shape(h.office.snapshot().agents.find((a) => a.key === 'obs-1') as AgentView));
  });

  test('a session with no stored events is not found, and one with too many is refused', async () => {
    h = harness();
    expect(await buildRecording(h.db, 'nada', depsOf(h))).toEqual({ ok: false, reason: 'no-events' });
    const insert = h.db.query('INSERT INTO events (ts, session_id, agent_key, floor, event) VALUES (?, ?, ?, ?, ?)');
    h.db.transaction(() => {
      for (let i = 0; i <= MAX_REPLAY_EVENTS; i++) insert.run(i, 'grande', 'grande', 'x', 'Notification');
    })();
    expect(await buildRecording(h.db, 'grande', depsOf(h))).toEqual({ ok: false, reason: 'too-large' });
  });

  test('compress shortens silences and keeps the order', async () => {
    h = harness();
    const repo = join(h.root, 'kapper');
    mkdirSync(repo, { recursive: true });
    h.office.ingest(ev('gap-1', repo, 'SessionStart', { source: 'startup' }));
    h.clock.advance(10 * 60_000);
    h.office.ingest(ev('gap-1', repo, 'Stop'));
    const plain = await buildRecording(h.db, 'gap-1', depsOf(h, spies()));
    const short = await buildRecording(h.db, 'gap-1', depsOf(h, spies()), { compress: true });
    if (!plain.ok || !short.ok) throw new Error('not built');
    const longest = (r: Recording) => Math.max(...r.messages.map((m) => m.t));
    expect(longest(plain.recording)).toBe(10 * 60_000);
    expect(longest(short.recording)).toBeLessThan(10 * 60_000);
    const gaps = short.recording.messages.slice(1).map((m, i) => m.t - short.recording.messages[i].t);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(GAP_MS);
    expect(short.recording.messages.length).toBe(plain.recording.messages.length);
  });

  test('compressed shortens only the silences over the threshold', () => {
    const msg: ServerMessage = { type: 'worktrees', floor: 'x' };
    const out = compressed([
      { t: 0, msg },
      { t: 1000, msg },
      { t: 1000 + GAP_MS + 1, msg },
      { t: 1000 + GAP_MS + 2, msg },
    ]);
    expect(out.map((m) => m.t)).toEqual([0, 1000, 1000 + SKIP_MS, 1000 + SKIP_MS + 1]);
  });

  test('rebuilds events: the stored payload wins, the columns fill in when there is none', () => {
    const full = eventOf({ ts: 1, agent_key: 'a', event: 'PreToolUse', tool: 'Bash', path: null, payload: JSON.stringify({ hook_event_name: 'x', session_id: 'other', tool_name: 'Bash', tool_input: { command: 'ls' } }) }, 's', '/cwd');
    expect(full).toMatchObject({ session_id: 's', hook_event_name: 'PreToolUse', cwd: '/cwd', tool_input: { command: 'ls' } });
    const bare = eventOf({ ts: 1, agent_key: 'sub-1', event: 'PostToolUse', tool: 'Edit', path: '/x/a.ts', payload: null }, 's', '/cwd');
    expect(bare).toEqual({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/cwd', agent_id: 'sub-1', tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } });
    expect(eventOf({ ts: 1, agent_key: 's', event: 'Stop', tool: null, path: null, payload: '{broken' }, 's', null)).toEqual({ hook_event_name: 'Stop', session_id: 's' });
  });
});

describe('a replay touches nothing', () => {
  test('no git, no tmux, no delivery and no process at all while building', async () => {
    const { repo } = playOffice();
    const rig = spies();
    const spawn = spyOn(Bun, 'spawn');
    const spawnSync = spyOn(Bun, 'spawnSync');
    try {
      const built = await buildRecording(h.db, LEAD, depsOf(h, rig));
      expect(built.ok).toBe(true);
      expect(rig.calls).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
    expect(existsSync(join(repo, '.git'))).toBe(false);
  });

  test('without injected doubles the replay still runs git-free', async () => {
    playOffice();
    const spawn = spyOn(Bun, 'spawn');
    const spawnSync = spyOn(Bun, 'spawnSync');
    try {
      expect((await buildRecording(h.db, LEAD, depsOf(h))).ok).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
  });

  test('it does not write into the real database', async () => {
    playOffice();
    const tables = ['events', 'activity_log', 'agents', 'sessions', 'messages'];
    const count = () => tables.map((table) => h.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
    const before = count();
    await buildRecording(h.db, LEAD, depsOf(h, spies()));
    expect(count()).toEqual(before);
  });
});

describe('Office without side effects', () => {
  // A managed team whose developer starts a turn: live, that starts the git watch of the guard.
  function watchedTurn(sideEffects: boolean) {
    const rig = spies();
    const hh = harness({ git: rig.git, sideEffects, gitRoot: (cwd) => cwd });
    h = hh;
    const where = join(hh.root, 'mobile');
    mkdirSync(where, { recursive: true });
    hh.config.floors.mobile = floor(where, true, 'flutter');
    hh.office.ingest(ev(LEAD, where, 'SessionStart', { source: 'startup', agent_type: 'office-lead-mobile' }), leadMeta);
    hh.office.ingest(ev(LEAD, where, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'c', tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile', description: 'x', prompt: '...' } }), leadMeta);
    hh.office.ingest(ev(LEAD, where, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'c', tool_input: {}, tool_response: { agentId: 'dev-1' } }), leadMeta);
    hh.office.ingest(ev(LEAD, where, 'PreToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Read', tool_input: { file_path: join(where, 'a.dart') } }));
    return { rig, hh, where };
  }

  test('control: a live office asks git for the changes of a developer turn', async () => {
    const { rig, hh } = watchedTurn(true);
    await hh.office.idle();
    expect(rig.calls.length).toBeGreaterThan(0);
  });

  test('without side effects neither the guard nor the raw dump nor the document refresh run', async () => {
    const { rig, hh } = watchedTurn(false);
    await hh.office.idle();
    expect(rig.calls).toEqual([]);
    expect(hh.office.snapshot().agents.find((agent) => agent.key === 'dev-1')).toBeDefined();
  });

  test('raw dumps, the start of the hub and the full-text index are off', () => {
    const { dir, cleanup } = tempDir();
    const raw = join(dir, 'raw');
    h = harness({ sideEffects: false, rawDir: raw });
    h.office.ingest(ev('s1', h.workspace, 'SessionStart', { source: 'startup' }));
    h.office.start();
    expect(existsSync(raw)).toBe(false);
    expect(h.db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_fts'").get()).toBeNull();
    cleanup();
  });

  test('control: a live office dumps raw events', () => {
    const { dir, cleanup } = tempDir();
    const raw = join(dir, 'raw');
    h = harness({ rawDir: raw });
    h.office.ingest(ev('s1', h.workspace, 'SessionStart', { source: 'startup' }));
    expect(existsSync(raw)).toBe(true);
    cleanup();
  });
});

describe('GET /api/replay/:sessionId', () => {
  const KEY = 'k'.repeat(64);
  const PORT = 4747;

  test('needs the panel credential, answers 404 without events and the recording otherwise', async () => {
    playOffice();
    let held = 0;
    const app = createApp({ office: h.office, port: PORT, key: () => KEY, publicDir: h.root }, () => {
      held += 1;
    });
    const get = (path: string, auth = true) =>
      app.request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, ...(auth ? { 'x-office-key': KEY } : {}) } });
    expect((await get(`/api/replay/${LEAD}`, false)).status).toBe(401);
    expect(held).toBe(0);
    const missing = await get('/api/replay/nada');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { key: 'hub.api.noRecording' } });
    const ok = await get(`/api/replay/${LEAD}?compress=1`);
    expect(ok.status).toBe(200);
    // Building a recording can outlast the server's idle timeout.
    expect(held).toBe(2);
    const recording = (await ok.json()) as Recording;
    expect(recording.version).toBe(1);
    expect(recording.messages[0].msg.type).toBe('snapshot');
  });
});

