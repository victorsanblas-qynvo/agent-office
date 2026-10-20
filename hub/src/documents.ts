import type { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { DocRef } from './protocol';
import type { DocumentAhead, DocumentBase, DocumentContent, DocumentKind, DocumentStatus, DocumentType, DocumentView, PlanDecision } from './types';

export const PLANS_DIR = join('redaccion', 'planes');
export const SKILLS_DIR = join('taller', 'skills');
export const HISTORY_DIR = join('redaccion', 'historial');
const MAX_CONTENT_BYTES = 1_000_000;
const SKIP_DIRS = new Set(['evals', '.git', 'node_modules', '__pycache__']);

export const FINISHED_PLAN: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['cerrado', 'descartado', 'entregado', 'aparcado', 'ejecutando']);

export type DocRow = {
  path: string;
  round: number;
  requested_at: number | null;
  closed_at: number | null;
  discarded_at: number | null;
  delivered_at: number | null;
  decision: string | null;
  decided_at: number | null;
  delivered_base: string | null;
};
export type VerdictRow = { kind: string; ts: number; round: number | null; score: number | null };

export type DocumentsOptions = {
  db: Database;
  root: () => string;
  enabled: () => { redaccion: boolean; mantenimiento: boolean };
  installTargets: () => { label: string; dir: string }[];
  base: (slug: string) => DocumentBase[];
  ahead: (slug: string) => DocumentAhead[];
  onChange: (docs: DocumentView[]) => void;
  maxRounds: () => number;
};


export function latestMtime(dir: string, depth = 0): number {
  let latest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth > 8) continue;
      latest = Math.max(latest, latestMtime(full, depth + 1));
    } else if (entry.isFile()) {
      try {
        latest = Math.max(latest, statSync(full).mtimeMs);
      } catch {}
    }
  }
  return latest;
}

function readHead(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    return null;
  }
}

