import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../src/i18n/en';
import { es, type MessageKey } from '../src/i18n/es';
import { errorText, renderHubText } from '../src/i18n/hub';
import type { HubText } from '../src/types';
import { createTranslator, interpolate } from '../src/i18n/index';

// Keys whose text is legitimately the same in both languages: proper names, words shared by both, symbols.
const SAME_KEYS: MessageKey[] = [
  'whatsNew.replay.title',
  'orders.brief.count',
  'board.spend.line',
  'digest.range',
  'digest.tokens',
  'metrics.days.option',
  'metrics.p90',
  'digest.totals',
  'needs.kind.hung',
  'needs.kind.context',
  'needs.kind.budget',
  'settings.notifications.context.pct',
  'needs.snooze.15m',
  'needs.snooze.1h',
  'settings.notifications.hung.minutes',
  'settings.board.stale.hours',
  'settings.board.editor.label',
  'settings.board.editor.vscode',
  'settings.board.editor.cursor',
  'settings.board.editor.zed',
  'topbar.status.replay',
  'replay.label',
  'board.tab.diff',
  'board.diff.summary',
  'role.director',
  'role.tester',
  'settings.role.director',
  'settings.role.tester',
  'settings.section.hub',
  'stack.flutter',
  'stack.laravel',
  'stack.node',
  'verdict.tests',
  'table.docs.skills',
  'hub.detail.tests',
  'hub.pr.commits',
  'hub.pr.diff',
  'hub.review.line',
  'hub.review.file',
  'hub.act.tests',
  'hub.act.ok',
  'hub.report.counts',
  'hub.role.director',
  'hub.role.tester',
  'topbar.tab.chat',
  'history.kind.chat',
  'chat.title',
  'chat.global',
  'usage.spend.total',
  'timeline.hours',
  'tokens.row',
  'tokens.unit.k',
  'tokens.unit.m',
  'board.card.plan',
  'board.card.tokens',
  'board.checks.count',
  'board.drawer.base',
  'board.drawer.checks',
  'board.drawer.plan',
  'needs.toast',
  'palette.group.plan',
];

const SOURCE_DIR = join(import.meta.dir, '../src');
const ACCENTED_LITERAL = /(['"`])(?:(?!\1)[^\n])*[áéíóúñÁÉÍÓÚÑ¿¡](?:(?!\1)[^\n])*\1/;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('dictionaries', () => {
  test('en has exactly the keys of es, none empty, with the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
    for (const key of Object.keys(es) as MessageKey[]) {
      expect(es[key].trim(), key).not.toBe('');
      expect(en[key].trim(), key).not.toBe('');
      expect(placeholders(en[key]), key).toEqual(placeholders(es[key]));
    }
  });

  test('every .one key has its .other', () => {
    const keys = new Set<string>(Object.keys(es));
    for (const key of keys) {
      if (key.endsWith('.one')) expect(keys.has(`${key.slice(0, -'.one'.length)}.other`), key).toBe(true);
    }
  });

  test('no key has the same text in both languages unless listed in SAME_KEYS', () => {
    const same = (Object.keys(es) as MessageKey[]).filter((key) => es[key] === en[key]);
    expect(same.sort()).toEqual([...SAME_KEYS].sort());
  });
});

describe('translator', () => {
  test('interpolate replaces known placeholders and keeps unknown ones', () => {
    expect(interpolate('{a} y {b}', { a: 1 })).toBe('1 y {b}');
    expect(interpolate('sin marcadores')).toBe('sin marcadores');
  });

  test('t and plural use the given dictionary', () => {
    const spanish = createTranslator(es);
    expect(spanish.t('table.files.other', { n: 3 })).toBe('3 ficheros');
    expect(spanish.plural('table.files', 1)).toBe('1 fichero');
    expect(spanish.plural('table.files', 2)).toBe('2 ficheros');

    const english = createTranslator(en);
    expect(english.t('table.files.other', { n: 3 })).toBe('3 files');
    expect(english.plural('table.files', 1)).toBe('1 file');
    expect(english.plural('table.files', 0)).toBe('0 files');
  });

  test('t falls back to the key when it is missing', () => {
    expect(createTranslator(es).t('stack.unknown' as MessageKey)).toBe('stack.unknown');
  });
});

