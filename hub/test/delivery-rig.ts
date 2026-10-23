import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDocsRepo } from '../src/docs-repo';
import { gitMainRoot, realPath } from '../src/floors';
import { runGit } from '../src/git';
import type { OfficeOptions } from '../src/office';
import type { HookMeta, OfficeConfig, OrderView } from '../src/types';
import { ev, git, harness, originAndClone, useGitIdentity, type Harness } from './helpers';

useGitIdentity();

export const LEAD = '22222222-bbbb-4ccc-8ddd-000000000002';
export const DIRECTOR = 'ffffffff-0000-4000-8000-000000000003';
export const DEV = 'a-dev-1';
export const PLAN = 'redaccion/planes/login.md';

export type Sent = { socket: string; payload: string; text: string };

export type Rig = {
  h: Harness;
  repo: string;
  seed: string;
  origin: string;
  sent: Sent[];
  docs: string;
};

const leadMeta = (socket: string): HookMeta => ({ socket, token: 'lead-token', role: 'office-lead-mobile', name: 'lead-mobile' });

export function textOf(payload: string): string {
  const lines = payload.trim().split('\n');
  const last = JSON.parse(lines.at(-1) ?? '{}') as { message?: { content?: string } };
  return last.message?.content ?? '';
}

export type RigOptions = {
  stack?: 'generic' | 'node' | 'flutter' | 'laravel';
  configure?: (config: OfficeConfig, repo: string) => void;
  office?: Partial<OfficeOptions>;
  lead?: boolean;
  director?: boolean;
  // The floor works with a folder per order unless a test says it does not.
  delivery?: boolean;
};

// A managed floor over a real clone with an origin, a lead and a director that can be written to, and the
// messages the hub sends them recorded in sent. The floor runs no setup in a new folder unless a test gives it one.
export function deliveryRig(options: RigOptions = {}): Rig {
  const sent: Sent[] = [];
  const h = harness({
    git: runGit,
    gitRoot: gitMainRoot,
    stackOf: () => options.stack ?? 'generic',
    deliverFn: async (socket, payload) => {
      sent.push({ socket, payload, text: textOf(payload) });
    },
    ...options.office,
  });
  const { seed, origin, repo } = originAndClone(h.root, 'mobile');
  const real = realPath(repo);
  h.config.floors.mobile = { path: real, stack: options.stack ?? 'generic', managed: true, baseBranch: 'develop', setup: null, ...(options.delivery === false ? {} : { delivery: true }) };
  h.config.departments = { redaccion: true, mantenimiento: false };
  options.configure?.(h.config, real);
  const docs = realPath(join(h.root, 'docs'));
  ensureDocsRepo(docs);
  h.office.refreshDocuments();
  const rig: Rig = { h, repo: real, seed, origin, sent, docs };
  if (options.lead !== false) startLead(rig);
  if (options.director !== false) startDirector(rig);
  return rig;
}

export function startLead(rig: Rig, cwd = rig.repo): void {
  const socket = join(rig.h.root, 'lead.sock');
  writeFileSync(socket, '');
  rig.h.office.ingest(ev(LEAD, cwd, 'SessionStart', { source: 'startup', agent_type: 'office-lead-mobile' }), leadMeta(socket));
}

export function startDirector(rig: Rig): void {
  const socket = join(rig.h.root, 'director.sock');
  writeFileSync(socket, '');
  rig.h.office.ingest(ev(DIRECTOR, rig.h.workspace, 'SessionStart', { source: 'startup' }), { socket, token: 'dir-token', role: 'office-director', name: 'director' });
}

// The director's ENCARGO to a lead, through the gate that lets it through.
export function brief(rig: Rig, text: string, to = 'lead-mobile') {
  return rig.h.office.gateMessage(ev(DIRECTOR, rig.h.workspace, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to, message: text } }));
}

export function boardOrders(rig: Rig): OrderView[] {
  return rig.h.office.snapshot().orders;
}

export function orderOf(rig: Rig, slug: string): OrderView {
  const found = boardOrders(rig).find((o) => o.slug === slug);
  if (!found) throw new Error(`no order ${slug}`);
  return found;
}

export async function newOrder(rig: Rig, title = 'Pantalla de login'): Promise<OrderView> {
  const before = new Set(boardOrders(rig).map((o) => o.slug));
  expectPass(brief(rig, `ENCARGO: ${title} — criterios: que compile — fuera: nada`));
  await rig.h.office.idle();
  const created = boardOrders(rig).find((o) => !before.has(o.slug));
  if (!created) throw new Error('the brief made no card');
  return created;
}

function expectPass(decision: { pass: boolean; reason: string }): void {
  if (!decision.pass) throw new Error(`gate blocked: ${decision.reason}`);
}

// An event of the lead (or any session) as if it ran with that cwd.
export function eventIn(rig: Rig, cwd: string, tool = 'Read', file = 'README.md', session = LEAD): void {
  rig.h.office.ingest(ev(session, cwd, 'PreToolUse', { tool_name: tool, tool_input: { file_path: join(cwd, file) } }));
}

export function write(cwd: string, file: string, content: string): void {
  const full = join(cwd, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

export function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

export function seedPlan(rig: Rig, floors: string[] = ['mobile'], title = 'Login con Apple'): void {
  mkdirSync(join(rig.docs, 'redaccion', 'planes'), { recursive: true });
  writeFileSync(join(rig.docs, PLAN), `# ${title}\n\n## Pasos\n1. migración\n`);
  const base = floors.map((floor) => ({ floor, ref: 'develop', sha: 'abcdef1', date: null, stale: false }));
  rig.h.db
    .query('INSERT INTO documents (path, kind, slug, round, delivered_at, delivered_base, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(PLAN, 'plan', 'login', 1, rig.h.clock.now, JSON.stringify(base), rig.h.clock.now);
  rig.h.office.refreshDocuments();
}

// A HECHO of the lead to the director, as the gate of SendMessage sees it.
export function done(rig: Rig, message: string, cwd = rig.repo) {
  return rig.h.office.gateMessage(ev(LEAD, cwd, 'PreToolUse', { agent_type: 'office-lead-mobile', tool_name: 'SendMessage', tool_input: { to: 'director', message } }));
}

export function checksConfig(...specs: [string, string][]) {
  return (config: OfficeConfig) => {
    const floor = config.floors.mobile;
    if (floor) floor.checks = specs.map(([name, command]) => ({ name, command }));
  };
}

export function leadMessages(rig: Rig): string[] {
  return rig.sent.filter((m) => m.socket.endsWith('lead.sock')).map((m) => m.text);
}
