import type { QuestionView } from './types';

export const HUNG_KEY = 'agent-office.hung';
export const HUNG_OPTIONS: readonly number[] = [5, 10, 20, 30, 0];
export const HUNG_DEFAULT = 10;

// Minutes a tool may run before it counts as hung; 0 turns the warning off.
export function readHungMinutes(): number {
  const stored = readJson(HUNG_KEY);
  return typeof stored === 'number' && HUNG_OPTIONS.includes(stored) ? stored : HUNG_DEFAULT;
}

export function writeHungMinutes(minutes: number): void {
  writeJson(HUNG_KEY, minutes);
}

export const CONTEXT_WARN_KEY = 'agent-office.contextWarn';
export const CONTEXT_WARN_OPTIONS: readonly number[] = [80, 85, 90, 0];
export const CONTEXT_WARN_DEFAULT = 85;

// Percentage of the context window from which an agent joins the queue; 0 turns the warning off.
export function readContextWarn(): number {
  const stored = readJson(CONTEXT_WARN_KEY);
  return typeof stored === 'number' && CONTEXT_WARN_OPTIONS.includes(stored) ? stored : CONTEXT_WARN_DEFAULT;
}

export function writeContextWarn(pct: number): void {
  writeJson(CONTEXT_WARN_KEY, pct);
}

export const BOARD_STALE_KEY = 'agent-office.boardStale';
export const BOARD_STALE_OPTIONS: readonly number[] = [6, 12, 24, 48, 0];
export const BOARD_STALE_DEFAULT = 24;

// Hours an open card may wait in its column before it is marked stale; 0 turns the mark off.
export function readBoardStaleHours(): number {
  const stored = readJson(BOARD_STALE_KEY);
  return typeof stored === 'number' && BOARD_STALE_OPTIONS.includes(stored) ? stored : BOARD_STALE_DEFAULT;
}

export function writeBoardStaleHours(hours: number): void {
  writeJson(BOARD_STALE_KEY, hours);
}

export const REMIND_KEY = 'agent-office.remind';
export const REMIND_OPTIONS: readonly number[] = [5, 10, 15, 0];
export const REMIND_DEFAULT = 10;

// Minutes a permission or question may stay open before it is announced once more; 0 turns the reminder off.
export function readRemindMinutes(): number {
  const stored = readJson(REMIND_KEY);
  return typeof stored === 'number' && REMIND_OPTIONS.includes(stored) ? stored : REMIND_DEFAULT;
}

export function writeRemindMinutes(minutes: number): void {
  writeJson(REMIND_KEY, minutes);
}

// The still-open questions that have waited `minutes` and were not reminded yet; a closed one is no longer in the list.
export function dueReminders(questions: readonly QuestionView[], now: number, minutes: number, alreadyReminded: ReadonlySet<string>): QuestionView[] {
  if (minutes <= 0) return [];
  return questions.filter((question) => !alreadyReminded.has(question.id) && now - question.createdAt >= minutes * 60_000);
}

export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage: the choice lasts for this session only.
  }
}

export const SNOOZE_KEY = 'agent-office.snooze';

// Postponed entries of the needs queue by need id; a null `until` lasts until the entry's signature changes.
export type Snoozes = Record<string, { until: number | null; sig: string }>;

export function readSnoozes(): Snoozes {
  const raw = readJson(SNOOZE_KEY);
  const snoozes: Snoozes = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return snoozes;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const { until, sig } = value as { until?: unknown; sig?: unknown };
    if (typeof sig !== 'string' || (until !== null && typeof until !== 'number')) continue;
    snoozes[id] = { until, sig };
  }
  return snoozes;
}

export function writeSnoozes(snoozes: Snoozes): void {
  writeJson(SNOOZE_KEY, snoozes);
}

export const QUIET_KEY = 'agent-office.quiet';

export type QuietHours = { enabled: boolean; from: string; to: string; allowPermissions: boolean };

export const QUIET_DEFAULT: QuietHours = { enabled: false, from: '22:00', to: '08:00', allowPermissions: true };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClock(value: unknown): value is string {
  return typeof value === 'string' && CLOCK.test(value);
}

export function readQuietHours(): QuietHours {
  const prefs = { ...QUIET_DEFAULT };
  const raw = readJson(QUIET_KEY);
  if (typeof raw !== 'object' || raw === null) return prefs;
  const record = raw as { enabled?: unknown; from?: unknown; to?: unknown; allowPermissions?: unknown };
  if (typeof record.enabled === 'boolean') prefs.enabled = record.enabled;
  if (isClock(record.from)) prefs.from = record.from;
  if (isClock(record.to)) prefs.to = record.to;
  if (typeof record.allowPermissions === 'boolean') prefs.allowPermissions = record.allowPermissions;
  return prefs;
}

export function writeQuietHours(prefs: QuietHours): void {
  writeJson(QUIET_KEY, prefs);
}

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

// From is inclusive and to exclusive; a window that ends before it starts crosses midnight, and from === to is never quiet.
export function inQuietHours(prefs: QuietHours, date: Date): boolean {
  if (!prefs.enabled) return false;
  const from = minutesOf(prefs.from);
  const to = minutesOf(prefs.to);
  if (from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

// A permission request blocks an agent, so it may keep sounding when the user allows it.
export function quietSilences(prefs: QuietHours, permission: boolean, date: Date): boolean {
  return inQuietHours(prefs, date) && !(permission && prefs.allowPermissions);
}
