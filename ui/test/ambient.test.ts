import { beforeEach, describe, expect, test } from 'bun:test';
import {
  AMBIENT_KEY,
  AmbientStore,
  COFFEE_IDLE_MS,
  COFFEE_MAX_MS,
  COFFEE_MIN_MS,
  COFFEE_WINDOW_MS,
  DAYLIGHT_STEPS,
  coffeeEligible,
  coffeePlan,
  daylight,
  daylightFor,
  defaultAmbient,
  readAmbientPrefs,
  quantizeDaylight,
  type CoffeeAgent,
} from '../src/ambient';
import { agent } from './fixtures';

const storage = new Map<string, string>();

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const at = (hour: number, minute = 0): Date => new Date(2026, 9, 17, hour, minute, 0);

beforeEach(() => storage.clear());

describe('daylight', () => {
  test('is night until 6, day from 8 to 19 and night again from 21', () => {
    expect(daylight(at(0))).toBe(0);
    expect(daylight(at(5, 59))).toBe(0);
    expect(daylight(at(6))).toBe(0);
    expect(daylight(at(8))).toBe(1);
    expect(daylight(at(12))).toBe(1);
    expect(daylight(at(19))).toBe(1);
    expect(daylight(at(21))).toBe(0);
    expect(daylight(at(23, 59))).toBe(0);
  });

  test('is interpolated through dawn and dusk', () => {
    expect(daylight(at(7))).toBeCloseTo(0.5, 5);
    expect(daylight(at(6, 30))).toBeCloseTo(0.25, 5);
    expect(daylight(at(20))).toBeCloseTo(0.5, 5);
    expect(daylight(at(20, 30))).toBeCloseTo(0.25, 5);
    const morning = [6, 6.5, 7, 7.5, 8].map((hour) => daylight(at(Math.floor(hour), (hour % 1) * 60)));
    expect(morning).toEqual([...morning].sort((a, b) => a - b));
  });

  test('the theme pins it to day or night and the clock follows the hour', () => {
    expect(daylightFor({ dayNight: 'theme', coffee: true }, false, at(3))).toBe(1);
    expect(daylightFor({ dayNight: 'theme', coffee: true }, true, at(12))).toBe(0);
    expect(daylightFor({ dayNight: 'clock', coffee: true }, true, at(12))).toBe(1);
    expect(daylightFor({ dayNight: 'clock', coffee: true }, false, at(3))).toBe(0);
  });

  test('it is quantised in steps and stays inside 0 to 1', () => {
    expect(quantizeDaylight(0.5)).toBe(0.5);
    expect(quantizeDaylight(0.51)).toBeCloseTo(Math.round(0.51 * DAYLIGHT_STEPS) / DAYLIGHT_STEPS, 10);
    expect(quantizeDaylight(-3)).toBe(0);
    expect(quantizeDaylight(4)).toBe(1);
  });
});

describe('ambient preferences', () => {
  test('default to the theme with coffee breaks', () => {
    expect(readAmbientPrefs()).toEqual({ dayNight: 'theme', coffee: true });
    expect(defaultAmbient()).toEqual({ dayNight: 'theme', coffee: true });
  });

  test('are stored, read back and announced to who listens', () => {
    const store = new AmbientStore();
    let calls = 0;
    const stop = store.subscribe(() => (calls += 1));
    store.set({ dayNight: 'clock', coffee: false });
    expect(JSON.parse(storage.get(AMBIENT_KEY) ?? 'null')).toEqual({ dayNight: 'clock', coffee: false });
    expect(readAmbientPrefs()).toEqual({ dayNight: 'clock', coffee: false });
    expect(store.get()).toEqual({ dayNight: 'clock', coffee: false });
    expect(calls).toBe(1);
    stop();
    store.set(defaultAmbient());
    expect(calls).toBe(1);
  });

  test('broken or foreign values fall back to the defaults', () => {
    storage.set(AMBIENT_KEY, '{"dayNight":"noon","coffee":"yes"}');
    expect(readAmbientPrefs()).toEqual({ dayNight: 'theme', coffee: true });
    storage.set(AMBIENT_KEY, 'nope');
    expect(readAmbientPrefs()).toEqual({ dayNight: 'theme', coffee: true });
  });
});

const asCoffee = (key: string, extra: Partial<CoffeeAgent> = {}): CoffeeAgent => {
  const { floor, state, stateSince, stalledSince, waiting, away, endedAt } = agent(key, { state: 'idle', stateSince: 0, ...extra });
  return { key, floor, state, stateSince, stalledSince, waiting, away, endedAt };
};

const NOW = 40 * COFFEE_WINDOW_MS;

