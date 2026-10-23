export type GitResult = { code: number; stdout: string; stderr: string; cut?: boolean };

// maxStdoutBytes stops reading once the output passes it: the process is killed and the result carries the
// first bytes with cut set.
export type GitLimits = { maxStdoutBytes?: number };

// input is written to the stdin of the command (pathspec lists); without it the command reads nothing.
export type GitRunner = (cwd: string, args: string[], timeoutMs?: number, input?: string, limits?: GitLimits) => Promise<GitResult>;

// Variables that would point git at another repository, index or object store than the one in cwd.
const FOREIGN_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];

function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of FOREIGN_GIT_ENV) delete env[name];
  return env;
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number, stop: () => void): Promise<{ text: string; cut: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), cut: false };
    if (size + value.byteLength > max) {
      text += decoder.decode(value.subarray(0, max - size), { stream: true });
      stop();
      await reader.cancel().catch(() => undefined);
      return { text, cut: true };
    }
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

export const runGit: GitRunner = async (cwd, args, timeoutMs = 60_000, input, limits) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['git', '-C', cwd, ...args], {
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
    });
  } catch (error) {
    return { code: -1, stdout: '', stderr: (error as Error).message };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const max = limits?.maxStdoutBytes;
  try {
    const [out, stderr, exited] = await Promise.all([
      max === undefined
        ? new Response(proc.stdout as ReadableStream).text().then((text) => ({ text, cut: false }))
        : readCapped(proc.stdout as ReadableStream<Uint8Array>, max, () => proc.kill()),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (out.cut) return { code: proc.signalCode === null ? exited : 0, stdout: out.text, stderr, cut: true };
    return { code: exited, stdout: out.text, stderr };
  } finally {
    clearTimeout(timer);
  }
};

export function gitSync(cwd: string, args: string[]): GitResult {
  try {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (error) {
    return { code: -1, stdout: '', stderr: (error as Error).message };
  }
}

export class GitQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
