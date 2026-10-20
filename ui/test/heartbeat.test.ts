import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Heartbeat } from '../src/heartbeat';
import type { ClientMessage } from '../src/types';

const intervals = new Map<number, () => void>();
const listeners = new Set<() => void>();
const page = { visible: false };
let nextTimer = 1;

function flushIntervals(): void {
  for (const fn of [...intervals.values()]) fn();
}

function fireVisibility(): void {
  for (const fn of [...listeners]) fn();
}

// The test files share the process: the stubs go in before each test and the globals come back after.
const stubDocument = {
  get visibilityState() {
    return page.visible ? 'visible' : 'hidden';
  },
  addEventListener: (type: string, fn: () => void) => {
    if (type === 'visibilitychange') listeners.add(fn);
  },
  removeEventListener: (_type: string, fn: () => void) => {
    listeners.delete(fn);
  },
  documentElement: { lang: 'es' },
};
const stubWindow = {
  setInterval: (fn: () => void) => {
    const id = nextTimer++;
    intervals.set(id, fn);
    return id;
  },
  clearInterval: (id: number) => {
    intervals.delete(id);
  },
};

let real: { document?: unknown; window?: unknown };

function recorder() {
  const sent: ClientMessage[] = [];
  const heartbeat = new Heartbeat((message) => {
    sent.push(message);
    return true;
  });
  return { sent, heartbeat };
}

beforeEach(() => {
  real = {
    document: (globalThis as { document?: unknown }).document,
    window: (globalThis as { window?: unknown }).window,
  };
  Object.assign(globalThis, { document: stubDocument, window: stubWindow });
  intervals.clear();
  listeners.clear();
  nextTimer = 1;
  page.visible = false;
});

afterEach(() => {
  Object.assign(globalThis, real);
});

describe('Heartbeat', () => {
  test('pulses only while the page is visible', () => {
    const { sent, heartbeat } = recorder();
    heartbeat.pulse();
    expect(sent).toEqual([]);

    page.visible = true;
    heartbeat.pulse();
    expect(sent).toEqual([{ type: 'heartbeat', visible: true }]);
  });

  test('start arms the interval and answers visibility changes', () => {
    const { sent, heartbeat } = recorder();
    page.visible = true;
    heartbeat.start();

    expect(intervals.size).toBe(1);
    expect(listeners.size).toBe(1);

    flushIntervals();
    expect(sent).toHaveLength(1);

    page.visible = false;
    fireVisibility();
    expect(sent).toHaveLength(1);

    page.visible = true;
    fireVisibility();
    expect(sent).toHaveLength(2);
  });

  test('starting twice keeps a single interval and listener', () => {
    const { sent, heartbeat } = recorder();
    page.visible = true;
    heartbeat.start();
    heartbeat.start();

    expect(intervals.size).toBe(1);
    expect(listeners.size).toBe(1);
    flushIntervals();
    expect(sent).toHaveLength(1);
  });

  test('stop clears the interval and the listener', () => {
    const { sent, heartbeat } = recorder();
    page.visible = true;
    heartbeat.start();
    heartbeat.stop();

    expect(intervals.size).toBe(0);
    expect(listeners.size).toBe(0);
    flushIntervals();
    fireVisibility();
    expect(sent).toEqual([]);
  });
});
