import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILES_DIR, defaultConfig, paths, type Paths } from '../src/config';
import type { Database } from 'bun:sqlite';
import { openDb } from '../src/db';
import { memoryRegistry } from '../src/floors';
import { Office, type OfficeOptions } from '../src/office';
import { loadProfiles } from '../src/profiles';
import type { HookEvent, HubText, OfficeConfig, ServerMessage } from '../src/types';

// The key of a hub text, or the raw text itself: HubText includes string, so .key alone does not compile.
export function keyOf(value: HubText): string {
  return typeof value === 'string' ? value : value.key;
}

export function tempDir(prefix = 'agent-office-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function fakePaths(root: string): Paths {
  const p = paths({ AGENT_OFFICE_HOME: join(root, 'office-home'), AGENT_OFFICE_CLAUDE_HOME: join(root, 'claude-home') });
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.claudeHome, { recursive: true });
  return p;
}

export function makeRepo(root: string, name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

export function loadFixture(name: string, cwd: string): HookEvent[] {
  const raw = readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8').replaceAll('__CWD__', cwd);
  return JSON.parse(raw) as HookEvent[];
}

export type Harness = {
  office: Office;
  db: Database;
  messages: ServerMessage[];
  clock: { now: number; advance(ms: number): void };
  config: OfficeConfig;
  root: string;
  workspace: string;
  cleanup: () => void;
  close: () => Promise<void>;
};

export function testConfig(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
  return { ...defaultConfig(), docsRepo: '/nonexistent/office-docs', departments: { redaccion: false, mantenimiento: false }, ...overrides };
}

export function floor(path: string, managed = true, stack: OfficeConfig['floors'][string]['stack'] = 'flutter') {
  return { path, stack, managed, baseBranch: 'develop' };
}

export function harness(
  overrides: Partial<OfficeOptions> & { floors?: OfficeConfig['floors']; configure?: (config: OfficeConfig, root: string) => void } = {},
): Harness {
  const { dir, cleanup } = tempDir();
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = testConfig({ floors: overrides.floors ?? {}, docsRepo: join(dir, 'docs') });
  overrides.configure?.(config, dir);
  const clock = {
    now: 1_800_000_000_000,
    advance(ms: number) {
      this.now += ms;
    },
  };
  const db = openDb(':memory:');
  const { configure: _configure, floors: _floors, ...options } = overrides;
  const office = new Office({
    hubId: 'hub-test',
    db,
    config,
    profiles: loadProfiles(PROFILES_DIR),
    workspaceDir: workspace,
    claudeHome: join(dir, 'claude-home'),
    registry: memoryRegistry(),
    gitRoot: (cwd) => cwd,
    stackOf: () => 'flutter',
    now: () => clock.now,
    ...options,
  });
  const messages: ServerMessage[] = [];
  office.subscribe((msg) => messages.push(msg));
  return {
    office,
    db,
    messages,
    clock,
    config,
    root: dir,
    workspace,
    cleanup: () => {
      office.stop();
      cleanup();
    },
    close: async () => {
      office.stop();
      await office.idle();
      cleanup();
    },
  };
}

export function ev(sessionId: string, cwd: string, hook: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { session_id: sessionId, cwd, hook_event_name: hook, ...extra };
}

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'office',
  GIT_AUTHOR_EMAIL: 'office@test',
  GIT_COMMITTER_NAME: 'office',
  GIT_COMMITTER_EMAIL: 'office@test',
};

export function useGitIdentity(): void {
  Object.assign(process.env, GIT_ENV);
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export function originAndClone(root: string, name = 'mobile'): { seed: string; origin: string; repo: string } {
  const seed = join(root, `${name}-seed`);
  const origin = join(root, `${name}-origin.git`);
  const repo = join(root, name);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'develop');
  writeFileSync(join(seed, 'README.md'), '# app\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'inicio');
  git(root, 'clone', '-q', '--bare', seed, origin);
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'checkout', '-q', '-b', 'feature/local');
  return { seed, origin, repo };
}

export function pushCommit(seed: string, origin: string, file: string, content: string, message: string): string {
  writeFileSync(join(seed, file), content);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', message);
  git(seed, 'push', '-q', origin, 'develop');
  return git(seed, 'rev-parse', 'HEAD');
}
