import { normalizeAmbientPrefs, AMBIENT_KEY } from '../ambient';
import { FLOOR_BUDGETS_KEY, normalizeFloorBudgets } from '../budgets';
import { NOTES_KEY, parseNotes } from '../notes';
import { BRIEF_TEMPLATES_KEY, parseTemplates } from '../panel/brief-templates';
import {
  BOARD_STALE_KEY,
  CONTEXT_WARN_KEY,
  EDITOR_KEY,
  HUNG_KEY,
  MUTED_FLOORS_KEY,
  PINS_KEY,
  QUIET_KEY,
  REMIND_KEY,
  normalizeBoardStaleHours,
  normalizeContextWarn,
  normalizeEditor,
  normalizeHungMinutes,
  normalizeMutedFloors,
  normalizePins,
  normalizeQuietHours,
  normalizeRemindMinutes,
} from '../prefs';
import { SOUND_KEY, normalizeSoundPrefs } from '../sound';
import { SAVED_KEY, parseSaved } from '../table/history';
import { THEME_KEY, normalizeTheme } from '../theme';

export const PREFS_FORMAT = 'agent-office-prefs';
export const PREFS_VERSION = 1;

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// A value is either a plain choice (valid only if it is one of the options) or a container the reader repairs.
type Rule = { kind: 'choice'; normalize: (raw: unknown) => unknown } | { kind: 'list' | 'record'; normalize: (raw: unknown) => unknown };

// Preferences and the user's own content. Left out on purpose: the panel token, snoozes, the notice inbox, recent
// palette entries, drafts, criteria ticks and the focused floor, which are session data.
const RULES: Record<string, Rule> = {
  [HUNG_KEY]: { kind: 'choice', normalize: normalizeHungMinutes },
  [CONTEXT_WARN_KEY]: { kind: 'choice', normalize: normalizeContextWarn },
  [BOARD_STALE_KEY]: { kind: 'choice', normalize: normalizeBoardStaleHours },
  [REMIND_KEY]: { kind: 'choice', normalize: normalizeRemindMinutes },
  [EDITOR_KEY]: { kind: 'choice', normalize: normalizeEditor },
  [THEME_KEY]: { kind: 'choice', normalize: normalizeTheme },
  [QUIET_KEY]: { kind: 'record', normalize: normalizeQuietHours },
  [AMBIENT_KEY]: { kind: 'record', normalize: normalizeAmbientPrefs },
  [SOUND_KEY]: { kind: 'record', normalize: normalizeSoundPrefs },
  [FLOOR_BUDGETS_KEY]: { kind: 'record', normalize: normalizeFloorBudgets },
  [NOTES_KEY]: { kind: 'record', normalize: parseNotes },
  [MUTED_FLOORS_KEY]: { kind: 'list', normalize: normalizeMutedFloors },
  [PINS_KEY]: { kind: 'list', normalize: normalizePins },
  [BRIEF_TEMPLATES_KEY]: { kind: 'list', normalize: parseTemplates },
  [SAVED_KEY]: { kind: 'list', normalize: parseSaved },
};

export const TRANSFER_KEYS: readonly string[] = Object.keys(RULES);

export type ImportError = 'json' | 'format' | 'version' | 'prefs';
export type SkipReason = 'unknown' | 'invalid';

export interface ImportItem {
  key: string;
  value: unknown;
  overwrites: boolean;
}

export interface ImportPlan {
  apply: ImportItem[];
  skipped: { key: string; reason: SkipReason }[];
  errors: ImportError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The value the app would read from this raw one, or undefined when it is not a value of that key at all.
function clean(key: string, raw: unknown): unknown {
  if (!Object.hasOwn(RULES, key)) return undefined;
  const rule = RULES[key]!;
  if (rule.kind === 'list') return Array.isArray(raw) ? rule.normalize(raw) : undefined;
  if (rule.kind === 'record') return isRecord(raw) ? rule.normalize(raw) : undefined;
  return JSON.stringify(rule.normalize(raw)) === JSON.stringify(raw) ? raw : undefined;
}

function readStored(storage: PrefsStorage, key: string): unknown {
  try {
    const text = storage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

// Only the allowlisted keys that hold a valid value, parsed.
export function collectPrefs(storage: PrefsStorage): Record<string, unknown> {
  const prefs: Record<string, unknown> = {};
  for (const key of TRANSFER_KEYS) {
    const value = clean(key, readStored(storage, key));
    if (value !== undefined) prefs[key] = value;
  }
  return prefs;
}

export function exportPrefs(storage: PrefsStorage, now: Date): string {
  return JSON.stringify({ format: PREFS_FORMAT, version: PREFS_VERSION, exportedAt: now.toISOString(), prefs: collectPrefs(storage) }, null, 2);
}

export function planImport(json: string, storage: PrefsStorage): ImportPlan {
  const plan: ImportPlan = { apply: [], skipped: [], errors: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    plan.errors.push('json');
    return plan;
  }
  if (!isRecord(doc) || doc.format !== PREFS_FORMAT) {
    plan.errors.push('format');
    return plan;
  }
  if (doc.version !== PREFS_VERSION) {
    plan.errors.push('version');
    return plan;
  }
  if (!isRecord(doc.prefs)) {
    plan.errors.push('prefs');
    return plan;
  }
  for (const [key, raw] of Object.entries(doc.prefs)) {
    if (!Object.hasOwn(RULES, key)) {
      plan.skipped.push({ key, reason: 'unknown' });
      continue;
    }
    const value = clean(key, raw);
    if (value === undefined) {
      plan.skipped.push({ key, reason: 'invalid' });
      continue;
    }
    const current = readStored(storage, key);
    plan.apply.push({ key, value, overwrites: current !== undefined && JSON.stringify(current) !== JSON.stringify(value) });
  }
  return plan;
}

export function applyImport(plan: ImportPlan, storage: PrefsStorage): void {
  for (const item of plan.apply) storage.setItem(item.key, JSON.stringify(item.value));
}

export function overwrittenKeys(plan: ImportPlan): string[] {
  return plan.apply.filter((item) => item.overwrites).map((item) => item.key);
}
