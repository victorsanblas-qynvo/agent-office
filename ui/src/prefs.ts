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
