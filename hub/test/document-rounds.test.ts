import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDocsRepo } from '../src/docs-repo';
import { parseRounds } from '../src/document-rounds';
import { realPath } from '../src/floors';
import { createApp } from '../src/server';
import { git, harness, useGitIdentity, type Harness } from './helpers';

useGitIdentity();

const KEY = 'k'.repeat(64);
const PORT = 4747;
const PLAN = 'redaccion/planes/login.md';
let h: Harness;
let docs = '';
afterEach(() => h?.cleanup());

function commit(content: string, message: string): string {
  writeFileSync(join(docs, PLAN), content);
  git(docs, 'add', '--', PLAN);
  git(docs, 'commit', '-q', '-m', message);
  return git(docs, 'rev-parse', 'HEAD');
}

function setup(): string[] {
  h = harness({
    configure: (config) => {
      config.departments = { redaccion: true, mantenimiento: true };
    },
  });
  docs = realPath(join(h.root, 'docs'));
  ensureDocsRepo(docs);
  const shas = [
    commit('# Login\n\nuno\n', 'redaccion: login ronda 1'),
    commit('# Login\n\ndos\n', 'redaccion: login ronda 2'),
    commit('# Login\n\ndos\ntres\n', 'redaccion: login descartado'),
  ];
  h.office.refreshDocuments();
  return shas;
}

function api() {
  const app = createApp({ office: h.office, port: PORT, key: () => KEY, publicDir: h.root }, () => {});
  return async (path: string, authed = true) => {
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, {
      headers: { host: `127.0.0.1:${PORT}`, ...(authed ? { 'x-office-key': KEY } : {}) },
    });
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') || text.startsWith('[') ? (JSON.parse(text) as any) : {} };
  };
}

describe('document rounds', () => {
  test('lists the commits of a document newest first with the round parsed from the subject', async () => {
    const shas = setup();
    const res = await api()(`/api/documents/rounds?path=${PLAN}`);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { sha: string }) => r.sha)).toEqual([shas[2], shas[1], shas[0]]);
    expect(res.body.map((r: { round?: number }) => r.round)).toEqual([undefined, 2, 1]);
    expect(res.body[1].subject).toBe('redaccion: login ronda 2');
    expect(res.body[1].at).toBeGreaterThan(1_000_000_000_000);
  });

  test('parseRounds skips malformed lines and reads the trailing round', () => {
    const sha = 'a'.repeat(40);
    expect(parseRounds(`${sha}\x1f100\x1ftaller: x ronda 7\nbasura\n\n`)).toEqual([{ sha, at: 100_000, subject: 'taller: x ronda 7', round: 7 }]);
  });

  test('caps the history at 50 commits', async () => {
    setup();
    for (let i = 0; i < 55; i++) commit(`# Login\n\nv${i}\n`, `redaccion: login ronda ${i + 4}`);
    h.office.refreshDocuments();
    const res = await api()(`/api/documents/rounds?path=${PLAN}`);
    expect(res.body.length).toBe(50);
    expect(res.body[0].round).toBe(58);
  });

  test('diffs two rounds of the document', async () => {
    const shas = setup();
    const res = await api()(`/api/documents/rounds/diff?path=${PLAN}&from=${shas[0]?.slice(0, 7)}&to=${shas[1]}`);
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(shas[0]);
    expect(res.body.to).toBe(shas[1]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.patch).toContain('--- a/redaccion/planes/login.md');
    expect(res.body.patch).toContain('-uno');
    expect(res.body.patch).toContain('+dos');
  });

  test('truncates a patch over the cap', async () => {
    const shas = setup();
    const big = commit(`# Login\n\n${'linea larga de relleno\n'.repeat(30_000)}`, 'redaccion: login ronda 3');
    h.office.refreshDocuments();
    const res = await api()(`/api/documents/rounds/diff?path=${PLAN}&from=${shas[0]}&to=${big}`);
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.patch.length).toBeLessThanOrEqual(400 * 1024);
    expect(res.body.patch.endsWith('\n')).toBe(true);
  });

  test('an unknown path is a 404', async () => {
    const shas = setup();
    const call = api();
    expect((await call('/api/documents/rounds?path=redaccion/planes/nadie.md')).status).toBe(404);
    expect((await call('/api/documents/rounds?path=../../etc/passwd')).status).toBe(404);
    expect((await call(`/api/documents/rounds/diff?path=redaccion/planes/nadie.md&from=${shas[0]}&to=${shas[1]}`)).status).toBe(404);
  });

  test('a sha outside the history of the path or a malformed one is a 400', async () => {
    const shas = setup();
    writeFileSync(join(docs, 'README.md'), 'otro\n');
    git(docs, 'add', '--', 'README.md');
    git(docs, 'commit', '-q', '-m', 'otra cosa');
    const other = git(docs, 'rev-parse', 'HEAD');
    const call = api();
    const outside = await call(`/api/documents/rounds/diff?path=${PLAN}&from=${shas[0]}&to=${other}`);
    expect(outside.status).toBe(400);
    expect(outside.body).toEqual({ error: { key: 'hub.api.roundSha' } });
    for (const bad of ['zzzzzzz', 'abc', '--output=x', '', 'a'.repeat(41)]) {
      const res = await call(`/api/documents/rounds/diff?path=${PLAN}&from=${bad}&to=${shas[1]}`);
      expect(res.status).toBe(400);
    }
  });

  test('both routes need the panel credential', async () => {
    const shas = setup();
    const call = api();
    expect((await call(`/api/documents/rounds?path=${PLAN}`, false)).status).toBe(401);
    expect((await call(`/api/documents/rounds/diff?path=${PLAN}&from=${shas[0]}&to=${shas[1]}`, false)).status).toBe(401);
  });
});
