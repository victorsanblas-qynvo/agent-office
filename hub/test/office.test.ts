import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES_DIR } from '../src/config';
import { ensureDocsRepo } from '../src/docs-repo';
import { realPath } from '../src/floors';
import { runGit, type GitRunner } from '../src/git';
import { Office } from '../src/office';
import { loadProfiles } from '../src/profiles';
import type { AgentView, HookMeta, ServerMessage, Stack } from '../src/types';
import { ev, floor, git, harness, loadFixture, useGitIdentity, type Harness } from './helpers';

const LEAD = '22222222-bbbb-4ccc-8ddd-000000000002';
const TEAM = 'session-22222222';
const leadMeta: HookMeta = { socket: null, token: null, role: 'office-lead-mobile', name: 'lead-mobile' };

let h: Harness;
afterEach(() => h?.cleanup());

const agent = (key: string): AgentView | undefined => h.office.snapshot().agents.find((a) => a.key === key);

function managedRepo(name = 'mobile', stack: Stack = 'flutter'): string {
  const repo = join(h.root, name);
  mkdirSync(repo, { recursive: true });
  h.config.floors[name] = floor(repo, true, stack);
  return repo;
}

function observedRepo(name = 'kapper'): string {
  const repo = join(h.root, name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

function team(stack: Stack = 'flutter'): string {
  h = harness();
  const repo = managedRepo('mobile', stack);
  h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }), leadMeta);
  h.office.ingest(
    ev(LEAD, repo, 'PreToolUse', {
      tool_name: 'Agent',
      tool_use_id: 'call-dev',
      tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile', description: 'pantalla de viajes', prompt: '...' },
    }),
  );
  h.office.ingest(ev(LEAD, repo, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'call-dev', tool_input: {}, tool_response: { agentId: 'dev-1' } }));
  return repo;
}

const done = (repo: string, extra: Record<string, unknown> = {}) =>
  ev(LEAD, repo, 'PreToolUse', {
    agent_type: 'office-lead-mobile',
    tool_name: 'SendMessage',
    tool_input: { to: 'director', message: 'HECHO: pantalla de viajes — validado por tester-mobile — pendiente: nada' },
    ...extra,
  });

function teamWithEdit(): string {
  h = harness();
  const repo = managedRepo();
  h.office.ingest(ev(LEAD, repo, 'SessionStart', { agent_type: 'office-lead-mobile' }), leadMeta);
  h.office.ingest(
    ev(LEAD, repo, 'PostToolUse', { agent_id: 'adev-1', agent_type: 'office-dev-mobile', tool_name: 'Write', tool_input: { file_path: join(repo, 'lib', 'a.dart') } }),
  );
  return repo;
}

describe('captured session', () => {
  test('every agent of the captured session ends done and the subagent hangs from the main one', () => {
    h = harness();
    const repo = observedRepo('repo');
    for (const e of loadFixture('session-basic.json', repo)) h.office.ingest(e);
    const main = agent('11111111-aaaa-4bbb-8ccc-000000000001');
    const sub = agent('a0f92699da9c839ef');
    expect(main?.state).toBe('done');
    expect(main?.endedAt).not.toBeNull();
    expect(main?.floor).toBe('repo');
    expect(sub?.state).toBe('done');
    expect(sub?.parentKey).toBe('11111111-aaaa-4bbb-8ccc-000000000001');
    expect(sub?.role).toBe('echoer');
    expect(sub?.roleKind).toBe('intern');
    const count = h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get();
    expect(count?.n).toBe(16);
  });
});

describe('privacy by floor kind', () => {
  test('an observed floor stores no tool input and shows no command', () => {
    h = harness();
    const repo = observedRepo();
    h.office.ingest(ev('obs-1', repo, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'cat secreto.txt' } }));
    const row = h.db.query<{ payload: string | null }, []>('SELECT payload FROM events').get();
    expect(row?.payload).toBeNull();
    expect(agent('obs-1')?.detail).toBe('Bash');
    expect(JSON.stringify(h.messages)).not.toContain('secreto');
  });

  test('a managed floor keeps the full event of an office session', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev('man-1', repo, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'flutter analyze' } }), leadMeta);
    const row = h.db.query<{ payload: string | null }, []>('SELECT payload FROM events').get();
    expect(row?.payload).toContain('flutter analyze');
    expect(agent('man-1')?.state).toBe('checking');
  });

  test('a personal session in a managed floor is observed: no payload, no task, no report', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev('me-1', repo, 'SessionStart', { source: 'startup' }));
    h.office.ingest(ev('me-1', repo, 'UserPromptSubmit', { prompt: 'Arregla el pago con la clave secreta' }));
    h.office.ingest(ev('me-1', repo, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'cat secreto.txt' } }));
    expect(agent('me-1')?.task).toBeNull();
    expect(agent('me-1')?.detail).toBe('Bash');
    h.office.ingest(ev('me-1', repo, 'Stop', { last_assistant_message: 'Pago arreglado con la clave secreta' }));
    h.office.ingest(ev('me-1', repo, 'SessionEnd', { reason: 'other' }));
    const payloads = h.db.query<{ payload: string | null }, []>('SELECT payload FROM events').all();
    expect(payloads).toHaveLength(5);
    expect(payloads.every((row) => row.payload === null)).toBe(true);
    expect(h.office.report('me-1')).toBeNull();
    expect(h.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
    expect(JSON.stringify(h.messages)).not.toContain('secret');
    expect(h.office.snapshot().sessions.find((s) => s.sessionId === 'me-1')?.office).toBe(false);
  });

  test('a lead identified only by agent_type is an office session from its first event and after a restart', () => {
    h = harness();
    const repo = managedRepo();
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup', agent_type: 'office-lead-mobile' }), { socket, token: null, role: null, name: null });
    const emitted = h.messages
      .filter((m): m is Extract<ServerMessage, { type: 'session' }> => m.type === 'session' && m.data.sessionId === LEAD)
      .at(-1);
    expect(emitted?.data.office).toBe(true);
    h.office.ingest(
      ev(LEAD, repo, 'PreToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'flutter analyze' } }),
    );
    expect(h.db.query<{ payload: string | null }, []>('SELECT payload FROM events ORDER BY id DESC LIMIT 1').get()?.payload).toContain('flutter analyze');
    const restarted = new Office({
      hubId: 'hub-test',
      db: h.db,
      config: h.config,
      profiles: loadProfiles(PROFILES_DIR),
      workspaceDir: h.workspace,
      claudeHome: join(h.root, 'claude-home'),
      gitRoot: (cwd) => cwd,
      now: () => h.clock.now,
    });
    expect(restarted.snapshot().sessions.find((s) => s.sessionId === LEAD)).toMatchObject({ role: 'office-lead-mobile', office: true });
  });
});

