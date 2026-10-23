import type { Database } from 'bun:sqlite';
import { roleSettingsFor } from './config';
import { STATUSLINE_FRESH_MS, agentContext, usedPctOf, windowFor } from './context';
import type { OfficeBus } from './office-bus';
import { METER_SWEEP_MS, type AgentRuntime } from './office-state';
import { inOfficeScope, roleIdOf } from './scope';
import type { SessionBook } from './session-book';
import { record, text } from './state-machine';
import { SWEEP_BUDGET, TokenMeter, planSlugOf, type MeterAgent, type PlanSubject } from './tokens';
import type { StatuslineContext } from './usage';
import type { DocumentView, HookEvent, OfficeConfig, TokensEvent, UsageRange, UsageSummary } from './types';

export type MeterDeskOpts = {
  db: Database;
  claudeHome: string;
  now: () => number;
  bus: OfficeBus;
  book: SessionBook;
  config: () => OfficeConfig;
};

export class MeterDesk {
  private readonly meter: TokenMeter;
  private sweptAt: number;
  // Per agent: the window the status line reports, the biggest context held, the compactions of the transcript
  // already counted and those that only the hook has told so far.
  private readonly reported = new Map<string, number>();
  private readonly peak = new Map<string, number>();
  private readonly seenCompactions = new Map<string, number>();
  private readonly hookCompactions = new Map<string, number>();

  constructor(private readonly opts: MeterDeskOpts) {
    this.meter = new TokenMeter({
      db: opts.db,
      claudeHome: opts.claudeHome,
      now: opts.now,
      onRead: (data) => this.read(data),
      windowFor: (agent, model, observed) => this.windowOf(agent, model, observed),
    });
    this.sweptAt = opts.now();
  }

  noteUsage(raw: unknown): void {
    const sessionId = text(record(raw).session_id);
    if (!sessionId) return;
    this.meter.noteSession(sessionId, record(raw).transcript_path);
    this.meter.noteAgent(sessionId, record(raw).transcript_path);
  }

  transcriptOf(sessionId: string): string | null {
    return this.meter.transcriptOf(sessionId, this.opts.book.sessions.get(sessionId)?.cwd ?? null);
  }

  totals(agentKey: string): ReturnType<TokenMeter['totals']> {
    return this.meter.totals(agentKey);
  }

  planTotals(): ReturnType<TokenMeter['planTotals']> {
    return this.meter.planTotals();
  }

  orderSpend(order: Parameters<TokenMeter['orderSpend']>[0]): ReturnType<TokenMeter['orderSpend']> {
    return this.meter.orderSpend(order);
  }

  summary(range: UsageRange): UsageSummary {
    return this.meter.summary(range);
  }

  forget(keys: ReadonlySet<string>): void {
    this.meter.forget(keys);
    for (const key of keys) {
      this.reported.delete(key);
      this.peak.delete(key);
      this.seenCompactions.delete(key);
      this.hookCompactions.delete(key);
    }
  }

  private windowOf(agent: Pick<MeterAgent, 'key' | 'floor' | 'roleId'>, model: string | null, observed: number): number {
    const peak = Math.max(this.peak.get(agent.key) ?? 0, observed);
    this.peak.set(agent.key, peak);
    const roleModel = agent.roleId ? roleSettingsFor(this.opts.config(), agent.floor, agent.roleId).model : null;
    return windowFor(model, { reported: this.reported.get(agent.key), roleModel, observed: peak });
  }

  // A transcript read: the context it measured goes to the agent unless the status line spoke a moment ago.
  // The compactions the hook announced and the transcript has not shown yet are added, never counted twice.
  private read(event: TokensEvent): void {
    const agent = this.opts.book.agents.get(event.agentKey);
    let context = event.context ?? null;
    if (agent && context) {
      const key = agent.key;
      const seen = this.seenCompactions.get(key) ?? context.compactions;
      this.seenCompactions.set(key, context.compactions);
      const pending = Math.max(0, (this.hookCompactions.get(key) ?? 0) - Math.max(0, context.compactions - seen));
      this.hookCompactions.set(key, pending);
      const live = agent.context;
      const fresh = live !== null && live.source === 'statusline' && this.opts.now() - live.at < STATUSLINE_FRESH_MS;
      context = { ...(fresh ? live : context), compactions: context.compactions + pending };
      agent.context = context;
    }
    this.opts.bus.emit({ type: 'tokens', data: context ? { ...event, context } : event });
  }

