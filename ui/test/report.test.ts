import { afterEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { escapeLine, reportFilename, reportMarkdown } from '../src/panel/report-markdown';
import { isoLocal } from '../src/table/history-export';
import type { ReportView } from '../src/types';
import { agent } from './fixtures';

const T0 = new Date(2026, 9, 23, 14, 5, 0).getTime();

const report = (extra: Partial<ReportView> = {}): ReportView => ({
  agentKey: 'mobile:dev-1',
  name: 'Dev Uno',
  role: 'Desarrollador',
  roleId: null,
  floor: 'mobile',
  startedAt: T0,
  endedAt: null,
  live: true,
  summary: 'Arregla el login',
  files: [],
  tests: [],
  verdicts: [],
  sent: [],
  received: [],
  questions: 0,
  blocked: 0,
  lessons: [],
  closing: null,
  tokens: null,
  ...extra,
});

afterEach(() => applyLang('es'));

describe('reportMarkdown', () => {
  test('a full report lists metadata and every section', () => {
    applyLang('es');
    const live = agent('mobile:dev-1', { sessionId: 'abcdef123456', updatedAt: T0 + 60_000, context: { usedPct: 41.6, tokens: 1, window: 2, compactions: 0, source: 'transcript', at: T0 } });
    const md = reportMarkdown(
      report({
        endedAt: T0 + 120_000,
        files: ['src/a.ts'],
        tests: [{ ok: true, ts: T0 + 1000, command: 'bun test' }],
        verdicts: [{ kind: 'approved', ts: T0 + 2000, path: 'plan.md', round: 2, score: 9 }],
        sent: [{ ts: T0 + 3000, to: 'lead', text: 'listo' }],
        received: [{ ts: T0 + 4000, from: 'lead', text: null }],
        questions: 1,
        blocked: 2,
        lessons: ['usa Bun'],
        closing: 'Hecho',
        tokens: { turns: 3, input: 1000, cacheRead: 0, cacheCreate: 0, output: 500 },
      }),
      live,
    );
    expect(md.startsWith('# Dev Uno — Desarrollador · mobile\n\n- Sesión: abcdef12\n')).toBe(true);
    expect(md).toContain(`- Inicio: ${isoLocal(T0)}`);
    expect(md).toContain(`- Última actividad: ${isoLocal(T0 + 60_000)}`);
    expect(md).toContain('- Contexto: 42 %');
    expect(md).toContain('- Tokens totales: 1,5 K (3)');
    for (const heading of ['## Resumen', '## Ficheros cambiados (1)', '## Tests (1)', '## Veredictos (1)', '## Mensajes enviados (1)', '## Mensajes recibidos (1)', '## Lecciones enviadas (1)', '## Mensaje de cierre']) {
      expect(md).toContain(`${heading}\n\n- `);
    }
    expect(md).toContain('- ✓ ');
    expect(md).toContain('- src/a.ts');
    expect(md.endsWith('- Hecho\n')).toBe(true);
  });

  test('empty sections are omitted', () => {
    const md = reportMarkdown(report());
    expect(md).toContain('## Resumen');
    expect(md).not.toContain('Ficheros');
    expect(md).not.toContain('Tests');
    expect(md).not.toContain('Lecciones');
    expect(md).not.toContain('cierre');
    expect(md).not.toContain('Sesión');
  });

  test('hostile lines cannot restructure the document', () => {
    const md = reportMarkdown(report({ lessons: ['# Título\n## otro', '> cita', '- item', '* x', '| a | b |', '`código`', '1. uno'], files: ['\n# colado'] }));
    const bodies = md.split('\n').filter((line) => line.startsWith('- '));
    for (const line of bodies.slice(-8)) expect(line).toMatch(/^- (\\[#>\-*|`]|\\1\.|\\#)/);
    expect(md.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(1 + 3);
  });

  test('headings follow the language', () => {
    applyLang('en');
    const md = reportMarkdown(report({ files: ['a'], closing: 'Done' }));
    expect(md).toContain('## Summary');
    expect(md).toContain('## Changed files (1)');
    expect(md).toContain('## Closing message');
    expect(md).toContain('- Start: ');
  });
});

describe('escapeLine', () => {
  test('folds newlines and defuses the first character only', () => {
    expect(escapeLine('  # a\n- b ')).toBe('\\# a - b');
    expect(escapeLine('texto - normal')).toBe('texto - normal');
  });
});

describe('reportFilename', () => {
  test('slugifies the agent and stamps local time', () => {
    const now = new Date(2026, 9, 3, 9, 7);
    expect(reportFilename({ name: 'Dév Üno / Jefe', agentKey: 'k' }, now)).toBe('informe-dev-uno-jefe-20261003-0907.md');
    expect(reportFilename({ name: null, agentKey: 'mobile:Dev_1' }, now)).toBe('informe-mobile-dev-1-20261003-0907.md');
    expect(reportFilename({ name: '***', agentKey: 'k' }, now)).toBe('informe-agente-20261003-0907.md');
  });
});
