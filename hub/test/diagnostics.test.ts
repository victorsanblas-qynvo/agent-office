import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_TAIL_BYTES, percentiles, redactLog, SampleRing, tailLines } from '../src/diagnostics';
import { createApp } from '../src/server';
import { harness, type Harness } from './helpers';

const KEY = 'k'.repeat(64);
const PORT = 4747;
let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe('percentiles', () => {
  test('no samples gives null for every point', () => {
    expect(percentiles([], [50, 95, 99])).toEqual([null, null, null]);
  });

  test('one sample is every percentile', () => {
    expect(percentiles([7], [50, 95, 99])).toEqual([7, 7, 7]);
  });

  test('many samples use nearest rank, unsorted input', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentiles(samples, [50, 95, 99])).toEqual([50, 95, 99]);
  });
});

describe('SampleRing', () => {
  test('wraps at its capacity and keeps the latest samples', () => {
    const ring = new SampleRing(500);
    for (let i = 1; i <= 650; i++) ring.record(i);
    expect(ring.count).toBe(500);
    const samples = ring.samples();
    expect(samples).toHaveLength(500);
    expect(Math.min(...samples)).toBe(151);
    expect(Math.max(...samples)).toBe(650);
  });
});

describe('redaction', () => {
  test('hides the key, the key header, bearer tokens and long hex runs', () => {
    const text = [`key ${KEY} used`, 'x-office-key: abc123', 'Authorization: Bearer tok.en-1', `sha ${'a1'.repeat(20)}`, 'plain line'].join('\n');
    const out = redactLog(text, KEY);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('tok.en-1');
    expect(out).not.toContain('a1a1a1a1');
    expect(out).toContain('plain line');
    expect(out).toContain('[redactado]');
  });

  test('hides short password-like values but keeps their keys', () => {
    const text = ['password=hunter2', 'DB_PASSWORD: s3cr3t', '"api_key":"abc"', 'apiKey = xyz', 'token=t1 secret=s1', 'auth: a1', 'pwd=p1', 'passwd=p2', 'pass=p3'].join('\n');
    const out = redactLog(text, KEY).split('\n');
    expect(out).toEqual([
      'password=[redactado]',
      'DB_PASSWORD: [redactado]',
      '"api_key":[redactado]',
      'apiKey = [redactado]',
      'token=[redactado] secret=[redactado]',
      'auth: [redactado]',
      'pwd=[redactado]',
      'passwd=[redactado]',
      'pass=[redactado]',
    ]);
  });

  test('hides a mysql -p password and the credentials of a url', () => {
    expect(redactLog('mysql -u root -phunter2 app', KEY)).toBe('mysql -u root -p[redactado] app');
    expect(redactLog('mysqldump -h db -P3306 -psecret app', KEY)).toBe('mysqldump -h db -P3306 -p[redactado] app');
    expect(redactLog('rm -print', KEY)).toBe('rm -print');
    expect(redactLog('clone https://bob:hunter2@github.com/o/r.git', KEY)).toBe('clone https://[redactado]@github.com/o/r.git');
    expect(redactLog('db postgres://app:p@ss@db:5432/x', KEY)).toBe('db postgres://[redactado]@db:5432/x');
    expect(redactLog('see http://localhost:4747/api and git@github.com:o/r', KEY)).toBe('see http://localhost:4747/api and git@github.com:o/r');
  });

  test('keeps long paths readable', () => {
    const path = '/Users/someone/Projects/agent-office/hub/src/delivery2-desk.ts';
    expect(redactLog(`at ${path}:12`, KEY)).toBe(`at ${path}:12`);
    expect(redactLog('blob QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA', KEY)).toBe('blob [redactado]');
  });

  test('hides base64 secrets with slashes, prefixed key names, Basic credentials, --password and PEM blocks', () => {
    const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const appKey = 'Ab3/dEf9+gH1jK2lM3nO4pQ5rS6tU7vW8xY9zA0bC1d=';
    const text = [
      `AWS_SECRET_ACCESS_KEY=${aws}`,
      `APP_KEY=base64:${appKey}`,
      'SECRET_KEY=s3cr3tvalue',
      'PRIVATE_KEY=abc',
      'Authorization: Basic dXNlcjpwYXNz',
      'run --password hunter2 --verbose',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234/abcd+efgh\n-----END RSA PRIVATE KEY-----',
      `bare ${aws}`,
      'Basic usage of the tool',
    ].join('\n');
    const out = redactLog(text, KEY);
    for (const leaked of [aws, appKey, 's3cr3tvalue', 'dXNlcjpwYXNz', 'hunter2', 'MIIEowIBAAKCAQEA', '=abc']) expect(out).not.toContain(leaked);
    expect(out).toContain('AWS_SECRET_ACCESS_KEY=[redactado]');
    expect(out).toContain('SECRET_KEY=[redactado]');
    expect(out).toContain('--verbose');
    expect(out).toContain('Basic usage of the tool');
    expect(out).not.toContain('-----BEGIN');
  });

  test('hides credentials behind an auth scheme, quoted values, curl -u and a PEM block without its END line', () => {
    const cases: [string, string][] = [
      ['authorization: basic dXNlcjpwYXNz', 'authorization: [redactado]'],
      ['Authorization: Token abc123def', 'Authorization: [redactado]'],
      ['-H "Authorization: Digest abc123"', '-H "Authorization: [redactado]'],
      ['DB_PASSWORD="my secret" next', 'DB_PASSWORD=[redactado] next'],
      ["pwd: 'two words' x", 'pwd: [redactado] x'],
      ['config: token=abc', 'config: token=[redactado]'],
      ['env=PASSWORD=x', 'env=PASSWORD=[redactado]'],
      ['curl -u admin:hunter2 https://x', 'curl -u [redactado] https://x'],
      ['curl --user admin:pw x', 'curl --user [redactado] x'],
      ['curl --user=admin:pw x', 'curl --user=[redactado] x'],
      ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAAAAABAAABlwAAAAdzc2gtcn\nnext line', '[redactado]\nnext line'],
      ['git push -u origin main', 'git push -u origin main'],
      ['password=\nnext line', 'password=\nnext line'],
      ['a basic understanding of Basic Authentication', 'a basic understanding of Basic Authentication'],
    ];
    for (const [text, expected] of cases) expect(redactLog(text, KEY)).toBe(expected);
  });

  test('keeps real paths readable and still hides base64 secrets that carry slashes', () => {
    const kept = [
      '/Users/v/.claude/worktrees/office-fix-login-a1b2/lib/a.dart',
      '~/Projects/agent-office/hub/src/delivery2-desk.ts:12',
      'ui/src/components/session-panel2.model.ts',
      '/Users/Someone/Library/Caches/com.app2/data/file9.json',
      'v1.2.3-some-long-package-name.with.dots2.tar.gz',
    ];
    for (const path of kept) expect(redactLog(`at ${path}`, KEY)).toBe(`at ${path}`);
    const SLACK_HOOK = ['https://hooks', 'slack', 'com/services/T0ABCD123/B0ABCD123'].join('.');
    const hidden: [string, string][] = [
      ['bare wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'bare [redactado]'],
      ['APP_KEY=base64:Ab3/dEf9+gH1jK2lM3nO4pQ5rS6tU7vW8xY9zA0bC1d=', 'APP_KEY=base64:[redactado]'],
      [`${SLACK_HOOK}/abcdEFGHijkl7NOPqrstUVWX`, `${SLACK_HOOK}/[redactado]`],
      [`export GITHUB_TOKEN ${'gh' + 'p_'}abcdefghijklmnop1234567890ABCDEFGH`, 'export GITHUB_TOKEN [redactado]'],
    ];
    for (const [text, expected] of hidden) expect(redactLog(text, KEY)).toBe(expected);
  });

  test('stays linear on long runs that look like the start of a key', () => {
    const inputs = ['token'.repeat(2000), 'a'.repeat(64 * 1024), 'a.'.repeat(32 * 1024), 'mysql '.repeat(10_000), '-----BEGIN A-----\n'.repeat(3000), `${'a'.repeat(127)} `.repeat(500)];
    for (const input of inputs) {
      const start = performance.now();
      redactLog(input, KEY);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  test('tailLines keeps the last lines', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
  });
});

describe('GET /api/diagnostics', () => {
  test('reads only the end of a big log', async () => {
    h = harness();
    const logFile = join(h.root, 'hub.log');
    mkdirSync(h.root, { recursive: true });
    const filler = `${'x '.repeat(40)}\n`;
    const lines = Array.from({ length: Math.ceil((LOG_TAIL_BYTES * 20) / filler.length) }, (_, i) => `${i} ${filler}`);
    writeFileSync(logFile, `antiguo\n${lines.join('')}ultimo password=hunter2\n`);
    const app = createApp({ office: h.office, port: PORT, key: () => KEY, publicDir: h.root, logFile }, () => {});
    const response = await app.request(`http://127.0.0.1:${PORT}/api/diagnostics`, { headers: { host: `127.0.0.1:${PORT}`, 'x-office-key': KEY } });
    const body = (await response.json()) as Record<string, any>;
    expect(body.logTail).toHaveLength(50);
    expect(body.logTail.at(-1)).toBe('ultimo password=[redactado]');
    expect(body.logTail).not.toContain('antiguo');
  });

  test('answers the shape with a redacted log tail and rejects a missing credential', async () => {
    h = harness();
    const logFile = join(h.root, 'hub.log');
    mkdirSync(h.root, { recursive: true });
    writeFileSync(logFile, `one\nBearer secret-token\n${KEY}\n`);
    const app = createApp({ office: h.office, port: PORT, key: () => KEY, publicDir: h.root, logFile }, () => {});
    const headers = { host: `127.0.0.1:${PORT}`, 'x-office-key': KEY };
    await app.request(`http://127.0.0.1:${PORT}/hook`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    const ok = await app.request(`http://127.0.0.1:${PORT}/api/diagnostics`, { headers });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(['activeCheckRuns', 'dbBytes', 'fts', 'hook', 'logTail', 'schema', 'sessions', 'uptimeMs', 'version', 'worktrees']);
    expect(body.dbBytes).toBeNull();
    expect(body.hook.count).toBe(1);
    expect(typeof body.hook.p99).toBe('number');
    expect(body.logTail.join('\n')).not.toContain('secret-token');
    expect(body.logTail.join('\n')).not.toContain(KEY);
    const denied = await app.request(`http://127.0.0.1:${PORT}/api/diagnostics`, { headers: { host: `127.0.0.1:${PORT}` } });
    expect(denied.status).toBe(401);
  });
});
