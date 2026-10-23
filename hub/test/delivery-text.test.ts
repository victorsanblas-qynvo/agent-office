import { describe, expect, test } from 'bun:test';
import { PR_MAX_SUMMARY, prDraft, type PrDraftInput } from '../src/delivery-text';

const input = (over: Partial<PrDraftInput> = {}): PrDraftInput => ({
  title: 'Pantalla de login',
  brief: 'Añade la pantalla de login con Apple.',
  branch: 'encargo/login',
  base: 'develop',
  commits: ['feat(auth): login screen', 'test(auth): cover login'],
  checks: [
    { name: 'analyze', status: 'passed', durationMs: 1500 },
    { name: 'test', status: 'failed', durationMs: null },
  ],
  totals: { files: 3, adds: 40, dels: 2 },
  lang: 'es',
  ...over,
});

describe('prDraft', () => {
  test('title, every section, commits, check table and diff totals', () => {
    const { title, body } = prDraft(input());
    expect(title).toBe('Pantalla de login');
    expect(body).toContain('## Resumen\n\nAñade la pantalla de login con Apple.');
    expect(body).toContain('`encargo/login`');
    expect(body).toContain('## Commits\n\n- feat(auth): login screen\n- test(auth): cover login');
    expect(body).toContain('| Comprobación | Resultado | Duración |');
    expect(body).toContain('| analyze | verde | 1.5 s |');
    expect(body).toContain('| test | rojo | — |');
    expect(body).toContain('## Diff\n\n3 archivos, +40 −2');
  });

  test('no checks says so instead of an empty table', () => {
    const { body } = prDraft(input({ checks: [], lang: 'en' }));
    expect(body).toContain('## Checks\n\nNo checks ran');
    expect(body).not.toContain('| --- |');
  });

  test('more than 50 commits are cut with an and-N-more line', () => {
    const commits = Array.from({ length: 53 }, (_, i) => `commit ${i}`);
    const { body } = prDraft(input({ commits }));
    expect(body).toContain('- commit 49');
    expect(body).not.toContain('- commit 50');
    expect(body).toContain('- …y 3 más');
  });

  test('a long brief is trimmed', () => {
    const { body } = prDraft(input({ brief: 'x'.repeat(PR_MAX_SUMMARY + 500) }));
    expect(body).toContain(`${'x'.repeat(PR_MAX_SUMMARY)}…`);
    expect(body).not.toContain('x'.repeat(PR_MAX_SUMMARY + 1));
  });

  test('a brief cut inside a fenced block gets the fence closed; a balanced one is left alone', () => {
    const open = `${'a\n'.repeat(10)}\`\`\`ts\n${'x'.repeat(PR_MAX_SUMMARY)}`;
    const cut = prDraft(input({ brief: open })).body;
    expect(cut).toMatch(/x…\n```\n/);
    const even = `\`\`\`\ncode\n\`\`\`\n${'y'.repeat(PR_MAX_SUMMARY)}`;
    const kept = prDraft(input({ brief: even })).body;
    expect(kept).toContain('y…\n');
    expect(kept).not.toContain('```…');
    const tilde = prDraft(input({ brief: `~~~\n${'z'.repeat(PR_MAX_SUMMARY)}` })).body;
    expect(tilde).toContain('z…\n~~~\n');
    const long = prDraft(input({ brief: `\`\`\`\`md\n\`\`\`\nin\n\`\`\`\n${'w'.repeat(PR_MAX_SUMMARY)}` })).body;
    expect(long).toContain('w…\n````\n');
  });

  test('stale checks add one notice line under the heading; the total of commits wins over the list', () => {
    const { body } = prDraft(input({ staleChecksSha: 'abc1234', commitsTotal: 120, lang: 'en' }));
    expect(body).toContain('## Checks\n\n> These checks are from an earlier commit (abc1234)\n\n| Check |');
    expect(body).toContain('- …and 70 more');
    expect(prDraft(input()).body).not.toContain('>');
  });

  test('an empty brief falls back to the title; pipes in a check name are escaped', () => {
    const { body } = prDraft(input({ brief: '  ', checks: [{ name: 'a|b', status: 'passed', durationMs: 0 }] }));
    expect(body).toContain('## Resumen\n\nPantalla de login');
    expect(body).toContain('| a\\|b | verde | 0.0 s |');
  });

  test('English and Spanish headings differ', () => {
    const en = prDraft(input({ lang: 'en' })).body;
    expect(en).toContain('## Summary');
    expect(en).toContain('## Commits');
    expect(en).toContain('| Check | Result | Duration |');
    expect(en).toContain('| analyze | passed | 1.5 s |');
    expect(en).toContain('3 files, +40 −2');
    expect(en).not.toContain('## Resumen');
  });
});
