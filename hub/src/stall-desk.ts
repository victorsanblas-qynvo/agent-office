import type { OfficeBus } from './office-bus';
import { GHOST_MS, GHOST_TOOL_MS, LEAD_BUSY, type AgentRuntime, type SessionRuntime } from './office-state';
import { parseWaiting } from './protocol';
import type { QuestionDesk } from './questions';
import { isLeadRole } from './scope';
import type { SessionBook } from './session-book';
import { BLOCK_PREFIX, DONE_PREFIX, text, type Classified } from './state-machine';
import type { HookEvent, OfficeConfig } from './types';

export type StallDeskOpts = {
  now: () => number;
  bus: OfficeBus;
  book: SessionBook;
  config: () => OfficeConfig;
  desk: QuestionDesk;
};

export class StallDesk {
  constructor(private readonly opts: StallDeskOpts) {}

  // A PreToolUse with no PostToolUse yet is a tool still running (a long build): such a session is not a ghost for hours.
  trackOpenTools(e: HookEvent, c: Classified, session: SessionRuntime, now: number): void {
    const open = session.openTools;
    const id = text(e.tool_use_id) ?? `${c.agentKey}:${c.tool ?? ''}`;
    if (c.event === 'PreToolUse' && c.tool) {
      open.set(id, { agentKey: c.agentKey, tool: c.tool, since: now });
    } else if (c.event === 'PostToolUse' || c.event === 'PostToolUseFailure') {
      open.delete(id);
    } else if (c.event === 'UserPromptSubmit' || c.event === 'Stop' || c.event === 'SessionStart' || c.event === 'SessionEnd') {
      open.clear();
    } else if (c.event === 'SubagentStop' || c.event === 'TeammateIdle') {
      for (const [key, tool] of open) if (tool.agentKey === c.agentKey) open.delete(key);
    }
  }

  openTask(agent: AgentRuntime, now: number): void {
    agent.taskOpenSince = now;
    agent.waiting = null;
    agent.stalledSince = null;
    this.opts.book.persistTaskOpen(agent);
  }

  closeTask(agent: AgentRuntime): void {
    agent.taskOpenSince = null;
    agent.stalledSince = null;
    this.opts.book.persistTaskOpen(agent);
  }

  declareWaiting(agent: AgentRuntime, rest: string, now: number): boolean {
    if (agent.retiredAt !== null) return false;
    const { who, what } = parseWaiting(rest);
    if (!who || (agent.waiting?.who === who && agent.waiting.what === what)) return false;
    agent.waiting = { who, what, since: now };
    agent.stalledSince = null;
    this.opts.bus.pushActivity({
      ts: now,
      agentKey: agent.key,
      event: 'Waiting',
      tool: 'SendMessage',
      state: null,
      summary: { key: 'hub.act.waitingDeclared', params: { who: agent.name ?? agent.key, to: who, what } },
    });
    return true;
  }

  settleWaiting(from: AgentRuntime, recipient: AgentRuntime | undefined, body: string | null, now: number): void {
    if (from.waiting && body && (DONE_PREFIX.test(body) || BLOCK_PREFIX.test(body))) {
      from.waiting = null;
      this.opts.book.emitAgent(from, now);
    }
    if (recipient && recipient !== from && recipient.waiting && waitsFor(recipient.waiting.who, from)) {
      recipient.waiting = null;
      this.opts.book.emitAgent(recipient, now);
    }
  }

  detectStalls(now: number): void {
    const minutes = this.opts.config().limits.stalledAfterMinutes;
    for (const agent of this.opts.book.agents.values()) {
      if (agent.key !== agent.sessionId || !isLeadRole(agent.role)) continue;
      const stalled = minutes > 0 && this.isStalled(agent, now, minutes);
      if (stalled && agent.stalledSince === null) {
        agent.stalledSince = idleSince(agent);
        this.opts.bus.pushActivity({
          ts: now,
          agentKey: agent.key,
          event: 'Stalled',
          tool: null,
          state: null,
          summary: { key: 'hub.act.stalled', params: { who: agent.name ?? agent.key, minutes: Math.floor((now - idleSince(agent)) / 60_000) } },
        });
        this.opts.book.emitAgent(agent, now);
      } else if (!stalled && agent.stalledSince !== null) {
        agent.stalledSince = null;
        this.opts.book.emitAgent(agent, now);
      }
    }
  }

  private isStalled(agent: AgentRuntime, now: number, minutes: number): boolean {
    if (agent.taskOpenSince === null || agent.endedAt !== null || agent.retiredAt !== null) return false;
    if (agent.state !== 'idle' || now - idleSince(agent) <= minutes * 60_000) return false;
    if (agent.blockedReason !== null || agent.awaitingAnswer || agent.waiting !== null) return false;
    return this.sessionFree(this.opts.book.sessions.get(agent.sessionId), true);
  }

  // The lead is idle and nobody of its team is working or asking, and no question of the session waits in the panel.
  sessionFree(session: SessionRuntime | undefined, ignoreMain = false): boolean {
    if (!session) return false;
    const main = this.opts.book.agents.get(session.sessionId);
    if (!ignoreMain && main && (main.state !== 'idle' || main.awaitingAnswer)) return false;
    if (this.opts.desk.list().some((question) => question.sessionId === session.sessionId)) return false;
    for (const agent of this.opts.book.agents.values()) {
      if (agent.sessionId !== session.sessionId || agent.key === session.sessionId) continue;
      if (agent.endedAt !== null || agent.retiredAt !== null || agent.away) continue;
      if (LEAD_BUSY.has(agent.state) || agent.state === 'asking') return false;
    }
    return true;
  }

  goesHome(agent: AgentRuntime, now: number): boolean {
    if (agent.away || !agent.teammate || agent.endedAt !== null || agent.retiredAt !== null) return false;
    if (agent.state !== 'idle' || agent.blockedReason !== null || agent.awaitingAnswer) return false;
    if (now - agent.updatedAt < this.opts.config().leaveAfterMinutes * 60_000) return false;
    const lead = this.opts.book.agents.get(agent.sessionId);
    if (!lead || lead === agent || lead.endedAt !== null) return true;
    return !LEAD_BUSY.has(this.opts.book.view(lead, now).state);
  }

  // No socket and no events: nobody can reach it and nobody is using it. A tool still open keeps it alive for longer.
  isGhost(session: SessionRuntime, now: number): boolean {
    if (session.endedAt !== null || session.socket) return false;
    const limit = session.openTools.size > 0 ? GHOST_TOOL_MS : GHOST_MS;
    return now - session.updatedAt > limit;
  }

  userAnswered(sessionId: string): void {
    const agent = this.opts.book.agents.get(sessionId);
    if (agent?.waiting && waitsForUser(agent.waiting.who)) agent.waiting = null;
  }
}

function idleSince(agent: AgentRuntime): number {
  return Math.max(agent.stateSince, agent.taskOpenSince ?? 0);
}

function waitsForUser(who: string): boolean {
  return /^@?(usuario|user)$/i.test(who.trim());
}

function waitsFor(who: string, from: AgentRuntime): boolean {
  const name = from.name?.split('@')[0]?.toLowerCase();
  if (!name) return false;
  return who
    .toLowerCase()
    .split(/\s*(?:,|\/|\by\b|\band\b)\s*/)
    .some((part) => part.trim().replace(/^@/, '') === name);
}