describe('blocked agents', () => {
  test('a BLOQUEADO message blocks until the agent works again', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }), leadMeta);
    h.office.ingest(
      ev(LEAD, repo, 'PreToolUse', {
        agent_id: 'dev-1',
        agent_type: 'office-dev-mobile',
        tool_name: 'SendMessage',
        tool_input: { to: 'main', message: 'BLOQUEADO: falta el contrato de /trips — necesito status de backend' },
      }),
    );
    expect(agent('dev-1')?.state).toBe('blocked');
    expect(h.office.snapshot().messages.at(-1)?.toKey).toBe(LEAD);

    h.office.ingest(ev(LEAD, repo, 'TeammateIdle', { agent_id: 'dev-1', teammate_name: 'dev-mobile', team_name: TEAM }));
    expect(agent('dev-1')?.state).toBe('blocked');
    expect(agent('dev-1')?.name).toBe('dev-mobile');

    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { agent_id: 'dev-1', tool_name: 'Read', tool_input: { file_path: join(repo, 'lib', 'a.dart') } }));
    expect(agent('dev-1')?.state).toBe('reading');
  });

  test('the panel receives the BLOQUEADO and HECHO messages it notifies about', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }), leadMeta);
    h.office.ingest(
      ev(LEAD, repo, 'PreToolUse', {
        agent_id: 'adev-1',
        agent_type: 'office-dev-mobile',
        tool_name: 'SendMessage',
        tool_input: { to: 'main', message: 'BLOQUEADO: falta el contrato de /trips — necesito status de backend' },
      }),
    );
    expect(h.messages).toContainEqual({ type: 'message', data: expect.objectContaining({ fromKey: 'adev-1', text: expect.stringMatching(/^BLOQUEADO:/) }) });
    expect(h.messages).toContainEqual({ type: 'agent', data: expect.objectContaining({ key: 'adev-1', state: 'blocked' }) });

    h.office.ingest(
      ev(LEAD, repo, 'PreToolUse', {
        tool_name: 'SendMessage',
        tool_input: { to: 'director', message: 'HECHO: pantalla de viajes — validado por tester-mobile — pendiente: nada' },
      }),
      leadMeta,
    );
    expect(h.messages).toContainEqual({ type: 'message', data: expect.objectContaining({ fromKey: LEAD, text: expect.stringMatching(/^HECHO:/) }) });
    expect(h.messages).toContainEqual({ type: 'agent', data: expect.objectContaining({ key: LEAD, roleKind: 'lead' }) });
  });

  test('a question without answer turns into blocked after the configured minutes', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(
      ev(LEAD, repo, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '¿Seguimos?', options: [] }] } }),
    );
    expect(agent(LEAD)?.state).toBe('asking');
    h.clock.advance(5 * 60_000 + 1);
    h.office.tick();
    const last = h.messages.filter((m) => m.type === 'agent').at(-1);
    expect(last?.type === 'agent' && last.data.state).toBe('blocked');
  });

  test('a permission prompt is cleared when the tool finishes', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }));
    expect(agent(LEAD)?.state).toBe('asking');
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(agent(LEAD)?.state).toBe('working');
  });
});

describe('test gate', () => {
  const edit = (repo: string) =>
    h.office.ingest(
      ev(LEAD, repo, 'PostToolUse', { agent_id: 'dev-1', agent_type: 'office-dev-mobile', tool_name: 'Edit', tool_input: { file_path: join(repo, 'lib', 'trips.dart') } }),
    );
  const runTests = (repo: string, agentId: string, agentType: string, ok = true) =>
    h.office.ingest(
      ev(LEAD, repo, ok ? 'PostToolUse' : 'PostToolUseFailure', {
        agent_id: agentId,
        agent_type: agentType,
        tool_name: 'Bash',
        tool_input: { command: 'flutter test test/trips_test.dart' },
        ...(ok ? {} : { error: 'Exit code 1', is_interrupt: false }),
      }),
    );
  const close = (repo: string) =>
    h.office.gate(ev(LEAD, repo, 'TaskCompleted', { task_id: '1', task_subject: 'Pantalla de viajes', team_name: TEAM }));

  test('the developer name comes from the Agent call', () => {
    const repo = team();
    edit(repo);
    expect(agent('dev-1')?.name).toBe('dev-mobile');
    expect(agent('dev-1')?.roleKind).toBe('dev');
  });

  test('the developer running tests is not enough; the tester is', () => {
    const repo = team();
    edit(repo);
    h.clock.advance(1000);
    runTests(repo, 'dev-1', 'office-dev-mobile');
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', owner: 'dev-mobile', status: 'in_progress' } }));
    h.clock.advance(1000);
    const blocked = close(repo);
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('Falta tester');

    h.clock.advance(1000);
    runTests(repo, 'tester-1', 'office-tester-mobile', false);
    expect(close(repo).pass).toBe(false);

    h.clock.advance(1000);
    runTests(repo, 'tester-1', 'office-tester-mobile');
    expect(close(repo).pass).toBe(true);

    h.clock.advance(1000);
    edit(repo);
    expect(close(repo).pass).toBe(false);
  });

  test('a task without changes closes', () => {
    team();
    expect(close(join(h.root, 'mobile')).pass).toBe(true);
  });

  test('teams outside the office are never blocked', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }));
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { agent_id: 'x-1', tool_name: 'Write', tool_input: { file_path: join(repo, 'a.txt') } }));
    const decision = h.office.gate(ev(LEAD, repo, 'TaskCompleted', { task_id: '7', team_name: TEAM }));
    expect(decision).toEqual({ pass: true, reason: 'fuera de la oficina' });
  });

  test('observed floors are never blocked', () => {
    h = harness();
    const repo = observedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { agent_id: 'x-1', tool_name: 'Write', tool_input: { file_path: join(repo, 'a.txt') } }));
    expect(h.office.gate(ev(LEAD, repo, 'TaskCompleted', { task_id: '7', team_name: TEAM })).pass).toBe(true);
  });
});

