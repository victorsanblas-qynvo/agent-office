import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES_DIR } from '../src/config';
import { Office, type TmuxFn } from '../src/office';
import { RELAUNCH_RESUMES, TMUX_SESSION, resumeCommand, sq } from '../src/office-sh';
import { loadProfiles } from '../src/profiles';
import { createApp } from '../src/server';
import { projectSlug } from '../src/tokens';
import type { HookMeta, SessionView } from '../src/types';
import { ev, floor, harness, keyOf, tempDir, type Harness } from './helpers';

const LEAD = '22222222-bbbb-4ccc-8ddd-000000000002';
const DIRECTOR = 'dddddddd-1111-4111-8111-000000000001';
const KEY = 'r'.repeat(64);
const NOTE = 'Las reglas de tu puesto cambiaron. Estas son las nuevas y mandan sobre las que recibiste al arrancar:';
const leadMeta = (socket: string): HookMeta => ({ socket, token: null, role: 'office-lead-mobile', name: 'lead-mobile' });
const directorMeta = (socket: string): HookMeta => ({ socket, token: null, role: 'office-director', name: 'director' });

let h: Harness;
let repo = '';
let agentsDir = '';
let sessionsDir = '';
let directorFloors = '';
let rulesDir = '';
let socket = '';
let calls: string[][] = [];
let tmuxReply: (args: string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: 'lead-mobile\ndirector\n' });
let tmuxThrows = false;
let home: { dir: string; cleanup: () => void } = { dir: '', cleanup: () => {} };
afterEach(() => {
  h?.cleanup();
  home.cleanup();
});

const tmux: TmuxFn = async (args) => {
  calls.push(args);
  if (tmuxThrows) throw new Error('spawn tmux ENOENT');
  return tmuxReply(args);
};

const leadAgent = (): string => join(agentsDir, 'office-lead-mobile.md');
const frontmatter = (model: string) => `---\nname: office-lead-mobile\nmodel: ${model}\n---\n\n`;
const rules = (extra = '') => `Eres el jefe.\n\n## Flujo\n1. Reparte.\n\n## Reglas\n- Sé breve.${extra}\n`;

function setup(withLaunch = true): void {
  calls = [];
  tmuxThrows = false;
  tmuxReply = () => ({ code: 0, stdout: 'lead-mobile\ndirector\n' });
  home = tempDir('agent-office-rules-');
  agentsDir = join(home.dir, 'claude-home', 'agents');
  sessionsDir = join(home.dir, 'office-home', 'sessions');
  directorFloors = join(home.dir, 'office-home', 'director-floors.md');
  rulesDir = join(home.dir, 'office-home', 'rules');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(leadAgent(), frontmatter('sonnet') + rules());
  writeFileSync(join(agentsDir, 'office-director.md'), '---\nname: office-director\n---\n\nEres el director.\n\n## Reglas\n- Encarga poco.\n');
  writeFileSync(directorFloors, '## Plantas gestionadas\n\n- `mobile`: Flutter.\n');
  writeFileSync(join(sessionsDir, 'lead-mobile.sh'), '#!/bin/sh\nexec claude --model sonnet "$@"\n');
  writeFileSync(join(sessionsDir, 'director.sh'), '#!/bin/sh\nexec claude "$@"\n');
  h = harness({ deliverFn: async () => {}, tmux, ...(withLaunch ? { launch: { agentsDir, sessionsDir, directorFloors } } : {}) });
  repo = join(h.root, 'mobile');
  mkdirSync(repo, { recursive: true });
  h.config.floors.mobile = floor(repo);
  socket = join(h.root, 'lead.sock');
  writeFileSync(socket, '');
  h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'startup' }), leadMeta(socket));
}

function launched(extra: Partial<ConstructorParameters<typeof Office>[0]> = {}): Office {
  return new Office({
    hubId: 'hub-test',
    db: h.db,
    config: h.config,
    profiles: loadProfiles(PROFILES_DIR),
    workspaceDir: h.workspace,
    claudeHome: join(h.root, 'claude-home'),
    gitRoot: (cwd) => cwd,
    now: () => h.clock.now,
    tmux,
    launch: { agentsDir, sessionsDir, directorFloors },
    ...extra,
  });
}

