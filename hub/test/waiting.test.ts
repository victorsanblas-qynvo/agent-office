import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES_DIR } from '../src/config';
import { broadcastText } from '../src/courier';
import { Office, STATUS_REQUEST } from '../src/office';
import { parseProtocol, parseWaiting } from '../src/protocol';
import { loadProfiles } from '../src/profiles';
import type { SessionBook } from '../src/session-book';
import type { AgentView, HookMeta } from '../src/types';
import { ev, floor, harness, keyOf, type Harness } from './helpers';

const DIRECTOR = 'dddddddd-1111-4111-8111-000000000001';
const LEAD = '22222222-bbbb-4ccc-8ddd-000000000002';
const MINUTE = 60_000;
const directorMeta: HookMeta = { socket: null, token: null, role: 'office-director', name: 'director' };
const leadMeta = (socket: string | null): HookMeta => ({ socket, token: null, role: 'office-lead-mobile', name: 'lead-mobile' });

let h: Harness;
let repo = '';
let socket = '';
let sent: { socket: string; payload: string }[] = [];
afterEach(() => h?.cleanup());

const agent = (key = LEAD): AgentView | undefined => h.office.snapshot().agents.find((a) => a.key === key);
const stalls = () => h.office.snapshot().activity.filter((a) => keyOf(a.summary) === 'hub.act.stalled');
const lead = (...args: Parameters<typeof ev> extends [string, string, ...infer R] ? R : never) => ev(LEAD, repo, ...args);

function office(): void {
  sent = [];
  h = harness({
    deliverFn: async (target, payload) => {
      sent.push({ socket: target, payload });
    },
  });
  repo = join(h.root, 'mobile');
  mkdirSync(repo, { recursive: true });
  h.config.floors.mobile = floor(repo);
  socket = join(h.root, 'lead.sock');
  writeFileSync(socket, '');
  h.office.ingest(ev(DIRECTOR, h.workspace, 'SessionStart', { source: 'startup' }), directorMeta);
  h.office.ingest(lead('SessionStart', { source: 'startup' }), leadMeta(socket));
}

function brief(message = 'ENCARGO: pantalla de viajes — criterios: tests'): void {
  h.office.ingest(ev(DIRECTOR, h.workspace, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'lead-mobile', message } }));
}

function say(to: string, message: string, teammate: { id: string; type: string } | null = null): void {
  const who = teammate ? { agent_id: teammate.id, agent_type: teammate.type } : {};
  h.office.ingest(lead('PreToolUse', { ...who, tool_name: 'SendMessage', tool_input: { to, message } }));
}

function done(message = 'HECHO: pantalla — validado por tester-mobile — pendiente: nada'): void {
  say('director', message);
  h.office.ingest(lead('PostToolUse', { tool_name: 'SendMessage', tool_input: { to: 'director', message } }));
}

function stalledLead(): void {
  office();
  brief();
  h.office.ingest(lead('Stop'));
  h.clock.advance(11 * MINUTE);
}

function startTeammate(id: string, name: string, type: string): void {
  h.office.ingest(lead('PreToolUse', { tool_name: 'Agent', tool_use_id: `call-${id}`, tool_input: { name, subagent_type: type, prompt: 'x' } }));
  h.office.ingest(lead('SubagentStart', { agent_id: id, agent_type: name }));
}

const startDev = () => startTeammate('adev-1', 'dev-mobile', 'office-dev-mobile');
const TESTER = { id: 'atest-1', type: 'tester-mobile' };

