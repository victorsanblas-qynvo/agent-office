import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server';
import { TAIL_BYTES, readTranscriptTail } from '../src/transcript-tail';
import { ev, floor, harness, makeRepo, type Harness } from './helpers';
import { projectSlug } from '../src/tokens';

const KEY = 'k'.repeat(64);
const PORT = 4747;
let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const assistant = (blocks: unknown[], ts = '2026-10-24T10:00:00.000Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks } });
const user = (blocks: unknown, ts = '2026-10-24T10:00:01.000Z') => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: blocks } });

// A session with an office role whose transcript sits where the meter looks for it.
function rig(lines: string[] | null, opts: { office?: boolean } = {}) {
  h = harness();
  const repo = makeRepo(h.root, 'repo');
  h.config.floors.mobile = floor(repo);
  const dir = join(h.root, 'claude-home', 'projects', projectSlug(repo));
  mkdirSync(dir, { recursive: true });
  if (lines) writeFileSync(join(dir, 's-1.jsonl'), lines.join('\n') + '\n');
  const meta = opts.office === false ? { role: null, name: null } : { role: 'office-lead-mobile', name: 'lead' };
  h.office.ingest(ev('s-1', repo, 'SessionStart', {}), { socket: join(h.root, 's.sock'), token: 't', ...meta });
  const app = createApp({ office: h.office, port: PORT, key: () => KEY, publicDir: h.root }, () => {});
  return async (path: string, headers: Record<string, string> = { 'x-office-key': KEY }) => {
    const res = await app.request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, ...headers } });
    const raw = await res.text();
    return { status: res.status, body: raw.startsWith('{') ? (JSON.parse(raw) as any) : raw };
  };
}