describe('questions held for the panel', () => {
  const question = (repo: string, id: string, sessionId = LEAD) =>
    ev(sessionId, repo, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: id,
      tool_input: {
        questions: [
          { question: '¿Qué endpoint?', header: 'API', options: [{ label: 'A', description: 'el viejo' }, { label: 'B' }], multiSelect: false },
        ],
        metadata: { source: 'test' },
      },
    });

  test('nobody watching: the question goes to the terminal at once', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    expect(await h.office.ask(question(repo, 'q0'), leadMeta)).toBeNull();
  });

  test('answered from the panel with the official hook output', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    h.office.heartbeat(true);
    const pending = h.office.ask(question(repo, 'q1'), leadMeta);
    expect(h.office.snapshot().questions.map((q) => q.id)).toEqual(['q1']);
    expect(h.office.answer('q1', {})).toBe('invalid');
    expect(h.office.answer('q1', { '¿Qué endpoint?': 'B' })).toBe('ok');
    const body = JSON.parse((await pending) ?? '{}');
    expect(body.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(body.hookSpecificOutput.updatedInput.answers).toEqual({ '¿Qué endpoint?': 'B' });
    expect(body.hookSpecificOutput.updatedInput.questions[0].options[0]).toEqual({ label: 'A', description: 'el viejo' });
    expect(body.hookSpecificOutput.updatedInput.metadata).toEqual({ source: 'test' });
    expect(h.office.answer('q1', { '¿Qué endpoint?': 'A' })).toBe('closed');
    expect(h.messages.some((m) => m.type === 'question-closed' && m.outcome === 'answered')).toBe(true);
  });

  test('released to the terminal from the panel', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    h.office.heartbeat(true);
    const pending = h.office.ask(question(repo, 'q2'), leadMeta);
    expect(h.office.release('q2')).toBe('ok');
    expect(await pending).toBeNull();
    expect(h.office.release('q2')).toBe('closed');
  });

  test('released when the visible heartbeat stops', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    h.office.heartbeat(true);
    const pending = h.office.ask(question(repo, 'q3'), leadMeta);
    h.clock.advance(31_000);
    h.office.tick();
    expect(await pending).toBeNull();
  });

  test('an open panel counts as watching even when its tab is covered, and a quick reload keeps the question', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    h.office.panelConnected();
    const pending = h.office.ask(question(repo, 'q9'), leadMeta);
    h.clock.advance(45_000);
    h.office.tick();
    expect(h.office.snapshot().questions.map((q) => q.id)).toEqual(['q9']);
    h.office.panelDisconnected();
    h.clock.advance(5_000);
    h.office.tick();
    h.office.panelConnected();
    h.clock.advance(40_000);
    h.office.tick();
    expect(h.office.snapshot().questions.map((q) => q.id)).toEqual(['q9']);
    h.office.panelDisconnected();
    h.clock.advance(31_000);
    h.office.tick();
    expect(await pending).toBeNull();
  });

  test('a hidden tab does not count as watching', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    h.office.heartbeat(false);
    expect(await h.office.ask(question(repo, 'q4'), leadMeta)).toBeNull();
  });

  test('observed floors and sessions outside the office are not held', async () => {
    h = harness({ holdMs: 60_000 });
    h.office.heartbeat(true);
    expect(await h.office.ask(question(observedRepo(), 'q5'), leadMeta)).toBeNull();
    expect(await h.office.ask(question(managedRepo(), 'q6', 'other-session'), { ...leadMeta, role: null })).toBeNull();
  });

  test('the director in its workspace is held', async () => {
    h = harness({ holdMs: 60_000 });
    h.office.heartbeat(true);
    const pending = h.office.ask(question(join(h.workspace, 'x'), 'q7', 'director-1'), { ...leadMeta, role: 'office:director', name: 'director' });
    expect(h.office.snapshot().questions[0]?.floor).toBe('direccion');
    h.office.release('q7');
    expect(await pending).toBeNull();
  });

  test('ending the session releases its questions', async () => {
    h = harness({ holdMs: 60_000 });
    const repo = managedRepo();
    h.office.heartbeat(true);
    const pending = h.office.ask(question(repo, 'q8'), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'SessionEnd', { reason: 'other' }));
    expect(await pending).toBeNull();
  });
});

