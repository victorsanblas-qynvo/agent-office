import { describe, expect, test } from 'bun:test';
import type { Recording, ServerMessage, Snapshot } from '../src/types';

Object.assign(globalThis, {
  window: { setInterval: () => 0, setTimeout: () => 0 },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { documentElement: { lang: 'es' } },
});

const { Store } = await import('../src/store');
const { MAX_REPLAY_EVENTS, parseRecording, seekKeyDelta, seekTo, serializeRecording, timeAt } = await import('../src/replay');
const { agent } = await import('./fixtures');

const snapshot: ServerMessage = { type: 'snapshot', data: { now: 1, floors: [], agents: [], sessions: [], questions: [], messages: [], activity: [], documents: [], alerts: [] } as unknown as Snapshot };
const joins = (key: string): ServerMessage => ({ type: 'agent', data: agent(key) });

const messages: Recording['messages'] = [
  { t: 0, msg: snapshot },
  { t: 1000, msg: joins('a') },
  { t: 2000, msg: joins('b') },
  { t: 2000, msg: { type: 'agent-gone', key: 'a' } },
  { t: 5000, msg: joins('c') },
];
const recording: Recording = { version: 1, startedAt: 100, messages };

describe('seekTo', () => {
  test('at the start only the snapshot is applied', () => {
    expect(seekTo(messages, 0)).toEqual({ index: 1, apply: [snapshot] });
    expect(seekTo(messages, -5).index).toBe(0);
  });

  test('in the middle it resumes after every message up to the target', () => {
    expect(seekTo(messages, 1500).index).toBe(2);
    expect(seekTo(messages, 2000).index).toBe(4);
    expect(seekTo(messages, 1500).apply).toEqual([snapshot, joins('a')]);
  });

  test('at the end and beyond it everything is applied', () => {
    expect(seekTo(messages, 5000).index).toBe(5);
    expect(seekTo(messages, 999_999).index).toBe(5);
    expect(seekTo([], 10)).toEqual({ index: 0, apply: [] });
  });

  test('the state after a seek equals the sequential application', () => {
    const sequential = new Store();
    const jumped = new Store();
    jumped.apply(joins('stale'));
    for (const entry of messages) if (entry.t <= 3000) sequential.apply(entry.msg);
    const { apply } = seekTo(messages, 3000);
    jumped.reset();
    for (const message of apply) jumped.apply(message);
    expect([...jumped.agents.keys()]).toEqual([...sequential.agents.keys()]);
    expect([...jumped.agents.keys()]).toEqual(['b']);
  });
});

describe('parseRecording', () => {
  const exported = (extra: Record<string, unknown> = {}): string => JSON.stringify({ ...JSON.parse(serializeRecording(recording)), ...extra });

  test('accepts an exported recording', () => {
    const parsed = parseRecording(serializeRecording(recording));
    expect(parsed).toEqual({ ok: true, recording });
  });

  test('rejects text that is not JSON', () => {
    expect(parseRecording('{nope')).toEqual({ ok: false, error: 'replay.import.badJson' });
  });

  test('rejects other shapes and other formats', () => {
    for (const text of ['null', '[]', '"x"', exported({ format: 'other' }), JSON.stringify(recording), exported({ version: 2 }), exported({ startedAt: 'x' }), exported({ messages: {} }), exported({ messages: [{ t: 'x', msg: snapshot }] }), exported({ messages: [{ t: 1, msg: {} }] })]) {
      expect(parseRecording(text)).toEqual({ ok: false, error: 'replay.import.badFormat' });
    }
  });

  test('rejects more events than the hub builds', () => {
    const many = Array.from({ length: MAX_REPLAY_EVENTS + 1 }, (_, i) => ({ t: i, msg: snapshot }));
    expect(parseRecording(exported({ messages: many }))).toEqual({ ok: false, error: 'replay.import.tooMany' });
    expect(parseRecording(exported({ messages: many.slice(1) })).ok).toBe(true);
  });

  test('sorts unsorted events by time', () => {
    const parsed = parseRecording(exported({ messages: [messages[4], messages[1], messages[0]] }));
    expect(parsed.ok && parsed.recording.messages.map((entry) => entry.t)).toEqual([0, 1000, 5000]);
  });
});

describe('seek controls', () => {
  test('the bar maps the pointer to recording time, clamped', () => {
    expect(timeAt(150, 100, 200, 10_000)).toBe(2500);
    expect(timeAt(0, 100, 200, 10_000)).toBe(0);
    expect(timeAt(900, 100, 200, 10_000)).toBe(10_000);
    expect(timeAt(150, 100, 0, 10_000)).toBe(0);
  });

  test('arrows jump 10 s, with Shift 60 s, and never while typing', () => {
    expect(seekKeyDelta('ArrowRight', false, false)).toBe(10_000);
    expect(seekKeyDelta('ArrowLeft', false, false)).toBe(-10_000);
    expect(seekKeyDelta('ArrowRight', true, false)).toBe(60_000);
    expect(seekKeyDelta('ArrowLeft', true, false)).toBe(-60_000);
    expect(seekKeyDelta('ArrowRight', false, true)).toBeNull();
    expect(seekKeyDelta('a', false, false)).toBeNull();
  });
});
