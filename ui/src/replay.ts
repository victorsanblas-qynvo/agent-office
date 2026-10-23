import { button, el } from './dom';
import { fileStamp, saveFile } from './download';
import { t, type MessageKey } from './i18n';
import { errorText } from './i18n/hub';
import { isTypingTarget } from './keys';
import type { Store } from './store';
import type { Recording, ServerMessage } from './types';

export const REPLAY_SPEEDS = [1, 4, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

const MAX_FRAME_MS = 250;
export const MAX_REPLAY_EVENTS = 20_000;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const REPLAY_FORMAT = 'agent-office-replay';
export const SEEK_STEP_MS = 10_000;
export const SEEK_BIG_STEP_MS = 60_000;

function isRecording(value: unknown): value is Recording {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.startedAt === 'number' && Array.isArray(record.messages);
}

export type ParsedRecording = { ok: true; recording: Recording } | { ok: false; error: MessageKey };

// Pure: a recording from the text of an exported file, or the key of what is wrong with it. Events come out sorted by time.
export function parseRecording(text: string): ParsedRecording {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'replay.import.badJson' };
  }
  if (!isRecording(data) || (data as { format?: unknown }).format !== REPLAY_FORMAT) return { ok: false, error: 'replay.import.badFormat' };
  if (data.messages.length > MAX_REPLAY_EVENTS) return { ok: false, error: 'replay.import.tooMany' };
  const valid = data.messages.every((entry) => typeof entry === 'object' && entry !== null && Number.isFinite(entry.t) && typeof entry.msg === 'object' && entry.msg !== null && typeof entry.msg.type === 'string');
  if (!valid) return { ok: false, error: 'replay.import.badFormat' };
  return { ok: true, recording: { version: 1, startedAt: data.startedAt, messages: [...data.messages].sort((a, b) => a.t - b.t) } };
}

// Pure: the text of the exported file.
export function serializeRecording(recording: Recording): string {
  return JSON.stringify({ format: REPLAY_FORMAT, ...recording });
}

// Pure: where to resume after jumping to targetTs (the first message not yet delivered) and the messages that rebuild the state
// from the initial snapshot up to that point.
export function seekTo(messages: Recording['messages'], targetTs: number): { index: number; apply: ServerMessage[] } {
  const index = indexAt(messages, targetTs);
  return { index, apply: messages.slice(0, index).map((entry) => entry.msg) };
}

function indexAt(messages: Recording['messages'], targetTs: number): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (messages[mid].t <= targetTs) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Pure: seeking forwards applies only the messages between the two indexes; seeking backwards starts from the snapshot again.
export function seekPlan(current: number, target: number): { reset: boolean; from: number; to: number } {
  const reset = target < current;
  return { reset, from: reset ? 0 : current, to: target };
}

// Pure: the recording time under a pointer, from its x and the bar's left edge and width.
export function timeAt(x: number, left: number, width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return 0;
  return Math.min(1, Math.max(0, (x - left) / width)) * duration;
}

