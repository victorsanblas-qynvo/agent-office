import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from './config';
import type { OfficeBus } from './office-bus';
import { RELAUNCH_RESUMES, TMUX_SESSION, resumeCommand, sq } from './office-sh';
import type { SessionRow, Sql } from './office-sql';
import {
  LAUNCH_CHECK_MS,
  RULES_MAX_CHARS,
  SAFE_ID,
  SAFE_NAME,
  type AgentRuntime,
  type LaunchPaths,
  type RelaunchResult,
  type SessionRuntime,
  type TmuxFn,
} from './office-state';
import { RULES_NOTE } from './office-texts';
import { canonicalRole, isOfficeRole } from './scope';
import type { SessionBook } from './session-book';

const RELAUNCH_COOLDOWN_MS = 30_000;

export type RulesDeskOpts = {
  sql: Sql;
  now: () => number;
  bus: OfficeBus;
  book: SessionBook;
  launch?: LaunchPaths;
  tmux?: TmuxFn;
  // Whether the main session has a transcript on disk: without one `claude --resume` exits at once.
  hasTranscript: (sessionId: string) => boolean;
  free: (session: SessionRuntime | undefined, ignoreMain?: boolean) => boolean;
};

export class RulesDesk {
  private readonly tmux: TmuxFn;
  private readonly hashes = new Map<string, { mtime: number; size: number; hash: string | null }>();
  private lastLaunchCheck = 0;
  private readonly relaunching = new Set<string>();
  private readonly relaunchedAt = new Map<string, number>();

  constructor(private readonly opts: RulesDeskOpts) {
    this.tmux = opts.tmux ?? runTmux;
  }

