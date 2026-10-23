import { describe, expect, test } from 'bun:test';
import { bytesText, diagnosticsMarkdown, msText, uptimeText } from '../src/settings/diagnostics-model';

const decimal = (value: number): string => String(Math.round(value * 10) / 10);

describe('diagnostics formatting', () => {
  test('bytes are humanized', () => {
    expect(bytesText(null, decimal)).toBe('—');
    expect(bytesText(512, decimal)).toBe('512 B');
    expect(bytesText(1536, decimal)).toBe('1.5 KB');
    expect(bytesText(5 * 1024 * 1024, decimal)).toBe('5 MB');
    expect(bytesText(3 * 1024 ** 3, decimal)).toBe('3 GB');
  });

  test('milliseconds keep one decimal and null is a dash', () => {
    expect(msText(null, decimal)).toBe('—');
    expect(msText(1.26, decimal)).toBe('1.3 ms');
  });

  test('uptime reads in the largest units', () => {
    expect(uptimeText(5000)).toBe('5 s');
    expect(uptimeText(5 * 60_000)).toBe('5 min');
    expect(uptimeText(125 * 60_000)).toBe('2 h 5 min');
    expect(uptimeText(50 * 3_600_000)).toBe('2 d 2 h');
  });
});

describe('diagnosticsMarkdown', () => {
  const view = {
    version: '1.2.3',
    schema: 14,
    uptimeMs: 125 * 60_000,
    dbBytes: 1536,
    fts: true,
    hook: { count: 40, p50: 1.26, p95: 3, p99: null },
    activeCheckRuns: 1,
    worktrees: 2,
    sessions: 5,
    logTail: ['one', 'two'],
  };
  const env = { userAgent: 'UA/1.0', lang: 'es' };

  test('lists the facts and fences the log', () => {
    const lines = diagnosticsMarkdown(view, env).split('\n');
    expect(lines).toContain('- Version: 1.2.3');
    expect(lines).toContain('- Uptime: 2 h 5 min');
    expect(lines).toContain('- Database size: 1.5 KB');
    expect(lines).toContain('- Hook latency (40 calls): p50 1.3 ms, p95 3.0 ms, p99 —');
    expect(lines).toContain('- Browser: UA/1.0');
    expect(lines).toContain('- Panel language: es');
    expect(lines.slice(-4)).toEqual(['```', 'one', 'two', '```']);
  });

  test('the fence is longer than any backtick run in the log', () => {
    const text = diagnosticsMarkdown({ ...view, logTail: ['a ``` b', 'c `` d'] }, env);
    expect(text.endsWith('````\na ``` b\nc `` d\n````')).toBe(true);
  });
});
