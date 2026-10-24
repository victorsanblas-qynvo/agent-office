import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { PATIENT_TOOLS } from '../../shared/patient-tools';
import { isInside, realPath, type FloorResolver, type ResolvedFloor } from './floors';
import type { OfficeBus } from './office-bus';
import type { SessionRow, Sql } from './office-sql';
import { PERSIST_EVERY_MS, RESTORE_WINDOW_MS, TEAM_CACHE_MS, remember, teamOfSession, type AgentRuntime, type SessionRuntime } from './office-state';
import { taskLine } from './office-texts';
import { isPrivate, publicText, visibleKind } from './privacy';
import { canonicalRole, inOfficeScope, isOfficeRole, isVerdictRole, roleFromName, roleIdOf, roleKind } from './scope';
import { idText, record, text, type Classified, type SpawnCall } from './state-machine';
import type { AgentView, FloorKind, HookEvent, HookMeta, OfficeConfig, SessionView } from './types';

export type SessionBookOpts = {
  sql: Sql;
  now: () => number;
  bus: OfficeBus;
  config: () => OfficeConfig;
  claudeHome: string;
  tokens: (agentKey: string) => AgentView['tokens'];
  flags: (session: SessionRuntime) => { rulesPending: boolean; canRelaunch: boolean; relaunchResumes: boolean };
  restored: (session: SessionRuntime, row: SessionRow) => void;
  floors: FloorResolver;
};

export class SessionBook {
  readonly agents = new Map<string, AgentRuntime>();
  readonly sessions = new Map<string, SessionRuntime>();
  private readonly spawnCalls = new Map<string, SpawnCall>();
  private readonly spawnCallsByName = new Map<string, SpawnCall>();
  private readonly spawnedAgents = new Map<string, SpawnCall>();
  private readonly teammateIds = new Map<string, true>();
  private readonly teamCache = new Map<string, { at: number; members: Record<string, unknown>[] }>();
  private readonly sessionFlags = new Map<string, string>();

  constructor(private readonly opts: SessionBookOpts) {}

  leadSession(team: string | null | undefined): SessionRuntime | null {
    if (!team) return null;
    const prefix = team.replace(/^session-/, '');
    if (!prefix) return null;
    for (const session of this.sessions.values()) {
      if (session.sessionId.startsWith(prefix)) return session;
    }
    return null;
  }

  directorSession(): SessionRuntime | null {
    let found: SessionRuntime | null = null;
    for (const session of this.sessions.values()) {
      if (session.endedAt !== null) continue;
      const role = session.role ?? this.agents.get(session.sessionId)?.role ?? null;
      if (canonicalRole(role) !== 'office-director') continue;
      if (!found || session.updatedAt > found.updatedAt) found = session;
    }
    return found;
  }

  // A session of the office: not in an observed floor, and with an office role of its own or a lead of the office
  // in its team, from the launcher header or from the agent_type of its main agent.
  sessionInOffice(session: SessionRuntime, team: string | null = null): boolean {
    const lead = this.leadSession(team ?? session.team);
    return inOfficeScope({
      floorKind: session.floorKind,
      sessionRole: session.role ?? this.agents.get(session.sessionId)?.role ?? null,
      leadRole: lead ? (lead.role ?? this.agents.get(lead.sessionId)?.role ?? null) : null,
    });
  }

  privacyKind(session: SessionRuntime, team: string | null = null): FloorKind {
    return visibleKind(session.floorKind, this.sessionInOffice(session, team));
  }

  privacyKindOf(agent: AgentRuntime): FloorKind {
    const session = this.sessions.get(agent.sessionId);
    return session ? this.privacyKind(session) : agent.floorKind;
  }

  recipientKey(to: string, from: AgentRuntime): string | null {
    if (this.agents.has(to)) return to;
    if (to === 'main' || to === 'team-lead') {
      if (from.parentKey) return from.parentKey;
      return from.team ? (this.leadSession(from.team)?.sessionId ?? null) : null;
    }
    const named = [...this.agents.values()].filter((a) => a.name === to && a.endedAt === null);
    const sameTeam = named.find(
      (a) => (from.team !== null && a.team === from.team) || a.sessionId === from.sessionId,
    );
    if (sameTeam) return sameTeam.key;
    if (named[0]) return named[0].key;
    for (const session of this.sessions.values()) {
      if (session.name === to && session.endedAt === null) return session.sessionId;
    }
    const at = to.indexOf('@');
    return at > 0 ? this.recipientKey(to.slice(0, at), from) : null;
  }

