import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintLaunchToken, mintPanelToken, newNonce } from '../src/panel-auth';
import { createApp, startServer } from '../src/server';
import { floor, harness } from './helpers';

const KEY = 'k'.repeat(64);

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await Bun.sleep(10);
  }
}

describe('hub server', () => {
  const h = harness({ holdMs: 30_000 });
  const repo = join(h.root, 'mobile');
  const withKey = { 'X-Office-Key': KEY };
  let base = '';
  let port = 0;
  let stop = () => {};

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const openSocket = (origin: string) =>
    new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { Origin: origin } });

  beforeAll(async () => {
    mkdirSync(repo, { recursive: true });
    h.config.floors.mobile = floor(repo);
    const publicDir = join(h.root, 'public');
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(join(publicDir, 'assets'), { recursive: true });
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><html><head><title>Agent Office</title></head><body></body></html>');
    writeFileSync(join(publicDir, 'app.js'), 'console.log(1)');
    writeFileSync(join(publicDir, 'assets', 'app-12345678.js'), 'console.log(2)');
    writeFileSync(join(publicDir, 'assets', 'logo.png'), 'png');
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    ({ stop } = startServer({ office: h.office, port, key: () => KEY, publicDir }));
  });

  afterAll(() => {
    stop();
    h.cleanup();
  });

  test('a foreign Host header is refused', async () => {
    const res = await fetch(`${base}/api/state`, { headers: { ...withKey, Host: `evil.test:${port}` } });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('responses carry anti-framing and no-sniff headers', async () => {
    const cases = [
      ['/', {}],
      ['/app.js', {}],
      ['/no-existe.js', {}],
      ['/health', {}],
      ['/api/state', withKey],
    ] as const;
    for (const [path, headers] of cases) {
      const res = await fetch(`${base}${path}`, { headers });
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
    const api = await fetch(`${base}/api/state`, { headers: withKey });
    expect(api.headers.get('cache-control')).toBe('no-store');
  });

  test('requests without the key are refused', async () => {
    expect((await post('/events', { session_id: 'x', hook_event_name: 'Stop' })).status).toBe(401);
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await post('/api/orders', { sessionId: 'x', text: 'y' }, { Origin: 'https://evil.test' })).status).toBe(401);
  });

  test('hook events with the key show up in the state and get an empty answer', async () => {
    const res = await post(
      '/events',
      { session_id: 'srv-1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' },
      { ...withKey, 'X-Office-Role': 'office-lead-mobile', 'X-Office-Name': 'lead-mobile' },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    const state = (await (await fetch(`${base}/api/state`, { headers: withKey })).json()) as { agents: { key: string; name: string | null }[] };
    expect(state.agents.find((a) => a.key === 'srv-1')?.name).toBe('lead-mobile');
  });

  test('the page is served without the key and sends no referrer', async () => {
    const link = mintLaunchToken(KEY, Date.now(), newNonce());
    for (const path of ['/', `/?t=${link}`, '/index.html']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await res.text();
      expect(html).not.toContain(KEY);
      expect(html).not.toContain('__OFFICE_KEY__');
    }
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
  });

  test('only the Vite assets with a content hash are cached forever', async () => {
    const hashed = await fetch(`${base}/assets/app-12345678.js`);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const path of ['/app.js', '/assets/logo.png']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  test('static files carry an ETag and a matching If-None-Match gets a 304', async () => {
    for (const path of ['/app.js', '/assets/app-12345678.js', '/assets/logo.png']) {
      const first = await fetch(`${base}${path}`);
      const etag = first.headers.get('etag');
      expect(etag, path).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
      const again = await fetch(`${base}${path}`, { headers: { 'If-None-Match': etag ?? '' } });
      expect(again.status, path).toBe(304);
      expect(await again.text(), path).toBe('');
      expect(again.headers.get('etag'), path).toBe(etag);
    }
    const changed = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': 'W/"stale"' } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('console.log(1)');
  });

  test('a launch link is claimed once for a panel token', async () => {
    const link = mintLaunchToken(KEY, Date.now(), newNonce());
    const first = await post('/api/panel/claim', { t: link });
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    expect(token).toStartWith('p1.');
    const again = await post('/api/panel/claim', { t: link });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: { key: 'hub.api.panelLinkInvalid' } });
  });

  test('a forged, expired or foreign-host launch link gets no token', async () => {
    const forged = mintLaunchToken('f'.repeat(64), Date.now(), newNonce());
    const expired = mintLaunchToken(KEY, Date.now() - 11 * 60_000, newNonce());
    for (const t of [forged, expired, mintPanelToken(KEY, Date.now()), KEY, '']) {
      expect((await post('/api/panel/claim', { t })).status).toBe(401);
    }
    expect((await post('/api/panel/claim', 'nada')).status).toBe(401);
    const live = mintLaunchToken(KEY, Date.now(), newNonce());
    const foreign = await fetch(`${base}/api/panel/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: `evil.test:${port}` },
      body: JSON.stringify({ t: live }),
    });
    expect(foreign.status).toBe(403);
    expect((await post('/api/panel/claim', { t: live })).status).toBe(200);
  });

  test('a panel token opens the API and the socket but not the hook routes', async () => {
    const token = mintPanelToken(KEY, Date.now());
    const asPanel = { 'X-Office-Panel': token };
    expect((await fetch(`${base}/api/state`, { headers: asPanel })).status).toBe(200);
    expect((await post('/api/orders', { sessionId: 'nadie', text: 'hola' }, asPanel)).status).toBe(404);
    for (const path of ['/events', '/hook', '/guard', '/gate', '/gate-message', '/usage', '/chat', '/encargo']) {
      expect((await post(path, { session_id: 'x', hook_event_name: 'Stop' }, asPanel)).status, path).toBe(401);
      expect((await post(path, { session_id: 'x', hook_event_name: 'Stop' }, { 'X-Office-Key': token })).status, path).toBe(401);
    }
    expect((await fetch(`${base}/chat/mobile`, { headers: asPanel })).status).toBe(401);
    const ws = openSocket(base);
    const first = await new Promise<{ type: string }>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
    });
    expect(first.type).toBe('snapshot');
    ws.close();
  });

  test('a panel token signed with the previous key or expired is refused by the API and the socket', async () => {
    for (const token of [mintPanelToken('f'.repeat(64), Date.now()), mintPanelToken(KEY, Date.now() - 31 * 86_400_000)]) {
      expect((await fetch(`${base}/api/state`, { headers: { 'X-Office-Panel': token } })).status).toBe(401);
      const ws = openSocket(base);
      const code = await new Promise<number>((resolve) => {
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
        ws.onclose = (e) => resolve(e.code);
      });
      expect(code).toBe(4401);
    }
  });

  test('every /api route answers 401 without the key or a panel token', async () => {
    const app = createApp({ office: h.office, port, key: () => KEY, publicDir: join(h.root, 'public') }, () => {});
    const routes = app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL');
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const path = route.path.replace(/:[a-zA-Z]+/g, 'x');
      const res = await app.request(path, { method: route.method, headers: { host: `127.0.0.1:${port}` } });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  test('the custom character index lists only the GLB files of the custom folder', async () => {
    const custom = join(h.root, 'public', 'assets', 'characters', 'custom');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'dev.glb'), 'glb');
    writeFileSync(join(custom, 'notas.txt'), 'x');
    const res = await fetch(`${base}/assets/characters/custom/index.json`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(['dev.glb']);
  });

  test('with no custom folder the character index is empty', async () => {
    rmSync(join(h.root, 'public', 'assets', 'characters', 'custom'), { recursive: true, force: true });
    const res = await fetch(`${base}/assets/characters/custom/index.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual([]);
  });

  test('nothing outside the public folder is served', async () => {
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%zz.js`)).status).toBe(400);
  });

  test('a websocket that does not authenticate is closed with 4401', async () => {
    const ws = openSocket(base);
    const code = await new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    expect(code).toBe(4401);
  });

  test('a websocket from another origin never opens', async () => {
    const ws = openSocket('https://evil.test');
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });
    expect(opened).toBe(false);
  });

  test('an authenticated websocket gets the snapshot and its heartbeats count', async () => {
    const ws = openSocket(base);
    const first = await new Promise<{ type: string }>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: KEY }));
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
    });
    expect(first.type).toBe('snapshot');
    expect(h.office.desk.someoneWatching()).toBe(true);
    ws.send(JSON.stringify({ type: 'heartbeat', visible: true }));
    await until(() => h.office.desk.someoneWatching());
    ws.close();
  });

  test('a hidden panel keeps the desk watching until its socket closes', async () => {
    const nobodyWatching = (): boolean => {
      h.clock.advance(31_000);
      return !h.office.desk.someoneWatching();
    };
    await until(nobodyWatching);
    const ws = openSocket(base);
    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: KEY }));
      ws.onmessage = () => resolve();
    });
    ws.send(JSON.stringify({ type: 'heartbeat', visible: false }));
    h.clock.advance(31_000);
    expect(h.office.desk.someoneWatching()).toBe(true);
    ws.close();
    await until(nobodyWatching);
  });

  test('/ask holds the hook until the panel answers, and a late answer gets 409', async () => {
    await post(
      '/events',
      { session_id: 'srv-2', cwd: repo, hook_event_name: 'SessionStart' },
      { ...withKey, 'X-Office-Role': 'office-lead-mobile' },
    );
    h.office.heartbeat(true);
    const question = {
      session_id: 'srv-2',
      cwd: repo,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'srv-q1',
      tool_input: { questions: [{ question: '¿Seguimos?', options: [{ label: 'Sí' }, { label: 'No' }] }] },
    };
    const pending = post('/ask', question, withKey);
    await until(() => h.office.desk.has('srv-q1'));
    expect((await post('/api/answers/srv-q1', { answers: {} }, withKey)).status).toBe(400);
    expect((await post('/api/answers/srv-q1', { answers: { '¿Seguimos?': 'Sí' } }, withKey)).status).toBe(200);
    const decision = (await (await pending).json()) as { hookSpecificOutput: { updatedInput: { answers: Record<string, string> } } };
    expect(decision.hookSpecificOutput.updatedInput.answers['¿Seguimos?']).toBe('Sí');
    expect((await post('/api/answers/srv-q1', { answers: { '¿Seguimos?': 'No' } }, withKey)).status).toBe(409);
  });

  test('a question leaves the panel when its hook gives up and closes the connection', async () => {
    h.office.heartbeat(true);
    const controller = new AbortController();
    const pending = fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...withKey },
      body: JSON.stringify({
        session_id: 'srv-2',
        cwd: repo,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'srv-q-abort',
        tool_input: { questions: [{ question: '¿Abandono?', options: [{ label: 'Sí' }] }] },
      }),
      signal: controller.signal,
    }).catch(() => null);
    await until(() => h.office.desk.has('srv-q-abort'));
    controller.abort();
    await pending;
    await until(() => !h.office.desk.has('srv-q-abort'));
    expect(h.office.snapshot().questions.map((q) => q.id)).not.toContain('srv-q-abort');
  });

  test('the panel can return a pending question to the terminal', async () => {
    await post(
      '/events',
      { session_id: 'srv-rel', cwd: repo, hook_event_name: 'SessionStart' },
      { ...withKey, 'X-Office-Role': 'office-lead-mobile' },
    );
    h.office.heartbeat(true);
    const pending = post(
      '/ask',
      {
        session_id: 'srv-rel',
        cwd: repo,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'srv-q-release',
        tool_input: { questions: [{ question: '¿Lo devuelvo?', options: [{ label: 'Sí' }, { label: 'No' }] }] },
      },
      withKey,
    );
    await until(() => h.office.desk.has('srv-q-release'));

    const released = await post('/api/answers/srv-q-release', { release: true }, withKey);
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ ok: true });

    // The hook sees a 200 with an empty body: the question goes back to the terminal.
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('');

    // A second release finds nothing to return.
    expect((await post('/api/answers/srv-q-release', { release: true }, withKey)).status).toBe(409);
    expect(h.office.snapshot().questions.map((q) => q.id)).not.toContain('srv-q-release');
  });

  test('/ask answers at once with an empty body when nobody watches', async () => {
    h.clock.advance(60_000);
    const res = await post(
      '/ask',
      {
        session_id: 'srv-2',
        cwd: repo,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'srv-q2',
        tool_input: { questions: [{ question: '¿Otra?', options: [{ label: 'Sí' }] }] },
      },
      withKey,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  test('/permission holds the hook until the panel allows it', async () => {
    h.office.heartbeat(true);
    const pending = post(
      '/permission',
      {
        session_id: 'srv-2',
        cwd: repo,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_use_id: 'srv-p1',
        tool_input: { command: 'bun run hub' },
      },
      withKey,
    );
    await until(() => h.office.snapshot().questions.some((q) => q.kind === 'permission'));
    const question = h.office.snapshot().questions.find((q) => q.kind === 'permission')!;
    expect(question.detail).toBe('bun run hub');
    expect((await post(`/api/answers/${question.id}`, { answers: { [question.questions[0]!.question]: 'Permitir' } }, withKey)).status).toBe(200);
    const decision = (await (await pending).json()) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(decision.hookSpecificOutput.decision.behavior).toBe('allow');
  });

  test('/permission answers at once with an empty body when the event is not a permission request', async () => {
    const res = await post(
      '/permission',
      { session_id: 'srv-2', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      withKey,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  test('/gate answers pass or block as plain text', async () => {
    const res = await post('/gate', { session_id: 'srv-3', cwd: repo, hook_event_name: 'TaskCompleted', task_id: '1' }, withKey);
    expect(await res.text()).toBe('pass');
  });

  test('/gate-message lets normal messages through', async () => {
    const res = await post(
      '/gate-message',
      { session_id: 'srv-1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'director', message: 'hola' } },
      withKey,
    );
    expect(await res.text()).toBe('pass');
  });

  test('/encargo authenticates the caller token and answers the script orders as plain text', async () => {
    const agent = { ...withKey, 'X-Office-Token': 'tok-encargo', 'X-Office-Role': 'office-lead-mobile', 'X-Office-Name': 'lead-mobile' };
    expect((await post('/events', { session_id: 'srv-encargo', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, agent)).status).toBe(200);

    const form = (fields: Record<string, string>) =>
      fetch(`${base}/encargo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...agent },
        body: new URLSearchParams(fields),
      });

    const estado = await form({ order: 'estado', cwd: repo, slug: '', reason: '' });
    expect(estado.status).toBe(200);
    expect(await estado.text()).toBe('No hay encargos abiertos en esta planta.\n');

    // The same fields as JSON take the same path.
    const asJson = await post('/encargo', { order: 'estado', cwd: repo }, agent);
    expect(asJson.status).toBe(200);
    expect(await asJson.text()).toBe('No hay encargos abiertos en esta planta.\n');

    const none = await form({ order: 'carpeta', cwd: repo, slug: '', reason: '' });
    expect(none.status).toBe(404);
    expect(await none.text()).toBe('ERROR: no hay ningún encargo abierto en esta planta.\n');

    const outside = await form({ order: 'estado', cwd: join(h.root, 'fuera'), slug: '', reason: '' });
    expect(outside.status).toBe(404);
    expect(await outside.text()).toContain('no es de ninguna planta gestionada por la oficina.');

    const noToken = await fetch(`${base}/encargo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...withKey },
      body: new URLSearchParams({ order: 'estado', cwd: repo }),
    });
    expect(noToken.status).toBe(403);
    expect(await noToken.text()).toContain('no reconozco tu sesión');
  });

  test('/api/orders validates its input', async () => {
    expect((await post('/api/orders', { sessionId: 'srv-1' }, withKey)).status).toBe(400);
    expect((await post('/api/orders', { sessionId: 'nope', text: 'hola' }, withKey)).status).toBe(404);
    expect((await post('/api/orders', { sessionId: 'srv-1', text: 'hola' }, withKey)).status).toBe(502);
  });
});