// Pure: how far the key jumps in recording time, or null when it is not a seek key here.
export function seekKeyDelta(key: string, shift: boolean, typing: boolean): number | null {
  if (typing || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return null;
  return (key === 'ArrowLeft' ? -1 : 1) * (shift ? SEEK_BIG_STEP_MS : SEEK_STEP_MS);
}

async function failure(response: Response): Promise<Error> {
  try {
    const body: unknown = await response.json();
    const text = typeof body === 'object' && body !== null ? errorText(t, (body as { error?: unknown }).error) : null;
    if (text) return new Error(text);
  } catch {}
  return new Error(`HTTP ${response.status}`);
}

// Pure: the URL to fetch for ?replay=<url>. For a recording the hub builds, compress=1 of the page goes with it.
export function replayFetchUrl(url: string, search: URLSearchParams): string {
  if (!url.startsWith('/api/') || search.get('compress') !== '1' || /[?&]compress=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}compress=1`;
}

// token: the panel credential, sent only to the hub's own /api/ routes (a recording on disk gets none).
export async function loadRecording(url: string, token: string | null = null): Promise<Recording> {
  const response = await fetch(url, token && url.startsWith('/api/') ? { headers: { 'X-Office-Panel': token } } : undefined);
  if (response.status === 401) throw new Error(t('auth.expired'));
  if (!response.ok) throw await failure(response);
  const data: unknown = await response.json();
  if (!isRecording(data)) throw new Error(t('replay.badFormat'));
  return { ...data, messages: [...data.messages].sort((a, b) => a.t - b.t) };
}

export class ReplayPlayer {
  speed: ReplaySpeed = 1;
  playing = false;
  elapsed = 0;

  private index = 0;
  private lastFrame = 0;
  private frame = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    public recording: Recording,
    private readonly store: Store,
  ) {
    store.setReplay(true);
    store.setConnection('replay');
    store.setClock(() => this.recording.startedAt + this.elapsed);
  }

  get duration(): number {
    const last = this.recording.messages[this.recording.messages.length - 1];
    return last ? last.t : 0;
  }

  get finished(): boolean {
    return this.index >= this.recording.messages.length;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.deliver();
    this.play();
  }

  play(): void {
    if (this.playing) return;
    if (this.finished && this.elapsed > 0) this.rewind();
    this.playing = true;
    this.lastFrame = performance.now();
    this.frame = requestAnimationFrame(this.step);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
    this.emit();
  }

  restart(): void {
    const wasPlaying = this.playing;
    this.pause();
    this.rewind();
    this.deliver();
    if (wasPlaying) this.play();
    else this.emit();
  }

  load(recording: Recording): void {
    const wasPlaying = this.playing;
    this.pause();
    this.recording = recording;
    this.rewind();
    this.deliver();
    if (wasPlaying) this.play();
    else this.emit();
  }

  seek(target: number): void {
    const to = Math.min(Math.max(0, target), this.duration);
    const { messages } = this.recording;
    const plan = seekPlan(this.index, indexAt(messages, to));
    if (plan.reset) this.store.reset();
    this.elapsed = to;
    this.index = plan.to;
    for (let at = plan.from; at < plan.to; at += 1) this.store.apply(messages[at].msg);
    this.lastFrame = performance.now();
    this.emit();
  }

  private rewind(): void {
    this.store.reset();
    this.elapsed = 0;
    this.index = 0;
  }

  private readonly step = (time: number): void => {
    const delta = Math.min(time - this.lastFrame, MAX_FRAME_MS);
    this.lastFrame = time;
    this.elapsed += delta * this.speed;
    this.deliver();
    if (this.finished) {
      this.elapsed = Math.min(this.elapsed, this.duration);
      this.playing = false;
    } else {
      this.frame = requestAnimationFrame(this.step);
    }
    this.emit();
  };

  private deliver(): void {
    const { messages } = this.recording;
    while (this.index < messages.length && messages[this.index].t <= this.elapsed) {
      this.store.apply(messages[this.index].msg);
      this.index += 1;
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function mountReplayControls(host: HTMLElement, player: ReplayPlayer, store: Store): void {
  const label = el('span', 'replay-label');
  const restart = button('↺', 'icon-button');
  const toggle = button('', 'icon-button primary');
  const speeds = REPLAY_SPEEDS.map((speed) => {
    const speedButton = button(`${speed}x`, 'speed-button');
    speedButton.addEventListener('click', () => player.setSpeed(speed));
    return speedButton;
  });
  const fill = el('div', 'replay-progress-fill');
  const bar = el('div', 'replay-progress', fill);
  const hover = el('span', 'replay-hover');
  hover.hidden = true;
  const seekBox = el('div', 'replay-seek', bar, hover);
  const time = el('span', 'replay-time');
  const exportButton = button('', 'speed-button');
  const importButton = button('', 'speed-button');
  const picker = el('input');
  picker.type = 'file';
  picker.accept = '.json,application/json';
  picker.hidden = true;
  let dragging: number | null = null;

  restart.addEventListener('click', () => player.restart());
  toggle.addEventListener('click', () => player.toggle());

  const preview = (clientX: number): number => {
    const rect = bar.getBoundingClientRect();
    const target = timeAt(clientX, rect.left, rect.width, player.duration);
    hover.hidden = false;
    hover.textContent = mmss(target);
    hover.style.left = `${Math.min(rect.width, Math.max(0, clientX - rect.left))}px`;
    return target;
  };
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    bar.setPointerCapture(event.pointerId);
    dragging = preview(event.clientX);
    render();
    event.preventDefault();
  });
  bar.addEventListener('pointermove', (event) => {
    const target = preview(event.clientX);
    if (dragging === null) return;
    dragging = target;
    render();
  });
  bar.addEventListener('pointerup', (event) => {
    if (dragging === null) return;
    const rect = bar.getBoundingClientRect();
    const target = timeAt(event.clientX, rect.left, rect.width, player.duration);
    dragging = null;
    player.seek(target);
  });
  bar.addEventListener('pointercancel', () => {
    dragging = null;
    hover.hidden = true;
    render();
  });
  bar.addEventListener('pointerleave', () => {
    if (dragging === null) hover.hidden = true;
  });
  bar.addEventListener('lostpointercapture', () => {
    hover.hidden = true;
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const delta = seekKeyDelta(event.key, event.shiftKey, isTypingTarget(event.target));
    if (delta === null) return;
    event.preventDefault();
    player.seek(player.elapsed + delta);
  });

  exportButton.addEventListener('click', () => saveFile(`agent-office-replay-${fileStamp(new Date())}.json`, serializeRecording(player.recording), 'application/json'));
  importButton.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      store.toast(t('replay.import.tooLarge'), 'error');
      return;
    }
    file
      .text()
      .then((text) => {
        const parsed = parseRecording(text);
        if (parsed.ok) player.load(parsed.recording);
        else store.toast(t(parsed.error), 'error');
      })
      .catch(() => store.toast(t('replay.import.badJson'), 'error'));
  });

  host.replaceChildren(label, restart, toggle, ...speeds, seekBox, time, exportButton, importButton, picker);

  const render = (): void => {
    label.textContent = t('replay.label');
    restart.title = t('replay.restart');
    toggle.textContent = player.playing ? '❚❚' : '▶';
    toggle.title = player.playing ? t('replay.pause') : t('replay.play');
    speeds.forEach((speedButton, index) => {
      speedButton.title = t('replay.speed', { n: REPLAY_SPEEDS[index] });
      speedButton.classList.toggle('active', REPLAY_SPEEDS[index] === player.speed);
    });
    exportButton.textContent = t('replay.export');
    exportButton.title = t('replay.export.hint');
    importButton.textContent = t('replay.import');
    importButton.title = t('replay.import.hint');
    const duration = player.duration;
    const shown = dragging ?? player.elapsed;
    fill.style.width = duration > 0 ? `${Math.min(100, (shown / duration) * 100)}%` : '0%';
    time.textContent = `${mmss(shown)} / ${mmss(duration)}`;
  };

  player.onChange(render);
  store.watch(['lang'], render);
}