  // The context window of a main session as its status line reports it. It speaks up only when the rounded
  // percentage (or the window) changes.
  noteContext(sample: StatuslineContext): void {
    const agent = this.opts.book.agents.get(sample.sessionId);
    if (!agent) return;
    const now = this.opts.now();
    if (sample.window !== null) this.reported.set(agent.key, sample.window);
    const window = this.windowOf({ key: agent.key, floor: agent.floor, roleId: roleIdOf(agent.role) }, sample.model, sample.tokens ?? 0);
    const tokens = sample.tokens ?? (sample.usedPct === null ? null : Math.round((sample.usedPct / 100) * window));
    if (tokens === null) return;
    const before = agent.context;
    const usedPct = sample.usedPct ?? usedPctOf(tokens, window);
    agent.context = agentContext(tokens, window, before?.compactions ?? 0, 'statusline', now, usedPct);
    if (!before || Math.round(before.usedPct) !== Math.round(usedPct) || before.window !== window) this.opts.book.emitAgent(agent, now);
  }

  // SessionStart with source "compact": the hook knows a compaction happened before the transcript says so.
  // Returns the percentage of the window before and, when the transcript already shows it, after.
  compacted(agent: AgentRuntime): { from: number | null; to: number | null } {
    const key = agent.key;
    if (!this.seenCompactions.has(key)) this.seenCompactions.set(key, this.meter.compactions(key));
    this.hookCompactions.set(key, (this.hookCompactions.get(key) ?? 0) + 1);
    const before = agent.context;
    if (before) agent.context = { ...before, compactions: before.compactions + 1, at: 0 };
    const subject = this.meterAgent(agent);
    if (subject) this.meter.readNow(subject);
    const after = agent.context;
    const settled = before !== null && after !== null && after.tokens < before.tokens;
    return { from: before ? Math.round(before.usedPct) : null, to: settled && after ? Math.round(after.usedPct) : null };
  }

  noteTranscripts(e: HookEvent, agentKey: string): void {
    this.meter.noteSession(e.session_id, e.transcript_path);
    this.meter.noteAgent(agentKey, agentKey === e.session_id ? e.transcript_path : e.agent_transcript_path);
  }

  private planSubject(agent: AgentRuntime): PlanSubject {
    return { name: agent.name, roleId: roleIdOf(agent.role), floorKind: agent.floorKind, planSlug: agent.planSlug };
  }

  private meterAgent(agent: AgentRuntime): MeterAgent | null {
    const lead = this.opts.book.agents.get(agent.sessionId) ?? null;
    if (!inOfficeScope({ floorKind: agent.floorKind, sessionRole: agent.role, leadRole: lead?.role ?? null })) return null;
    return {
      key: agent.key,
      sessionId: agent.sessionId,
      floor: agent.floor,
      roleId: roleIdOf(agent.role),
      name: agent.name,
      cwd: this.opts.book.sessions.get(agent.sessionId)?.cwd ?? null,
      plan: planSlugOf(this.planSubject(agent), lead && lead !== agent ? this.planSubject(lead) : null),
    };
  }

  later(agent: AgentRuntime): void {
    const subject = this.meterAgent(agent);
    if (subject) this.opts.bus.background(this.meter.schedule(subject));
  }

  setPlan(agent: AgentRuntime, slug: string): void {
    if (agent.planSlug === slug) return;
    const subject = this.meterAgent(agent);
    if (subject) this.meter.readNow(subject);
    agent.planSlug = slug;
  }

  sweep(now: number): void {
    if (now - this.sweptAt < METER_SWEEP_MS) return;
    this.sweptAt = now;
    let budget = SWEEP_BUDGET;
    for (const agent of this.opts.book.agents.values()) {
      if (budget <= 0) break;
      if (agent.endedAt !== null || agent.away) continue;
      if (agent.updatedAt <= this.meter.lastRead(agent.key) && !this.meter.behind(agent.key)) continue;
      const subject = this.meterAgent(agent);
      if (subject) budget -= this.meter.readNow(subject, subject.plan, budget);
    }
  }

  withPlanTokens(docs: DocumentView[]): DocumentView[] {
    const plans = this.meter.planTotals();
    return docs.map((doc) => (doc.kind === 'plan' ? { ...doc, tokens: plans.get(doc.slug) ?? null } : doc));
  }
}