// The transcript claude writes once the session has received a message: what `claude --resume` looks for.
const writeTranscript = (id = LEAD, cwd = repo): string => {
  const dir = join(h.root, 'claude-home', 'projects', projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, '{"type":"user"}\n');
  return file;
};
const prompt = (office: Office = h.office, session = LEAD, cwd = repo): string | null => office.ingest(ev(session, cwd, 'UserPromptSubmit', { prompt: 'Sigue con el login' }));
const context = (output: string | null): string | null => (output ? (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : null);
const rewrite = (file: string, content: string) => {
  writeFileSync(file, content);
  h.clock.advance(1000);
};
const sessionOf = (office: Office = h.office, id = LEAD): SessionView | undefined => office.snapshot().sessions.find((s) => s.sessionId === id);
const sessionEvents = () => h.messages.flatMap((m) => (m.type === 'session' ? [m.data] : []));

describe('rules without relaunching', () => {
  test('rewriting the agent file injects the new rules once, at the next prompt, and not again after a restart', () => {
    setup();
    expect(prompt()).toBeNull();
    writeFileSync(leadAgent(), frontmatter('sonnet') + rules('\n- Pregunta antes de abrir más de un encargo.'));
    const injected = context(prompt());
    expect(injected).toStartWith(NOTE);
    expect(injected).toContain('- Pregunta antes de abrir más de un encargo.');
    expect(injected).not.toContain('model: sonnet');
    expect(sessionOf()?.rulesPending).toBe(false);
    expect(prompt()).toBeNull();
    expect(h.office.snapshot().activity.map((a) => keyOf(a.summary))).toContain('hub.act.rulesReloaded');

    const restarted = launched();
    expect(prompt(restarted)).toBeNull();
    expect(readFileSync(join(rulesDir, 'lead-mobile.md'), 'utf8')).toContain('Pregunta antes de abrir más de un encargo.');
  });

  test('a change made while the hub was down arrives with the next prompt after the restart', () => {
    setup();
    writeFileSync(leadAgent(), frontmatter('sonnet') + rules('\n- Nueva regla.'));
    const restarted = launched();
    expect(context(prompt(restarted))).toContain('- Nueva regla.');
    expect(prompt(restarted)).toBeNull();
  });

  test('no note when nothing changed, when only the frontmatter changed or when the session has no hash', () => {
    setup();
    expect(prompt()).toBeNull();
    writeFileSync(leadAgent(), frontmatter('opus') + rules());
    expect(prompt()).toBeNull();
    expect(prompt()).toBeNull();

    const other = 'cccccccc-0000-4000-8000-000000000009';
    rmSync(join(agentsDir, 'office-lead-mobile.md'));
    h.office.ingest(ev(other, repo, 'SessionStart', { source: 'startup' }), { ...leadMeta(socket), name: 'lead-otro' });
    writeFileSync(leadAgent(), frontmatter('opus') + rules('\n- Otra.'));
    expect(prompt(h.office, other)).toBeNull();
    expect(prompt(h.office, other)).toBeNull();
  });

  test('a session that is not an office session never gets rules', () => {
    setup();
    h.office.ingest(ev('plain-1', repo, 'SessionStart', { source: 'startup' }));
    expect(prompt(h.office, 'plain-1')).toBeNull();
    expect(sessionOf(h.office, 'plain-1')?.canRelaunch).toBe(false);
  });

  test('the director receives the contents of both its files', () => {
    setup();
    const directorSocket = join(h.root, 'director.sock');
    writeFileSync(directorSocket, '');
    h.office.ingest(ev(DIRECTOR, h.workspace, 'SessionStart', { source: 'startup' }), directorMeta(directorSocket));
    rewrite(directorFloors, '## Plantas gestionadas\n\n- `mobile`: Flutter.\n- `backend`: Laravel.\n');
    const first = context(prompt(h.office, DIRECTOR, h.workspace));
    expect(first).toContain('Eres el director.');
    expect(first).toContain('- Encarga poco.');
    expect(first).toContain('- `backend`: Laravel.');
    expect(prompt(h.office, DIRECTOR, h.workspace)).toBeNull();
    rewrite(join(agentsDir, 'office-director.md'), '---\nname: office-director\n---\n\nEres el director.\n\n## Reglas\n- Encarga menos.\n');
    const second = context(prompt(h.office, DIRECTOR, h.workspace));
    expect(second).toContain('- Encarga menos.');
    expect(second).toContain('- `backend`: Laravel.');
  });

  test('above the cap only the sections that changed since the baseline arrive; without a baseline copy, the whole file', () => {
    setup();
    const big = `Eres el jefe.\n\n## Flujo\n${'Paso largo. '.repeat(1200)}\n\n## Reglas\n- Sé breve.\n`;
    writeFileSync(leadAgent(), frontmatter('sonnet') + big);
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'resume' }), leadMeta(socket));
    writeFileSync(leadAgent(), frontmatter('sonnet') + big.replace('- Sé breve.', '- Sé muy breve.'));
    const changed = context(prompt()) ?? '';
    expect(changed).toContain('- Sé muy breve.');
    expect(changed).not.toContain('Paso largo.');
    expect(changed.length).toBeLessThan(12_000);

    rmSync(join(rulesDir, 'lead-mobile.md'));
    writeFileSync(leadAgent(), frontmatter('sonnet') + big.replace('- Sé breve.', '- Sé brevísimo.'));
    const whole = context(prompt()) ?? '';
    expect(whole).toContain('- Sé brevísimo.');
    expect(whole).toContain('Paso largo.');
  });

  test('compact and clear keep the baseline; startup and resume take a new one', () => {
    setup();
    writeFileSync(leadAgent(), frontmatter('sonnet') + rules('\n- Regla A.'));
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'compact' }), leadMeta(socket));
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'clear' }), leadMeta(socket));
    expect(context(prompt())).toContain('- Regla A.');

    writeFileSync(leadAgent(), frontmatter('sonnet') + rules('\n- Regla B.'));
    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'resume' }), leadMeta(socket));
    expect(prompt()).toBeNull();
  });

  test('subagents never get the rules block', () => {
    setup();
    writeFileSync(leadAgent(), frontmatter('sonnet') + rules('\n- Regla A.'));
    expect(h.office.ingest(ev(LEAD, repo, 'SubagentStart', { agent_id: 'adev-1', agent_type: 'dev-mobile' }))).toBeNull();
  });
});

