import { readJson, writeJson } from './prefs';
import type { AgentView } from './types';

export type DayNight = 'clock' | 'theme';

export type AmbientPrefs = { dayNight: DayNight; coffee: boolean };

export const AMBIENT_KEY = 'agent-office.ambient';
export const DAY_NIGHT_MODES: readonly DayNight[] = ['theme', 'clock'];

// Daylight, 1 at noon and 0 at night: dawn goes from 6 to 8 h and dusk from 19 to 21 h, interpolated.
export const DAWN_FROM = 6;
export const DAWN_TO = 8;
export const DUSK_FROM = 19;
export const DUSK_TO = 21;
// The 3D scene repaints its buildings when the quantised daylight changes, so it changes in this many steps.
export const DAYLIGHT_STEPS = 12;

export function daylight(date: Date): number {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  if (hour >= DAWN_TO && hour < DUSK_FROM) return 1;
  if (hour < DAWN_FROM || hour >= DUSK_TO) return 0;
  if (hour < DAWN_TO) return (hour - DAWN_FROM) / (DAWN_TO - DAWN_FROM);
  return 1 - (hour - DUSK_FROM) / (DUSK_TO - DUSK_FROM);
}

export function quantizeDaylight(k: number): number {
  return Math.round(Math.min(1, Math.max(0, k)) * DAYLIGHT_STEPS) / DAYLIGHT_STEPS;
}

// The clock follows the hour; the theme follows the system: day when it is light and night when it is dark.
export function daylightFor(prefs: AmbientPrefs, systemDark: boolean, date: Date): number {
  if (prefs.dayNight === 'clock') return daylight(date);
  return systemDark ? 0 : 1;
}

export function defaultAmbient(): AmbientPrefs {
  return { dayNight: 'theme', coffee: true };
}

export function readAmbientPrefs(): AmbientPrefs {
  return normalizeAmbientPrefs(readJson(AMBIENT_KEY));
}

export function normalizeAmbientPrefs(raw: unknown): AmbientPrefs {
  const prefs = defaultAmbient();
  if (typeof raw !== 'object' || raw === null) return prefs;
  const record = raw as { dayNight?: unknown; coffee?: unknown };
  if (record.dayNight === 'clock' || record.dayNight === 'theme') prefs.dayNight = record.dayNight;
  if (typeof record.coffee === 'boolean') prefs.coffee = record.coffee;
  return prefs;
}

// The preferences of the ambient life, shared by the 3D and the 2D view and the settings that change them.
export class AmbientStore {
  private value: AmbientPrefs;
  private readonly listeners = new Set<() => void>();

  constructor(initial: AmbientPrefs = readAmbientPrefs()) {
    this.value = initial;
  }

  get(): AmbientPrefs {
    return { ...this.value };
  }

  set(next: AmbientPrefs): void {
    this.value = { dayNight: next.dayNight, coffee: next.coffee };
    writeJson(AMBIENT_KEY, this.value);
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const ambient = new AmbientStore();

export type CoffeeAgent = Pick<AgentView, 'key' | 'floor' | 'state' | 'stateSince' | 'stalledSince' | 'waiting' | 'away' | 'endedAt'>;

export type CoffeeVisit = { key: string; floor: string; seat: number; startsAt: number; endsAt: number };

// An agent that has done nothing for 90 s may take a break; the plan is a function of the clock, so every
// panel of the same office agrees.
export const COFFEE_IDLE_MS = 90_000;
export const COFFEE_WINDOW_MS = 120_000;
export const COFFEE_MIN_MS = 40_000;
export const COFFEE_MAX_MS = 90_000;
export const COFFEE_SEATS = 2;
export const COFFEE_MAX_PER_FLOOR = 2;
// Share of the eligible agents that go in each window of two minutes.
export const COFFEE_ODDS = 0.6;

export function hashKey(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Strict: only an agent whose shown state is idle, for at least 90 s, with nothing stalled, waited for or
// ended. A stalled or blocked one never goes, and anything but idle cancels the visit on the spot because the
// caller only passes the agents it still sees idle.
export function coffeeEligible(agent: CoffeeAgent, now: number): boolean {
  return (
    agent.state === 'idle' &&
    now - agent.stateSince >= COFFEE_IDLE_MS &&
    (agent.stalledSince ?? null) === null &&
    (agent.waiting ?? null) === null &&
    !agent.away &&
    agent.endedAt === null
  );
}

function visitOf(agent: CoffeeAgent, now: number): CoffeeVisit | null {
  const window = Math.floor(now / COFFEE_WINDOW_MS);
  const tag = `${agent.key}|${window}`;
  if ((hashKey(`${tag}|go`) % 1000) / 1000 >= COFFEE_ODDS) return null;
  const length = COFFEE_MIN_MS + Math.floor(((hashKey(`${tag}|for`) % 1000) / 1000) * (COFFEE_MAX_MS - COFFEE_MIN_MS + 1));
  const slack = COFFEE_WINDOW_MS - length;
  const startsAt = window * COFFEE_WINDOW_MS + Math.floor(((hashKey(`${tag}|at`) % 1000) / 1000) * (slack + 1));
  if (now < startsAt || now >= startsAt + length) return null;
  return { key: agent.key, floor: agent.floor, seat: hashKey(`${tag}|seat`) % COFFEE_SEATS, startsAt, endsAt: startsAt + length };
}

// Who is at the coffee machine at `now`: at most two per floor, the ones that left first keep their place.
export function coffeePlan(agents: readonly CoffeeAgent[], now: number): CoffeeVisit[] {
  const byFloor = new Map<string, CoffeeVisit[]>();
  for (const agent of agents) {
    if (!coffeeEligible(agent, now)) continue;
    const visit = visitOf(agent, now);
    if (!visit) continue;
    const list = byFloor.get(visit.floor) ?? [];
    list.push(visit);
    byFloor.set(visit.floor, list);
  }
  const plan: CoffeeVisit[] = [];
  for (const visits of byFloor.values()) {
    visits.sort((a, b) => a.startsAt - b.startsAt || (a.key < b.key ? -1 : 1));
    const chosen = visits.slice(0, COFFEE_MAX_PER_FLOOR);
    const [first, second] = chosen;
    if (second) second.seat = (first.seat + 1) % COFFEE_SEATS;
    plan.push(...chosen);
  }
  return plan.sort((a, b) => (a.key < b.key ? -1 : 1));
}