  roleForEvent(e: HookEvent, session: SessionRuntime): string | null {
    const key = e.agent_id ?? e.session_id;
    const known = this.agents.get(key)?.role ?? null;
    if (isOfficeRole(known)) return canonicalRole(known);
    const type = text(e.agent_type);
    if (isOfficeRole(type)) return canonicalRole(type);
    if (key === e.session_id) return canonicalRole(session.role ?? known);
    if (!type) return null;
    const team = text(e.team_name) ?? session.team ?? teamOfSession(e.session_id);
    const resolved =
      this.teamMemberType(team, type) ??
      this.spawnCallsByName.get(`${e.session_id}:${type}`)?.subagentType ??
      roleFromName(type, session.floor, session.floorKind);
    return canonicalRole(resolved);
  }

  liveTeammate(name: string | null, team: string, sessionId: string): AgentRuntime | null {
    if (!name) return null;
    for (const agent of this.agents.values()) {
      if (agent.name !== name || agent.endedAt !== null || this.isRetired(agent)) continue;
      if (agent.team === team || agent.sessionId === sessionId) return agent;
    }
    return null;
  }

  isRetired(agent: AgentRuntime): boolean {
    if (agent.retiredAt !== null) return true;
    if (!isVerdictRole(agent.role)) return false;
    const row = this.opts.sql.firstVerdictOf.get(agent.key);
    if (!row || row.ts === null) return false;
    agent.retiredAt = row.ts;
    agent.retiredAwake = false;
    agent.state = 'done';
    agent.sentState = 'done';
    agent.stateSince = row.ts;
    if (agent.endedAt === null) agent.endedAt = row.ts;
    this.persistAgent(agent);
    return true;
  }

  private teamMembers(team: string): Record<string, unknown>[] {
    const now = this.opts.now();
    const cached = this.teamCache.get(team);
    if (cached && now - cached.at < TEAM_CACHE_MS) return cached.members;
    let members: Record<string, unknown>[] = [];
    const file = join(this.opts.claudeHome, 'teams', team, 'config.json');
    try {
      if (existsSync(file)) {
        const raw = record(JSON.parse(readFileSync(file, 'utf8'))).members;
        members = Array.isArray(raw) ? raw.map((m) => record(m)) : [];
      }
    } catch {
      members = [];
    }
    this.teamCache.set(team, { at: now, members });
    return members;
  }

  teamMemberIds(team: string, name: string): string[] {
    return this.teamMembers(team)
      .filter((m) => m.name === name)
      .map((m) => idText(m.agentId) ?? idText(m.agent_id) ?? idText(m.id))
      .filter((id): id is string => id !== null);
  }

  private teamMemberType(team: string, name: string): string | null {
    const member = this.teamMembers(team).find((m) => m.name === name);
    const type = member ? (text(member.agentType) ?? text(member.agent_type)) : null;
    return type && type !== 'team-lead' ? type : null;
  }

  persistSession(s: SessionRuntime): void {
    s.persistedAt = this.opts.now();
    this.opts.sql.upsertSession.run(s.sessionId, s.cwd, s.floor, s.role, s.name, s.socket, s.token, s.team, s.startedAt, s.updatedAt, s.endedAt);
  }

  persistTaskOpen(a: AgentRuntime): void {
    if (a.key === a.sessionId) this.opts.sql.updateTaskOpen.run(a.taskOpenSince, a.sessionId);
  }

  persistAgent(a: AgentRuntime): void {
    this.opts.sql.upsertAgent.run(a.key, a.sessionId, a.parentKey, a.name, a.role, a.floor, a.team, a.startedAt, a.updatedAt, a.endedAt);
  }

  private oldestOpenTool(agent: AgentRuntime): { tool: string; since: number } | null {
    let oldest: { tool: string; since: number } | null = null;
    for (const open of this.sessions.get(agent.sessionId)?.openTools.values() ?? []) {
      if (open.agentKey !== agent.key || PATIENT_TOOLS.has(open.tool)) continue;
      if (oldest === null || open.since < oldest.since) oldest = open;
    }
    return oldest;
  }

