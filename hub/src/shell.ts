// Runs a command line the user configured (a check, a setup) in its own process group, so a timeout or a
// cancel takes down the whole tree it started.
export type ShellOptions = {
  cwd: string;
  timeoutMs: number;
  tailBytes: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  killGraceMs?: number;
};

export type ShellResult = { code: number | null; timedOut: boolean; cancelled: boolean; tail: string; durationMs: number };

const BUFFER_BYTES = 64 * 1024;

export async function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  const started = Date.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['/bin/sh', '-c', command], {
      cwd: opts.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
      env: { ...process.env, ...opts.env, CI: '1' },
    });
  } catch (error) {
    return { code: null, timedOut: false, cancelled: false, tail: (error as Error).message, durationMs: Date.now() - started };
  }
  const group = proc.pid;
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    signalGroup(group, 'SIGTERM');
    if (killTimer) return;
    killTimer = setTimeout(() => signalGroup(group, 'SIGKILL'), opts.killGraceMs ?? 2000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);
  const onAbort = (): void => {
    cancelled = true;
    stop();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > BUFFER_BYTES) buffer = buffer.slice(buffer.length - BUFFER_BYTES);
    }
  };
  const readers = [read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)];
  try {
    const code = await proc.exited;
    // Anything the command left running in its group goes with it: its pipes would hold the readers open.
    signalGroup(group, 'SIGKILL');
    await Promise.all(readers);
    return { code, timedOut, cancelled, tail: tailOf(buffer, opts.tailBytes), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // The group is already gone.
  }
}

export function tailOf(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  return new TextDecoder().decode(encoded.slice(encoded.length - bytes)).replace(/^�+/, '');
}

export function lastLines(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
