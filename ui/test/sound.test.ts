import { beforeEach, describe, expect, test } from 'bun:test';
import { MERGE_MS, MIN_GAP_MS, SOUND_EVENTS, SOUND_KEY, SoundDesk, WebAudioEngine, clampVolume, notesOf, readSoundPrefs, testSequence, type Note, type ToneEngine } from '../src/sound';
import type { AgentView, MessageView, OrderView, QuestionView, ServerMessage, Snapshot } from '../src/types';
import { agent, order, question } from './fixtures';

const storage = new Map<string, string>();

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

class FakeEngine implements ToneEngine {
  played: { notes: readonly Note[]; volume: number }[] = [];
  unlocked = 0;
  play(notes: readonly Note[], volume: number): void {
    this.played.push({ notes, volume });
  }
  unlock(): void {
    this.unlocked += 1;
  }
}

const LEAD = 'lead-1';

function context(agents: AgentView[] = [agent(LEAD, { roleKind: 'lead' })], orders: OrderView[] = []) {
  return { agents: new Map(agents.map((item) => [item.key, item])), orders };
}

function message(text: string | null, extra: Partial<MessageView> = {}): ServerMessage {
  return { type: 'message', data: { id: 1, ts: 1, fromKey: LEAD, toKey: null, text, ...extra } as MessageView };
}

function snapshot(extra: Partial<Snapshot> = {}): ServerMessage {
  return { type: 'snapshot', data: { now: 1, floors: [], agents: [], sessions: [], questions: [], messages: [], activity: [], ...extra } as unknown as Snapshot };
}

let engine: FakeEngine;
let now: number;
let desk: SoundDesk;

function build(ctx = context()): SoundDesk {
  const built = new SoundDesk(ctx, { engine, clock: () => now, listen: false });
  built.save({ enabled: true, volume: 0.5, events: { question: true, delivery: true, stalled: true, error: true } });
  return built;
}

beforeEach(() => {
  storage.clear();
  engine = new FakeEngine();
  now = 100_000;
  desk = build();
});

describe('sound preferences', () => {
  test('are off by default, with a 0.4 volume and every event on', () => {
    storage.clear();
    const fresh = new SoundDesk(context(), { engine, listen: false });
    expect(fresh.preferences).toEqual({ enabled: false, volume: 0.4, events: { question: true, delivery: true, stalled: true, error: true } });
    fresh.observe({ type: 'question', data: question('q', LEAD, 1) as QuestionView });
    expect(engine.played).toHaveLength(0);
  });

  test('survive a reload, and broken or out of range values fall back', () => {
    desk.save({ enabled: true, volume: 7, events: { question: false, delivery: true, stalled: true, error: true } });
    expect(readSoundPrefs()).toEqual({ enabled: true, volume: 1, events: { question: false, delivery: true, stalled: true, error: true } });
    storage.set(SOUND_KEY, '{"enabled":"yes","volume":"loud","events":{"error":false,"stalled":3}}');
    expect(readSoundPrefs()).toEqual({ enabled: false, volume: 0.4, events: { question: true, delivery: true, stalled: true, error: false } });
    storage.set(SOUND_KEY, 'not json');
    expect(readSoundPrefs().enabled).toBe(false);
    expect(clampVolume(Number.NaN)).toBe(0.4);
    expect(clampVolume(-2)).toBe(0);
  });

  test('mute turns the sounds off and keeps the rest', () => {
    desk.mute();
    expect(desk.preferences).toMatchObject({ enabled: false, volume: 0.5 });
    desk.observe(message('BLOQUEADO: sin acceso'));
    expect(engine.played).toHaveLength(0);
  });

  test('an event switched off does not sound', () => {
    desk.save({ ...desk.preferences, events: { ...desk.preferences.events, error: false } });
    desk.observe(message('BLOQUEADO: sin acceso'));
    expect(engine.played).toHaveLength(0);
  });
});

