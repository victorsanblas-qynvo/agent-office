import { BROADCAST_LEAD, CHAT_PREFIX, ORDER_LEAD, ORDER_PREFIX } from './courier';
import { DIRECCION, MANTENIMIENTO, REDACCION } from './floors';
import { TASK_MAX } from './office-state';
import { BRIEF_PREFIX, parseProtocol } from './protocol';
import { roleIdOf } from './scope';
import { short, text } from './state-machine';
import type { DocumentView, HubText, RoleId, VerdictKind } from './types';

export const RULES_NOTE = 'Las reglas de tu puesto cambiaron. Estas son las nuevas y mandan sobre las que recibiste al arrancar:';
export const STATUS_REQUEST = '¿En qué estado está el encargo? Si esperas algo, escribe ESPERO: <a quién> — <qué>.';
export const STATUS_QUESTION = '¿En qué estado está el encargo?';
export const VERDICT_DETAILS: Record<Exclude<VerdictKind, 'tests'>, HubText> = {
  approved: { key: 'hub.detail.verdictApproved' },
  improve: { key: 'hub.detail.verdictImprove' },
  'no-agreement': { key: 'hub.detail.verdictNoAgreement' },
};
export const DISCARDED_MARK = '> **Descartado**';

// The paragraph markDiscardedFile prepends, gone; a file that does not start with it comes back as it was.
export function withoutDiscardMark(content: string): string {
  if (!content.startsWith(DISCARDED_MARK)) return content;
  const end = content.indexOf('\n\n');
  return end < 0 ? '' : content.slice(end + 2);
}

export const ROLE_LABELS: Record<RoleId, string> = {
  director: 'director',
  lead: 'jefe',
  dev: 'desarrollador',
  tester: 'tester',
  reviewer: 'revisor de código',
  redactor: 'redactor',
  'revisor-planes': 'revisor de planes',
  artesano: 'artesano de skills',
  'revisor-skills': 'revisor de skills',
};

export function roleLabel(role: string | null): string | null {
  const id = roleIdOf(role);
  return id ? ROLE_LABELS[id] : null;
}

export function floorLabel(slug: string): string {
  if (slug === DIRECCION) return 'Dirección';
  if (slug === REDACCION) return 'Redacción';
  if (slug === MANTENIMIENTO) return 'Mantenimiento';
  return `la planta ${slug}`;
}

export function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function executeOrderText(doc: Pick<DocumentView, 'path' | 'title' | 'round' | 'base'>, docsRepo: string): string {
  const floors = [...new Set(doc.base.map((b) => b.floor))];
  const rounds = `${doc.round} ${doc.round === 1 ? 'ronda' : 'rondas'}`;
  const floorList = floors.length > 0 ? floors.join(', ') : 'las que indique el plan';
  const leads = floors.length > 0 ? ` (${floors.map((f) => `\`lead-${f}\``).join(', ')})` : '';
  return [
    `Ejecuta el plan ${doc.path} («${doc.title}»), aprobado por Redacción en ${rounds}.`,
    `Plantas: ${floorList}.`,
    `Léelo en \`${docsRepo}/${doc.path}\`, divídelo por planta según sus Pasos y manda a cada jefe${leads} su parte con la ruta del plan; ya lo conocen por el aviso PLAN de Redacción.`,
    'Avísame cuando terminen todas.',
  ].join(' ');
}

export function analysisOrderText(doc: Pick<DocumentView, 'path' | 'title'>, docsRepo: string): string {
  return [
    `Analiza el documento \`${doc.path}\` («${doc.title}») que te ha entregado Redacción.`,
    `Léelo en \`${docsRepo}/${doc.path}\` y, antes de encargar nada, pregúntame con AskUserQuestion qué planes de implementación quieres que encargue a Redacción y en qué orden (opciones: las acciones que propone el documento).`,
    'Encarga solo los que elija, en ese orden, y avísame.',
  ].join(' ');
}

export function taskLine(body: string | null): string | null {
  if (!body) return null;
  let rest = body.trim();
  if (rest.startsWith(ORDER_LEAD)) rest = rest.slice(ORDER_LEAD.length).trim();
  else if (rest.startsWith(ORDER_PREFIX) || rest.startsWith(CHAT_PREFIX) || rest.startsWith('<') || rest.startsWith('/')) return null;
  rest = rest.replace(BRIEF_PREFIX, '').trim();
  if (rest.startsWith(STATUS_QUESTION) || parseProtocol(rest) !== null) return null;
  const line = rest
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? short(line, TASK_MAX) : null;
}

export function isUserPrompt(prompt: string | null): boolean {
  const body = (prompt ?? '').trim();
  return body !== '' && !body.startsWith('<') && !body.startsWith(CHAT_PREFIX) && !body.includes(STATUS_QUESTION);
}

export function isBroadcast(prompt: string | null): boolean {
  return (prompt ?? '').trim().startsWith(BROADCAST_LEAD);
}

export function historyPath(slug: string): string {
  return `redaccion/historial/${slug}.md`;
}

export function permissionMatch(tool: string, input: Record<string, unknown>): string {
  return `${tool}|${JSON.stringify(input)}`;
}

export function permissionPrompt(tool: string, who: string): HubText {
  if (tool === 'Bash') return { key: 'hub.permission.bash', params: { who } };
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return { key: 'hub.permission.edit', params: { who } };
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return { key: 'hub.permission.read', params: { who } };
  if (tool === 'WebFetch' || tool === 'WebSearch') return { key: 'hub.permission.web', params: { who } };
  return { key: 'hub.permission.other', params: { who, tool } };
}

export function permissionDetail(tool: string, input: Record<string, unknown>): string {
  const value =
    text(input.command) ??
    text(input.file_path) ??
    text(input.notebook_path) ??
    text(input.url) ??
    text(input.query) ??
    (text(input.pattern) ? `${input.pattern as string}${text(input.path) ? ` (${input.path as string})` : ''}` : null);
  return short(value ?? `${tool} ${JSON.stringify(input)}`, 600);
}

export function folderText(folder: { branch: string; path: string; base: string; sha: string }, dependencies: string): string {
  return `${ORDER_PREFIX} CARPETA: ${folder.branch} → ${folder.path} (base ${folder.base}@${folder.sha.slice(0, 7)}; dependencias: ${dependencies})`;
}

export function folderFailedText(slug: string, reason: string): string {
  return `${ORDER_PREFIX} CARPETA: encargo/${slug} sin carpeta (${reason}). No empieces: avisa al director con BLOQUEADO: y espera.`;
}