  view(agent: AgentRuntime, now: number): AgentView {
    const openTool = this.oldestOpenTool(agent);
    let state = agent.state;
    let detail = agent.detail;
    if (agent.endedAt === null && agent.blockedReason) {
      state = 'blocked';
      detail = agent.blockedReason;
    } else if (
      agent.endedAt === null &&
      agent.state === 'asking' &&
      now - agent.stateSince > this.opts.config().blockedAfterMinutes * 60_000
    ) {
      state = 'blocked';
      detail = { key: 'hub.detail.noAnswer', params: { detail: agent.detail } };
    } else if (agent.endedAt === null && agent.state === 'idle' && agent.waiting) {
      detail = { key: 'hub.detail.waitingFor', params: { who: agent.waiting.who, what: agent.waiting.what || '…' } };
    }
    return {
      key: agent.key,
      sessionId: agent.sessionId,
      parentKey: agent.parentKey,
      name: agent.name,
      role: agent.role,
      roleId: roleIdOf(agent.role),
      roleKind: roleKind(agent.role),
      floor: agent.floor,
      touchedFloor: agent.touchedFloor,
      state,
      detail,
      tool: agent.tool,
      lastTest: agent.lastTest,
      stateSince: agent.stateSince,
      updatedAt: agent.updatedAt,
      endedAt: agent.endedAt,
      file: agent.file,
      task: agent.task,
      away: agent.away || agent.endedAt !== null || agent.retiredAt !== null,
      tokens: this.opts.tokens(agent.key),
      waiting: agent.waiting,
      stalledSince: agent.stalledSince,
      toolSince: openTool?.since ?? null,
      openTool: openTool?.tool ?? null,
      context: agent.context,
    };
  }

  sessionView(session: SessionRuntime): SessionView {
    const { rulesPending, canRelaunch, relaunchResumes } = this.opts.flags(session);
    const office = this.sessionInOffice(session);
    return {
      sessionId: session.sessionId,
      agentKey: session.sessionId,
      name: session.name,
      role: session.role,
      floor: session.floor,
      canReceive: session.endedAt === null && !!session.socket && existsSync(session.socket),
      endedAt: session.endedAt,
      needsRelaunch: session.needsRelaunch,
      rulesPending,
      canRelaunch,
      relaunchResumes,
      office,
      cwd: office ? session.cwd : null,
    };
  }

  emitSession(session: SessionRuntime): void {
    const view = this.sessionView(session);
    this.sessionFlags.set(session.sessionId, flagsOf(view));
    this.opts.bus.emit({ type: 'session', data: view });
  }

  emitAgent(agent: AgentRuntime, now: number): void {
    const view = this.view(agent, now);
    agent.sentState = view.state;
    this.opts.bus.emit({ type: 'agent', data: view });
  }

  touchSession(e: HookEvent, meta: HookMeta, now: number): SessionRuntime {
    const cwd = text(e.cwd);
    let session = this.sessions.get(e.session_id);
    let changed = false;
    if (!session) {
      const floor = this.opts.floors.resolve(cwd);
      session = {
        sessionId: e.session_id,
        cwd,
        floor: floor.slug,
        floorKind: floor.kind,
        stack: floor.stack,
        role: null,
        name: null,
        socket: null,
        token: null,
        team: null,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        rulesHash: null,
        launchHash: null,
        needsRelaunch: false,
        persistedAt: now,
        ghost: false,
        openTools: new Map(),
      };
      this.sessions.set(e.session_id, session);
      changed = true;
    } else if (cwd && cwd !== session.cwd) {
      session.cwd = cwd;
      this.applyFloor(session, this.opts.floors.resolve(cwd));
      changed = true;
    }
    for (const field of ['socket', 'token', 'role', 'name'] as const) {
      const value = field === 'role' ? canonicalRole(meta.role) : meta[field];
      if (value && value !== session[field]) {
        session[field] = value;
        changed = true;
      }
    }
    const mainType = e.agent_id ? null : text(e.agent_type);
    if (!session.role && isOfficeRole(mainType)) {
      session.role = canonicalRole(mainType);
      changed = true;
    }
    const title = text(e.session_title);
    if (title && !session.name) {
      session.name = title;
      changed = true;
    }
    const team = text(e.team_name);
    if (team && team !== session.team) {
      session.team = team;
      changed = true;
    }
    if (session.endedAt !== null && (e.hook_event_name === 'SessionStart' || session.ghost)) {
      session.endedAt = null;
      session.ghost = false;
      changed = true;
    }
    session.updatedAt = now;
    // updated_at decides which sessions come back after a restart: a quiet one is written at most once a minute.
    if (changed || now - session.persistedAt >= PERSIST_EVERY_MS) {
      this.persistSession(session);
      if (changed) this.emitSession(session);
    }
    return session;
  }