describe('launcher changes', () => {
  test('rewriting the launcher flags the session once and emits it; a new SessionStart takes the new baseline', () => {
    setup();
    h.office.tick();
    expect(sessionOf()).toMatchObject({ needsRelaunch: false, canRelaunch: true, relaunchResumes: false });

    h.messages.length = 0;
    rewrite(join(sessionsDir, 'lead-mobile.sh'), '#!/bin/sh\nexec claude --model opus "$@"\n');
    h.clock.advance(30_000);
    h.office.tick();
    expect(sessionOf()?.needsRelaunch).toBe(true);
    expect(sessionEvents().map((s) => s.needsRelaunch)).toEqual([true]);
    h.clock.advance(30_000);
    h.office.tick();
    expect(sessionEvents()).toHaveLength(1);

    h.office.ingest(ev(LEAD, repo, 'SessionStart', { source: 'resume' }), leadMeta(socket));
    expect(sessionOf()?.needsRelaunch).toBe(false);
  });

  test('a restart keeps the stored baseline, so a launcher changed meanwhile is flagged', () => {
    setup();
    rewrite(join(sessionsDir, 'lead-mobile.sh'), '#!/bin/sh\nexec claude --model opus "$@"\n');
    const restarted = launched();
    expect(sessionOf(restarted)?.needsRelaunch).toBe(true);
    expect(sessionOf(launched({ launch: undefined }))?.needsRelaunch).toBe(false);
  });

  test('a session without a stored baseline adopts the current files and is not flagged', () => {
    setup();
    h.db.run('UPDATE sessions SET rules_hash = NULL, launch_hash = NULL');
    const restarted = launched();
    expect(sessionOf(restarted)).toMatchObject({ needsRelaunch: false, rulesPending: false });
    expect(prompt(restarted)).toBeNull();
  });

  test('the pending rules show on the session until the next prompt delivers them', () => {
    setup();
    h.office.tick();
    h.messages.length = 0;
    rewrite(leadAgent(), frontmatter('sonnet') + rules('\n- Nueva.'));
    h.office.tick();
    expect(sessionOf()?.rulesPending).toBe(true);
    expect(sessionEvents().at(-1)?.rulesPending).toBe(true);
    prompt();
    expect(sessionOf()?.rulesPending).toBe(false);
  });
});

