import type { Database } from 'bun:sqlite';
import { CHAT_SCRIPT } from './agents';
import { GLOBAL_CHANNEL, type ChatDesk, type ChatUnread } from './chat';
import { captureLesson, cleanLesson, deleteLesson, isRoleId, listLessons, memoryContext, updateLesson } from './memory';
import type { OfficeBus } from './office-bus';
import type { AgentRuntime, LessonResult, SessionRuntime } from './office-state';
import { ROLE_LABELS, floorLabel, isoDate } from './office-texts';
import { buildReport, saveReport, savedReport, savedReports } from './reports';
import { contextFree, inOfficeScope, remembers, roleIdOf, roleKind } from './scope';
import type { SessionBook } from './session-book';
import { record, text } from './state-machine';
import type { AgentView, MemoryView, OfficeConfig, ReportView, RoleId } from './types';

export type ContextDeskOpts = {
  db: Database;
  now: () => number;
  bus: OfficeBus;
  book: SessionBook;
  config: () => OfficeConfig;
  chat: ChatDesk;
  rules: (agent: AgentRuntime, session: SessionRuntime) => string | null;
  tokens: (agentKey: string) => AgentView['tokens'];
};

export class ContextDesk {
  private readonly chatNudged = new Set<string>();
  private readonly chatWarned = new Set<string>();

  constructor(private readonly opts: ContextDeskOpts) {}