describe('orders from the panel', () => {
  test('delivered to the session socket with its token and the panel prefix', async () => {
    const sent: { socket: string; payload: string }[] = [];
    h = harness({
      deliverFn: async (socket, payload) => {
        sent.push({ socket, payload });
      },
    });
    const repo = managedRepo();
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), { ...leadMeta, socket, token: 'tok-1' });
    expect(h.office.snapshot().sessions.find((s) => s.sessionId === LEAD)?.canReceive).toBe(true);
    expect(await h.office.order(LEAD, 'Prioriza el login')).toBe('ok');
    const lines = sent[0]!.payload.trim().split('\n').map((l) => JSON.parse(l));
    expect(sent[0]!.socket).toBe(socket);
    expect(lines[0]).toEqual({ type: 'auth', token: 'tok-1' });
    expect(lines[1].type).toBe('user');
    expect(lines[1].message.role).toBe('user');
    expect(lines[1].message.content).toStartWith('[Agent Office]');
    expect(lines[1].message.content).toContain('Prioriza el login');
  });

  test('a session outside the office is refused before delivery, also for a status request and a relaunch', async () => {
    const sent: string[] = [];
    h = harness({
      deliverFn: async (socket) => {
        sent.push(socket);
      },
    });
    const repo = managedRepo();
    const socket = join(h.root, 'me.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev('me-3', repo, 'SessionStart', {}), { socket, token: 'tok-3', role: null, name: null });
    expect(h.office.snapshot().sessions.find((s) => s.sessionId === 'me-3')).toMatchObject({ canReceive: true, office: false });
    expect(await h.office.order('me-3', 'hola')).toBe('not-office');
    expect(await h.office.requestStatus('me-3')).toBe('not-office');
    expect(await h.office.relaunch('me-3')).toBe('not-office');
    expect(sent).toEqual([]);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), { ...leadMeta, socket, token: 'tok-1' });
    expect(h.office.snapshot().sessions.find((s) => s.sessionId === LEAD)?.office).toBe(true);
    expect(await h.office.requestStatus(LEAD)).toBe('ok');
    expect(sent).toEqual([socket]);
  });

  test('unknown, unreachable and failing sessions', async () => {
    h = harness({
      deliverFn: async () => {
        throw new Error('refused');
      },
    });
    const repo = managedRepo();
    expect(await h.office.order('nope', 'x')).toBe('not-found');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    expect(await h.office.order(LEAD, 'x')).toBe('unreachable');
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'Stop', {}), { ...leadMeta, socket });
    expect(await h.office.order(LEAD, 'x')).toBe('failed');
  });
});

describe('configuration reload', () => {
  test('promoting an observed floor repaints its sessions and floors', () => {
    h = harness();
    const repo = observedRepo('repo');
    h.office.ingest(ev('s-1', repo, 'SessionStart', {}));
    expect(h.office.snapshot().floors.find((f) => f.slug === 'repo')?.kind).toBe('observed');
    h.office.reload(
      { ...h.config, floors: { repo: floor(realPath(repo)) } },
      loadProfiles(PROFILES_DIR),
    );
    expect(h.office.snapshot().floors.find((f) => f.slug === 'repo')?.kind).toBe('managed');
    const types = h.messages.map((m) => m.type);
    expect(types).toContain('floors');
    expect(types.at(-1) === 'settings' || types.at(-1) === 'documents').toBe(true);
  });
});

describe('message recipients', () => {
  test('a lead message to a teammate name points at that agent', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'TeammateIdle', { agent_id: 'dev-1', teammate_name: 'dev-mobile', team_name: TEAM }));
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'dev-mobile', message: 'Empieza por la tarea 1' } }));
    const message = h.office.snapshot().messages.at(-1);
    expect(message?.fromKey).toBe(LEAD);
    expect(message?.toKey).toBe('dev-1');
    expect(message?.text).toBe('Empieza por la tarea 1');
  });
});

describe('real agent team capture', () => {
  const REAL_LEAD = 'c3cfeeca-51b9-41c6-b0e7-ef76b63ccf96';
  const DEV = 'adev-office-sandbox-6cae7fd9efff0a59';
  const TESTER = 'atester-office-sandbox-0df0ed3ceca180ab';

  test('teammates get their office type, phantom forks are ignored and team-lead is the lead', () => {
    h = harness();
    const repo = managedRepo('office-sandbox');
    for (const e of loadFixture('team-sandbox.json', repo)) h.office.ingest(e);
    const agents = h.office.snapshot().agents;
    expect(agents.map((a) => a.key).sort()).toEqual([DEV, REAL_LEAD, TESTER].sort());
    expect(agent(REAL_LEAD)).toMatchObject({ role: 'office-lead-office-sandbox', roleKind: 'lead', name: 'lead-office-sandbox' });
    expect(agent(DEV)).toMatchObject({ role: 'office-dev-office-sandbox', roleKind: 'dev', name: 'dev-office-sandbox', parentKey: REAL_LEAD });
    expect(agent(TESTER)).toMatchObject({ role: 'office-tester-office-sandbox', roleKind: 'tester', state: 'idle', endedAt: null });
    expect(agent(DEV)?.state).toBe('blocked');
    const message = h.office.snapshot().messages.at(-1);
    expect(message).toMatchObject({ fromKey: DEV, toName: 'team-lead', toKey: REAL_LEAD });
  });

  test('without the spawn call the type comes from the team config', () => {
    h = harness();
    const repo = managedRepo();
    const teamDir = join(h.root, 'claude-home', 'teams', TEAM);
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(
      join(teamDir, 'config.json'),
      JSON.stringify({ members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'tester-mobile', agentType: 'office-tester-mobile' }] }),
    );
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { agent_id: 'atester-1', agent_type: 'tester-mobile', tool_name: 'Read', tool_input: { file_path: join(repo, 'a') } }));
    expect(agent('atester-1')).toMatchObject({ role: 'office-tester-mobile', roleKind: 'tester' });
  });
});