describe('ESPERO', () => {
  test('parseWaiting splits who and what on a dash and keeps everything as who without one', () => {
    expect(parseWaiting('tester-mobile — tests del login')).toEqual({ who: 'tester-mobile', what: 'tests del login' });
    expect(parseWaiting('director – decisión sobre el contrato')).toEqual({ who: 'director', what: 'decisión sobre el contrato' });
    expect(parseWaiting('lead-backend -- el endpoint /trips\nsegunda línea')).toEqual({ who: 'lead-backend', what: 'el endpoint /trips' });
    expect(parseWaiting('usuario')).toEqual({ who: 'usuario', what: '' });
    expect(parseWaiting('dev-mobile-listo — x')).toEqual({ who: 'dev-mobile-listo', what: 'x' });
    expect(parseProtocol('ESPERO: tester — tests')).toMatchObject({ kind: 'waiting', target: null, rest: 'tester — tests' });
    expect(parseProtocol('espero: x')?.kind).toBe('waiting');
  });

  test('declares the wait, shows it as the detail of an idle lead and logs it', () => {
    office();
    say('director', 'ESPERO: tester-mobile — tests del login');
    h.office.ingest(lead('Stop'));
    expect(agent()?.waiting).toEqual({ who: 'tester-mobile', what: 'tests del login', since: h.clock.now });
    expect(agent()?.state).toBe('idle');
    expect(agent()?.detail).toEqual({ key: 'hub.detail.waitingFor', params: { who: 'tester-mobile', what: 'tests del login' } });
    expect(h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({
      key: 'hub.act.waitingDeclared',
      params: { who: 'lead-mobile', to: 'tester-mobile', what: 'tests del login' },
    });
    h.office.ingest(lead('UserPromptSubmit', { prompt: '/status' }));
    expect(agent()?.detail).not.toMatchObject({ key: 'hub.detail.waitingFor' });
  });

  test('a message from who clears it, one from anybody else does not', () => {
    office();
    startDev();
    startTeammate(TESTER.id, 'tester-mobile', 'office-tester-mobile');
    say('director', 'ESPERO: tester-mobile — tests del login');
    say('lead-mobile', 'Avance del login', { id: 'adev-1', type: 'dev-mobile' });
    expect(agent()?.waiting).not.toBeNull();
    say('lead-mobile', 'Tests en verde', TESTER);
    expect(agent()?.waiting).toBeNull();
  });

  test('the final text of a Stop that starts with ESPERO counts', () => {
    office();
    h.office.ingest(lead('Stop', { last_assistant_message: 'ESPERO: usuario — que elija la rama' }));
    expect(agent()?.waiting).toMatchObject({ who: 'usuario', what: 'que elija la rama' });
    expect(agent()?.detail).toEqual({ key: 'hub.detail.waitingFor', params: { who: 'usuario', what: 'que elija la rama' } });
  });

  test('an instruction of the user clears a wait on the user and not a wait on a teammate', () => {
    office();
    say('director', 'ESPERO: tester-mobile — tests');
    h.office.ingest(lead('UserPromptSubmit', { prompt: '/status' }));
    expect(agent()?.waiting).not.toBeNull();
    say('director', 'ESPERO: usuario — una decisión');
    h.office.ingest(lead('UserPromptSubmit', { prompt: '/status' }));
    expect(agent()?.waiting).toBeNull();
  });

  test('a new assignment, a sent HECHO or BLOQUEADO and the end of the agent clear it', () => {
    office();
    say('director', 'ESPERO: tester-mobile — tests');
    brief('ENCARGO: otra cosa');
    expect(agent()?.waiting).toBeNull();

    say('director', 'ESPERO: tester-mobile — tests');
    say('director', 'HECHO: algo — validado por nadie — pendiente: nada');
    expect(agent()?.waiting).toBeNull();

    say('director', 'ESPERO: tester-mobile — tests');
    say('director', 'BLOQUEADO: falta la key — necesito la key de backend');
    expect(agent()?.waiting).toBeNull();

    say('director', 'ESPERO: tester-mobile — tests');
    h.office.ingest(lead('SessionEnd', { reason: 'other' }));
    expect(agent()?.waiting).toBeNull();
  });

  test('a message from the director to a lead that waits for the director clears it', () => {
    office();
    say('director', 'ESPERO: director — decisión sobre el contrato');
    h.office.ingest(ev(DIRECTOR, h.workspace, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'lead-mobile', message: 'Usa el campo trip_id' } }));
    expect(agent()?.waiting).toBeNull();
  });
});

