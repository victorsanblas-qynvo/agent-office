import type { BriefFields } from './brief-compose';

export const BRIEF_TEMPLATES_KEY = 'agent-office.briefTemplates';
export const TEMPLATE_LIMIT = 30;
export const TEMPLATE_NAME_MAX = 60;

export interface BriefTemplate {
  name: string;
  fields: BriefFields;
  savedAt: number;
}

export interface PlaceholderContext {
  floor: string | null;
  now: Date;
}

const FIELD_KEYS = ['title', 'what', 'criteria', 'outOfScope'] as const;

export function validTemplateName(name: string): boolean {
  return name.length >= 1 && name.length <= TEMPLATE_NAME_MAX;
}

function parseTemplate(raw: unknown): BriefTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== 'string' || !validTemplateName(record.name)) return null;
  if (typeof record.fields !== 'object' || record.fields === null) return null;
  const source = record.fields as Record<string, unknown>;
  const fields: BriefFields = { title: '', what: '', criteria: '', outOfScope: '' };
  for (const key of FIELD_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') return null;
    fields[key] = value;
  }
  const savedAt = typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0;
  return { name: record.name, fields, savedAt };
}

// Drops malformed entries and repeated names (the first, newest one wins), capped at TEMPLATE_LIMIT.
export function parseTemplates(raw: unknown): BriefTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list: BriefTemplate[] = [];
  for (const item of raw) {
    const template = parseTemplate(item);
    if (template === null || seen.has(template.name)) continue;
    seen.add(template.name);
    list.push(template);
  }
  return list.slice(0, TEMPLATE_LIMIT);
}

// Newest first; a template with the same name is replaced; the oldest fall off past the cap.
export function upsertTemplate(list: readonly BriefTemplate[], template: { name: string; fields: BriefFields }, now: number): BriefTemplate[] {
  const next: BriefTemplate = { name: template.name, fields: { ...template.fields }, savedAt: now };
  return [next, ...list.filter((item) => item.name !== template.name)].slice(0, TEMPLATE_LIMIT);
}

export function removeTemplate(list: readonly BriefTemplate[], name: string): BriefTemplate[] {
  return list.filter((item) => item.name !== name);
}

export function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// {planta} stays as written when the floor is unknown.
export function fillPlaceholders(fields: BriefFields, context: PlaceholderContext): BriefFields {
  const date = localDate(context.now);
  const fill = (value: string): string => {
    const dated = value.replaceAll('{fecha}', date);
    return context.floor === null ? dated : dated.replaceAll('{planta}', context.floor);
  };
  return { title: fill(fields.title), what: fill(fields.what), criteria: fill(fields.criteria), outOfScope: fill(fields.outOfScope) };
}

// Imported templates win over the ones with the same name; conflicts lists those names.
export function mergeImported(list: readonly BriefTemplate[], imported: readonly BriefTemplate[]): { list: BriefTemplate[]; conflicts: string[] } {
  const names = new Set(list.map((item) => item.name));
  const conflicts = imported.filter((item) => names.has(item.name)).map((item) => item.name);
  const incoming = new Set(imported.map((item) => item.name));
  const merged = [...imported, ...list.filter((item) => !incoming.has(item.name))];
  return { list: merged.slice(0, TEMPLATE_LIMIT), conflicts };
}
