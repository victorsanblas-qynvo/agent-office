import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { SCHEMA_VERSION } from './db';
import type { Office } from './office';
import type { DiagnosticsView } from './types';

export const HOOK_SAMPLES = 500;
export const LOG_TAIL_LINES = 50;
export const LOG_TAIL_BYTES = 64 * 1024;
const REDACTED = '[redactado]';

// Fixed-size ring of the latest samples: recording never allocates.
export class SampleRing {
  private readonly buffer: Float64Array;
  private next = 0;
  private filled = 0;

  constructor(readonly capacity: number = HOOK_SAMPLES) {
    this.buffer = new Float64Array(capacity);
  }

  record(value: number): void {
    this.buffer[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  get count(): number {
    return this.filled;
  }

  samples(): number[] {
    return Array.from(this.buffer.subarray(0, this.filled));
  }
}

// Nearest-rank percentiles; null for every one when there are no samples.
export function percentiles(samples: readonly number[], points: readonly number[]): (number | null)[] {
  if (samples.length === 0) return points.map(() => null);
  const sorted = [...samples].sort((a, b) => a - b);
  return points.map((point) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((point / 100) * sorted.length) - 1))] ?? null);
}

// The office key, the key header, bearer tokens, password-like key=value pairs, a mysql -p password, the
// credentials of a url, PEM blocks and long hex or base64 runs never leave the hub. A run that starts with a slash is an absolute path, kept readable.
export function redactLog(text: string, key: string): string {
  let out = key.length > 0 ? text.split(key).join(REDACTED) : text;
  out = out.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, REDACTED);
  out = out.replace(/x-office-(?:key|panel)\s*[:=]\s*\S+/gi, REDACTED);
  out = out.replace(/Bearer\s+\S+/gi, REDACTED);
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/_-]{8,}={0,2}/g, REDACTED);
  out = out.replace(/--password(?:=|\s+)\S+/gi, `--password ${REDACTED}`);
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/gi, `$1${REDACTED}@`);
  out = out.replace(/([\w-]*(?:pass(?:word)?|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|auth)[\w-]*)(["']?\s*[:=]\s*)\S+/gi, `$1$2${REDACTED}`);
  out = out.replace(/(\b(?:mysql\w*|mariadb[\w-]*)\b[^\n]*?\s-p)\S+/g, `$1${REDACTED}`);
  out = out.replace(/[0-9a-fA-F]{32,}/g, REDACTED);
  return out.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) && !run.startsWith('/') ? REDACTED : run));
}

export function tailLines(text: string, count: number): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count);
}

// The last `bytes` of a file, without the line the cut may have split.
export function readTail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (got === 0) break;
      read += got;
    }
    const raw = buffer.subarray(0, read).toString('utf8');
    if (start === 0) return raw;
    const newline = raw.indexOf('\n');
    return newline < 0 ? '' : raw.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function version(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export type DiagnosticsInput = { office: Office; hook: SampleRing; key: string; logFile?: string; startedAt: number; now?: number };

export function collectDiagnostics(input: DiagnosticsInput): DiagnosticsView {
  const facts = input.office.diagnostics();
  const onDisk = facts.dbFile !== '' && facts.dbFile !== ':memory:';
  const [p50, p95, p99] = percentiles(input.hook.samples(), [50, 95, 99]);
  let logTail: string[] = [];
  if (input.logFile) {
    try {
      logTail = tailLines(redactLog(readTail(input.logFile, LOG_TAIL_BYTES), input.key), LOG_TAIL_LINES);
    } catch {}
  }
  return {
    version: version(),
    schema: SCHEMA_VERSION,
    uptimeMs: (input.now ?? Date.now()) - input.startedAt,
    dbBytes: onDisk ? sizeOf(facts.dbFile) + sizeOf(`${facts.dbFile}-wal`) : null,
    fts: facts.fts,
    hook: { count: input.hook.count, p50: p50 ?? null, p95: p95 ?? null, p99: p99 ?? null },
    activeCheckRuns: facts.activeCheckRuns,
    worktrees: facts.worktrees,
    sessions: facts.sessions,
    logTail,
  };
}