describe('stall detector', () => {
  test('an idle lead with an open brief and nobody working stalls once, with an activity entry', () => {
    stalledLead();
    h.office.tick();
    expect(agent()?.stalledSince).toBe(h.clock.now - 11 * MINUTE);
    expect(stalls().map((a) => a.summary)).toEqual([{ key: 'hub.act.stalled', params: { who: 'lead-mobile', minutes: 11 } }]);
    h.messages.length = 0;
    h.clock.advance(5000);
    h.office.tick();
    expect(stalls()).toHaveLength(1);
    expect(h.messages.filter((m) => m.type === 'agent')).toHaveLength(0);
  });

  test('is not stalled before the limit, nor without an open brief, and 0 turns it off', () => {
    office();
    brief();
    h.office.ingest(lead('Stop'));
    h.clock.advance(9 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();

    h.clock.advance(2 * MINUTE);
    h.config.limits.stalledAfterMinutes = 0;
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();
    h.config.limits.stalledAfterMinutes = 10;
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();

    office();
    h.office.ingest(lead('Stop'));
    h.clock.advance(30 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();
  });

  test('a brief that arrives after a long idle does not stall the lead until it has waited too', () => {
    office();
    h.office.ingest(lead('Stop'));
    h.clock.advance(60 * MINUTE);
    brief();
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();
  });

  test('is not stalled while a developer works, and is once the team stops', () => {
    office();
    brief();
    startDev();
    h.office.ingest(lead('Stop'));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent('adev-1')?.state).toBe('working');
    expect(agent()?.stalledSince).toBeNull();
    h.office.ingest(lead('SubagentStop', { agent_id: 'adev-1', agent_type: 'dev-mobile' }));
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();
  });

  test('is not stalled after a delivered HECHO, but a HECHO the gate blocked keeps the brief open', () => {
    office();
    brief();
    say('director', 'HECHO: algo — validado por nadie — pendiente: nada');
    h.office.ingest(lead('Stop'));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();

    office();
    brief();
    done();
    h.office.ingest(lead('Stop'));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();
  });

  test('is not stalled when blocked, waiting or asking', () => {
    stalledLead();
    say('director', 'BLOQUEADO: falta la key — necesito la key de backend');
    h.office.ingest(lead('Stop'));
    h.office.tick();
    expect(agent()?.state).toBe('blocked');
    expect(agent()?.stalledSince).toBeNull();

    stalledLead();
    say('director', 'ESPERO: tester-mobile — tests');
    h.office.ingest(lead('Stop'));
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();

    stalledLead();
    h.office.ingest(lead('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '¿Rama?', options: [{ label: 'A' }] }] } }));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).toBeNull();
  });

  test('clears when the lead works again, when it is declared waiting, and can stall again', () => {
    stalledLead();
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();
    h.office.ingest(lead('UserPromptSubmit', { prompt: '/status' }));
    expect(agent()?.stalledSince).toBeNull();
    h.office.ingest(lead('Stop'));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();
    expect(stalls()).toHaveLength(2);
    say('director', 'ESPERO: tester-mobile — tests');
    expect(agent()?.stalledSince).toBeNull();
  });

  test('the open brief survives a restart of the hub', () => {
    stalledLead();
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
    restarted.tick();
    h.clock.advance(11 * MINUTE);
    restarted.tick();
    expect(restarted.snapshot().agents.find((a) => a.key === LEAD)?.stalledSince).not.toBeNull();
  });
});

describe('status request', () => {
  test('delivers the question through the inbox and leaves the task and the open brief alone', async () => {
    stalledLead();
    const before = agent()?.task;
    expect(before).toBe('pantalla de viajes — criterios: tests');
    expect(await h.office.requestStatus(LEAD)).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.socket).toBe(socket);
    expect(sent[0]?.payload).toContain('[Agent Office] Orden del usuario');
    expect(sent[0]?.payload).toContain(STATUS_REQUEST);
    expect(agent()?.task).toBe(before);
    h.office.ingest(lead('UserPromptSubmit', { prompt: `[Agent Office] Orden del usuario desde el panel de la oficina: ${STATUS_REQUEST}` }));
    expect(agent()?.task).toBe(before);
    expect(h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.statusRequested', params: { who: 'lead-mobile' } });
    h.office.ingest(lead('Stop'));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();
  });

  test('an order from the panel does change the task and opens the brief', async () => {
    office();
    expect(await h.office.order(LEAD, 'Prioriza el login')).toBe('ok');
    expect(agent()?.task).toBe('Prioriza el login');
    h.office.ingest(lead('Stop'));
    h.clock.advance(11 * MINUTE);
    h.office.tick();
    expect(agent()?.stalledSince).not.toBeNull();
  });

  test('a second request within two minutes is busy and delivers nothing; after them it goes again', async () => {
    stalledLead();
    expect(await h.office.requestStatus(LEAD)).toBe('ok');
    h.clock.advance(2 * MINUTE - 1);
    expect(await h.office.requestStatus(LEAD)).toBe('busy');
    expect(sent).toHaveLength(1);
    h.clock.advance(1);
    expect(await h.office.requestStatus(LEAD)).toBe('ok');
    expect(sent).toHaveLength(2);
  });

  test('a request that could not be delivered does not hold the next one back', async () => {
    office();
    h.office.ingest(ev('sin-socket', repo, 'SessionStart', {}), { ...leadMeta(null), name: 'lead-otro' });
    expect(await h.office.requestStatus('sin-socket')).toBe('unreachable');
    expect(await h.office.requestStatus('sin-socket')).toBe('unreachable');
  });

  test('a message to every lead leaves its task and its plan alone, also when it arrives as a prompt', async () => {
    stalledLead();
    const runtime = () => (h.office as unknown as { book: SessionBook }).book.agents.get(LEAD);
    const before = agent()?.task;
    const message = 'Mirad redaccion/planes/otro-plan.md antes de seguir';
    expect(await h.office.order(LEAD, message, { broadcast: true })).toBe('ok');
    expect(sent[0]?.payload).toContain(broadcastText(message));
    expect(agent()?.task).toBe(before);
    h.office.ingest(lead('UserPromptSubmit', { prompt: broadcastText(message) }));
    expect(agent()?.task).toBe(before);
    expect(runtime()?.planSlug).toBeNull();
    expect(h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.order', params: { text: message } });

    expect(await h.office.order(LEAD, message)).toBe('ok');
    expect(agent()?.task).toBe(message);
    expect(runtime()?.planSlug).toBe('otro-plan');
  });

  test('answers not-found and unreachable like an order', async () => {
    office();
    expect(await h.office.requestStatus('nope')).toBe('not-found');
    h.office.ingest(ev('sin-socket', repo, 'SessionStart', {}), { ...leadMeta(null), name: 'lead-otro' });
    expect(await h.office.requestStatus('sin-socket')).toBe('unreachable');
  });
});