describe('hub texts', () => {
  const spanish = createTranslator(es).t;
  const english = createTranslator(en).t;

  test('raw text stays as is, keys are translated with their nested parameters', () => {
    expect(renderHubText(spanish, 'flutter test')).toBe('flutter test');
    expect(renderHubText(spanish, null)).toBe('');
    const start = { key: 'hub.act.sessionStart', params: { source: 'startup' } } as const;
    expect(renderHubText(spanish, start)).toBe('sesión iniciada (startup)');
    expect(renderHubText(english, start)).toBe('session started (startup)');
    const lesson = { key: 'hub.act.lessonSaved', params: { role: { key: 'hub.role.redactor' }, floor: { key: 'hub.floor.redaccion' } } } as const;
    expect(renderHubText(spanish, lesson)).toBe('lección guardada para redactor en Redacción');
    expect(renderHubText(english, lesson)).toBe('lesson saved for writer in Drafting');
  });

  test('the waiting detail and the stall activity carry who, what and minutes', () => {
    const waiting = { key: 'hub.detail.waitingFor', params: { who: 'tester-mobile', what: 'tests del login' } } as const;
    expect(renderHubText(spanish, waiting)).toBe('Esperando a tester-mobile: tests del login');
    expect(renderHubText(english, waiting)).toBe('Waiting for tester-mobile: tests del login');
    const stalled = { key: 'hub.act.stalled', params: { who: 'lead-mobile', minutes: 12 } } as const;
    expect(renderHubText(spanish, stalled)).toContain('12 min');
    expect(renderHubText(english, stalled)).toContain('12 min');
  });

  test('an unknown key comes out as the key and malformed values never throw', () => {
    const unknown = { key: 'hub.act.fromNewerHub', params: { who: { key: 'hub.who.alsoUnknown' }, n: 2 } } as unknown as HubText;
    expect(renderHubText(spanish, unknown)).toBe('hub.act.fromNewerHub');
    expect(renderHubText(english, { key: 'hub.nope' } as unknown as HubText)).toBe('hub.nope');
    expect(renderHubText(spanish, { key: 42 } as unknown as HubText)).toBe('');
    expect(renderHubText(spanish, { key: 'hub.act.edit', params: 'x' } as unknown as HubText)).toBe('edita {name}');
    expect(errorText(english, { key: 'hub.api.fromNewerHub' })).toBe('hub.api.fromNewerHub');
    expect(errorText(english, [{ key: 'hub.api.noReport' }, { key: 'hub.api.fromNewerHub' }])).toBe('There is no report for that agent hub.api.fromNewerHub');
  });

  test('an analysis sent to the director has its own activity text', () => {
    const sent = { key: 'hub.act.planAnalysisSent', params: { path: 'redaccion/planes/x.md' } } as const;
    expect(renderHubText(spanish, sent)).toBe('análisis enviado al director para encargar planes: redaccion/planes/x.md');
    expect(renderHubText(english, sent)).toBe('analysis sent to the director to commission plans: redaccion/planes/x.md');
  });

  test('parameters are interpolated in a single pass', () => {
    expect(renderHubText(spanish, { key: 'hub.act.message', params: { to: '{text}', text: 'hola' } })).toBe('escribe a {text}: hola');
  });

  test('API errors may be raw text, a hub text or a list of them', () => {
    expect(errorText(spanish, 'x')).toBe('x');
    expect(errorText(english, { key: 'hub.api.noReport' })).toBe('There is no report for that agent');
    expect(errorText(spanish, [{ key: 'hub.settings.saved' }, { key: 'hub.settings.noChanges' }])).toBe(
      `${es['hub.settings.saved']} ${es['hub.settings.noChanges']}`,
    );
    expect(errorText(spanish, 42)).toBeNull();
  });
});

describe('source scan', () => {
  test('no accented literal outside i18n/', () => {
    const found: string[] = [];
    for (const path of new Bun.Glob('**/*.ts').scanSync(SOURCE_DIR)) {
      if (path.startsWith('i18n/')) continue;
      const lines = readFileSync(join(SOURCE_DIR, path), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (ACCENTED_LITERAL.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
