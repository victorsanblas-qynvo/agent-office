import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../src/config';
import { openDb } from '../src/db';
import { captureLesson, deleteLesson, listLessons, memoryContext, updateLesson } from '../src/memory';
import { buildReport, saveReport, savedReport, savedReports } from '../src/reports';

const limits = DEFAULT_CONFIG.memory;
const at = (n: number) => 1_800_000_000_000 + n;

describe('lessons', () => {
  test('duplicates are ignored even with different case, accents or spacing', () => {
    const db = openDb(':memory:');
    const base = { floor: 'mobile', role: 'dev' as const, origin: 'agent' as const, agentKey: 'a1' };
    expect(captureLesson(db, { ...base, text: 'No uses pumpAndSettle en los flow tests', now: at(1) }, limits).status).toBe('saved');
    expect(captureLesson(db, { ...base, agentKey: 'a2', text: '  no uses PUMPANDSETTLE en los flow tests. ', now: at(2) }, limits).status).toBe('duplicate');
    expect(captureLesson(db, { ...base, text: 'La migración de viajes exige backfill', now: at(3) }, limits).status).toBe('saved');
    expect(listLessons(db, 'mobile', 'dev').map((l) => l.text)).toEqual(['La migración de viajes exige backfill', 'No uses pumpAndSettle en los flow tests']);
    expect(listLessons(db, 'backend', 'dev')).toEqual([]);
  });

  test('editing a lesson rewrites its text and its dedupe key', () => {
    const db = openDb(':memory:');
    const base = { floor: 'mobile', role: 'dev' as const, origin: 'user' as const, agentKey: null };
    const first = captureLesson(db, { ...base, text: 'Primera lección', now: at(1) }, limits);
    const second = captureLesson(db, { ...base, text: 'Segunda lección', now: at(2) }, limits);
    if (first.status !== 'saved' || second.status !== 'saved') throw new Error('setup');
    const edited = updateLesson(db, first.lesson.id, '  Primera   lección corregida ');
    expect(edited.status).toBe('updated');
    if (edited.status === 'updated') expect(edited.lesson).toEqual({ ...first.lesson, text: 'Primera lección corregida' });
    expect(listLessons(db, 'mobile', 'dev').map((l) => l.text)).toEqual(['Segunda lección', 'Primera lección corregida']);
    expect(captureLesson(db, { ...base, text: 'primera lección corregida', now: at(3) }, limits).status).toBe('duplicate');
    expect(captureLesson(db, { ...base, text: 'Primera lección', now: at(4) }, limits).status).toBe('saved');
    expect(updateLesson(db, first.lesson.id, 'x'.repeat(600)).status).toBe('updated');
    expect(listLessons(db, 'mobile', 'dev').find((l) => l.id === first.lesson.id)?.text.length).toBe(500);
  });

  test('editing refuses another lesson text of the same role, accepts its own and unknown ids are not found', () => {
    const db = openDb(':memory:');
    const base = { floor: 'mobile', role: 'dev' as const, origin: 'user' as const, agentKey: null };
    const first = captureLesson(db, { ...base, text: 'Uno', now: at(1) }, limits);
    const second = captureLesson(db, { ...base, text: 'Dos', now: at(2) }, limits);
    const other = captureLesson(db, { ...base, role: 'tester', text: 'Tres', now: at(3) }, limits);
    if (first.status !== 'saved' || second.status !== 'saved' || other.status !== 'saved') throw new Error('setup');
    expect(updateLesson(db, first.lesson.id, ' dos. ').status).toBe('duplicate');
    expect(updateLesson(db, first.lesson.id, 'UNO').status).toBe('updated');
    expect(updateLesson(db, first.lesson.id, '   ').status).toBe('invalid');
    expect(updateLesson(db, first.lesson.id, 'tres').status).toBe('updated');
    expect(updateLesson(db, 9999, 'algo').status).toBe('notFound');
    expect(listLessons(db, 'mobile', 'dev').map((l) => l.text)).toEqual(['Dos', 'tres']);
  });

  test('each agent saves at most the per-session cap', () => {
    const db = openDb(':memory:');
    const cap = { ...limits, maxLessonsPerSession: 2 };
    const save = (text: string, n: number) => captureLesson(db, { floor: 'mobile', role: 'tester', origin: 'agent', agentKey: 't1', text, now: at(n) }, cap).status;
    expect(save('uno', 1)).toBe('saved');
    expect(save('dos', 2)).toBe('saved');
    expect(save('tres', 3)).toBe('cap');
    expect(captureLesson(db, { floor: 'mobile', role: 'tester', origin: 'agent', agentKey: 't2', text: 'tres', now: at(4) }, cap).status).toBe('saved');
  });

  test('pruning drops the oldest agent lessons and never the user ones', () => {
    const db = openDb(':memory:');
    const small = { ...limits, maxLessons: 3, maxLessonsPerSession: 10 };
    captureLesson(db, { floor: 'mobile', role: 'dev', origin: 'user', agentKey: null, text: 'del usuario', now: at(0) }, small);
    for (let i = 1; i <= 4; i++) {
      captureLesson(db, { floor: 'mobile', role: 'dev', origin: 'agent', agentKey: `a${i}`, text: `agente ${i}`, now: at(i) }, small);
    }
    const kept = listLessons(db, 'mobile', 'dev');
    expect(kept.map((l) => l.text)).toEqual(['agente 4', 'agente 3', 'del usuario']);
    expect(kept.find((l) => l.text === 'del usuario')?.origin).toBe('user');
    const removed = deleteLesson(db, kept[0]!.id);
    expect(removed).toEqual({ floor: 'mobile', role: 'dev' });
    expect(deleteLesson(db, 9999)).toBeNull();
  });

  test('empty lessons are refused and long ones are cut', () => {
    const db = openDb(':memory:');
    expect(captureLesson(db, { floor: 'f', role: 'dev', origin: 'user', agentKey: null, text: '  . ', now: at(0) }, limits).status).toBe('invalid');
    const long = captureLesson(db, { floor: 'f', role: 'dev', origin: 'user', agentKey: null, text: 'x'.repeat(900), now: at(1) }, limits);
    expect(long.status === 'saved' && long.lesson.text.length).toBe(500);
  });

  test('the injected context is written as facts and respects the character cap', () => {
    const lessons = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      floor: 'mobile',
      role: 'dev' as const,
      text: `lección número ${i} con algo de texto para ocupar espacio`,
      origin: 'agent' as const,
      agentKey: null,
      createdAt: at(i),
    }));
    const context = memoryContext({
      roleLabel: 'desarrollador',
      floorLabel: 'la planta mobile',
      lessons,
      reports: [{ date: '2026-10-15', name: 'dev-mobile', summary: 'HECHO: login' }],
      maxChars: 600,
    });
    expect(context).not.toBeNull();
    expect(context!.length).toBeLessThanOrEqual(600);
    expect(context).toStartWith('Memoria de Agent Office para el puesto desarrollador en la planta mobile.');
    expect(context).toContain('- lección número 0');
    expect(memoryContext({ roleLabel: 'x', floorLabel: 'y', lessons: [], reports: [], maxChars: 4000 })).toBeNull();
    const withReports = memoryContext({ roleLabel: 'x', floorLabel: 'y', lessons: [], reports: [{ date: 'd', name: null, summary: 's' }], maxChars: 4000 });
    expect(withReports).toContain('Últimos informes de este puesto:\n- d · sin nombre: s');
  });
});

