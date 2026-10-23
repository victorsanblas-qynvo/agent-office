import { describe, expect, test } from 'bun:test';
import { composeBrief, EMPTY_BRIEF, mayReplaceDraft, parseBriefDraft } from '../src/panel/brief-compose';

const full = { title: 'Login social', what: 'Añadir Google', criteria: 'pasa el test', outOfScope: 'Apple' };

describe('composeBrief', () => {
  test('full brief', () => {
    const brief = composeBrief(full);
    expect(brief.text).toBe('ENCARGO: Login social — Añadir Google — criterios: pasa el test — fuera: Apple');
    expect(brief.length).toBe(brief.text.length);
    expect(brief.over).toBe(false);
    expect(brief.valid).toBe(true);
  });

  test('optional parts are omitted', () => {
    expect(composeBrief({ ...full, criteria: ' ', outOfScope: '' }).text).toBe('ENCARGO: Login social — Añadir Google');
    expect(composeBrief({ ...full, criteria: '' }).text).toBe('ENCARGO: Login social — Añadir Google — fuera: Apple');
  });

  test('the separator inside a field is neutralized', () => {
    const brief = composeBrief({ ...full, title: 'A — B', what: 'x – y' });
    expect(brief.text).toBe('ENCARGO: A - B — x - y — criterios: pasa el test — fuera: Apple');
    expect(brief.text.split(' — ')).toHaveLength(4);
  });

  test('newlines are collapsed and fields trimmed', () => {
    expect(composeBrief({ ...full, title: '  Uno\n\n dos  ', what: 'a\r\nb   c' }).text).toBe(
      'ENCARGO: Uno dos — a b c — criterios: pasa el test — fuera: Apple',
    );
  });

  test('over the limit is flagged', () => {
    expect(composeBrief({ ...full, what: 'x'.repeat(4000) }).over).toBe(true);
    expect(composeBrief(full, 10).over).toBe(true);
  });

  test('an empty required field gives no text', () => {
    for (const fields of [{ ...full, title: ' ' }, { ...full, what: '' }, EMPTY_BRIEF]) {
      expect(composeBrief(fields)).toEqual({ text: '', length: 0, over: false, valid: false });
    }
  });
});

describe('parseBriefDraft', () => {
  test('keeps strings and falls back to empty', () => {
    expect(parseBriefDraft({ title: 'a', what: 3 })).toEqual({ title: 'a', what: '', criteria: '', outOfScope: '' });
    expect(parseBriefDraft(null)).toEqual(EMPTY_BRIEF);
  });
});

describe('mayReplaceDraft', () => {
  test('an empty order is filled without asking; a typed one asks first', () => {
    let asked = 0;
    const ask = (answer: boolean) => () => (asked++, answer);
    expect(mayReplaceDraft('  ', ask(false))).toBe(true);
    expect(asked).toBe(0);
    expect(mayReplaceDraft('haz esto', ask(false))).toBe(false);
    expect(mayReplaceDraft('haz esto', ask(true))).toBe(true);
    expect(asked).toBe(2);
  });
});
