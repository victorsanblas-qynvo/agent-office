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
