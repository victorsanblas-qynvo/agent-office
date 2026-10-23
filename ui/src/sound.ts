import { isBlockedMessage, leadDeliveryFloor, type DeliveryContext } from './deliveries';
import { quietSilences, readJson, readQuietHours, writeJson } from './prefs';
import type { QuestionView, ServerMessage } from './types';

export type SoundEvent = 'question' | 'delivery' | 'stalled' | 'error';

export const SOUND_EVENTS: readonly SoundEvent[] = ['question', 'delivery', 'stalled', 'error'];

export type SoundPrefs = { enabled: boolean; volume: number; events: Record<SoundEvent, boolean> };

export const SOUND_KEY = 'agent-office.sound';
export const DEFAULT_VOLUME = 0.4;
// At most one sound in this window, and the same event again inside the second one is merged into the first.
export const MIN_GAP_MS = 1500;
export const MERGE_MS = 10_000;
export const SEEN_LIMIT = 200;
// The envelope of every note: a 10 ms attack and a 300 ms release.
export const ATTACK_S = 0.01;
export const RELEASE_S = 0.3;
const PEAK_GAIN = 0.35;
const TEST_STEP_S = 0.8;

export type Note = { freq: number; at: number; hold: number; wave: OscillatorType };

// No files: each event is a few oscillator notes. A question climbs, a delivery is a major third, a stall is
// a low tone and an error falls.
export function notesOf(event: SoundEvent): Note[] {
  switch (event) {
    case 'question':
      return [
        { freq: 523.25, at: 0, hold: 0.1, wave: 'sine' },
        { freq: 783.99, at: 0.14, hold: 0.16, wave: 'sine' },
      ];
    case 'delivery':
      return [
        { freq: 523.25, at: 0, hold: 0.28, wave: 'triangle' },
        { freq: 659.25, at: 0, hold: 0.28, wave: 'triangle' },
      ];
    case 'stalled':
      return [{ freq: 146.83, at: 0, hold: 0.4, wave: 'triangle' }];
    case 'error':
      return [
        { freq: 493.88, at: 0, hold: 0.1, wave: 'square' },
        { freq: 329.63, at: 0.14, hold: 0.2, wave: 'square' },
      ];
  }
}

// Every sound one after the other, for the Probar button.
export function testSequence(): Note[] {
  return SOUND_EVENTS.flatMap((event, index) => notesOf(event).map((note) => ({ ...note, at: note.at + index * TEST_STEP_S })));
}

export interface ToneEngine {
  play(notes: readonly Note[], volume: number): void;
  unlock(): void;
}

type ContextFactory = () => AudioContext | null;

function browserContext(): AudioContext | null {
  const ctor = typeof AudioContext === 'undefined' ? undefined : AudioContext;
  return ctor ? new ctor() : null;
}

// The context is created on first use and resumed at the first gesture, as browsers only start audio after one.
export class WebAudioEngine implements ToneEngine {
  private context: AudioContext | null = null;
  private failed = false;

  constructor(private readonly create: ContextFactory = browserContext) {}

  unlock(): void {
    const context = this.ensure();
    if (context && context.state === 'suspended') void context.resume().catch(() => {});
  }

  play(notes: readonly Note[], volume: number): void {
    const context = this.ensure();
    if (!context) return;
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const start = context.currentTime + 0.02;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const from = start + note.at;
      const peak = Math.max(0.0001, volume * PEAK_GAIN);
      const end = from + note.hold + RELEASE_S;
      oscillator.type = note.wave;
      oscillator.frequency.setValueAtTime(note.freq, from);
      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(peak, from + ATTACK_S);
      gain.gain.setValueAtTime(peak, from + note.hold);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(from);
      oscillator.stop(end + 0.02);
    }
  }

  private ensure(): AudioContext | null {
    if (this.context || this.failed) return this.context;
    try {
      this.context = this.create();
    } catch {
      this.context = null;
    }
    if (!this.context) this.failed = true;
    return this.context;
  }
}

function defaultPrefs(): SoundPrefs {
  return { enabled: false, volume: DEFAULT_VOLUME, events: { question: true, delivery: true, stalled: true, error: true } };
}