describe('completion gate on HECHO messages', () => {

  test('blocks the lead report while the change has no green tester run, then lets it through', () => {
    const repo = teamWithEdit();
    h.clock.advance(1000);
    h.office.ingest(
      ev(LEAD, repo, 'PostToolUse', { agent_id: 'adev-1', agent_type: 'office-dev-mobile', tool_name: 'Bash', tool_input: { command: 'flutter test test/a_test.dart' } }),
    );
    const blocked = h.office.gateMessage(done(repo));
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('Falta tester');
    h.clock.advance(1000);
    h.office.ingest(
      ev(LEAD, repo, 'PostToolUse', { agent_id: 'atester-1', agent_type: 'office-tester-mobile', tool_name: 'Bash', tool_input: { command: 'flutter test test/a_test.dart' } }),
    );
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
    const rows = h.db.query<{ decision: string }, []>('SELECT decision FROM gate_decisions ORDER BY id').all();
    expect(rows.map((r) => r.decision)).toEqual(['block', 'pass']);
  });

  test('only a HECHO message from a lead is checked', () => {
    const repo = teamWithEdit();
    expect(h.office.gateMessage(done(repo, { tool_input: { to: 'director', message: 'Voy por la mitad' } })).pass).toBe(true);
    expect(h.office.gateMessage(done(repo, { agent_id: 'adev-1', agent_type: 'office-dev-mobile' })).pass).toBe(true);
    expect(h.office.gateMessage(done(repo)).pass).toBe(false);
  });

  test('a report without changes passes', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { agent_type: 'office-lead-mobile' }), leadMeta);
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
  });
});