export function headBytes(file: string, bytes = 4000): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function titleOf(kind: DocumentKind, head: string | null, slug: string): string {
  if (head === null) return slug;
  if (kind === 'skill') {
    const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim();
    return name ? name.replace(/^['"]|['"]$/g, '') : slug;
  }
  const heading = /^#\s+(.+)$/m.exec(head)?.[1]?.trim();
  return heading || slug;
}

const TYPE_MARKER = /^#[ \t]+.+\r?\n(?:[ \t]*\r?\n)*>[ \t]*(?:tipo|type)[ \t]*:[ \t]*(an[aá]lisis|analysis)\b/im;

export function docTypeOf(kind: DocumentKind, head: string | null): DocumentType {
  if (kind !== 'plan' || head === null) return 'implementacion';
  return TYPE_MARKER.test(head) ? 'analisis' : 'implementacion';
}

export class DocumentDesk {
  private cache: DocumentView[] = [];
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rewatchTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedRoot: string | null = null;
  private watchedDirs = new Set<string>();

  constructor(private readonly opts: DocumentsOptions) {}

  list(): DocumentView[] {
    return this.cache;
  }

  find(path: string): DocumentView | null {
    return this.cache.find((d) => d.path === path) ?? null;
  }


  refresh(): boolean {
    const next = this.scan();
    const changed = JSON.stringify(next) !== JSON.stringify(this.cache);
    this.cache = next;
    if (changed) this.opts.onChange(next);
    return changed;
  }

  watch(): void {
    const root = this.opts.root();
    if (this.watchedRoot !== root) {
      this.unwatch();
      this.watchedRoot = root;
    }
    // Per directory: one target may already be watched while the other does not exist yet.
    for (const dir of [join(root, PLANS_DIR), join(root, SKILLS_DIR)]) {
      if (this.watchedDirs.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, () => this.schedule());
        watcher.on('error', () => this.rewatchLater());
        this.watchers.push(watcher);
        this.watchedDirs.add(dir);
      } catch {}
    }
  }

  private rewatchLater(): void {
    this.unwatch();
    this.watchedRoot = null;
    this.rewatchTimer = setTimeout(() => {
      this.rewatchTimer = null;
      this.watch();
      this.refresh();
    }, 5000);
  }

  unwatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.watchedDirs.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.rewatchTimer) clearTimeout(this.rewatchTimer);
    this.rewatchTimer = null;
  }

  changedAt(ref: DocRef): number | null {
    const abs = join(this.opts.root(), ref.path);
    if (ref.kind === 'plan') {
      try {
        return statSync(abs).mtimeMs;
      } catch {
        return null;
      }
    }
    if (!existsSync(join(abs, 'SKILL.md'))) return null;
    return latestMtime(abs);
  }

  markRequested(ref: DocRef, round: number | null, now: number): void {
    this.upsert(ref, now);
    this.opts.db
      .query('UPDATE documents SET requested_at = ?, round = MAX(round, ?), updated_at = ? WHERE path = ?')
      .run(now, round ?? 0, now, ref.path);
  }

  markRound(ref: DocRef, round: number | null, now: number): void {
    this.upsert(ref, now);
    if (round !== null) this.opts.db.query('UPDATE documents SET round = MAX(round, ?), updated_at = ? WHERE path = ?').run(round, now, ref.path);
  }

  markClosed(ref: DocRef, now: number): void {
    this.upsert(ref, now);
    this.opts.db.query('UPDATE documents SET closed_at = ?, updated_at = ? WHERE path = ?').run(now, now, ref.path);
  }

  markDelivered(ref: DocRef, base: DocumentBase[], now: number): void {
    this.upsert(ref, now);
    this.opts.db
      .query(
        'UPDATE documents SET delivered_at = COALESCE(delivered_at, ?), delivered_base = COALESCE(delivered_base, ?), updated_at = ? WHERE path = ?',
      )
      .run(now, base.length > 0 ? JSON.stringify(base) : null, now, ref.path);
  }

  markDecision(ref: DocRef, decision: PlanDecision, now: number): void {
    this.upsert(ref, now);
    if (decision === 'cerrar') {
      this.opts.db.query('UPDATE documents SET closed_at = ?, decided_at = ?, updated_at = ? WHERE path = ?').run(now, now, now, ref.path);
      return;
    }
    this.opts.db.query('UPDATE documents SET decision = ?, decided_at = ?, updated_at = ? WHERE path = ?').run(decision, now, now, ref.path);
  }

  markDiscarded(ref: DocRef, now: number): void {
    this.upsert(ref, now);
    this.opts.db.query('UPDATE documents SET discarded_at = ?, updated_at = ? WHERE path = ?').run(now, now, ref.path);
  }

  // Runtime UPDATE, not a migration: the schema only grows, but undoing a discard has to clear the mark.
  clearDiscarded(ref: DocRef, now: number): void {
    this.opts.db.query('UPDATE documents SET discarded_at = NULL, updated_at = ? WHERE path = ?').run(now, ref.path);
  }

  isOpen(slug: string, kind: DocumentKind): boolean {
    const doc = this.cache.find((d) => d.slug === slug && d.kind === kind);
    return !!doc && !FINISHED_PLAN.has(doc.status);
  }

  finishedPlanSlugs(): Set<string> {
    const finished = new Set<string>();
    for (const d of this.cache) if (d.kind === 'plan' && FINISHED_PLAN.has(d.status)) finished.add(d.slug);
    const rows = this.opts.db
      .query<{ slug: string }, []>(
        "SELECT slug FROM documents WHERE kind = 'plan' AND (closed_at IS NOT NULL OR discarded_at IS NOT NULL OR delivered_at IS NOT NULL)",
      )
      .all();
    for (const r of rows) finished.add(r.slug);
    for (const slug of this.splitPlanSlugs()) finished.add(slug);
    return finished;
  }

  private splitPlanSlugs(): string[] {
    const root = this.opts.root();
    return safeList(join(root, HISTORY_DIR)).flatMap((name) => {
      const slug = /^([a-z0-9][a-z0-9_-]{0,79})\.partido\.md$/.exec(name)?.[1];
      return slug && !existsSync(join(root, PLANS_DIR, `${slug}.md`)) ? [slug] : [];
    });
  }

  content(path: string): DocumentContent | null {
    const doc = this.find(path);
    if (!doc) return null;
    const file = doc.kind === 'plan' ? join(this.opts.root(), doc.path) : join(this.opts.root(), doc.path, 'SKILL.md');
    try {
      if (statSync(file).size > MAX_CONTENT_BYTES) return { path, kind: doc.kind, markdown: '', notice: { key: 'hub.doc.tooLarge' } };
      return { path, kind: doc.kind, markdown: readFileSync(file, 'utf8') };
    } catch {
      return null;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, 300);
  }

  private upsert(ref: DocRef, now: number): void {
    this.opts.db
      .query('INSERT OR IGNORE INTO documents (path, kind, slug, round, updated_at) VALUES (?, ?, ?, 0, ?)')
      .run(ref.path, ref.kind, ref.slug, now);
  }

  private scan(): DocumentView[] {
    const root = this.opts.root();
    const enabled = this.opts.enabled();
    const found: { ref: DocRef; file: string; mtime: number }[] = [];
    if (enabled.redaccion) {
      const dir = join(root, PLANS_DIR);
      for (const name of safeList(dir)) {
        const match = /^([a-z0-9][a-z0-9_-]{0,79})\.md$/.exec(name);
        if (!match?.[1]) continue;
        const file = join(dir, name);
        try {
          if (!statSync(file).isFile()) continue;
          found.push({ ref: { path: `redaccion/planes/${name}`, kind: 'plan', slug: match[1] }, file, mtime: statSync(file).mtimeMs });
        } catch {}
      }
    }
    if (enabled.mantenimiento) {
      const dir = join(root, SKILLS_DIR);
      for (const name of safeList(dir)) {
        if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) continue;
        const file = join(dir, name, 'SKILL.md');
        if (!existsSync(file)) continue;
        found.push({ ref: { path: `taller/skills/${name}`, kind: 'skill', slug: name }, file, mtime: latestMtime(join(dir, name)) });
      }
    }
    return found
      .map((f) => this.view(f.ref, f.file, f.mtime))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
  }

  private view(ref: DocRef, file: string, mtime: number): DocumentView {
    const row = this.opts.db
      .query<DocRow, [string]>(
        'SELECT path, round, requested_at, closed_at, discarded_at, delivered_at, decision, decided_at, delivered_base FROM documents WHERE path = ?',
      )
      .get(ref.path);
    const verdicts = this.opts.db
      .query<VerdictRow, [string]>(
        "SELECT kind, ts, round, score FROM verdicts WHERE path = ? AND kind IN ('approved', 'improve', 'no-agreement') ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .all(ref.path);
    const last = verdicts[0] ?? null;
    const round = Math.max(row?.round ?? 0, last?.round ?? 0);
    const head = readHead(file);
    return {
      path: ref.path,
      kind: ref.kind,
      slug: ref.slug,
      title: titleOf(ref.kind, head, ref.slug),
      docType: docTypeOf(ref.kind, head),
      status: statusOf(row ?? null, last, mtime),
      round,
      maxRounds: this.opts.maxRounds(),
      score: last?.score ?? null,
      updatedAt: Math.round(mtime),
      deliveredAt: row?.delivered_at ?? null,
      decidedAt: row?.decided_at ?? null,
      base: ref.kind === 'plan' ? this.planBase(ref.slug, row?.delivered_base ?? null) : [],
      ahead: ref.kind === 'plan' ? this.opts.ahead(ref.slug) : [],
      installedAt: ref.kind === 'skill' ? this.installedAt(ref.slug) : [],
      tokens: null,
    };
  }

  private planBase(slug: string, delivered: string | null): DocumentBase[] {
    const live = this.opts.base(slug);
    return live.length > 0 || delivered === null ? live : parseBase(delivered);
  }

  private installedAt(name: string): string[] {
    return this.opts
      .installTargets()
      .filter((t) => existsSync(join(t.dir, name, 'SKILL.md')))
      .map((t) => t.label);
  }
}

export function statusOf(row: DocRow | null, last: VerdictRow | null, mtime: number): DocumentStatus {
  if (row?.discarded_at) return 'descartado';
  if (row?.closed_at) return 'cerrado';
  if (row?.decision === 'ejecutar') return 'ejecutando';
  if (row?.decision === 'aparcar') return 'aparcado';
  if (row?.delivered_at) return 'entregado';
  if (last?.kind === 'approved') return last.ts > mtime ? 'aprobado' : 'revision';
  if (last?.kind === 'no-agreement') return 'sin-acuerdo';
  if (last?.kind === 'improve') return 'revision';
  if (row?.requested_at) return 'revision';
  return 'borrador';
}

function parseBase(raw: string): DocumentBase[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const b = item as Record<string, unknown>;
      if (typeof b.floor !== 'string' || typeof b.ref !== 'string' || typeof b.sha !== 'string') return [];
      return [{ floor: b.floor, ref: b.ref, sha: b.sha, date: typeof b.date === 'string' ? b.date : null, stale: b.stale === true }];
    });
  } catch {
    return [];
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