  private fileHash(path: string): string | null {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      this.hashes.delete(path);
      return null;
    }
    const cached = this.hashes.get(path);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.hash;
    let hash: string | null = null;
    try {
      hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    } catch {
      hash = null;
    }
    this.hashes.set(path, { mtime: stat.mtimeMs, size: stat.size, hash });
    return hash;
  }

  private roleOf(session: SessionRuntime): string | null {
    const role = canonicalRole(session.role ?? this.opts.book.agents.get(session.sessionId)?.role ?? null);
    return role && isOfficeRole(role) && SAFE_NAME.test(role) ? role : null;
  }

  private rulesFiles(session: SessionRuntime): string[] {
    const launch = this.opts.launch;
    const role = this.roleOf(session);
    if (!launch || !role) return [];
    return role === 'office-director' ? [join(launch.agentsDir, `${role}.md`), launch.directorFloors] : [join(launch.agentsDir, `${role}.md`)];
  }

  private launchFile(session: SessionRuntime): string | null {
    const launch = this.opts.launch;
    if (!launch || !session.name || !SAFE_NAME.test(session.name) || !this.roleOf(session)) return null;
    return join(launch.sessionsDir, `${session.name}.sh`);
  }

  private rulesHash(session: SessionRuntime): string | null {
    const files = this.rulesFiles(session);
    const hashes = files.map((file) => this.fileHash(file));
    if (hashes.length === 0 || hashes[0] === null) return null;
    return createHash('sha256').update(hashes.map((hash) => hash ?? '-').join(':')).digest('hex').slice(0, 16);
  }

  private rulesText(session: SessionRuntime): string | null {
    const files = this.rulesFiles(session);
    if (files.length === 0) return null;
    const parts: string[] = [];
    for (const [index, file] of files.entries()) {
      try {
        const content = readFileSync(file, 'utf8');
        parts.push((index === 0 ? withoutFrontmatter(content) : content).trim());
      } catch {
        if (index === 0) return null;
      }
    }
    return parts.join('\n\n');
  }

  private rulesCopy(session: SessionRuntime): string | null {
    const launch = this.opts.launch;
    if (!launch || !session.name || !SAFE_NAME.test(session.name)) return null;
    return join(dirname(launch.sessionsDir), 'rules', `${session.name}.md`);
  }

  private readRulesCopy(session: SessionRuntime): string | null {
    const file = this.rulesCopy(session);
    if (!file) return null;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  private saveRulesCopy(session: SessionRuntime): void {
    const file = this.rulesCopy(session);
    const rules = this.rulesText(session);
    if (!file || rules === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeAtomic(file, rules, 0o600);
    } catch {
      return;
    }
  }

  setBaseline(session: SessionRuntime): void {
    if (!this.opts.launch) return;
    const script = this.launchFile(session);
    session.rulesHash = this.rulesHash(session);
    session.launchHash = script ? this.fileHash(script) : null;
    session.needsRelaunch = false;
    this.saveRulesCopy(session);
    this.opts.sql.updateHashes.run(session.rulesHash, session.launchHash, session.sessionId);
    this.opts.book.emitSession(session);
  }

  rulesBlock(agent: AgentRuntime, session: SessionRuntime): string | null {
    if (session.rulesHash === null || !this.rulesPending(session)) return null;
    const rules = this.rulesText(session);
    const current = this.rulesHash(session);
    if (rules === null || current === null) return null;
    const base = this.readRulesCopy(session);
    session.rulesHash = current;
    this.opts.sql.updateHashes.run(session.rulesHash, session.launchHash, session.sessionId);
    this.saveRulesCopy(session);
    this.opts.book.emitSession(session);
    if (base === rules) return null;
    const body = base !== null && rules.length > RULES_MAX_CHARS ? changedSections(rules, base) : rules;
    this.opts.bus.pushActivity({
      ts: this.opts.now(),
      agentKey: agent.key,
      event: 'Rules',
      tool: null,
      state: null,
      summary: { key: 'hub.act.rulesReloaded', params: { who: agent.name ?? agent.key } },
    });
    return `${RULES_NOTE}\n\n${body}`;
  }

  rulesPending(session: SessionRuntime): boolean {
    if (session.rulesHash === null) return false;
    const current = this.rulesHash(session);
    return current !== null && current !== session.rulesHash;
  }

  private relaunchNeeded(session: SessionRuntime): boolean {
    if (!this.opts.launch || session.launchHash === null) return false;
    const script = this.launchFile(session);
    return !script || this.fileHash(script) !== session.launchHash;
  }

  refreshSessionFlags(now: number, force = false): void {
    if (!this.opts.launch) return;
    const due = force || now - this.lastLaunchCheck >= LAUNCH_CHECK_MS;
    if (due) this.lastLaunchCheck = now;
    for (const session of this.opts.book.sessions.values()) {
      if (session.endedAt !== null) continue;
      if (due) session.needsRelaunch = this.relaunchNeeded(session);
      this.opts.book.refreshFlags(session);
    }
  }

  async relaunch(sessionId: string, resume: boolean = RELAUNCH_RESUMES): Promise<RelaunchResult> {
    const session = this.opts.book.sessions.get(sessionId);
    if (!session || session.endedAt !== null) return 'not-found';
    if (!this.opts.book.sessionInOffice(session)) return 'not-office';
    const script = this.launchFile(session);
    if (!script || !existsSync(script)) return 'no-script';
    if (!this.opts.free(session)) return 'busy';
    if (resume && !SAFE_ID.test(sessionId)) return 'failed';
    const name = session.name ?? '';
    if (this.relaunching.has(name) || this.opts.now() - (this.relaunchedAt.get(name) ?? -Infinity) < RELAUNCH_COOLDOWN_MS || this.hasNewer(session)) return 'busy';
    this.relaunching.add(name);
    try {
      return await this.respawn(sessionId, name, script, resume);
    } finally {
      this.relaunching.delete(name);
    }
  }

  private hasNewer(session: SessionRuntime): boolean {
    for (const other of this.opts.book.sessions.values()) {
      if (other.sessionId !== session.sessionId && other.endedAt === null && other.name === session.name && other.startedAt > session.startedAt) return true;
    }
    return false;
  }

  private async respawn(sessionId: string, name: string, script: string, resume: boolean): Promise<RelaunchResult> {
    let windows: { code: number; stdout: string };
    try {
      windows = await this.tmux(['list-windows', '-t', TMUX_SESSION, '-F', '#{window_name}']);
    } catch {
      return 'no-tmux';
    }
    if (windows.code !== 0) return 'no-tmux';
    if (!windows.stdout.split('\n').some((line) => line.trim() === name)) return 'no-window';
    const command = resume && this.opts.hasTranscript(sessionId) ? resumeCommand(script, sessionId) : sq(script);
    try {
      const respawned = await this.tmux(['respawn-window', '-k', '-t', `${TMUX_SESSION}:=${name}`, command]);
      if (respawned.code !== 0) return 'failed';
    } catch {
      return 'failed';
    }
    this.relaunchedAt.set(name, this.opts.now());
    this.opts.bus.pushActivity({ ts: this.opts.now(), agentKey: sessionId, event: 'Relaunch', tool: null, state: null, summary: { key: 'hub.act.relaunched', params: { who: name } } });
    return 'ok';
  }

  restored(session: SessionRuntime, row: SessionRow): void {
    if (this.opts.launch && (row.rules_hash === null || row.launch_hash === null)) {
      session.rulesHash ??= this.rulesHash(session);
      const script = this.launchFile(session);
      session.launchHash ??= script ? this.fileHash(script) : null;
      this.opts.sql.updateHashes.run(session.rulesHash, session.launchHash, session.sessionId);
    }
    session.needsRelaunch = this.relaunchNeeded(session);
  }

  flags(session: SessionRuntime): { rulesPending: boolean; canRelaunch: boolean; relaunchResumes: boolean } {
    const script = this.launchFile(session);
    return {
      rulesPending: this.rulesPending(session),
      canRelaunch: session.endedAt === null && script !== null && existsSync(script) && this.opts.free(session),
      relaunchResumes: RELAUNCH_RESUMES && SAFE_ID.test(session.sessionId) && this.opts.hasTranscript(session.sessionId),
    };
  }
}

function withoutFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function sectionsOf(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const chunk of content.split(/^(?=## )/m)) sections.set(chunk.split('\n')[0] ?? '', chunk.trim());
  return sections;
}

function changedSections(current: string, base: string): string {
  const before = sectionsOf(base);
  const changed = [...sectionsOf(current)].filter(([heading, body]) => before.get(heading) !== body).map(([, body]) => body);
  return changed.length > 0 ? changed.join('\n\n') : current.slice(0, RULES_MAX_CHARS);
}

async function runTmux(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}