describe('test gate on real changes', () => {
  const CLEAN = { stdout: '', stderr: '', interrupted: false };
  const DEV = { agent_id: 'dev-1', agent_type: 'office-dev-mobile' };
  const TESTER = { agent_id: 'tester-1', agent_type: 'office-tester-mobile' };
  const edits = (agentKey?: string) =>
    (agentKey
      ? h.db.query<{ path: string }, [string]>('SELECT path FROM edits WHERE agent_key = ?').all(agentKey)
      : h.db.query<{ path: string }, []>('SELECT path FROM edits').all()
    ).map((row) => row.path);

  function bash(repo: string, who: Record<string, string>, id: string, command: string, between: () => void = () => {}, failed = false): void {
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { ...who, tool_name: 'Bash', tool_use_id: id, tool_input: { command } }));
    between();
    h.office.ingest(
      ev(LEAD, repo, failed ? 'PostToolUseFailure' : 'PostToolUse', {
        ...who,
        tool_name: 'Bash',
        tool_use_id: id,
        tool_input: { command },
        ...(failed ? { error: 'Exit code 1', is_interrupt: false } : { tool_response: CLEAN }),
      }),
    );
  }

  const testerRun = (repo: string, command: string) =>
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { ...TESTER, tool_name: 'Bash', tool_input: { command }, tool_response: CLEAN }));

  function sedTeam(): { repo: string; file: string } {
    const repo = team('generic');
    mkdirSync(join(repo, 'lib'), { recursive: true });
    const file = join(repo, 'lib', 'trips.dart');
    writeFileSync(file, 'a');
    return { repo, file };
  }

  function gitTeam(extra: { git?: GitRunner } = {}): string {
    useGitIdentity();
    h = harness(extra);
    const dir = join(h.root, 'mobile');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    git(dir, 'init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'build/\n');
    writeFileSync(join(dir, 'lib', 'a.dart'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'inicio');
    const repo = realPath(dir);
    h.config.floors.mobile = floor(repo);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }), leadMeta);
    return repo;
  }

  const devStarts = (repo: string) => h.office.ingest(ev(LEAD, repo, 'SubagentStart', DEV));
  const devIdle = (repo: string) => h.office.ingest(ev(LEAD, repo, 'TeammateIdle', { ...DEV, teammate_name: 'dev-mobile', team_name: TEAM }));

  test('sed through Bash counts as a change', () => {
    const { repo, file } = sedTeam();
    bash(repo, DEV, 'b1', "sed -i '' 's/a/b/' lib/trips.dart", () => writeFileSync(file, 'bb'));
    const blocked = h.office.gateMessage(done(repo));
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('Falta tester');
    expect(blocked.reason).toContain('lib/trips.dart');
    expect(edits().some((path) => path.includes('s/a/b/'))).toBe(false);
    h.clock.advance(1000);
    testerRun(repo, 'bun test test/trips_test.dart');
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
  });

  test('TaskCompleted with the same change', () => {
    const { repo, file } = sedTeam();
    bash(repo, DEV, 'b1', "sed -i '' 's/a/b/' lib/trips.dart", () => writeFileSync(file, 'bb'));
    const close = () => h.office.gate(ev(LEAD, repo, 'TaskCompleted', { task_id: '1', task_subject: 'Pantalla de viajes', team_name: TEAM, teammate_name: 'dev-mobile' }));
    const blocked = close();
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('lib/trips.dart');
    h.clock.advance(1000);
    testerRun(repo, 'bun test test/trips_test.dart');
    expect(close().pass).toBe(true);
  });

  test('a Bash that exits red at the end also wrote', () => {
    const { repo, file } = sedTeam();
    bash(repo, DEV, 'b1', "sed -i '' 's/a/b/' lib/trips.dart && dart format lib/", () => writeFileSync(file, 'bb'), true);
    expect(edits('dev-1')).toEqual([realPath(file)]);
    expect(h.office.gateMessage(done(repo)).pass).toBe(false);
  });

  test('a read through Bash does not count', () => {
    const { repo } = sedTeam();
    bash(repo, DEV, 'b1', 'python3 tool.py lib/trips.dart');
    expect(edits()).toEqual([]);
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
  });

  test('the developer own tests do not count', () => {
    const { repo, file } = sedTeam();
    bash(repo, DEV, 'b1', "sed -i '' 's/a/b/' lib/trips.dart", () => writeFileSync(file, 'bb'));
    h.clock.advance(1000);
    testerRun(repo, 'bun test test/trips_test.dart');
    h.clock.advance(1000);
    mkdirSync(join(repo, 'test'), { recursive: true });
    bash(repo, DEV, 'b2', 'bun test test/x.test.ts', () => writeFileSync(join(repo, 'test', 'x.test.ts'), 'snapshot'));
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
  });

  test('git commit does not count but git stash does', () => {
    const { repo, file } = sedTeam();
    bash(repo, DEV, 'b1', "sed -i '' 's/a/b/' lib/trips.dart", () => writeFileSync(file, 'bb'));
    h.clock.advance(1000);
    testerRun(repo, 'bun test test/trips_test.dart');
    h.clock.advance(1000);
    bash(repo, DEV, 'b2', 'git commit -m "x"');
    bash(repo, DEV, 'b3', 'git stash list');
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
    bash(repo, DEV, 'b4', 'git stash');
    const blocked = h.office.gateMessage(done(repo));
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('. (git)');
  });

  test('a call to the chat script names files without changing them', () => {
    const { repo } = sedTeam();
    bash(repo, DEV, 'b1', 'sh ~/.claude/office-chat.sh toca lib/trips.dart', () => writeFileSync(join(repo, 'lib', 'trips.dart'), 'bb'));
    expect(edits()).toEqual([]);
  });

  test('the turn fingerprint picks up what Bash does not declare', async () => {
    const repo = gitTeam();
    devStarts(repo);
    await h.office.idle();
    writeFileSync(join(repo, 'lib', 'a.dart'), 'cambio por un generador');
    mkdirSync(join(repo, 'build'), { recursive: true });
    writeFileSync(join(repo, 'build', 'out.txt'), 'ignorado');
    bash(repo, DEV, 'b1', 'bun run gen');
    devIdle(repo);
    await h.office.idle();
    const blocked = h.office.gateMessage(done(repo));
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('lib/a.dart');
    expect(blocked.reason).not.toContain('build/out.txt');
    expect(edits('dev-1')).toContain(join(repo, 'lib', 'a.dart'));
    expect(edits('dev-1').some((path) => path.includes('build'))).toBe(false);
    h.clock.advance(1000);
    testerRun(repo, 'flutter test test/a_test.dart');
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
  });

  test('the direct path respects .gitignore while a turn is watched', async () => {
    const repo = gitTeam();
    devStarts(repo);
    await h.office.idle();
    mkdirSync(join(repo, 'build'), { recursive: true });
    bash(repo, DEV, 'b1', 'cp lib/a.dart build/copia.dart', () => writeFileSync(join(repo, 'build', 'copia.dart'), 'copia'));
    writeFileSync(join(repo, 'build', 'a'), 'a');
    writeFileSync(join(repo, 'build', 'b'), 'b');
    bash(repo, DEV, 'b2', 'rm -rf build/a build/b', () => {
      unlinkSync(join(repo, 'build', 'a'));
      unlinkSync(join(repo, 'build', 'b'));
    });
    expect(edits()).toEqual([]);
  });

  test('the fingerprint does not blind the guard', async () => {
    useGitIdentity();
    h = harness({
      configure: (config) => {
        config.departments = { redaccion: true, mantenimiento: false };
      },
    });
    const docs = realPath(join(h.root, 'docs'));
    ensureDocsRepo(docs);
    h.office.refreshDocuments();
    const dir = join(h.root, 'mobile');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'lib', 'a.dart'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'inicio');
    const repo = realPath(dir);
    h.config.floors.mobile = floor(repo);
    const RED = 'dddddddd-0000-4000-8000-000000000001';
    const cwd = join(docs, 'redaccion');
    h.office.ingest(ev(RED, cwd, 'SessionStart', {}), { socket: null, token: null, role: 'office-lead-redaccion', name: 'lead-redaccion' });
    h.office.ingest(ev(RED, cwd, 'SubagentStart', { agent_id: 'ared-1', agent_type: 'office-redactor' }));
    await h.office.idle();
    h.clock.advance(1000);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }), leadMeta);
    devStarts(repo);
    await h.office.idle();
    writeFileSync(join(repo, 'lib', 'a.dart'), 'cambio que nadie declara');
    h.clock.advance(1000);
    devIdle(repo);
    await h.office.idle();
    expect(edits('dev-1')).toEqual([join(repo, 'lib', 'a.dart')]);
    h.clock.advance(1000);
    h.office.ingest(ev(RED, cwd, 'SubagentStop', { agent_id: 'ared-1', agent_type: 'office-redactor' }));
    await h.office.idle();
    const alerts = h.db.query<{ level: string; floor: string; files: string }, []>('SELECT level, floor, files FROM alerts').all();
    expect(alerts).toEqual([{ level: 'posible', floor: 'mobile', files: JSON.stringify([join(repo, 'lib', 'a.dart')]) }]);
  });

  test('a commit in the turn does not hide the changes', async () => {
    const repo = gitTeam();
    devStarts(repo);
    await h.office.idle();
    writeFileSync(join(repo, 'lib', 'a.dart'), 'cambio con commit');
    git(repo, 'commit', '-qam', 'x');
    devIdle(repo);
    await h.office.idle();
    const blocked = h.office.gateMessage(done(repo));
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('lib/a.dart');
  });

  test('a commit of what was already tested does not block', async () => {
    const repo = gitTeam();
    devStarts(repo);
    await h.office.idle();
    writeFileSync(join(repo, 'lib', 'a.dart'), 'cambio ya probado');
    devIdle(repo);
    await h.office.idle();
    h.clock.advance(1000);
    testerRun(repo, 'flutter test test/a_test.dart');
    h.clock.advance(1000);
    devStarts(repo);
    await h.office.idle();
    git(repo, 'commit', '-qam', 'x');
    bash(repo, DEV, 'b1', 'git commit -am x');
    devIdle(repo);
    await h.office.idle();
    expect(h.office.gateMessage(done(repo)).pass).toBe(true);
  });

  test('a fingerprint in progress closes the gate', async () => {
    let slow = false;
    const slowGit: GitRunner = async (cwd, args, timeoutMs) => {
      if (slow) await Bun.sleep(200);
      return runGit(cwd, args, timeoutMs);
    };
    const repo = gitTeam({ git: slowGit });
    devStarts(repo);
    await h.office.idle();
    writeFileSync(join(repo, 'lib', 'a.dart'), 'cambio aún sin huella');
    slow = true;
    devIdle(repo);
    const pending = h.office.gateMessage(done(repo));
    expect(pending.pass).toBe(false);
    expect(pending.reason).toContain('huella');
    await h.office.idle();
    const settled = h.office.gateMessage(done(repo));
    expect(settled.pass).toBe(false);
    expect(settled.reason).toContain('lib/a.dart');
  });
});