describe('relaunch', () => {
  const prepare = () => {
    setup();
    h.office.ingest(ev(LEAD, repo, 'Stop'));
  };

  test('lists the windows and respawns the exact one with --resume, falling back to a fresh start if it dies at once', async () => {
    prepare();
    writeTranscript();
    expect(RELAUNCH_RESUMES).toBe(true);
    expect(await h.office.relaunch(LEAD)).toBe('ok');
    const script = sq(join(sessionsDir, 'lead-mobile.sh'));
    const inner = `t=$(date +%s); ${script} --resume ${LEAD} || { [ $(($(date +%s) - t)) -lt 10 ] && { echo 'Agent Office: no se pudo reanudar, abriendo sesión nueva'; exec ${script}; }; }`;
    expect(calls).toEqual([
      ['list-windows', '-t', TMUX_SESSION, '-F', '#{window_name}'],
      ['respawn-window', '-k', '-t', `${TMUX_SESSION}:=lead-mobile`, `sh -c ${sq(inner)}`],
    ]);
    expect(calls[1]?.at(-1)).toBe(resumeCommand(join(sessionsDir, 'lead-mobile.sh'), LEAD));
    expect(h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.relaunched', params: { who: 'lead-mobile' } });
  });

  test('a session without a transcript is relaunched fresh, and its view says so until the transcript appears', async () => {
    prepare();
    h.office.tick();
    expect(sessionOf()?.relaunchResumes).toBe(false);
    expect(await h.office.relaunch(LEAD)).toBe('ok');
    expect(calls[1]?.at(-1)).toBe(sq(join(sessionsDir, 'lead-mobile.sh')));
    expect(calls[1]?.at(-1)).not.toContain('--resume');

    h.messages.length = 0;
    writeTranscript();
    h.clock.advance(30_000);
    h.office.tick();
    expect(sessionOf()?.relaunchResumes).toBe(true);
    expect(sessionEvents().at(-1)?.relaunchResumes).toBe(true);
    expect(await h.office.relaunch(LEAD)).toBe('ok');
    expect(calls.at(-1)?.at(-1)).toContain(`--resume ${LEAD}`);
  });

  test('an explicit resume still falls back to a fresh start when there is no transcript', async () => {
    prepare();
    expect(await h.office.relaunch(LEAD, true)).toBe('ok');
    expect(calls[1]?.at(-1)).toBe(sq(join(sessionsDir, 'lead-mobile.sh')));
  });

  test('a transcript the hooks reported counts even outside the project folder of the cwd', async () => {
    prepare();
    const elsewhere = join(h.root, 'claude-home', 'projects', 'other-slug');
    mkdirSync(elsewhere, { recursive: true });
    const file = join(elsewhere, `${LEAD}.jsonl`);
    writeFileSync(file, '{}\n');
    h.office.ingest(ev(LEAD, repo, 'Stop', { transcript_path: file }));
    expect(sessionOf()?.relaunchResumes).toBe(true);
    expect(await h.office.relaunch(LEAD)).toBe('ok');
    expect(calls[1]?.at(-1)).toContain('--resume');
  });

  test('the wrapper itself starts a fresh session when the resumed one fails at once, and leaves a clean exit alone', () => {
    setup();
    const fake = join(h.root, 'fake claude.sh');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--resume" ]; then echo "No conversation found"; exit 1; fi\necho "fresh session"\n', { mode: 0o755 });
    const failing = Bun.spawnSync(['sh', '-c', resumeCommand(fake, LEAD)], { env: { ...process.env, PATH: process.env.PATH ?? '' } });
    expect(failing.stdout.toString()).toBe('No conversation found\nAgent Office: no se pudo reanudar, abriendo sesión nueva\nfresh session\n');
    expect(failing.exitCode).toBe(0);

    writeFileSync(fake, '#!/bin/sh\necho "resumed $1 $2"\n', { mode: 0o755 });
    const working = Bun.spawnSync(['sh', '-c', resumeCommand(fake, LEAD)]);
    expect(working.stdout.toString()).toBe(`resumed --resume ${LEAD}\n`);
  });

  test('without resume the script runs bare', async () => {
    prepare();
    expect(await h.office.relaunch(LEAD, false)).toBe('ok');
    expect(calls[1]?.at(-1)).toBe(sq(join(sessionsDir, 'lead-mobile.sh')));
  });

  test('is busy while a teammate works, the lead is not idle or a question is pending, and free once they stop', async () => {
    prepare();
    h.office.ingest(ev(LEAD, repo, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'c1', tool_input: { name: 'dev-mobile', subagent_type: 'office-dev-mobile', prompt: 'x' } }));
    h.office.ingest(ev(LEAD, repo, 'SubagentStart', { agent_id: 'adev-1', agent_type: 'dev-mobile' }));
    h.office.ingest(ev(LEAD, repo, 'Stop'));
    expect(sessionOf()?.canRelaunch).toBe(false);
    expect(await h.office.relaunch(LEAD)).toBe('busy');
    expect(calls).toEqual([]);
    h.office.ingest(ev(LEAD, repo, 'SubagentStop', { agent_id: 'adev-1', agent_type: 'dev-mobile' }));
    expect(sessionOf()?.canRelaunch).toBe(true);

    h.office.ingest(ev(LEAD, repo, 'UserPromptSubmit', { prompt: 'Sigue' }));
    expect(await h.office.relaunch(LEAD)).toBe('busy');
    h.office.ingest(ev(LEAD, repo, 'Stop'));

    h.office.heartbeat(true);
    void h.office.ask(ev(LEAD, repo, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: { questions: [{ question: '¿Rama?', options: [{ label: 'A' }] }] } }));
    expect(await h.office.relaunch(LEAD)).toBe('busy');
    h.office.release(h.office.snapshot().questions[0]?.id ?? '');
    h.office.ingest(ev(LEAD, repo, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }));
    h.office.ingest(ev(LEAD, repo, 'Stop'));
    expect(await h.office.relaunch(LEAD)).toBe('ok');
  });

  test('one tmux window is relaunched once: a call while one runs or within 30 s after it is busy', async () => {
    prepare();
    const respawns = () => calls.filter((args) => args[0] === 'respawn-window');
    const [first, second] = await Promise.all([h.office.relaunch(LEAD), h.office.relaunch(LEAD)]);
    expect([first, second]).toEqual(['ok', 'busy']);
    expect(respawns()).toHaveLength(1);
    h.clock.advance(10_000);
    expect(await h.office.relaunch(LEAD)).toBe('busy');
    h.clock.advance(21_000);
    expect(await h.office.relaunch(LEAD)).toBe('ok');
    expect(respawns()).toHaveLength(2);
  });

  test('an older session of a window a newer open session already has is busy', async () => {
    prepare();
    const NEWER = '33333333-cccc-4ddd-8eee-000000000003';
    h.clock.advance(1000);
    h.office.ingest(ev(NEWER, repo, 'SessionStart', { source: 'startup' }), leadMeta(socket));
    h.office.ingest(ev(NEWER, repo, 'Stop'));
    expect(await h.office.relaunch(LEAD)).toBe('busy');
    expect(calls).toEqual([]);
    expect(await h.office.relaunch(NEWER)).toBe('ok');
  });

  test('answers no-window, no-tmux, no-script, not-found and failed', async () => {
    prepare();
    tmuxReply = () => ({ code: 0, stdout: 'director\n' });
    expect(await h.office.relaunch(LEAD)).toBe('no-window');
    expect(calls).toHaveLength(1);

    tmuxReply = () => ({ code: 1, stdout: '' });
    expect(await h.office.relaunch(LEAD)).toBe('no-tmux');
    tmuxThrows = true;
    expect(await h.office.relaunch(LEAD)).toBe('no-tmux');
    tmuxThrows = false;

    tmuxReply = (args) => (args[0] === 'list-windows' ? { code: 0, stdout: 'lead-mobile\n' } : { code: 1, stdout: '' });
    expect(await h.office.relaunch(LEAD)).toBe('failed');

    expect(await h.office.relaunch('nope')).toBe('not-found');
    rmSync(join(sessionsDir, 'lead-mobile.sh'));
    expect(await h.office.relaunch(LEAD)).toBe('no-script');
    expect(sessionOf()?.canRelaunch).toBe(false);
  });

  test('a session name that is not a plain name never reaches tmux', async () => {
    setup();
    h.office.ingest(ev('weird-1', repo, 'SessionStart', { source: 'startup' }), { ...leadMeta(socket), name: '../lead-mobile; rm -rf' });
    h.office.ingest(ev('weird-1', repo, 'Stop'));
    calls = [];
    expect(await h.office.relaunch('weird-1')).toBe('no-script');
    expect(calls).toEqual([]);
  });

  test('without the launch option nothing is offered', async () => {
    setup(false);
    h.office.ingest(ev(LEAD, repo, 'Stop'));
    expect(sessionOf()).toMatchObject({ needsRelaunch: false, canRelaunch: false, rulesPending: false });
    expect(await h.office.relaunch(LEAD)).toBe('no-script');
  });
});

