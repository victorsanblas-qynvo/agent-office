import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { percentiles, redactLog, SampleRing, tailLines } from '../src/diagnostics';
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

  test('tailLines keeps the last lines', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
  });
});

describe('GET /api/diagnostics', () => {
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