describe('session liveness', () => {
  test('a session whose socket disappears is ended on the next tick', () => {
    h = harness();
    const repo = managedRepo();
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), { ...leadMeta, socket });
    h.office.tick();
    expect(h.office.snapshot().sessions.find((s) => s.sessionId === LEAD)?.endedAt).toBeNull();
    rmSync(socket);
    h.office.tick();
    expect(h.office.snapshot().sessions.find((s) => s.sessionId === LEAD)?.endedAt).not.toBeNull();
    expect(agent(LEAD)?.state).toBe('done');
  });

  test('a restart only restores sessions whose socket still exists', () => {
    h = harness();
    const repo = managedRepo();
    const live = join(h.root, 'live.sock');
    writeFileSync(live, '');
    h.office.ingest(ev('live-1', repo, 'SessionStart', {}), { ...leadMeta, socket: live });
    h.office.ingest(ev('dead-1', repo, 'SessionStart', {}), { ...leadMeta, socket: join(h.root, 'gone.sock') });
    const restarted = new Office({
      hubId: 'hub-test',
      db: h.db,
      config: h.config,
      profiles: loadProfiles(PROFILES_DIR),
      workspaceDir: h.workspace,
      claudeHome: join(h.root, 'claude-home'),
      gitRoot: (cwd) => cwd,
      now: () => h.clock.now,
    });
    expect(restarted.snapshot().sessions.map((s) => s.sessionId)).toEqual(['live-1']);
    expect(restarted.snapshot().agents).toMatchObject([
      { key: 'live-1', name: 'lead-mobile', role: 'office-lead-mobile', roleKind: 'lead', state: 'idle', floor: 'mobile', endedAt: null },
    ]);
  });
});

describe('what each agent is on', () => {
  test('the file is relative to the floor, only its name outside it, and clears on a new turn', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    expect(agent(LEAD)?.file).toBeNull();
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'lib', 'login.dart') } }));
    expect(agent(LEAD)?.file).toBe(join('lib', 'login.dart'));
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(agent(LEAD)?.file).toBe(join('lib', 'login.dart'));
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(h.root, 'docs', 'plan.md') } }));
    expect(agent(LEAD)?.file).toBe('plan.md');
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x', path: join(repo, 'lib') } }));
    expect(agent(LEAD)?.file).toBe('plan.md');
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'Sigue con el registro' }));
    expect(agent(LEAD)?.file).toBeNull();
  });

  test('an observed floor shows only the file name', () => {
    h = harness();
    const repo = observedRepo();
    h.office.ingest(ev('obs-1', repo, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'secreto.ts') } }));
    h.office.ingest(ev('obs-1', repo, 'UserPromptSubmit', { prompt: 'Arregla el pago' }));
    expect(agent('obs-1')?.task).toBeNull();
    h.office.ingest(ev('obs-1', repo, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'secreto.ts') } }));
    expect(agent('obs-1')?.file).toBe('secreto.ts');
  });

  test('the task is the first line of the last message or order received that is not protocol', async () => {
    h = harness({ deliverFn: async () => {} });
    const repo = managedRepo();
    const socket = join(h.root, 'lead.sock');
    writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), { ...leadMeta, socket });
    h.office.ingest(
      ev(LEAD, repo, 'PreToolUse', {
        tool_name: 'Agent',
        tool_use_id: 'call-dev',
        tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile', description: 'pantalla de viajes', prompt: '...' },
      }),
    );
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'call-dev', tool_input: {}, tool_response: { agentId: 'dev-1' } }));
    h.office.ingest(ev(LEAD, repo, 'SubagentStart', { agent_id: 'dev-1', agent_type: 'office-dev-mobile' }));
    expect(agent('dev-1')?.task).toBe('pantalla de viajes');

    const send = (message: string) =>
      h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'dev-mobile', message } }));
    send('\nEmpieza por la tarea 1: el login\nDetalles: usa el repositorio nuevo');
    expect(agent('dev-1')?.task).toBe('Empieza por la tarea 1: el login');
    send('LECCIÓN: los tests van antes');
    expect(agent('dev-1')?.task).toBe('Empieza por la tarea 1: el login');
    send(`Ahora el registro ${'x'.repeat(200)}`);
    expect(agent('dev-1')?.task?.length).toBe(120);
    expect(agent('dev-1')?.task).toStartWith('Ahora el registro');
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { agent_id: 'dev-1', tool_name: 'SendMessage', tool_input: { to: 'team-lead', message: 'Listo el login' } }));
    expect(h.office.snapshot().messages.at(-1)?.toKey).toBe(LEAD);
    expect(agent(LEAD)?.task).toBeNull();

    expect(await h.office.order(LEAD, 'Prioriza el login\ny luego el perfil')).toBe('ok');
    expect(agent(LEAD)?.task).toBe('Prioriza el login');
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: '[Agent Office] Orden del usuario desde el panel de la oficina: Cierra la rama' }));
    expect(agent(LEAD)?.task).toBe('Cierra la rama');
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: '/clear' }));
    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'HECHO: todo listo' }));
    expect(agent(LEAD)?.task).toBe('Cierra la rama');
  });
});

