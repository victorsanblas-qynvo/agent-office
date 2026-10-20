import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR, SCRIPTS_DIR } from '../src/config';
import { tempDir } from './helpers';

const HOOK = join(PLUGIN_DIR, 'hooks', 'office-hook.sh');
const KEY = 'hook-test-key';
const SCRIPTS = [HOOK, join(SCRIPTS_DIR, 'office-sync.sh'), join(SCRIPTS_DIR, 'office-statusline.sh'), join(SCRIPTS_DIR, 'office-chat.sh'), join(SCRIPTS_DIR, 'office-encargo.sh')];

type Seen = { path: string; headers: Record<string, string>; body: string };

function spawnHook(args: string[], home: string, stdin: string, env: Record<string, string> = {}) {
  return Bun.spawn(['sh', HOOK, ...args], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '', AGENT_OFFICE_ROLE: '', AGENT_OFFICE_NAME: '', AGENT_OFFICE_HOME: home, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function runHook(args: string[], home: string, stdin: string, env: Record<string, string> = {}) {
  const started = Date.now();
  const proc = spawnHook(args, home, stdin, env);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, ms: Date.now() - started };
}

async function runScript(script: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(['sh', join(SCRIPTS_DIR, script), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

async function runScriptWithErr(script: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(['sh', join(SCRIPTS_DIR, script), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_CODE_MESSAGING_TOKEN: '', ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await Bun.sleep(5);
  }
}

describe('office-hook.sh', () => {
  const { dir, cleanup } = tempDir();
  const home = join(dir, 'home');
  const keyOnly = join(dir, 'key-only');
  const downHome = join(dir, 'down');
  const tmp = join(dir, 'tmp');
  const seen: Seen[] = [];
  let hookAnswer = 'pass';
  let gateAnswer = 'pass';
  let encargoStatus = 200;
  let syncStatus = 200;
  let delayMs = 0;
  let holdAsk = false;
  const aborted: boolean[] = [];
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 30,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
        if (delayMs > 0) await Bun.sleep(delayMs);
        if (path === '/ask' && holdAsk) {
          await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()));
          aborted.push(req.signal.aborted);
          return new Response(null);
        }
        if (path === '/hook') return new Response(hookAnswer);
        if (path === '/gate-message') return new Response(gateAnswer);
        if (path === '/ask') return new Response('{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}');
        if (path === '/chat') return new Response('enviado #1\n');
        if (path === '/encargo') return new Response(encargoStatus === 200 ? 'encargo/login-a1b2 → /r/.claude/worktrees/office-login-a1b2\n' : 'ERROR: no hay ningún encargo abierto', { status: encargoStatus });
        if (path === '/api/redaccion/sync') return new Response(syncStatus === 200 ? 'fuentes listas\n' : 'ERROR: la planta mobile no existe\n', { status: syncStatus });
        if (path === '/permission') return new Response('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
        return new Response(null, { status: 404 });
      },
    });
    for (const d of [home, keyOnly, downHome, tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'key'), `${KEY}\n`);
    writeFileSync(join(home, 'headers'), `X-Office-Key: ${KEY}\n`);
    writeFileSync(join(home, 'port'), String(server.port));
    writeFileSync(join(keyOnly, 'key'), `${KEY}\n`);
    writeFileSync(join(keyOnly, 'port'), `${server.port}\n`);
    writeFileSync(join(downHome, 'headers'), `X-Office-Key: ${KEY}\n`);
    writeFileSync(join(downHome, 'port'), '1\n');
  });

  afterAll(() => {
    server.stop(true);
    cleanup();
  });

  test('without the headers file it does nothing and sends nothing, even with a key', async () => {
    const before = seen.length;
    expect(await runHook([], keyOnly, '{"hook_event_name":"Stop"}')).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await runHook(['ask'], keyOnly, '{}')).toMatchObject({ code: 0, stdout: '' });
    expect(seen.length).toBe(before);
  });

  test('with the hub down it exits 0 at once with no output', async () => {
    const result = await runHook([], downHome, '{"hook_event_name":"PreToolUse","tool_name":"Write"}');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(1000);
    expect(readdirSync(downHome).sort()).toEqual(['headers', 'port']);
  });

  test('a port file without a final newline still reaches the hub', async () => {
    hookAnswer = 'pass';
    await runHook([], home, '{"hook_event_name":"Stop","session_id":"s-0"}');
    expect(seen.at(-1)?.path).toBe('/hook');
  });

  test('the event goes to /hook with key, socket, token, role and name, and the body as given', async () => {
    const event = '{"hook_event_name":"SessionStart","session_id":"s-1"}';
    const result = await runHook([], home, event, {
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1',
      AGENT_OFFICE_ROLE: 'office-lead-mobile',
      AGENT_OFFICE_NAME: 'lead-mobile',
    });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const request = seen.at(-1)!;
    expect(request.path).toBe('/hook');
    expect(request.body).toBe(event);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-office-key']).toBe(KEY);
    expect(request.headers['x-office-socket']).toBe('/tmp/cc-socks/1.sock');
    expect(request.headers['x-office-token']).toBe('tok-1');
    expect(request.headers['x-office-role']).toBe('office-lead-mobile');
    expect(request.headers['x-office-name']).toBe('lead-mobile');
  });

  test('without a messaging token the request carries no token header', async () => {
    await runHook([], home, '{"hook_event_name":"Stop","session_id":"s-1"}');
    expect(seen.at(-1)?.headers).not.toHaveProperty('x-office-token');
    expect(seen.at(-1)?.headers['x-office-key']).toBe(KEY);
  });

  test('pass prints only what the hub sends after it: memory, chat reminder or a read denial', async () => {
    hookAnswer = 'pass\n{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"Lecciones"}}';
    const started = await runHook([], home, '{"hook_event_name":"SubagentStart","session_id":"s-1"}');
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout).hookSpecificOutput.additionalContext).toBe('Lecciones');
    hookAnswer = 'pass\n{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"no has anunciado lib/a.dart"}}';
    const edit = await runHook([], home, '{"hook_event_name":"PreToolUse","tool_name":"Edit","session_id":"s-1"}');
    expect(edit).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(edit.stdout).hookSpecificOutput.additionalContext).toBe('no has anunciado lib/a.dart');
    hookAnswer = 'pass\n{"hookSpecificOutput":{}}';
    expect((await runHook([], home, '{"hook_event_name":"PreToolUse","tool_name":"Read"}')).stdout).toBe('{"hookSpecificOutput":{}}\n');
    hookAnswer = 'pass';
    expect(await runHook([], home, '{"hook_event_name":"Stop"}')).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  test('block: exits 2 with the reason on stderr and nothing on stdout', async () => {
    hookAnswer = 'block:Guardia de Agent Office: Redacción solo escribe dentro de /docs/redaccion.';
    const blocked = await runHook([], home, '{"hook_event_name":"PreToolUse","tool_name":"Write"}', { AGENT_OFFICE_ROLE: 'office-lead-redaccion' });
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr.trim()).toBe('Guardia de Agent Office: Redacción solo escribe dentro de /docs/redaccion.');
    expect(seen.at(-1)?.headers['x-office-role']).toBe('office-lead-redaccion');
    hookAnswer = 'pass';
  });

  test('a PreToolUse of Edit makes exactly one request, to /hook', async () => {
    const before = seen.length;
    await runHook([], home, '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/a.ts"}}');
    expect(seen.slice(before).map((s) => s.path)).toEqual(['/hook']);
  });

  test('the old emit, gate and guard scripts forward to their endpoints for sessions started before the single hook', async () => {
    const legacy = (script: string, args: string[], stdin: string) =>
      Bun.spawn(['sh', join(PLUGIN_DIR, 'hooks', script), ...args], {
        stdin: new TextEncoder().encode(stdin),
        env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '', AGENT_OFFICE_ROLE: '', AGENT_OFFICE_NAME: '', AGENT_OFFICE_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
    const event = '{"hook_event_name":"Stop"}';
    expect(await legacy('emit.sh', ['events'], event)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/events', body: event });
    expect(await legacy('gate.sh', ['gate-message'], event)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/gate-message', body: event });
    expect(await legacy('gate.sh', ['gate'], event)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/gate', body: event });
    expect(await legacy('guard.sh', [], event)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/guard', body: event });
  });

  test('ask, permission and gate-message keep their own endpoints and send the event untouched', async () => {
    const ask = '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}';
    const asked = await runHook(['ask'], home, ask);
    expect(asked.code).toBe(0);
    expect(asked.stdout.trim()).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}');
    expect(seen.at(-1)).toMatchObject({ path: '/ask', body: ask });
    const permission = '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}';
    const allowed = await runHook(['permission'], home, permission);
    expect(JSON.parse(allowed.stdout).hookSpecificOutput.decision.behavior).toBe('allow');
    expect(seen.at(-1)).toMatchObject({ path: '/permission', body: permission });
    gateAnswer = 'block:Falta tester';
    const message = '{"hook_event_name":"PreToolUse","tool_name":"SendMessage"}';
    const gated = await runHook(['gate-message'], home, message);
    expect(gated.code).toBe(2);
    expect(gated.stderr.trim()).toBe('Falta tester');
    expect(seen.at(-1)).toMatchObject({ path: '/gate-message', body: message });
    gateAnswer = 'pass';
    expect((await runHook(['gate-message'], home, message)).code).toBe(0);
  });

  test('TaskCompleted goes to /hook and exits 2 when the gate blocks', async () => {
    hookAnswer = 'block:Falta tester: pide al tester que pruebe.';
    const event = '{"hook_event_name":"TaskCompleted","task_id":"1"}';
    const result = await runHook([], home, event);
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe('Falta tester: pide al tester que pruebe.');
    expect(seen.at(-1)).toMatchObject({ path: '/hook', body: event });
    hookAnswer = 'pass';
    expect((await runHook([], home, event)).code).toBe(0);
  });

  test('the session headers live in a private file of the office folder only while the hook runs', async () => {
    delayMs = 300;
    const proc = spawnHook([], home, '{"hook_event_name":"Stop"}', { CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1', TMPDIR: tmp });
    const session = join(home, `hook.${proc.pid}`);
    await until(() => existsSync(session) && existsSync(`${session}.out`));
    expect(statSync(session).mode & 0o777).toBe(0o600);
    expect(statSync(`${session}.out`).mode & 0o777).toBe(0o600);
    expect(readFileSync(session, 'utf8')).toContain('X-Office-Token: tok-1\n');
    expect(await proc.exited).toBe(0);
    delayMs = 0;
    expect(readdirSync(home).sort()).toEqual(['headers', 'key', 'port']);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('SIGTERM while the hub holds the request ends the hook, its curl and its files at once', async () => {
    holdAsk = true;
    const proc = spawnHook(['ask'], home, '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}');
    await until(() => existsSync(join(home, `hook.${proc.pid}`)) && seen.at(-1)?.path === '/ask');
    const started = Date.now();
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    await until(() => aborted.length > 0);
    expect(aborted).toEqual([true]);
    expect(readdirSync(home).filter((name) => name.startsWith('hook.'))).toEqual([]);
    holdAsk = false;
  });

  test('office-chat.sh sends the key from headers and the messaging token from a private file it removes', async () => {
    const chat = (env: Record<string, string>) =>
      runScript('office-chat.sh', ['mobile', 'di', 'hola'], { CLAUDE_CODE_MESSAGING_TOKEN: '', AGENT_OFFICE_ROLE: 'office-dev-mobile', AGENT_OFFICE_NAME: 'dev-mobile', AGENT_OFFICE_HOME: home, ...env });
    expect(await chat({ CLAUDE_CODE_MESSAGING_TOKEN: 'tok-chat' })).toEqual({ stdout: 'enviado #1\n', code: 0 });
    expect(seen.at(-1)?.path).toBe('/chat');
    expect(seen.at(-1)?.headers['x-office-key']).toBe(KEY);
    expect(seen.at(-1)?.headers['x-office-token']).toBe('tok-chat');
    expect(seen.at(-1)?.headers['x-office-name']).toBe('dev-mobile');
    expect((await chat({})).code).toBe(0);
    expect(seen.at(-1)?.headers).not.toHaveProperty('x-office-token');
    expect(readdirSync(home).sort()).toEqual(['headers', 'key', 'port']);
    expect((await chat({ AGENT_OFFICE_HOME: keyOnly })).code).toBe(69);
  });

  test('office-encargo.sh posts the order as a form with the key from headers and the token from a private file it removes', async () => {
    const encargo = (args: string[], env: Record<string, string> = {}) =>
      runScriptWithErr('office-encargo.sh', args, { CLAUDE_CODE_MESSAGING_TOKEN: 'tok-encargo', AGENT_OFFICE_ROLE: 'office-lead-mobile', AGENT_OFFICE_NAME: 'lead-mobile', AGENT_OFFICE_HOME: home, ...env });
    const ok = await encargo(['carpeta']);
    expect(ok).toMatchObject({ stdout: 'encargo/login-a1b2 → /r/.claude/worktrees/office-login-a1b2\n', code: 0 });
    const seenNow = seen.at(-1);
    expect(seenNow?.path).toBe('/encargo');
    expect(seenNow?.headers['x-office-key']).toBe(KEY);
    expect(seenNow?.headers['x-office-token']).toBe('tok-encargo');
    expect(seenNow?.headers['x-office-name']).toBe('lead-mobile');
    const form = new URLSearchParams(seenNow?.body);
    expect(Object.fromEntries(form.entries())).toMatchObject({ order: 'carpeta', slug: '', reason: '' });
    expect(form.get('cwd')).toBeTruthy();

    await encargo(['comprobar', 'encargo/login-a1b2']);
    expect(new URLSearchParams(seen.at(-1)?.body).get('slug')).toBe('encargo/login-a1b2');
    await encargo(['descartar', 'login-a1b2', 'ya', 'no', 'hace', 'falta']);
    expect(Object.fromEntries(new URLSearchParams(seen.at(-1)?.body).entries())).toMatchObject({ order: 'descartar', slug: 'login-a1b2', reason: 'ya no hace falta' });
    await encargo(['estado']);
    expect(new URLSearchParams(seen.at(-1)?.body).get('order')).toBe('estado');

    await encargo(['carpeta'], { CLAUDE_CODE_MESSAGING_TOKEN: '' });
    expect(seen.at(-1)?.headers).not.toHaveProperty('x-office-token');
    expect(readdirSync(home).sort()).toEqual(['headers', 'key', 'port']);
  });

  test('office-encargo.sh prints the error of the hub to stderr and exits 1, and checks its arguments before calling', async () => {
    const calls = seen.length;
    expect((await runScriptWithErr('office-encargo.sh', ['nada'], { AGENT_OFFICE_HOME: home })).code).toBe(64);
    expect((await runScriptWithErr('office-encargo.sh', ['descartar', 'solo-slug'], { AGENT_OFFICE_HOME: home })).code).toBe(64);
    expect((await runScriptWithErr('office-encargo.sh', ['carpeta', 'a;b'], { AGENT_OFFICE_HOME: home })).code).toBe(64);
    expect((await runScriptWithErr('office-encargo.sh', ['estado', 'sobra'], { AGENT_OFFICE_HOME: home })).code).toBe(64);
    expect((await runScriptWithErr('office-encargo.sh', ['carpeta'], { AGENT_OFFICE_HOME: keyOnly })).code).toBe(69);
    expect(seen.length).toBe(calls);
    encargoStatus = 404;
    const refused = await runScriptWithErr('office-encargo.sh', ['carpeta'], { AGENT_OFFICE_HOME: home });
    encargoStatus = 200;
    expect(refused).toMatchObject({ stdout: '', stderr: 'ERROR: no hay ningún encargo abierto', code: 1 });
  });

  test('office-sync.sh sends the key from headers and refuses to run without them', async () => {
    const sync = (dir: string) => runScript('office-sync.sh', ['login', 'mobile'], { AGENT_OFFICE_HOME: dir });
    expect(await sync(home)).toEqual({ stdout: 'fuentes listas\n', code: 0 });
    expect(seen.at(-1)).toMatchObject({ path: '/api/redaccion/sync', body: '{"slug":"login","floors":["mobile"]}' });
    expect(seen.at(-1)?.headers['x-office-key']).toBe(KEY);
    expect((await sync(keyOnly)).code).toBe(69);
  });

  test('office-sync.sh prints the hub error to stderr and exits 1', async () => {
    syncStatus = 400;
    const failed = await runScriptWithErr('office-sync.sh', ['login', 'mobile'], { AGENT_OFFICE_HOME: home });
    syncStatus = 200;
    expect(failed).toEqual({ stdout: '', stderr: 'ERROR: la planta mobile no existe\n', code: 1 });
  });

  test('a stale answer file left by a killed hook with the same pid is never printed', async () => {
    hookAnswer = '';
    const proc = spawnHook([], home, '{"hook_event_name":"Stop"}');
    writeFileSync(join(home, `hook.${proc.pid}.out`), 'block:viejo');
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect({ stdout, code }).toEqual({ stdout: '', code: 0 });
    hookAnswer = 'pass';
  });
});

describe('plugin command lines', () => {
  test('no script passes the key or the messaging token as an argument', () => {
    for (const file of SCRIPTS) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('X-Office-Key: $(');
      expect(source, file).not.toContain('X-Office-Token: $');
      expect(source, file).toContain('-H @"$dir/headers"');
    }
    const found = Bun.spawnSync(['grep', '-rn', 'X-Office-Key: $(cat', PLUGIN_DIR]);
    expect(found.exitCode).toBe(1);
    expect(found.stdout.toString()).toBe('');
  });

  test('hooks.json runs office-hook.sh for all 17 commands and the old hooks only forward to it', () => {
    const raw = readFileSync(join(PLUGIN_DIR, 'hooks', 'hooks.json'), 'utf8');
    const commands = [...raw.matchAll(/"command": "(.*)"/g)].map((m) => m[1] ?? '');
    expect(commands).toHaveLength(17);
    for (const command of commands) expect(command).toMatch(/^\\"\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/office-hook\.sh\\"( (ask|permission|gate-message))?$/);
    expect(commands.filter((c) => c.endsWith(' ask'))).toHaveLength(1);
    expect(commands.filter((c) => c.endsWith(' permission'))).toHaveLength(1);
    expect(commands.filter((c) => c.endsWith(' gate-message'))).toHaveLength(1);
    expect(readdirSync(join(PLUGIN_DIR, 'hooks')).sort()).toEqual(['emit.sh', 'gate.sh', 'guard.sh', 'hooks.json', 'office-hook.sh']);
    for (const legacy of ['emit.sh', 'gate.sh', 'guard.sh']) {
      const body = readFileSync(join(PLUGIN_DIR, 'hooks', legacy), 'utf8');
      expect(body).toContain('office-hook.sh');
      expect(body).not.toContain('X-Office-Key');
      expect(body.split('\n').filter((line) => line.trim() !== '')).toHaveLength(2);
    }
    expect(statSync(join(PLUGIN_DIR, 'hooks', 'office-hook.sh')).mode & 0o111).not.toBe(0);
  });
});