  applyFloor(session: SessionRuntime, floor: ResolvedFloor): void {
    session.floor = floor.slug;
    session.floorKind = floor.kind;
    session.stack = floor.stack;
  }

  touchAgent(e: HookEvent, c: Classified, session: SessionRuntime, now: number): AgentRuntime {
    let agent = this.agents.get(c.agentKey);
    if (!agent) {
      agent = {
        key: c.agentKey,
        sessionId: e.session_id,
        parentKey: c.parentKey,
        name: null,
        role: null,
        spawnType: null,
        teammate: false,
        team: null,
        floor: session.floor,
        floorKind: session.floorKind,
        touchedFloor: null,
        state: 'idle',
        stateSince: now,
        detail: '',
        tool: null,
        blockedReason: null,
        lastTest: null,
        startedAt: now,
        closing: null,
        updatedAt: now,
        endedAt: null,
        sentState: null,
        retiredAt: null,
        retiredAwake: false,
        awaitingAnswer: false,
        file: null,
        task: null,
        away: false,
        planSlug: null,
        waiting: null,
        taskOpenSince: null,
        stalledSince: null,
        context: null,
      };
      this.agents.set(agent.key, agent);
    }
    const isMain = agent.key === e.session_id;
    agent.floor = session.floor;
    agent.floorKind = session.floorKind;
    if (c.parentKey && !agent.parentKey) agent.parentKey = c.parentKey;
    if (isMain && session.name) agent.name = session.name;
    if (c.team) agent.team = c.team;
    if (c.teammate && (e.hook_event_name === 'TeammateIdle' || e.agent_id)) agent.name = c.teammate;

    if (c.spawnCall?.toolUseId) {
      remember(this.spawnCalls, c.spawnCall.toolUseId, c.spawnCall);
      if (c.spawnCall.name) remember(this.spawnCallsByName, `${e.session_id}:${c.spawnCall.name}`, c.spawnCall);
    }
    if (c.spawned) {
      if (c.spawned.teammate) remember(this.teammateIds, c.spawned.agentId, true);
      const call = this.spawnCalls.get(c.spawned.toolUseId);
      if (call) {
        this.spawnCalls.delete(c.spawned.toolUseId);
        remember(this.spawnedAgents, c.spawned.agentId, call);
      }
      const target = this.agents.get(c.spawned.agentId);
      if (target) {
        if (c.spawned.teammate) target.teammate = true;
        if (call) this.applySpawn(target, call);
        this.emitAgent(target, now);
      }
    }
    if (this.teammateIds.has(agent.key) || e.hook_event_name === 'TeammateIdle') agent.teammate = true;
    const call = this.spawnedAgents.get(agent.key);
    if (call) this.applySpawn(agent, call);
    if (!isMain && !agent.spawnType) this.resolveSpawnType(e, c, agent, session);
    const wasOffice = isOfficeRole(agent.role);
    agent.role = canonicalRole(agent.spawnType ?? c.role ?? agent.role ?? (isMain ? session.role : null));
    if (isMain && !wasOffice && isOfficeRole(agent.role)) this.emitSession(session);

    if (agent.team && !agent.parentKey) {
      const lead = this.leadSession(agent.team);
      if (lead && lead.sessionId !== agent.key) agent.parentKey = lead.sessionId;
    }
    return agent;
  }

  private resolveSpawnType(e: HookEvent, c: Classified, agent: AgentRuntime, session: SessionRuntime): void {
    if (isOfficeRole(c.role)) {
      agent.spawnType = canonicalRole(c.role);
      return;
    }
    const candidate = agent.name ?? c.role;
    if (!candidate) return;
    const team = agent.team ?? session.team ?? teamOfSession(e.session_id);
    const type =
      this.teamMemberType(team, candidate) ??
      this.spawnCallsByName.get(`${e.session_id}:${candidate}`)?.subagentType ??
      roleFromName(candidate, session.floor, session.floorKind);
    if (!type) return;
    agent.spawnType = canonicalRole(type);
    if (!agent.name && candidate !== type) agent.name = candidate;
  }