describe('agents going home', () => {
  const lastAgent = (key: string): AgentView | undefined => {
    for (let index = h.messages.length - 1; index >= 0; index -= 1) {
      const msg = h.messages[index];
      if (msg?.type === 'agent' && msg.data.key === key) return msg.data;
    }
    return undefined;
  };

  function teamWithDev(): string {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'TeammateIdle', { agent_id: 'dev-1', teammate_name: 'dev-mobile', team_name: TEAM }));
    return repo;
  }

  test('an idle teammate leaves after leaveAfterMinutes; the lead and the director never do', () => {
    const repo = teamWithDev();
    // Launched sessions have a socket; one without it and silent for 30 minutes is a ghost, not an idle lead.
    const sockets = [join(h.root, 'lead.sock'), join(h.root, 'dir.sock')];
    for (const socket of sockets) writeFileSync(socket, '');
    h.office.ingest(ev(LEAD, repo, 'Notification', {}), { ...leadMeta, socket: sockets[0] ?? null });
    h.office.ingest(ev('dir-1', h.workspace, 'SessionStart', {}), { socket: sockets[1] ?? null, token: null, role: 'office-director', name: 'director' });
    h.clock.advance(4 * 60_000);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(false);
    h.clock.advance(60_000 + 1);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(true);
    expect(lastAgent('dev-1')?.away).toBe(true);
    h.clock.advance(60 * 60_000);
    h.office.tick();
    expect(agent(LEAD)).toMatchObject({ state: 'idle', away: false });
    expect(agent('dir-1')).toMatchObject({ roleKind: 'director', away: false });
  });

  test('the configured minutes are respected', () => {
    h = harness({ configure: (config) => (config.leaveAfterMinutes = 15) });
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'TeammateIdle', { agent_id: 'dev-1', teammate_name: 'dev-mobile', team_name: TEAM }));
    h.clock.advance(14 * 60_000);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(false);
    h.clock.advance(60_000 + 1);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(true);
  });

  test('the team waits at its desks while the lead is working', () => {
    const repo = teamWithDev();
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }));
    h.clock.advance(20 * 60_000);
    h.office.tick();
    expect(agent(LEAD)?.state).toBe('working');
    expect(agent('dev-1')?.away).toBe(false);
    h.office.ingest(ev(LEAD, repo, 'Stop', {}));
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(true);
  });

  test('any new event or a message brings it back', () => {
    const repo = teamWithDev();
    h.clock.advance(6 * 60_000);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(true);
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { agent_id: 'dev-1', tool_name: 'Read', tool_input: { file_path: join(repo, 'a.dart') } }));
    expect(agent('dev-1')?.away).toBe(false);

    h.office.ingest(ev(LEAD, repo, 'TeammateIdle', { agent_id: 'dev-1', teammate_name: 'dev-mobile', team_name: TEAM }));
    h.clock.advance(6 * 60_000);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(true);
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'dev-mobile', message: 'Revisa el registro' } }));
    expect(agent('dev-1')).toMatchObject({ away: false, task: 'Revisa el registro' });
    expect(lastAgent('dev-1')?.away).toBe(false);
    h.office.tick();
    expect(agent('dev-1')?.away).toBe(false);
  });

  test('an ended agent is away at once and agent-gone is sent when the hub forgets it', () => {
    h = harness();
    const repo = managedRepo();
    h.office.ingest(ev(LEAD, repo, 'SessionStart', {}), leadMeta);
    h.office.ingest(ev(LEAD, repo, 'SubagentStart', { agent_id: 'sub-1', agent_type: 'Explore' }));
    expect(agent('sub-1')?.away).toBe(false);
    h.office.ingest(ev(LEAD, repo, 'SubagentStop', { agent_id: 'sub-1', agent_type: 'Explore' }));
    expect(agent('sub-1')).toMatchObject({ state: 'done', away: true });
    h.clock.advance(10 * 60_000 + 1);
    h.office.tick();
    expect(agent('sub-1')).toBeUndefined();
    expect(h.messages.at(-1)).toEqual({ type: 'agent-gone', key: 'sub-1' });
    expect(h.messages.filter((m) => m.type === 'agent-gone')).toHaveLength(1);
  });
});

describe('open tool start', () => {
  const MIN = 60_000;
  const pre = (id: string, tool = 'Bash') => ev(LEAD, observedRepo(), 'PreToolUse', { tool_name: tool, tool_use_id: id, tool_input: { command: 'sleep 1' } });
  const post = (id: string, hook = 'PostToolUse') => ev(LEAD, observedRepo(), hook, { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'sleep 1' } });

  test('toolSince is set on PreToolUse and cleared on PostToolUse', () => {
    h = harness();
    h.office.ingest(ev(LEAD, observedRepo(), 'SessionStart', { source: 'startup' }), leadMeta);
    expect(agent(LEAD)?.toolSince).toBeNull();
    const opened = h.clock.now;
    h.office.ingest(pre('t1'));
    expect(agent(LEAD)?.toolSince).toBe(opened);
    h.clock.advance(MIN);
    h.office.ingest(post('t1'));
    expect(agent(LEAD)?.toolSince).toBeNull();
  });

  test('PostToolUseFailure clears it too', () => {
    h = harness();
    h.office.ingest(ev(LEAD, observedRepo(), 'SessionStart', { source: 'startup' }), leadMeta);
    h.office.ingest(pre('t1'));
    h.office.ingest(post('t1', 'PostToolUseFailure'));
    expect(agent(LEAD)?.toolSince).toBeNull();
  });

  test('with two open tools it is the earliest, and closing it leaves the other', () => {
    h = harness();
    h.office.ingest(ev(LEAD, observedRepo(), 'SessionStart', { source: 'startup' }), leadMeta);
    const first = h.clock.now;
    h.office.ingest(pre('t1'));
    h.clock.advance(MIN);
    const second = h.clock.now;
    h.office.ingest(pre('t2', 'Read'));
    expect(agent(LEAD)?.toolSince).toBe(first);
    h.office.ingest(post('t1'));
    expect(agent(LEAD)?.toolSince).toBe(second);
  });
});