describe('tones', () => {
  test('a question climbs, a delivery is a major third, a stall is low and an error falls', () => {
    const question = notesOf('question');
    expect(question).toHaveLength(2);
    expect(question[1].freq).toBeGreaterThan(question[0].freq);
    expect(question[1].at).toBeGreaterThan(question[0].at);

    const [root, third] = notesOf('delivery');
    expect(third.freq / root.freq).toBeCloseTo(2 ** (4 / 12), 2);
    expect(third.at).toBe(root.at);

    const [low] = notesOf('stalled');
    expect(low.freq).toBeLessThan(200);

    const error = notesOf('error');
    expect(error[1].freq).toBeLessThan(error[0].freq);
  });

  test('the test sequence plays every event, one after the other', () => {
    const sequence = testSequence();
    expect(sequence).toHaveLength(SOUND_EVENTS.flatMap((event) => notesOf(event)).length);
    const starts = sequence.map((note) => note.at);
    expect(Math.max(...starts)).toBeGreaterThan(2);
  });

  test('Probar plays at the chosen volume even with the sounds off', () => {
    desk.mute();
    desk.test();
    expect(engine.played).toEqual([{ notes: testSequence(), volume: 0.5 }]);
    expect(engine.unlocked).toBe(1);
  });
});

describe('what makes a sound', () => {
  test('a new question or permission sounds once, whatever the snapshot repeats', () => {
    desk.observe(snapshot({ questions: [question('old', LEAD, 1)] }));
    desk.observe({ type: 'question', data: question('old', LEAD, 1) });
    expect(engine.played).toHaveLength(0);
    desk.observe({ type: 'question', data: question('new', LEAD, 2, { kind: 'permission' }) });
    expect(engine.played).toHaveLength(1);
    expect(engine.played[0]).toEqual({ notes: notesOf('question'), volume: 0.5 });
    now += MIN_GAP_MS + 1;
    desk.observe({ type: 'question', data: question('new', LEAD, 2, { kind: 'permission' }) });
    expect(engine.played).toHaveLength(1);
  });

  test('the snapshot is silent, also for a lead that is already stalled', () => {
    desk.observe(snapshot({ agents: [agent(LEAD, { stalledSince: 5 })] }));
    desk.observe({ type: 'agent', data: agent(LEAD, { stalledSince: 5 }) });
    expect(engine.played).toHaveLength(0);
    desk.observe({ type: 'agent', data: agent(LEAD, { stalledSince: null }) });
    now += MERGE_MS + 1;
    desk.observe({ type: 'agent', data: agent(LEAD, { stalledSince: 9 }) });
    expect(engine.played.map((entry) => entry.notes)).toEqual([notesOf('stalled')]);
  });

  test('a BLOQUEADO and a guard alert are errors, a possible one is not', () => {
    desk.observe(message('BLOQUEADO: falta la clave'));
    expect(engine.played.map((entry) => entry.notes)).toEqual([notesOf('error')]);
    now += MIN_GAP_MS + 1;
    desk.observe({ type: 'alert', data: { id: 1, ts: 1, level: 'posible', floor: 'mobile', agentKey: LEAD, files: [] } });
    expect(engine.played).toHaveLength(1);
    now += MERGE_MS;
    desk.observe({ type: 'alert', data: { id: 2, ts: 1, level: 'alerta', floor: 'mobile', agentKey: LEAD, files: ['a'] } });
    expect(engine.played).toHaveLength(2);
  });

  test('the end popup and the HECHO of a lead without orders deliver; a tracked floor says it through the popup', () => {
    desk.observe({ type: 'finished', data: { id: 1, ts: 1, kind: 'order', slug: 'x', title: 'x', floors: ['mobile'] } as never });
    expect(engine.played.map((entry) => entry.notes)).toEqual([notesOf('delivery')]);

    now += MERGE_MS + 1;
    desk.observe(message('HECHO: listo'));
    expect(engine.played).toHaveLength(2);

    now += MERGE_MS + 1;
    const tracked = build(context([agent(LEAD, { roleKind: 'lead', floor: 'mobile' })], [order('x', { floor: 'mobile', worktree: { path: '/w', state: 'listo', error: null, stale: false } })]));
    tracked.observe(message('HECHO: listo'));
    expect(engine.played).toHaveLength(2);

    const dev = build(context([agent(LEAD, { roleKind: 'dev' })]));
    dev.observe(message('HECHO: listo'));
    dev.observe(message(null));
    expect(engine.played).toHaveLength(2);
  });
});

