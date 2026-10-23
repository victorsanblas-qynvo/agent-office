import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { redactLog } from './diagnostics';
import { record, text } from './state-machine';
import type { TranscriptEntry } from './types';

export const TAIL_BYTES = 256 * 1024;
export const TAIL_LIMIT_BYTES = 2 * 1024 * 1024;
export const TAIL_DEFAULT = 20;
export const TAIL_MAX = 50;
const TEXT_CHARS = 500;
const LINE_CHARS = 200;
const INPUT_FIELDS = ['command', 'file_path', 'pattern', 'url'] as const;

export function clampTail(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(TAIL_MAX, Math.max(1, n)) : TAIL_DEFAULT;
}

// The last bytes of the file, without the line the cut may have split; when the cut leaves no whole line, the read goes
// further back, reading only the bytes not read yet.
function tailText(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    let have = Buffer.alloc(0);
    let start = size;
    for (let bytes = TAIL_BYTES; ; bytes += TAIL_BYTES) {
      const next = Math.max(0, size - bytes);
      const chunk = Buffer.alloc(start - next);
      let read = 0;
      while (read < chunk.length) {
        const got = readSync(fd, chunk, read, chunk.length - read, next + read);
        if (got === 0) break;
        read += got;
      }
      have = Buffer.concat([chunk.subarray(0, read), have]);
      start = next;
      if (start === 0) return have.toString('utf8');
      const newline = have.indexOf(10);
      const whole = newline < 0 ? '' : have.subarray(newline + 1).toString('utf8');
      if (whole.trim() !== '' || bytes >= TAIL_LIMIT_BYTES) return whole;
    }
  } finally {
    closeSync(fd);
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function firstLine(value: string): string {
  return clip(value.trim().split('\n')[0] ?? '', LINE_CHARS);
}

function toolSummary(block: Record<string, unknown>): string {
  const name = text(block.name) ?? 'tool';
  const input = record(block.input);
  for (const field of INPUT_FIELDS) {
    const value = text(input[field]);
    if (value) return `${name}: ${firstLine(value)}`;
  }
  return name;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    const piece = record(part);
    if (piece.type === 'text' && typeof piece.text === 'string') return piece.text;
  }
  return '';
}

function entriesOf(line: Record<string, unknown>, key: string): TranscriptEntry[] {
  const kind = line.type;
  if (kind !== 'assistant' && kind !== 'user') return [];
  const parsed = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
  const ts = Number.isFinite(parsed) ? parsed : 0;
  const content = record(line.message).content;
  const out: TranscriptEntry[] = [];
  const push = (role: TranscriptEntry['role'], value: string): void => {
    if (value.trim() !== '') out.push({ ts, role, text: redactLog(value, key) });
  };
  if (typeof content === 'string') {
    if (kind === 'user') push('user', clip(content.trim(), TEXT_CHARS));
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const raw of content) {
    const block = record(raw);
    if (kind === 'assistant' && block.type === 'text' && typeof block.text === 'string') push('assistant', clip(block.text.trim(), TEXT_CHARS));
    else if (kind === 'assistant' && block.type === 'tool_use') push('tool', toolSummary(block));
    else if (kind === 'user' && block.type === 'tool_result') {
      const first = firstLine(resultText(block.content));
      if (first) push('tool', `↳ ${first}`);
    } else if (kind === 'user' && block.type === 'text' && typeof block.text === 'string') push('user', clip(block.text.trim(), TEXT_CHARS));
  }
  return out;
}

// The last n steps of a transcript as plain text: no thinking, no tool output past its first line, secrets redacted.
export function readTranscriptTail(file: string, n: number, key: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const raw of tailText(file).split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    entries.push(...entriesOf(record(parsed), key));
  }
  return entries.slice(-n);
}
