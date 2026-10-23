import { afterEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { digestText, weekDigestText } from '../src/table/digest-text';
import { shiftDay, weekOf } from '../src/table/digest';
import { readTableView } from '../src/table/history';
import type { OfficeDigest, WeekDigest } from '../src/types';

afterEach(() => applyLang('es'));

const digest: OfficeDigest = {
  day: '2026-10-22',
  floors: [
    {
      floor: 'mobile',
      delivered: [{ slug: 'login', title: 'Login con Google' }],
      blocked: 2,
      redRuns: 0,
      greenRuns: 3,
      tokens: 1_250_000,
      plans: { approved: 0, noAgreement: 0 },
      lessons: 1,
    },
    { floor: 'backend', delivered: [], blocked: 0, redRuns: 1, greenRuns: 0, tokens: 0, plans: { approved: 1, noAgreement: 1 }, lessons: 0 },
  ],
  totals: { delivered: 1, blocked: 2, redRuns: 1, greenRuns: 3, tokens: 1_250_000, plans: { approved: 1, noAgreement: 1 }, lessons: 1 },
};

describe('digestText', () => {
  test('writes a Spanish Markdown stand-up with only the lines that are not zero', () => {
    expect(digestText(digest, 'es', (slug) => slug.toUpperCase())).toBe(
      [
        '# Resumen del 2026-10-22',
        '',
        '## MOBILE',
        '- Encargos entregados: 1',
        '  - Login con Google (`login`)',
        '- Bloqueos: 2',
        '- Comprobaciones en verde: 3',
        '- Lecciones nuevas: 1',
        '- Tokens: 1,3 M',
        '',
        '## BACKEND',
        '- Comprobaciones en rojo: 1',
        '- Planes aprobados: 1',
        '- Planes sin acuerdo: 1',
        '',
        '## Total',
        '- Encargos entregados: 1',
        '- Bloqueos: 2',
        '- Comprobaciones en rojo: 1',
        '- Comprobaciones en verde: 3',
        '- Planes aprobados: 1',
        '- Planes sin acuerdo: 1',
        '- Lecciones nuevas: 1',
        '- Tokens: 1,3 M',
      ].join('\n'),
    );
  });

  test('follows the language it is given, not the panel one', () => {
    const text = digestText(digest, 'en');
    expect(text.split('\n')[0]).toBe('# Summary for 2026-10-22');
    expect(text).toContain('- Orders delivered: 1');
    expect(text).toContain('- Tokens: 1.3 M');
  });

  test('a quiet day says so', () => {
    expect(digestText({ day: '2026-10-21', floors: [], totals: { ...digest.totals, delivered: 0, blocked: 0, redRuns: 0, greenRuns: 0, tokens: 0, lessons: 0, plans: { approved: 0, noAgreement: 0 } } }, 'en')).toBe(
      '# Summary for 2026-10-21\n\nNo activity on this day.',
    );
  });
});

const quiet = { delivered: 0, blocked: 0, redRuns: 0, greenRuns: 0, tokens: 0, plans: { approved: 0, noAgreement: 0 }, lessons: 0 };
const week: WeekDigest = {
  from: '2026-10-21',
  to: '2026-10-22',
  days: [
    { day: '2026-10-21', floors: [], totals: quiet },
    digest,
  ],
  floors: digest.floors,
  totals: digest.totals,
};

describe('weekDigestText', () => {
  test('writes the floors, the total and a line per day', () => {
    expect(weekDigestText(week, 'es', (slug) => slug.toUpperCase())).toBe(
      [
        '# Resumen semanal del 2026-10-21 al 2026-10-22',
        '',
        '## MOBILE',
        '- Encargos entregados: 1',
        '  - Login con Google (`login`)',
        '- Bloqueos: 2',
        '- Comprobaciones en verde: 3',
        '- Lecciones nuevas: 1',
        '- Tokens: 1,3 M',
        '',
        '## BACKEND',
        '- Comprobaciones en rojo: 1',
        '- Planes aprobados: 1',
        '- Planes sin acuerdo: 1',
        '',
        '## Total',
        '- Encargos entregados: 1',
        '- Bloqueos: 2',
        '- Comprobaciones en rojo: 1',
        '- Comprobaciones en verde: 3',
        '- Planes aprobados: 1',
        '- Planes sin acuerdo: 1',
        '- Lecciones nuevas: 1',
        '- Tokens: 1,3 M',
        '',
        '## Por día',
        '- 2026-10-21: —',
        '- 2026-10-22: Encargos entregados 1, Bloqueos 2, Comprobaciones en rojo 1, Comprobaciones en verde 3, Planes aprobados 1, Planes sin acuerdo 1, Lecciones nuevas 1, Tokens 1,3 M',
      ].join('\n'),
    );
  });

  test('a quiet week says so, in the given language', () => {
    expect(weekDigestText({ ...week, floors: [], totals: quiet }, 'en')).toBe('# Weekly summary from 2026-10-21 to 2026-10-22\n\nNo activity this week.');
  });

  test('the week ends today and spans 7 days', () => {
    expect(weekOf('2026-10-24')).toEqual({ from: '2026-10-18', to: '2026-10-24' });
  });
});

describe('the day picker', () => {
  test('steps over month and year ends', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
  });

  test('the digest view is a remembered table view', () => {
    expect(readTableView('digest')).toBe('digest');
  });
});
