export const BRIEF_LIMIT = 4000;
export const BRIEF_DRAFT_KEY = 'agent-office.briefDraft';

export interface BriefFields {
  title: string;
  what: string;
  criteria: string;
  outOfScope: string;
}

export interface ComposedBrief {
  text: string;
  length: number;
  over: boolean;
  valid: boolean;
}

export const EMPTY_BRIEF: BriefFields = { title: '', what: '', criteria: '', outOfScope: '' };

// The hub splits the brief on the first " — " (or " – "): the dashes cannot survive inside a field.
function clean(value: string): string {
  return value
    .replace(/[—–]/g, '-')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ENCARGO: <title> — <what> — criterios: … — fuera: …; title and what are required, the rest is left out when empty.
export function composeBrief(fields: BriefFields, limit = BRIEF_LIMIT): ComposedBrief {
  const title = clean(fields.title);
  const what = clean(fields.what);
  const criteria = clean(fields.criteria);
  const outOfScope = clean(fields.outOfScope);
  if (title === '' || what === '') return { text: '', length: 0, over: false, valid: false };
  const parts = [title, what];
  if (criteria !== '') parts.push(`criterios: ${criteria}`);
  if (outOfScope !== '') parts.push(`fuera: ${outOfScope}`);
  const text = `ENCARGO: ${parts.join(' — ')}`;
  return { text, length: text.length, over: text.length > limit, valid: true };
}

export function parseBriefDraft(raw: unknown): BriefFields {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_BRIEF };
  const record = raw as Record<string, unknown>;
  const read = (key: keyof BriefFields): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  return { title: read('title'), what: read('what'), criteria: read('criteria'), outOfScope: read('outOfScope') };
}