export function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
}

export function readSoundPrefs(): SoundPrefs {
  const prefs = defaultPrefs();
  const raw = readJson(SOUND_KEY);
  if (typeof raw !== 'object' || raw === null) return prefs;
  const record = raw as { enabled?: unknown; volume?: unknown; events?: unknown };
  if (typeof record.enabled === 'boolean') prefs.enabled = record.enabled;
  if (typeof record.volume === 'number') prefs.volume = clampVolume(record.volume);
  const events = typeof record.events === 'object' && record.events !== null ? (record.events as Record<string, unknown>) : {};
  for (const event of SOUND_EVENTS) {
    if (typeof events[event] === 'boolean') prefs.events[event] = events[event];
  }
  return prefs;
}

type SoundOptions = { engine?: ToneEngine; clock?: () => number; listen?: boolean };

// The audible counterpart of the Notifier: what the hub sends decides which sound plays. History does not
// sound (a snapshot only seeds what is already stalled), and a replay never builds one.
export class SoundDesk {
  private prefs: SoundPrefs = readSoundPrefs();
  private readonly engine: ToneEngine;
  private readonly clock: () => number;
  private readonly lastOf = new Map<SoundEvent, number>();
  private readonly seen = new Set<string>();
  private readonly stalled = new Map<string, number | null>();
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: DeliveryContext,
    options: SoundOptions = {},
  ) {
    this.engine = options.engine ?? new WebAudioEngine();
    this.clock = options.clock ?? Date.now;
    if (options.listen !== false && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const unlock = (): void => {
        this.engine.unlock();
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      };
      window.addEventListener('pointerdown', unlock);
      window.addEventListener('keydown', unlock);
    }
  }

  get preferences(): SoundPrefs {
    return { enabled: this.prefs.enabled, volume: this.prefs.volume, events: { ...this.prefs.events } };
  }

  save(prefs: SoundPrefs): void {
    this.prefs = { enabled: prefs.enabled, volume: clampVolume(prefs.volume), events: { ...prefs.events } };
    writeJson(SOUND_KEY, this.prefs);
  }

  mute(): void {
    this.save({ ...this.preferences, enabled: false });
  }

  // The Probar button: every sound at the chosen volume, whether or not the sounds are on.
  test(): void {
    this.engine.unlock();
    this.engine.play(testSequence(), this.prefs.volume);
  }

  observe(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.stalled.clear();
        for (const agent of message.data.agents) this.stalled.set(agent.key, agent.stalledSince ?? null);
        for (const question of message.data.questions) this.remember(`question:${question.id}`);
        break;
      case 'agent': {
        const before = this.stalled.get(message.data.key) ?? null;
        const since = message.data.stalledSince ?? null;
        this.stalled.set(message.data.key, since);
        if (before === null && since !== null) this.emit('stalled');
        break;
      }
      case 'agent-gone':
        this.stalled.delete(message.key);
        break;
      case 'question':
        this.question(message.data);
        break;
      case 'message':
        if (isBlockedMessage(message.data)) this.emit('error');
        else if (leadDeliveryFloor(this.store, message.data) !== null) this.emit('delivery');
        break;
      case 'finished':
        this.emit('delivery');
        break;
      case 'alert':
        if (message.data.level === 'alerta') this.emit('error');
        break;
    }
  }

  private question(question: QuestionView): void {
    if (!this.remember(`question:${question.id}`)) return;
    this.emit('question', question.kind === 'permission');
  }

  private remember(tag: string): boolean {
    if (this.seen.has(tag)) return false;
    this.seen.add(tag);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private emit(event: SoundEvent, permission = false): void {
    if (!this.prefs.enabled || !this.prefs.events[event]) return;
    const now = this.clock();
    if (quietSilences(readQuietHours(), permission, new Date(now))) return;
    if (now - this.lastAt < MIN_GAP_MS) return;
    if (now - (this.lastOf.get(event) ?? Number.NEGATIVE_INFINITY) < MERGE_MS) return;
    this.lastAt = now;
    this.lastOf.set(event, now);
    this.engine.play(notesOf(event), this.prefs.volume);
  }
}