  private applySpawn(agent: AgentRuntime, call: SpawnCall): void {
    if (!agent.name && call.name) agent.name = call.name;
    if (!agent.task) agent.task = taskLine(publicText(call.description, this.privacyKindOf(agent)));
    if (call.subagentType) {
      agent.spawnType = canonicalRole(call.subagentType);
      agent.role = agent.spawnType;
    }
  }

  touchedFloor(filePath: string, ownFloor: string): string | null {
    const file = realPath(filePath);
    for (const [slug, floor] of Object.entries(this.opts.config().floors)) {
      if (slug !== ownFloor && isInside(file, realPath(floor.path))) return slug;
    }
    return null;
  }

  fileLabel(filePath: string, session: SessionRuntime): string {
    const name = basename(filePath);
    if (isPrivate(this.privacyKind(session))) return name;
    const root = this.opts.floors.resolve(session.cwd).path;
    if (!root) return name;
    const file = realPath(resolve(session.cwd ?? root, filePath));
    const base = realPath(root);
    return file !== base && isInside(file, base) ? relative(base, file) : name;
  }

  restoreSessions(): void {
    for (const row of this.opts.sql.openSessions.all(this.opts.now() - RESTORE_WINDOW_MS)) {
      if (!row.socket || !existsSync(row.socket)) {
        this.opts.sql.endSession.run(this.opts.now(), row.session_id);
        continue;
      }
      const floor = this.opts.floors.resolve(row.cwd);
      const now = this.opts.now();
      this.agents.set(row.session_id, {
        key: row.session_id,
        sessionId: row.session_id,
        parentKey: null,
        name: row.name,
        role: canonicalRole(row.role),
        spawnType: null,
        teammate: false,
        team: row.team,
        floor: floor.slug,
        floorKind: floor.kind,
        touchedFloor: null,
        state: 'idle',
        stateSince: now,
        detail: { key: 'hub.detail.waiting' },
        tool: null,
        blockedReason: null,
        lastTest: null,
        startedAt: row.started_at,
        closing: null,
        updatedAt: now,
        endedAt: null,
        sentState: null,
        retiredAt: null,
        retiredAwake: false,
        awaitingAnswer: false,
        file: null,
        task: null,
        away: false,
        planSlug: null,
        waiting: null,
        taskOpenSince: row.task_open_since,
        stalledSince: null,
        context: null,
      });
      const session: SessionRuntime = {
        sessionId: row.session_id,
        cwd: row.cwd,
        floor: floor.slug,
        floorKind: floor.kind,
        stack: floor.stack,
        role: canonicalRole(row.role),
        name: row.name,
        socket: row.socket,
        token: row.token,
        team: row.team,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        endedAt: null,
        rulesHash: row.rules_hash,
        launchHash: row.launch_hash,
        needsRelaunch: false,
        persistedAt: row.updated_at,
        ghost: false,
        openTools: new Map(),
      };
      this.sessions.set(row.session_id, session);
      this.opts.restored(session, row);
    }
  }

  floorInUse(slug: string): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.floor === slug && session.endedAt === null)
      .map((session) => session.name ?? session.sessionId.slice(0, 8));
  }

  refloor(now: number): void {
    for (const session of this.sessions.values()) {
      const floor = this.opts.floors.resolve(session.cwd);
      if (floor.slug === session.floor && floor.kind === session.floorKind && floor.stack === session.stack) continue;
      this.applyFloor(session, floor);
      this.emitSession(session);
      for (const agent of this.agents.values()) {
        if (agent.sessionId !== session.sessionId) continue;
        agent.floor = session.floor;
        agent.floorKind = session.floorKind;
        this.emitAgent(agent, now);
      }
    }
  }

  refreshFlags(session: SessionRuntime): void {
    if (this.sessionFlags.get(session.sessionId) !== flagsOf(this.sessionView(session))) this.emitSession(session);
  }
}

function flagsOf(view: SessionView): string {
  return `${view.needsRelaunch}|${view.rulesPending}|${view.canRelaunch}|${view.relaunchResumes}|${view.canReceive}|${view.office}|${view.cwd}`;
}