describe('relaunch and status routes', () => {
  const headers = { host: '127.0.0.1:4747', 'x-office-key': KEY, 'content-type': 'application/json' };
  const app = () => createApp({ office: h.office, port: 4747, key: () => KEY, publicDir: h.root }, () => {});
  const post = (path: string, body: unknown = {}, withKey = true) =>
    app().request(path, { method: 'POST', headers: withKey ? headers : { host: headers.host }, body: JSON.stringify(body) });

  test('need the key and map every result to its status', async () => {
    setup();
    writeTranscript();
    h.office.ingest(ev(LEAD, repo, 'Stop'));
    expect((await post(`/api/sessions/${LEAD}/relaunch`, {}, false)).status).toBe(401);
    expect((await post(`/api/sessions/${LEAD}/status`, {}, false)).status).toBe(401);

    expect((await post('/api/sessions/nope/relaunch')).status).toBe(404);
    expect((await post(`/api/sessions/${LEAD}/relaunch`, { resume: false })).status).toBe(200);
    expect(calls.at(-1)?.at(-1)).toBe(sq(join(sessionsDir, 'lead-mobile.sh')));
    const again = await post(`/api/sessions/${LEAD}/relaunch`, {});
    expect([again.status, await again.json()]).toEqual([409, { error: { key: 'hub.api.relaunchBusy' } }]);
    h.clock.advance(30_000);
    expect((await post(`/api/sessions/${LEAD}/relaunch`, {})).status).toBe(200);
    expect(calls.at(-1)?.at(-1)).toContain('--resume');

    h.clock.advance(30_000);
    tmuxReply = () => ({ code: 0, stdout: 'director\n' });
    const noWindow = await post(`/api/sessions/${LEAD}/relaunch`);
    expect([noWindow.status, await noWindow.json()]).toEqual([409, { error: { key: 'hub.api.relaunchNoWindow' } }]);
    tmuxReply = () => ({ code: 1, stdout: '' });
    expect((await post(`/api/sessions/${LEAD}/relaunch`)).status).toBe(501);
    tmuxReply = (args) => (args[0] === 'list-windows' ? { code: 0, stdout: 'lead-mobile\n' } : { code: 1, stdout: '' });
    expect((await post(`/api/sessions/${LEAD}/relaunch`)).status).toBe(502);
    rmSync(join(sessionsDir, 'lead-mobile.sh'));
    expect((await post(`/api/sessions/${LEAD}/relaunch`)).status).toBe(404);

    expect((await post('/api/sessions/nope/status')).status).toBe(404);
    expect((await post(`/api/sessions/${LEAD}/status`)).status).toBe(200);
    h.office.ingest(ev('nosock-1', repo, 'SessionStart', {}), { ...leadMeta(''), socket: null, name: 'lead-otro' });
    expect((await post('/api/sessions/nosock-1/status')).status).toBe(502);
  });
});