  // The rules when they changed, first; memory on start only, and the chat lines the agent has not seen yet on start and on every turn.
  injection(event: string, agent: AgentRuntime, session: SessionRuntime): string | null {
    const blocks = [
      event === 'UserPromptSubmit' && agent.key === session.sessionId ? this.opts.rules(agent, session) : null,
      event === 'UserPromptSubmit' ? null : this.memoryBlock(agent, session),
      this.chatBlock(agent, session),
    ].filter((block): block is string => block !== null);
    if (blocks.length === 0) return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: blocks.join('\n\n') } });
  }

  private memoryBlock(agent: AgentRuntime, session: SessionRuntime): string | null {
    const roleId = roleIdOf(agent.role);
    if (contextFree(roleKind(agent.role))) return null;
    if (!roleId || !remembers(session.floorKind) || !inOfficeScope({ floorKind: session.floorKind, sessionRole: agent.role, leadRole: null })) {
      return null;
    }
    const lessons = listLessons(this.opts.db, agent.floor, roleId, { userFirst: true });
    const reports = savedReports(this.opts.db, agent.floor, roleId, 3, agent.key).map((r) => ({
      date: isoDate(r.endedAt ?? r.startedAt),
      name: r.name,
      summary: r.summary,
    }));
    const context = memoryContext({
      roleLabel: ROLE_LABELS[roleId],
      floorLabel: floorLabel(agent.floor),
      lessons,
      reports,
      maxChars: this.opts.config().memory.maxContextChars,
    });
    if (!context) return null;
    this.opts.bus.pushActivity({
      ts: this.opts.now(),
      agentKey: agent.key,
      event: 'Memory',
      tool: null,
      state: null,
      summary: { key: 'hub.act.memoryDelivered', params: { lessons: lessons.length, reports: reports.length } },
    });
    return context;
  }

  private chatBlock(agent: AgentRuntime, session: SessionRuntime): string | null {
    const channels = this.chatChannelsOf(agent, session);
    if (!channels) return null;
    const lines = this.chatLines(this.opts.chat.unreadFor(agent.key, channels), channels[0] ?? GLOBAL_CHANNEL);
    if (!lines) return null;
    return `Chat de Agent Office. Mensajes nuevos en ${channels.map((channel) => `#${channel}`).join(' y ')}:\n${lines}`;
  }

  private chatChannelsOf(agent: AgentRuntime, session: SessionRuntime): string[] | null {
    const roleId = roleIdOf(agent.role);
    if (session.floorKind === 'managed' && (roleId === 'lead' || roleId === 'dev' || roleId === 'tester') && this.opts.chat.isChannel(agent.floor)) {
      return [agent.floor, GLOBAL_CHANNEL];
    }
    if (session.floorKind === 'direccion' && roleId === 'director') return [GLOBAL_CHANNEL];
    return null;
  }

  chatLines(unread: ChatUnread, channel: string): string | null {
    if (unread.messages.length === 0) return null;
    const lines = [this.opts.chat.digest(unread.messages)];
    if (unread.hidden > 0) lines.push(`Hay ${unread.hidden} anteriores sin mostrar: ${CHAT_SCRIPT} ${channel} leer`);
    return lines.join('\n');
  }

  // A developer about to edit a file: a reminder to claim it, once per file, or a warning per claim of someone else.
  chatReminder(agent: AgentRuntime, session: SessionRuntime, filePath: string, now: number): string | null {
    if (session.floorKind !== 'managed' || roleKind(agent.role) !== 'dev' || !this.opts.chat.isChannel(agent.floor)) return null;
    const slug = agent.floor;
    const rel = this.opts.book.fileLabel(filePath, session);
    const from = agent.name ? ` --de ${agent.name}` : '';
    const claims = this.opts.chat.claimsOn(slug, rel);
    const others = claims.filter((claim) => claim.authorKey !== agent.key);
    let context: string;
    if (others.length > 0) {
      const fresh = others.find((claim) => !this.chatWarned.has(`${agent.key}|${rel}|${claim.id}`));
      if (!fresh) return null;
      this.chatWarned.add(`${agent.key}|${rel}|${fresh.id}`);
      const minutes = Math.max(0, Math.round((now - fresh.ts) / 60_000));
      context = `Chat de la planta: ${fresh.authorName} anunció ${fresh.file} hace ${minutes} min (#${fresh.id}). Acordadlo en #${slug} antes de editar: ${CHAT_SCRIPT} ${slug} pregunta "…"${from}`;
    } else {
      const nudge = `${agent.key}|${rel}`;
      if (claims.length > 0 || this.chatNudged.has(nudge)) return null;
      this.chatNudged.add(nudge);
      context = `Chat de la planta: no has anunciado ${rel} en #${slug}. Anúncialo antes de seguir: ${CHAT_SCRIPT} ${slug} toca ${rel}${from}`;
    }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } });
  }

  forgetChatNotes(keys: ReadonlySet<string>): void {
    for (const notes of [this.chatNudged, this.chatWarned]) {
      for (const note of notes) if (keys.has(note.slice(0, note.indexOf('|')))) notes.delete(note);
    }
  }

  storeReport(agent: AgentRuntime, now: number): void {
    if (!remembers(agent.floorKind) || contextFree(roleKind(agent.role))) return;
    const session = this.opts.book.sessions.get(agent.sessionId);
    if (session && !this.opts.book.sessionInOffice(session)) return;
    saveReport(this.opts.db, this.buildReportFor(agent), now);
  }

  private buildReportFor(agent: AgentRuntime): ReportView {
    return buildReport(
      this.opts.db,
      {
        key: agent.key,
        name: agent.name,
        role: agent.role,
        roleId: roleIdOf(agent.role),
        floor: agent.floor,
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        closing: agent.closing,
      },
      (key) => this.opts.book.agents.get(key)?.name ?? this.opts.book.sessions.get(key)?.name ?? key,
    );
  }

  memoryView(floor: string, role: RoleId): MemoryView {
    return { floor, role, lessons: listLessons(this.opts.db, floor, role), reports: savedReports(this.opts.db, floor, role, 10) };
  }

  addLesson(raw: unknown): LessonResult {
    const body = record(raw);
    const floor = text(body.floor);
    const role = body.role;
    const lessonText = text(body.text);
    if (!floor || floor.length > 80) return { ok: false, status: 400, error: { key: 'hub.api.floorRequired' } };
    if (!isRoleId(role)) return { ok: false, status: 400, error: { key: 'hub.api.roleInvalid' } };
    if (!lessonText || !cleanLesson(lessonText)) return { ok: false, status: 400, error: { key: 'hub.api.lessonEmpty' } };
    const result = captureLesson(
      this.opts.db,
      { floor, role, text: lessonText, origin: 'user', agentKey: null, now: this.opts.now() },
      this.opts.config().memory,
    );
    if (result.status === 'saved') {
      this.opts.bus.emit({ type: 'memory', floor, role });
      return { ok: true, lesson: result.lesson };
    }
    if (result.status === 'duplicate') return { ok: false, status: 409, error: { key: 'hub.api.lessonDuplicate' } };
    return { ok: false, status: 400, error: { key: 'hub.api.lessonSaveFailed' } };
  }

  editLesson(id: number, raw: unknown): LessonResult | null {
    const lessonText = text(record(raw).text);
    if (!lessonText) return { ok: false, status: 400, error: { key: 'hub.api.lessonEmpty' } };
    const result = updateLesson(this.opts.db, id, lessonText);
    if (result.status === 'notFound') return null;
    if (result.status === 'updated') {
      this.opts.bus.emit({ type: 'memory', floor: result.lesson.floor, role: result.lesson.role });
      return { ok: true, lesson: result.lesson };
    }
    if (result.status === 'duplicate') return { ok: false, status: 409, error: { key: 'hub.api.lessonDuplicate' } };
    return { ok: false, status: 400, error: { key: 'hub.api.lessonEmpty' } };
  }

  removeLesson(id: number): boolean {
    const removed = deleteLesson(this.opts.db, id);
    if (!removed) return false;
    this.opts.bus.emit({ type: 'memory', floor: removed.floor, role: removed.role });
    return true;
  }

  report(agentKey: string): ReportView | null {
    const agent = this.opts.book.agents.get(agentKey);
    const session = agent ? this.opts.book.sessions.get(agent.sessionId) : undefined;
    if (session && !this.opts.book.sessionInOffice(session)) return null;
    const report = agent ? this.buildReportFor(agent) : savedReport(this.opts.db, agentKey);
    return report ? { ...report, tokens: this.opts.tokens(agentKey) } : null;
  }
}