describe('reports', () => {
  test('a report gathers files, tests, verdicts, messages, questions, blocks and lessons', () => {
    const db = openDb(':memory:');
    db.query('INSERT INTO edits (ts, agent_key, floor, path) VALUES (?, ?, ?, ?)').run(at(1), 'dev-1', 'mobile', '/m/lib/a.dart');
    db.query('INSERT INTO edits (ts, agent_key, floor, path) VALUES (?, ?, ?, ?)').run(at(2), 'dev-1', 'mobile', '/m/lib/a.dart');
    db.query('INSERT INTO edits (ts, agent_key, floor, path) VALUES (?, ?, ?, ?)').run(at(3), 'dev-1', 'mobile', '/m/lib/b.dart');
    const verdict = db.query('INSERT INTO verdicts (ts, agent_key, role, floor, kind, ok, command, path, round, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    verdict.run(at(4), 'dev-1', 'office-dev-mobile', 'mobile', 'tests', 0, 'flutter test', null, null, null);
    const message = db.query('INSERT INTO messages (ts, from_key, to_name, to_key, text, floor) VALUES (?, ?, ?, ?, ?, ?)');
    message.run(at(5), 'dev-1', 'team-lead', 'lead', 'BLOQUEADO: falta el contrato — necesito status de backend', 'mobile');
    message.run(at(6), 'lead', 'dev-mobile', 'dev-1', 'Usa status 422', 'mobile');
    message.run(at(7), 'dev-1', 'team-lead', 'lead', 'HECHO: pantalla de viajes lista', 'mobile');
    db.query("INSERT INTO questions (id, session_id, agent_key, floor, payload, status, created_at) VALUES ('q', 's', 'dev-1', 'mobile', '[]', 'answered', ?)").run(at(8));
    captureLesson(db, { floor: 'mobile', role: 'dev', origin: 'agent', agentKey: 'dev-1', text: 'Pide el contrato antes de empezar', now: at(9) }, limits);
    const report = buildReport(
      db,
      { key: 'dev-1', name: 'dev-mobile', role: 'office-dev-mobile', roleId: 'dev', floor: 'mobile', startedAt: at(0), endedAt: null, closing: 'Listo.' },
      (key) => (key === 'lead' ? 'lead-mobile' : key),
    );
    expect(report.files).toEqual(['/m/lib/b.dart', '/m/lib/a.dart']);
    expect(report.tests).toEqual([{ ok: false, ts: at(4), command: 'flutter test' }]);
    expect(report.sent.map((m) => m.to)).toEqual(['team-lead', 'team-lead']);
    expect(report.received).toEqual([{ ts: at(6), from: 'lead-mobile', text: 'Usa status 422' }]);
    expect(report).toMatchObject({ questions: 1, blocked: 1, live: true, lessons: ['Pide el contrato antes de empezar'], summary: 'HECHO: pantalla de viajes lista' });
  });

  test('a report saved before summaryText is rendered from its data', () => {
    const db = openDb(':memory:');
    db.query('INSERT INTO edits (ts, agent_key, floor, path) VALUES (?, ?, ?, ?)').run(at(1), 'old-1', 'mobile', '/m/a');
    db.query('INSERT INTO verdicts (ts, agent_key, floor, kind, ok, command) VALUES (?, ?, ?, ?, ?, ?)').run(at(2), 'old-1', 'mobile', 'tests', 1, 'x');
    const subject = (key: string) => ({ key, name: key, role: 'office-dev-mobile', roleId: 'dev' as const, floor: 'mobile', startedAt: at(0), endedAt: at(9), closing: null });
    const counts = buildReport(db, subject('old-1'), (k) => k);
    expect(counts.summary).toBe('1 fichero cambiado · 1 ejecución de tests');
    saveReport(db, counts, at(10));
    db.query("UPDATE reports SET data = json_remove(data, '$.summaryText') WHERE agent_key = ?").run('old-1');
    expect(savedReport(db, 'old-1')?.summaryText).toEqual({
      key: 'hub.report.counts',
      params: { files: { key: 'hub.report.files.one', params: { n: 1 } }, tests: { key: 'hub.report.tests.one', params: { n: 1 } } },
    });

    db.query('INSERT INTO messages (ts, from_key, to_name, to_key, text, floor) VALUES (?, ?, ?, ?, ?, ?)').run(at(3), 'old-2', 'lead', 'lead-1', 'HECHO: x', 'mobile');
    const done = buildReport(db, subject('old-2'), (k) => k);
    expect(done.summary).toBe('HECHO: x');
    saveReport(db, done, at(11));
    db.query("UPDATE reports SET data = json_remove(data, '$.summaryText') WHERE agent_key = ?").run('old-2');
    expect(savedReport(db, 'old-2')?.summaryText).toBeNull();

    db.query("UPDATE reports SET data = json_set(data, '$.summary', 'otro resumen') WHERE agent_key = ?").run('old-1');
    db.query("UPDATE reports SET data = json_remove(data, '$.summaryText') WHERE agent_key = ?").run('old-1');
    expect(savedReport(db, 'old-1')?.summaryText).toBeNull();
  });

  test('saved reports keep the newest per floor and role and come back without the live flag', () => {
    const db = openDb(':memory:');
    const make = (key: string, n: number) =>
      buildReport(db, { key, name: key, role: 'office-tester-mobile', roleId: 'tester', floor: 'mobile', startedAt: at(n), endedAt: at(n + 1), closing: `cierre ${key}` }, (k) => k);
    for (let i = 0; i < 55; i++) saveReport(db, make(`t${i}`, i), at(i));
    const latest = savedReports(db, 'mobile', 'tester', 3);
    expect(latest.map((r) => r.agentKey)).toEqual(['t54', 't53', 't52']);
    expect(latest[0]?.summary).toBe('cierre t54');
    expect(savedReports(db, 'mobile', 'tester', 100)).toHaveLength(50);
    expect(savedReports(db, 'mobile', 'tester', 3, 't54').map((r) => r.agentKey)).toEqual(['t53', 't52', 't51']);
    expect(savedReport(db, 't54')?.live).toBe(false);
    expect(savedReport(db, 't0')).toBeNull();
  });
});