describe('coffeePlan', () => {
  const crew = Array.from({ length: 8 }, (_, index) => asCoffee(`dev-${index}`));

  // Every second of 30 windows: who is at the coffee machine.
  function scan(agents: CoffeeAgent[], windows = 30, step = 1000) {
    const rows: { now: number; keys: string[] }[] = [];
    for (let now = NOW; now < NOW + windows * COFFEE_WINDOW_MS; now += step) {
      rows.push({ now, keys: coffeePlan(agents, now).map((visit) => visit.key) });
    }
    return rows;
  }

  test('is deterministic: the same clock gives the same plan, in any order of agents', () => {
    for (let now = NOW; now < NOW + 10 * COFFEE_WINDOW_MS; now += 7_000) {
      expect(coffeePlan(crew, now)).toEqual(coffeePlan(crew, now));
      expect(coffeePlan([...crew].reverse(), now)).toEqual(coffeePlan(crew, now));
    }
    expect(scan(crew).some((row) => row.keys.length > 0)).toBe(true);
  });

  test('at most two per floor, and each on a different seat', () => {
    const many = Array.from({ length: 12 }, (_, index) => asCoffee(`dev-${index}`));
    const other = Array.from({ length: 12 }, (_, index) => asCoffee(`qa-${index}`, { floor: 'backend' }));
    let both = 0;
    for (let now = NOW; now < NOW + 40 * COFFEE_WINDOW_MS; now += 5_000) {
      const plan = coffeePlan([...many, ...other], now);
      for (const floor of ['mobile', 'backend']) {
        const visits = plan.filter((visit) => visit.floor === floor);
        expect(visits.length).toBeLessThanOrEqual(2);
        if (visits.length === 2) {
          both += 1;
          expect(visits[0].seat).not.toBe(visits[1].seat);
        }
      }
    }
    expect(both).toBeGreaterThan(0);
  });

  test('a visit lasts between 40 and 90 seconds and stays inside its window', () => {
    const solo = [asCoffee('dev-solo')];
    const spans: number[] = [];
    let start: number | null = null;
    for (let now = NOW; now < NOW + 200 * COFFEE_WINDOW_MS; now += 1000) {
      const out = coffeePlan(solo, now).length === 1;
      if (out && start === null) start = now;
      if (!out && start !== null) {
        spans.push(now - start);
        start = null;
      }
    }
    expect(spans.length).toBeGreaterThan(20);
    for (const span of spans) {
      expect(span).toBeGreaterThanOrEqual(COFFEE_MIN_MS);
      expect(span).toBeLessThanOrEqual(COFFEE_MAX_MS + 1000);
    }
    for (const visit of coffeePlan(solo, NOW).concat(...scan(solo, 20, 11_000).map((row) => coffeePlan(solo, row.now)))) {
      expect(visit.startsAt).toBeGreaterThanOrEqual(Math.floor(visit.startsAt / COFFEE_WINDOW_MS) * COFFEE_WINDOW_MS);
      expect(visit.endsAt).toBeLessThanOrEqual(Math.floor(visit.startsAt / COFFEE_WINDOW_MS) * COFFEE_WINDOW_MS + COFFEE_WINDOW_MS);
    }
  });

  test('only an agent idle for 90 s or more, with nothing pending, is eligible', () => {
    const now = NOW + 50_000;
    expect(coffeeEligible(asCoffee('a', { stateSince: now - COFFEE_IDLE_MS }), now)).toBe(true);
    expect(coffeeEligible(asCoffee('a', { stateSince: now - COFFEE_IDLE_MS + 1 }), now)).toBe(false);
    for (const extra of [
      { state: 'working' },
      { state: 'blocked' },
      { state: 'asking' },
      { state: 'testing' },
      { state: 'talking' },
      { state: 'done' },
      { stalledSince: now - 1 },
      { waiting: { on: 'tester', since: 1 } },
      { away: true },
      { endedAt: 1 },
    ] as Partial<CoffeeAgent>[]) {
      expect(coffeeEligible(asCoffee('a', extra), now), JSON.stringify(extra)).toBe(false);
    }
  });

  test('stalled, blocked, waiting and busy agents are never in the plan', () => {
    const never = [
      asCoffee('stalled', { stalledSince: 5 }),
      asCoffee('blocked', { state: 'blocked' }),
      asCoffee('waiting', { waiting: { who: 'tester', what: 'tests', since: 1 } }),
      asCoffee('busy', { state: 'working' }),
      asCoffee('away', { away: true }),
      asCoffee('fresh', { stateSince: NOW + 90 * COFFEE_WINDOW_MS }),
    ];
    for (const row of scan([...never, asCoffee('free')], 30, 3_000)) {
      expect(row.keys.every((key) => key === 'free')).toBe(true);
    }
  });

  test('anything but idle cancels the visit from one moment to the next', () => {
    const solo = [asCoffee('dev-solo')];
    let now = NOW;
    while (coffeePlan(solo, now).length === 0) now += 1000;
    expect(coffeePlan([{ ...solo[0], state: 'working' }], now)).toEqual([]);
    expect(coffeePlan([{ ...solo[0], state: 'asking' }], now)).toEqual([]);
    expect(coffeePlan(solo, now)).toHaveLength(1);
  });
});