describe('throttle', () => {
  test('one sound per 1.5 s, whichever the event', () => {
    desk.observe(message('BLOQUEADO: a'));
    now += MIN_GAP_MS - 1;
    desk.observe({ type: 'finished', data: { id: 1, ts: 1, kind: 'order', slug: 'x', title: 'x', floors: [] } as never });
    expect(engine.played).toHaveLength(1);
    now += 2;
    desk.observe({ type: 'finished', data: { id: 2, ts: 1, kind: 'order', slug: 'y', title: 'y', floors: [] } as never });
    expect(engine.played).toHaveLength(2);
  });

  test('the same event again within 10 s is merged into the first', () => {
    desk.observe(message('BLOQUEADO: a'));
    now += MIN_GAP_MS + 100;
    desk.observe(message('BLOQUEADO: b', { id: 2 }));
    expect(engine.played).toHaveLength(1);
    now += MERGE_MS;
    desk.observe(message('BLOQUEADO: c', { id: 3 }));
    expect(engine.played).toHaveLength(2);
  });
});

describe('the WebAudio engine', () => {
  function fakeContext(state: 'running' | 'suspended') {
    const log = { oscillators: [] as { type: string; freq: number; start: number; stop: number }[], gains: [] as [string, number, number][], resumed: 0 };
    const context = {
      state,
      currentTime: 10,
      destination: {},
      resume: async () => {
        log.resumed += 1;
      },
      createOscillator: () => {
        const entry = { type: '', freq: 0, start: 0, stop: 0 };
        log.oscillators.push(entry);
        return {
          set type(value: string) {
            entry.type = value;
          },
          frequency: { setValueAtTime: (value: number) => (entry.freq = value) },
          connect: () => {},
          start: (at: number) => (entry.start = at),
          stop: (at: number) => (entry.stop = at),
        };
      },
      createGain: () => ({
        gain: {
          setValueAtTime: (value: number, at: number) => log.gains.push(['set', value, at]),
          linearRampToValueAtTime: (value: number, at: number) => log.gains.push(['ramp', value, at]),
        },
        connect: () => {},
      }),
    };
    return { context: context as unknown as AudioContext, log };
  }

  test('each note is an oscillator with a 10 ms attack and a 300 ms release', () => {
    const { context, log } = fakeContext('running');
    new WebAudioEngine(() => context).play(notesOf('question'), 0.4);
    expect(log.oscillators.map((entry) => entry.freq)).toEqual(notesOf('question').map((note) => note.freq));
    const [first] = log.oscillators;
    expect(first.start).toBeCloseTo(10.02, 5);
    expect(first.stop).toBeGreaterThan(first.start + 0.4);
    const ramps = log.gains.filter(([kind]) => kind === 'ramp');
    expect(ramps[0][2] - first.start).toBeCloseTo(0.01, 5);
    expect(ramps[1][1]).toBe(0);
    expect(ramps[1][2] - (first.start + notesOf('question')[0].hold)).toBeCloseTo(0.3, 5);
    expect(log.resumed).toBe(0);
  });

  test('a suspended context is resumed on the first gesture and on play', () => {
    const { context, log } = fakeContext('suspended');
    const engine = new WebAudioEngine(() => context);
    engine.unlock();
    engine.play(notesOf('stalled'), 0.4);
    expect(log.resumed).toBe(2);
  });

  test('without WebAudio nothing throws', () => {
    const engine = new WebAudioEngine(() => null);
    engine.unlock();
    engine.play(notesOf('error'), 1);
    const broken = new WebAudioEngine(() => {
      throw new Error('blocked');
    });
    broken.play(notesOf('error'), 1);
  });
});