describe('transcript tail', () => {
  test('assistant text, tool_use and tool_result become plain text and thinking is left out', async () => {
    const call = rig([
      assistant([{ type: 'thinking', thinking: 'secreto interno' }, { type: 'text', text: 'Voy a leer el fichero' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }]),
      user([{ type: 'tool_result', content: [{ type: 'text', text: 'linea uno\nlinea dos\nlinea tres' }] }]),
      assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }]),
      user('hola equipo'),
    ]);
    const { status, body } = await call('/api/sessions/s-1/tail');
    expect(status).toBe(200);
    expect(body.entries.map((e: any) => [e.role, e.text])).toEqual([
      ['assistant', 'Voy a leer el fichero'],
      ['tool', 'Read: /a/b.ts'],
      ['tool', '↳ linea uno'],
      ['tool', 'Bash: bun test'],
      ['user', 'hola equipo'],
    ]);
    expect(body.entries[0].ts).toBe(Date.parse('2026-10-24T10:00:00.000Z'));
    expect(JSON.stringify(body)).not.toContain('secreto interno');
    expect(JSON.stringify(body)).not.toContain('linea dos');
  });

  test('a long text with no whitespace is redacted whole, so no fragment of a secret near the clip shows', async () => {
    const secret = ['gh', 'p_', 'Ab3dE5gH7jK9mN1pQ3sT5vX7zB9dF1hJ3kL5'].join('');
    const text = '!'.repeat(480) + secret + '!'.repeat(5000 - 480 - secret.length);
    const call = rig([assistant([{ type: 'text', text }])]);
    const { body } = await call('/api/sessions/s-1/tail');
    const shown = body.entries[0].text as string;
    expect(shown.length).toBeLessThanOrEqual(500);
    expect(shown).not.toContain(secret.slice(0, 8));
    expect(shown).not.toContain(secret.slice(-8));
  });

  test('texts are cut: 500 chars for text, 200 for a tool input and for a result line', async () => {
    const call = rig([
      assistant([{ type: 'text', text: 'x'.repeat(900) }, { type: 'tool_use', name: 'Grep', input: { pattern: 'p'.repeat(400) } }]),
      user([{ type: 'tool_result', content: 'r'.repeat(400) }]),
    ]);
    const { body } = await call('/api/sessions/s-1/tail');
    expect(body.entries[0].text).toHaveLength(500);
    expect(body.entries[1].text).toBe(`Grep: ${'p'.repeat(200)}`);
    expect(body.entries[2].text).toBe(`↳ ${'r'.repeat(200)}`);
  });

  test('n is clamped to 1..50 with 20 by default', async () => {
    const call = rig(Array.from({ length: 80 }, (_, i) => user(`m${i}`)));
    const count = async (query: string) => (await call(`/api/sessions/s-1/tail${query}`)).body.entries.length;
    expect(await count('')).toBe(20);
    expect(await count('?n=5')).toBe(5);
    expect(await count('?n=0')).toBe(1);
    expect(await count('?n=-3')).toBe(1);
    expect(await count('?n=999')).toBe(50);
    expect(await count('?n=abc')).toBe(20);
    expect((await call('/api/sessions/s-1/tail?n=3')).body.entries.map((e: any) => e.text)).toEqual(['m77', 'm78', 'm79']);
  });

  test('only the last 256 KB are read and the partial first line is dropped', async () => {
    const filler = user('z'.repeat(1000));
    const lines = Array.from({ length: Math.ceil((TAIL_BYTES * 2) / filler.length) }, () => filler);
    lines.unshift(user('muy antiguo'));
    lines.push(user('ultimo'));
    const call = rig(lines);
    const { body } = await call('/api/sessions/s-1/tail?n=50');
    expect(body.entries).toHaveLength(50);
    expect(body.entries.at(-1).text).toBe('ultimo');
    expect(body.entries.every((e: any) => e.text === 'ultimo' || e.text === 'z'.repeat(500))).toBe(true);
  });

  test('reading never goes back further than the last 256 KB', () => {
    rig([user('muy antiguo'), ...Array.from({ length: 3000 }, (_, i) => user(`m${i}`))]);
    const file = join(h!.root, 'claude-home', 'projects', projectSlug(join(h!.root, 'repo')), 's-1.jsonl');
    const all = readTranscriptTail(file, 1_000_000, KEY);
    expect(all.at(-1)!.text).toBe('m2999');
    expect(all.length).toBeLessThan(3001);
    expect(all.some((e) => e.text === 'muy antiguo')).toBe(false);
    expect(all.length * 90).toBeLessThanOrEqual(TAIL_BYTES + 90);
  });

  test('a cut line at the start of the window is not parsed as an entry', async () => {
    const big = user('z'.repeat(TAIL_BYTES + 5000));
    const call = rig([big, user('uno'), user('dos')]);
    const { body } = await call('/api/sessions/s-1/tail');
    expect(body.entries.map((e: any) => e.text)).toEqual(['uno', 'dos']);
  });

  test('a last line longer than the window is still read by going further back', async () => {
    const call = rig([user('antes'), user('z'.repeat(300 * 1024))]);
    const { body } = await call('/api/sessions/s-1/tail');
    expect(body.entries.at(-1).text).toBe('z'.repeat(500));
  });

  test('a multibyte last line longer than several windows is read whole across the chunk cuts', async () => {
    const call = rig([user('antes'), user('é'.repeat(400 * 1024))]);
    const { body } = await call('/api/sessions/s-1/tail');
    expect(body.entries.at(-1).text).toBe('é'.repeat(500));
  });

  test('a line past the 2 MB limit gives an empty tail', () => {
    rig([user('antes'), user('z'.repeat(2.5 * 1024 * 1024))]);
    const file = join(h!.root, 'claude-home', 'projects', projectSlug(join(h!.root, 'repo')), 's-1.jsonl');
    expect(readTranscriptTail(file, 5, KEY)).toEqual([]);
  });

  test('lines that are not JSON are skipped', async () => {
    const call = rig([user('antes'), '{"type":"assistant","message":', 'basura', '[1,2]', user('despues')]);
    const { body } = await call('/api/sessions/s-1/tail');
    expect(body.entries.map((e: any) => e.text)).toEqual(['antes', 'despues']);
  });

  test('keys and tokens are redacted', async () => {
    const call = rig([
      assistant([{ type: 'tool_use', name: 'Bash', input: { command: `curl -H "x-office-key: ${KEY}" -H "Authorization: Bearer abc.def" http://x` } }]),
      user([{ type: 'tool_result', content: `token ${'a1'.repeat(20)}` }]),
    ]);
    const { body } = await call('/api/sessions/s-1/tail');
    const all = JSON.stringify(body);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('abc.def');
    expect(all).not.toContain('a1'.repeat(20));
    expect(all).toContain('[redactado]');
  });

  test('a secret is redacted before the cut, so the cut cannot leave a short piece of it', async () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const call = rig([
      assistant([{ type: 'text', text: `${'x'.repeat(480)} ${secret}` }, { type: 'tool_use', name: 'Bash', input: { command: `${'y'.repeat(180)} ${secret}` } }]),
      user([{ type: 'tool_result', content: `${'z'.repeat(180)} ${secret}` }]),
      user(`${'f'.repeat(4070)} ${secret}`),
    ]);
    const { body } = await call('/api/sessions/s-1/tail');
    expect(body.entries.map((e: any) => e.text)).toEqual([
      `${'x'.repeat(480)} [redactado]`,
      `Bash: ${'y'.repeat(180)} [redactado]`,
      `↳ ${'z'.repeat(180)} [redactado]`,
      '[redactado]',
    ]);
  });

  test('a session outside the office is hidden', async () => {
    const call = rig([user('privado')], { office: false });
    const { status, body } = await call('/api/sessions/s-1/tail');
    expect(status).toBe(200);
    expect(body).toEqual({ entries: [], hidden: true });
  });

  test('an unknown session is 404 and a session without transcript is 410', async () => {
    const call = rig(null);
    const unknown = await call('/api/sessions/nada/tail');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { key: 'hub.api.sessionNotFound' } });
    const missing = await call('/api/sessions/s-1/tail');
    expect(missing.status).toBe(410);
    expect(missing.body).toEqual({ error: { key: 'hub.api.transcriptMissing' } });
  });

  test('the route needs the panel credential', async () => {
    const call = rig([user('hola')]);
    expect((await call('/api/sessions/s-1/tail', {})).status).toBe(401);
    expect((await call('/api/sessions/s-1/tail', { 'x-office-key': 'mala' })).status).toBe(401);
  });
});
