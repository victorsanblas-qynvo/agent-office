import { describe, expect, test } from 'bun:test';
import type { BriefFields } from '../src/panel/brief-compose';
import {
  fillPlaceholders,
  mergeImported,
  parseTemplates,
  removeTemplate,
  TEMPLATE_LIMIT,
  upsertTemplate,
  type BriefTemplate,
} from '../src/panel/brief-templates';

const fields = (title: string): BriefFields => ({ title, what: 'w', criteria: '', outOfScope: '' });
const tpl = (name: string, savedAt = 1): BriefTemplate => ({ name, fields: fields(name), savedAt });

describe('parseTemplates', () => {
  test('drops malformed entries', () => {
    const raw = [
      tpl('ok'),
      null,
      'x',
      { name: '', fields: fields('a'), savedAt: 1 },
      { name: 'n'.repeat(61), fields: fields('a'), savedAt: 1 },
      { name: 'nofields' },
      { name: 'bad', fields: { title: 1, what: '', criteria: '', outOfScope: '' } },
    ];
    expect(parseTemplates(raw).map((item) => item.name)).toEqual(['ok']);
    expect(parseTemplates({})).toEqual([]);
    expect(parseTemplates(null)).toEqual([]);
  });

  test('caps at 30 keeping the first', () => {
    const raw = Array.from({ length: 40 }, (_, i) => tpl(`t${i}`));
    const list = parseTemplates(raw);
    expect(list).toHaveLength(TEMPLATE_LIMIT);
    expect(list[0]?.name).toBe('t0');
  });
});

describe('upsertTemplate / removeTemplate', () => {
  test('newest first and capped', () => {
    let list: BriefTemplate[] = [];
    for (let i = 0; i < 32; i += 1) list = upsertTemplate(list, { name: `t${i}`, fields: fields('a') }, i);
    expect(list).toHaveLength(TEMPLATE_LIMIT);
    expect(list[0]?.name).toBe('t31');
    expect(list.at(-1)?.name).toBe('t2');
  });

  test('replaces the same name and moves it first', () => {
    const list = upsertTemplate([tpl('a'), tpl('b')], { name: 'b', fields: fields('new') }, 9);
    expect(list.map((item) => item.name)).toEqual(['b', 'a']);
    expect(list[0]?.fields.title).toBe('new');
    expect(list[0]?.savedAt).toBe(9);
  });

  test('removes by name', () => {
    expect(removeTemplate([tpl('a'), tpl('b')], 'a').map((item) => item.name)).toEqual(['b']);
  });
});

describe('fillPlaceholders', () => {
  const now = new Date(2026, 0, 5, 23, 59);
  const f: BriefFields = { title: '{fecha} {planta}', what: '{planta} y {planta} el {fecha}', criteria: '{otro}', outOfScope: '' };

  test('substitutes every occurrence', () => {
    const out = fillPlaceholders(f, { floor: 'Backend', now });
    expect(out.title).toBe('2026-01-05 Backend');
    expect(out.what).toBe('Backend y Backend el 2026-01-05');
    expect(out.criteria).toBe('{otro}');
  });

  test('leaves {planta} when the floor is unknown', () => {
    const out = fillPlaceholders(f, { floor: null, now });
    expect(out.title).toBe('2026-01-05 {planta}');
  });
});

describe('mergeImported', () => {
  test('reports conflicts and lets imported win', () => {
    const current = [tpl('a', 1), tpl('b', 1)];
    const incoming = [{ ...tpl('b', 2), fields: fields('imp') }, tpl('c', 2)];
    const { list, conflicts } = mergeImported(current, incoming);
    expect(conflicts).toEqual(['b']);
    expect(list.map((item) => item.name)).toEqual(['b', 'c', 'a']);
    expect(list[0]?.fields.title).toBe('imp');
  });

  test('no conflicts', () => {
    expect(mergeImported([tpl('a')], [tpl('b')]).conflicts).toEqual([]);
  });
});
