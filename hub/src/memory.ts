import type { Database } from 'bun:sqlite';
import { ROLE_IDS } from './config';
import { normalizeLesson } from './protocol';
import type { LessonOrigin, LessonView, MemoryConfig, RoleId } from './types';

export const MAX_LESSON_CHARS = 500;

type LessonRow = {
  id: number;
  floor: string;
  role: string;
  text: string;
  origin: string;
  agent_key: string | null;
  created_at: number;
};

export type LessonInput = {
  floor: string;
  role: RoleId;
  text: string;
  origin: LessonOrigin;
  agentKey: string | null;
  now: number;
};

export type CaptureResult =
  | { status: 'saved'; lesson: LessonView; pruned: number }
  | { status: 'duplicate' | 'cap' | 'invalid' };

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value);
}

function toView(row: LessonRow): LessonView {
  return {
    id: row.id,
    floor: row.floor,
    role: row.role as RoleId,
    text: row.text,
    origin: row.origin === 'user' ? 'user' : 'agent',
    agentKey: row.agent_key,
    createdAt: row.created_at,
  };
}

export function cleanLesson(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line || !normalizeLesson(line)) return null;
  return line.length > MAX_LESSON_CHARS ? `${line.slice(0, MAX_LESSON_CHARS - 1)}…` : line;
}

export function captureLesson(db: Database, input: LessonInput, limits: MemoryConfig): CaptureResult {
  return db.transaction(() => capture(db, input, limits))();
}

function capture(db: Database, input: LessonInput, limits: MemoryConfig): CaptureResult {
  const text = cleanLesson(input.text);
  if (!text) return { status: 'invalid' };
  if (input.origin === 'agent' && input.agentKey) {
    const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM lessons WHERE agent_key = ? AND origin = 'agent'").get(input.agentKey)?.n ?? 0;
    if (count >= limits.maxLessonsPerSession) return { status: 'cap' };
  }
  const norm = normalizeLesson(text);
  const inserted = db
    .query('INSERT OR IGNORE INTO lessons (floor, role, text, norm, origin, agent_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.floor, input.role, text, norm, input.origin, input.agentKey, input.now);
  if (inserted.changes === 0) return { status: 'duplicate' };
  const id = Number(inserted.lastInsertRowid);
  const pruned = pruneLessons(db, input.floor, input.role, limits.maxLessons);
  const row = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE id = ?').get(id);
  return row ? { status: 'saved', lesson: toView(row), pruned } : { status: 'cap' };
}

export function pruneLessons(db: Database, floor: string, role: RoleId, maxLessons: number): number {
  const total = db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM lessons WHERE floor = ? AND role = ?').get(floor, role)?.n ?? 0;
  const excess = total - maxLessons;
  if (excess <= 0) return 0;
  return db
    .query(
      `DELETE FROM lessons WHERE id IN (
         SELECT id FROM lessons WHERE floor = ? AND role = ? AND origin = 'agent' ORDER BY created_at ASC, id ASC LIMIT ?
       )`,
    )
    .run(floor, role, excess).changes;
}

// userFirst puts the lessons the user wrote ahead of the agents' ones: the context block cuts from the end.
export function listLessons(db: Database, floor: string, role: RoleId, opts: { userFirst?: boolean } = {}): LessonView[] {
  const order = opts.userFirst ? "(origin = 'user') DESC, created_at DESC, id DESC" : 'created_at DESC, id DESC';
  return db
    .query<LessonRow, [string, string]>(`SELECT * FROM lessons WHERE floor = ? AND role = ? ORDER BY ${order}`)
    .all(floor, role)
    .map(toView);
}

export function lessonsBy(db: Database, agentKey: string): string[] {
  return db
    .query<{ text: string }, [string]>('SELECT text FROM lessons WHERE agent_key = ? ORDER BY created_at ASC, id ASC')
    .all(agentKey)
    .map((r) => r.text);
}

export function deleteLesson(db: Database, id: number): { floor: string; role: RoleId } | null {
  const row = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE id = ?').get(id);
  if (!row) return null;
  db.query('DELETE FROM lessons WHERE id = ?').run(id);
  return { floor: row.floor, role: row.role as RoleId };
}

export type UpdateResult = { status: 'updated'; lesson: LessonView } | { status: 'notFound' | 'duplicate' | 'invalid' };

export function updateLesson(db: Database, id: number, raw: string): UpdateResult {
  return db.transaction((): UpdateResult => {
    const row = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE id = ?').get(id);
    if (!row) return { status: 'notFound' };
    const text = cleanLesson(raw);
    if (!text) return { status: 'invalid' };
    const norm = normalizeLesson(text);
    const clash = db
      .query<{ id: number }, [string, string, string, number]>('SELECT id FROM lessons WHERE floor = ? AND role = ? AND norm = ? AND id <> ?')
      .get(row.floor, row.role, norm, id);
    if (clash) return { status: 'duplicate' };
    db.query("UPDATE lessons SET text = ?, norm = ?, origin = 'user', agent_key = NULL WHERE id = ?").run(text, norm, id);
    return { status: 'updated', lesson: toView({ ...row, text, origin: 'user', agent_key: null }) };
  })();
}

export type ContextInput = {
  roleLabel: string;
  floorLabel: string;
  lessons: LessonView[];
  reports: { date: string; name: string | null; summary: string }[];
  maxChars: number;
};

export function memoryContext(input: ContextInput): string | null {
  const sections: { title: string; lines: string[] }[] = [
    {
      title: 'Lecciones registradas en sesiones anteriores, las del usuario primero:',
      lines: input.lessons.map((l) => `- ${l.text}`),
    },
    {
      title: 'Últimos informes de este puesto:',
      lines: input.reports.map((r) => `- ${r.date} · ${r.name ?? 'sin nombre'}: ${r.summary}`),
    },
  ];
  let out = `Memoria de Agent Office para el puesto ${input.roleLabel} en ${input.floorLabel}.`;
  let added = 0;
  for (const section of sections) {
    let block = '';
    for (const line of section.lines) {
      const candidate = `${block || `\n\n${section.title}`}\n${line}`;
      if (out.length + candidate.length > input.maxChars) break;
      block = candidate;
      added++;
    }
    out += block;
  }
  return added > 0 ? out : null;
}
