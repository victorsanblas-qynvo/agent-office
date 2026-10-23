import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedFloors } from './agents';
import { AskDesk } from './ask-desk';
import { BoardDesk, type CreateOrderRequest, type CreateOrderResult, type MoveResult, type ScriptRequest, type ScriptResult } from './board-desk';
import { BranchRestoreDesk, type BranchRestoreResult } from './branch-restore';
import { ChatDesk, GLOBAL_CHANNEL, SNAPSHOT_LIMIT } from './chat';
import { CheckpointDesk } from './checkpoints';
import { ChecksDesk } from './checks';
import { withoutChatCalls } from './chat-commands';
import { ChatRoom, type ReadChatResult, type UserChatResult } from './chat-room';
import { ContextDesk } from './context-desk';
import { deliver } from './courier';
import type { TextLang } from './render-text';
import { documentRoundDiff, documentRounds, type RoundDiffResult, type RoundsResult } from './document-rounds';
import { DeliveryDesk, type DiffFileResult, type DiffResult, type PrDraftResult } from './delivery-desk';
import { DocumentDesk } from './documents';
import { FloorDirtyError, FloorInUseError, purgeFloorData } from './floor-data';
import { FloorResolver, isInside, memoryRegistry, realPath, type FloorRegistry, type GitRootFn } from './floors';
import type { GateDecision } from './gate';
import { GateDesk } from './gate-desk';
import { GitQueue, runGit, type GitRunner } from './git';
import { GuardDesk } from './guard-desk';
import type { Log } from './log';
import { emptyLayouts, type LayoutStore, type LayoutsSave } from './layouts';
import { MeterDesk } from './meter-desk';
import { OfficeBus } from './office-bus';
import { prepare, type Sql } from './office-sql';
import {
  ANSWERS_QUESTION,
  EMPTY_META,
  FILE_TOOLS,
  FORGET_ENDED_MS,
  HOLDS_QUESTION,
  MAX_MESSAGES,
  NEW_TURN,
  NO_TESTS,
  TURN_OVER,
  UNDO_MS,
  isHookEvent,
  recentDocuments,
  teamOfSession,
  type AgentRuntime,
  type DecideResult,
  type DiscardResult,
  type LaunchPaths,
  type LessonResult,
  type OrderResult,
  type RelaunchResult,
  type RestoreResult,
  type SessionRuntime,
  type TmuxFn,
} from './office-state';
import { isUserPrompt, roleLabel, taskLine } from './office-texts';
import { OrderDesk } from './order-desk';
import { OrderStore } from './order-store';
import { publicDetail, publicSummary, publicText, storedPayload, visibleKind } from './privacy';
import { detectStack, profileFor, type Profiles } from './profiles';
import { parseProtocol } from './protocol';
import { ProtocolDesk } from './protocol-desk';
import { QuestionDesk } from './questions';
import type { ReplayDeps } from './replay-build';
import { ReviewDesk, type ReviewRequest, type ReviewResult } from './review-desk';
import { RulesDesk } from './rules-desk';
import { isDepartmentFloor, remembers, roleKind } from './scope';
import { SearchDesk, type SearchQuery } from './search';
import { SessionBook } from './session-book';
import { settingsView } from './settings';
import { StallDesk } from './stall-desk';
import { DONE_PREFIX, EDIT_TOOLS, classify, record, text, type Classified } from './state-machine';
import { SyncDesk, type SyncResult } from './sync';
import { digest } from './digest';
import { localDay, planDocSlugIn, planSlugIn } from './tokens';
import type {
  ActivityView,
  ChatMessageView,
  ChatPostRequest,
  ChatPostResult,
  CheckRunView,
  CheckTrigger,
  CheckpointView,
  DeletedBranchView,
  DocumentContent,
  DocumentView,
  HookEvent,
  HookMeta,
  HubText,
  LayoutsFile,
  MemoryView,
  MessageView,
  OfficeConfig,
  OfficeDigest,
  OrderCommentView,
  OrderStatus,
  PlanDecision,
  ReportView,
  RoleId,
  ServerMessage,
  SkippedFile,
  SearchResult,
  Snapshot,
  Stack,
  UsageRange,
  UsageSummary,
} from './types';
import { UsageDesk } from './usage';
import { WorktreeDesk, type RemoveResult, type WorktreeSummary } from './worktrees';

export {
  GHOST_MS,
  GHOST_TOOL_MS,
  PERSIST_EVERY_MS,
  SNAPSHOT_CLOSED_DOCS,
  UNDO_MS,
  isHookEvent,
  recentDocuments,
  teamOfSession,
  type DecideResult,
  type DiscardResult,
  type LaunchPaths,
  type LessonResult,
  type OrderResult,
  type RelaunchResult,
  type RestoreResult,
  type TmuxFn,
} from './office-state';

export {
  DISCARDED_MARK,
  ROLE_LABELS,
  STATUS_REQUEST,
  analysisOrderText,
  executeOrderText,
  floorLabel,
  historyPath,
  isUserPrompt,
  permissionDetail,
  permissionMatch,
  permissionPrompt,
  taskLine,
  withoutDiscardMark,
} from './office-texts';
export { chatFreeCommand, isChatCommand } from './chat-commands';

export type OfficeDiagnostics = { dbFile: string; fts: boolean; activeCheckRuns: number; worktrees: number; sessions: number };

export type OfficeOptions = {
  db: Database;
  config: OfficeConfig;
  profiles: Profiles;
  workspaceDir: string;
  claudeHome: string;
  registry?: FloorRegistry;
  gitRoot?: GitRootFn;
  stackOf?: (dir: string) => Stack;
  git?: GitRunner;
  rawDir?: string | null;
  holdMs?: number;
  now?: () => number;
  deliverFn?: typeof deliver;
  launch?: LaunchPaths;
  tmux?: TmuxFn;
  // Id of this hub, written in the marker of its snapshots in redaccion/.fuentes.
  hubId: string;
  // Where background failures and broken listeners are written; console.error when absent.
  log?: Log;
  // How long a discarded plan can be restored before its sources are removed.
  undoMs?: number;
  // How long after a dev says listo the checks of its order start.
  listoDelayMs?: number;
  // layouts.json: where the user moved the desks and the furniture; none in a replay, which draws the defaults.
  layouts?: LayoutStore;
  // false builds an office that only lives in memory (the replay of a session): no guard, document watch or
  // refresh, token meter, sync, chat index or raw dump, and the hub never starts anything of its own.
  sideEffects?: boolean;
};

export class Office {
  readonly desk: QuestionDesk;
  private config: OfficeConfig;
  private profiles: Profiles;
  private readonly floors: FloorResolver;
  private readonly messages: MessageView[] = [];
  private readonly docsQueue = new GitQueue();
  private readonly bus: OfficeBus;
  private readonly book: SessionBook;
  private readonly rules: RulesDesk;
  private readonly guards: GuardDesk;
  private readonly orders: OrderDesk;
  private readonly protocol: ProtocolDesk;
  private readonly gates: GateDesk;
  private readonly room: ChatRoom;
  private readonly context: ContextDesk;
  private readonly asks: AskDesk;
  private readonly stall: StallDesk;
  private readonly now: () => number;
  private readonly deliverFn: typeof deliver;
  private readonly git: GitRunner;
  private readonly sql: Sql;
  private readonly docs: DocumentDesk;
  private readonly sync: SyncDesk;
  private readonly usage: UsageDesk;
  private readonly meter: MeterDesk;
  private readonly store: OrderStore;
  private readonly worktrees: WorktreeDesk;
  private readonly branches: BranchRestoreDesk;
  private readonly checkpoints: CheckpointDesk;
  private readonly delivery: DeliveryDesk;
  private readonly checks: ChecksDesk;
  private readonly board: BoardDesk;
  private readonly reviews: ReviewDesk;
  private readonly searches: SearchDesk;
  private readonly live: boolean;
  readonly chat: ChatDesk;

  constructor(private readonly opts: OfficeOptions) {
    this.config = opts.config;
    this.profiles = opts.profiles;
    this.now = opts.now ?? Date.now;
    this.deliverFn = opts.deliverFn ?? deliver;
    this.live = opts.sideEffects !== false;
    this.bus = new OfficeBus(
      opts.log ?? ((text) => console.error(`Agent Office: ${text}`)),
      (entry) => this.searches.recordActivity(entry),
    );
    this.git = opts.git ?? runGit;
    this.floors = new FloorResolver(
      () => this.config,
      opts.workspaceDir,
      opts.registry ?? memoryRegistry(),
      opts.gitRoot,
      opts.stackOf ?? detectStack,
    );
    this.sql = prepare(opts.db);
    this.searches = new SearchDesk({ db: opts.db, resolve: (key) => this.activityOwner(key) });
    if (this.live) this.searches.ensureIndex();
    this.book = new SessionBook({
      sql: this.sql,
      now: this.now,
      bus: this.bus,
      config: () => this.config,
      claudeHome: opts.claudeHome,
      tokens: (key) => this.meter.totals(key),
      flags: (session) => this.rules.flags(session),
      restored: (session, row) => this.rules.restored(session, row),
      floors: this.floors,
    });
    const base = { sql: this.sql, now: this.now, bus: this.bus, book: this.book, config: () => this.config };
    this.rules = new RulesDesk({
      ...base,
      launch: opts.launch,
      tmux: opts.tmux,
      hasTranscript: (sessionId) => this.meter.transcriptOf(sessionId) !== null,
      free: (session, ignoreMain) => this.stall.sessionFree(session, ignoreMain),
    });
    this.desk = new QuestionDesk(
      {
        opened: (view) => this.asks.questionOpened(view),
        closed: (id, outcome) => this.asks.questionClosed(id, outcome),
      },
      opts.holdMs,
      this.now,
    );
    this.asks = new AskDesk({ ...base, desk: this.desk });
    this.stall = new StallDesk({ ...base, desk: this.desk });
    this.sync = new SyncDesk({
      db: opts.db,
      git: this.git,
      root: () => this.docsRoot(),
      floors: () => this.config.floors,
      now: this.now,
      onChange: () => this.refreshDocuments(),
      id: opts.hubId,
      onForeign: (dirs) =>
        this.pushActivity({
          ts: this.now(),
          agentKey: 'redaccion',
          event: 'Sync',
          tool: null,
          state: null,
          summary: { key: 'hub.act.sourcesForeign', params: { n: dirs.length, dirs: dirs.join(', ') } },
        }),
    });
    this.docs = new DocumentDesk({
      db: opts.db,
      root: () => this.docsRoot(),
      enabled: () => this.config.departments,
      installTargets: () => this.guards.installTargets(),
      base: (slug) => this.sync.base(slug),
      ahead: (slug) => this.sync.ahead(slug),
      onChange: (docs) => this.bus.emit({ type: 'documents', data: this.meter.withPlanTokens(docs) }),
      maxRounds: () => this.config.review.maxRounds,
    });
    this.guards = new GuardDesk({ ...base, git: this.git, claudeHome: opts.claudeHome, docsRoot: () => this.docsRoot() });
    this.usage = new UsageDesk(this.now, (view) => this.bus.emit({ type: 'usage', data: view }), opts.db);
    this.meter = new MeterDesk({ ...base, db: opts.db, claudeHome: opts.claudeHome });
    this.chat = new ChatDesk({
      db: opts.db,
      now: this.now,
      channels: () => [GLOBAL_CHANNEL, ...managedFloors(this.config).map(([slug]) => slug)],
      roleLabel,
      onMessage: (message) => {
        this.searches.recordChat(message);
        this.bus.emit({ type: 'chat', data: message });
      },
    });
    this.context = new ContextDesk({
      ...base,
      db: opts.db,
      chat: this.chat,
      rules: (agent, session) => this.rules.rulesBlock(agent, session),
      tokens: (key) => this.meter.totals(key),
    });
    this.room = new ChatRoom({
      ...base,
      chat: this.chat,
      floors: this.floors,
      deliver: this.deliverFn,
      lines: (unread, channel) => this.context.chatLines(unread, channel),
      listo: (cwd, floor) => this.board.listo(cwd, floor),
    });
    const documents = {
      docs: this.docs,
      sync: this.sync,
      docsRoot: () => this.docsRoot(),
      refreshDocuments: () => this.refreshDocuments(),
    };
    this.gates = new GateDesk({
      ...base,
      ...documents,
      db: opts.db,
      context: () => this.guards.context(),
      busy: (floor) => this.guards.busy(floor),
      userAnswered: (sessionId) => this.stall.userAnswered(sessionId),
      briefAccepted: (to, body) => this.board.briefAccepted(to, body, planDocSlugIn(body)),
      doneGate: (args) => this.board.doneGate(args),
    });
    this.protocol = new ProtocolDesk({
      ...base,
      ...documents,
      db: opts.db,
      git: this.git,
      queue: this.docsQueue,
      review: (ref, round, from) => this.gates.reviewBlock(ref, round, from),
      declareWaiting: (agent, rest, now) => this.stall.declareWaiting(agent, rest, now),
      retire: (agent, detail, now) => this.retire(agent, detail, now),
    });
    this.orders = new OrderDesk({
      ...base,
      ...documents,
      git: this.git,
      queue: this.docsQueue,
      deliver: this.deliverFn,
      undoMs: opts.undoMs ?? UNDO_MS,
      instructed: (sessionId, now) => this.gates.userInstructed(sessionId, now),
      allowBriefs: (sessionId, floors) => this.gates.allowBriefs(sessionId, floors),
      setPlan: (agent, slug) => this.setPlan(agent, slug),
      openTask: (agent, now) => this.stall.openTask(agent, now),
      planExecuting: (plan) => this.board.planExecuting(plan),
    });
    this.store = new OrderStore(opts.db);
    this.worktrees = new WorktreeDesk({
      store: this.store,
      git: this.git,
      now: this.now,
      bus: this.bus,
      config: () => this.config,
      hubId: opts.hubId,
      inside: (path) => this.sessionInside(path),
      changed: (order) => this.bus.emit({ type: 'worktrees', floor: order.floor }),
    });
    this.branches = new BranchRestoreDesk({ db: opts.db, git: this.git, now: this.now, bus: this.bus, config: () => this.config });
    this.checkpoints = new CheckpointDesk({ db: opts.db, store: this.store, git: this.git, now: this.now, bus: this.bus, config: () => this.config });
    this.delivery = new DeliveryDesk({ store: this.store, git: this.git, config: () => this.config, latestChecks: (id) => this.checks.latest(id), now: this.now });
    this.checks = new ChecksDesk({
      db: opts.db,
      store: this.store,
      git: this.git,
      now: this.now,
      bus: this.bus,
      config: () => this.config,
      profiles: () => this.profiles,
      checkpoints: this.checkpoints,
      notify: (order, text) => this.board.tellLead(order, text),
      changed: (order) => this.board.refresh(order.id),
      listoDelayMs: opts.listoDelayMs,
    });
    this.board = new BoardDesk({
      db: opts.db,
      store: this.store,
      now: this.now,
      bus: this.bus,
      book: this.book,
      config: () => this.config,
      worktrees: this.worktrees,
      byPath: (cwd) => this.worktrees.byPath(cwd),
      deliver: this.deliverFn,
      order: (sessionId, text) => this.orders.order(sessionId, text),
      planTotals: () => this.meter.planTotals(),
      checks: this.checks,
      floorOf: (cwd) => {
        const root = this.floors.rootOf(realPath(cwd));
        return managedFloors(this.config).find(([, floor]) => realPath(floor.path) === root)?.[0] ?? null;
      },
    });
    this.reviews = new ReviewDesk({
      db: opts.db,
      store: this.store,
      now: this.now,
      bus: this.bus,
      diff: (id) => this.delivery.diff(id),
      toLead: (order, content) => this.board.toLead(order, content),
      reopen: (id) => void this.board.move(id, 'en-curso'),
    });
    this.book.restoreSessions();
    if (this.live) this.docs.refresh();
  }

  start(): void {
    if (!this.live) return;
    // A question still pending in the database lost the request that held it when the hub went down.
    this.sql.releaseStalePending.run(this.now());
    this.checks.sweepStale();
    this.docs.watch();
    this.refreshDocuments();
    this.bus.background(this.sync.cleanup(this.docs.finishedPlanSlugs()));
    this.bus.background(this.worktrees.cleanup());
    this.bus.background(this.searches.backfill());
  }

  stop(): void {
    this.docs.unwatch();
    this.orders.stop();
    this.checks.stop();
  }

  idle(): Promise<void> {
    return this.bus.idle();
  }

  subscribe(listener: (msg: ServerMessage) => void): () => void {
    return this.bus.subscribe(listener);
  }

  snapshot(): Snapshot {
    const now = this.now();
    return {
      now,
      floors: this.floors.views(),
      agents: [...this.book.agents.values()].map((a) => this.book.view(a, now)),
      sessions: [...this.book.sessions.values()].map((s) => this.book.sessionView(s)),
      questions: this.desk.list(),
      messages: this.messages.slice(-100),
      activity: this.bus.recent(),
      documents: this.meter.withPlanTokens(recentDocuments(this.docs.list())),
      alerts: this.guards.alerts(),
      usage: this.usage.view(),
      chat: this.chat.recent(SNAPSHOT_LIMIT),
      orders: this.board.list(),
      finished: this.board.finishedAlerts(),
      layouts: this.layouts(),
    };
  }

  layouts(): LayoutsFile {
    return this.opts.layouts?.get() ?? emptyLayouts();
  }

  // The whole file replaces the previous one; every panel gets the new one.
  saveLayouts(raw: unknown): LayoutsSave {
    const store = this.opts.layouts;
    if (!store) return { ok: false, error: { key: 'hub.layouts.unavailable' }, failed: true };
    const result = store.save(raw);
    if (result.ok) this.bus.emit({ type: 'layouts', data: result.data });
    return result;
  }

  ingestUsage(raw: unknown): string {
    if (this.live) {
      this.meter.noteUsage(raw);
      const context = this.usage.contextOf(raw);
      if (context) this.meter.noteContext(context);
    }
    return this.usage.ingest(raw);
  }

  // One transaction per event: the writes of a hook (event, agent, edit, verdict, report) commit together, once.
  ingest(e: HookEvent, meta: HookMeta = EMPTY_META): string | null {
    if (!isHookEvent(e)) return null;
    return this.opts.db.transaction(() => this.ingestEvent(e, meta))();
  }

  private ingestEvent(e: HookEvent, meta: HookMeta): string | null {
    const now = this.now();
    this.dumpRaw(e, now);
    const session = this.book.touchSession(e, meta, now);
    this.board.touch(e.cwd, now);
    if (this.live && e.hook_event_name === 'SessionStart' && (e.source === 'startup' || e.source === 'resume')) this.rules.setBaseline(session);
    const kind = visibleKind(session.floorKind, this.book.sessionInOffice(session, text(e.team_name)));
    const matchers = isDepartmentFloor(session.floorKind) ? NO_TESTS : profileFor(this.profiles, session.stack);
    const c = withoutChatCalls(classify(e, matchers), e, matchers);
    const byName = c.event === 'TeammateIdle' && !e.agent_id && c.agentKey !== e.session_id && !this.book.agents.has(c.agentKey);
    const owner = byName ? this.book.liveTeammate(c.teammate, c.team ?? session.team ?? teamOfSession(e.session_id), e.session_id) : null;
    if (owner) c.agentKey = owner.key;
    if ((c.event === 'SubagentStop' || byName) && !this.book.agents.has(c.agentKey)) {
      this.sql.insertEvent.run(now, e.session_id, c.agentKey, session.floor, c.event, null, null, null, storedPayload(e, kind));
      return null;
    }
    this.stall.trackOpenTools(e, c, session, now);
    if (this.live) this.meter.noteTranscripts(e, c.agentKey);
    const agent = this.book.touchAgent(e, c, session, now);
    if (this.book.isRetired(agent)) {
      this.ingestRetired(e, c, agent, session, now);
      return this.gates.readCap(c, agent, session, true, now);
    }

    let nextState = c.state;
    let ended = c.ended;
    if (c.event === 'SubagentStop' && agent.teammate) {
      nextState = 'idle';
      ended = false;
    }
    if (c.question !== null) agent.awaitingAnswer = true;
    else if (agent.awaitingAnswer && ANSWERS_QUESTION.has(c.event)) agent.awaitingAnswer = false;
    const holding = agent.awaitingAnswer && !ended && HOLDS_QUESTION.has(c.event);
    if (holding) nextState = null;
    if (
      nextState === null &&
      (c.event === 'PostToolUse' || c.event === 'PostToolUseFailure') &&
      agent.state === 'asking' &&
      !agent.awaitingAnswer
    ) {
      nextState = 'working';
    }
    if (ended) {
      agent.endedAt = now;
      agent.waiting = null;
      agent.stalledSince = null;
      this.context.forgetChatNotes(new Set([agent.key]));
    }
    else if (agent.endedAt !== null) agent.endedAt = null;
    if (nextState && nextState !== agent.state) {
      agent.state = nextState;
      agent.stateSince = now;
    }
    if (agent.stalledSince !== null && agent.state !== 'idle') agent.stalledSince = null;
    if (!holding) {
      if (c.event === 'SubagentStop' && agent.teammate) agent.detail = { key: 'hub.detail.waiting' };
      else if (c.detail) agent.detail = publicDetail(c, kind);
    }
    if (c.tool && c.event === 'PreToolUse') agent.tool = c.tool;
    if (c.blocked) agent.blockedReason = kind === 'observed' ? { key: 'hub.detail.blocked' } : c.blocked;
    else if (c.unblock) agent.blockedReason = null;
    if (c.filePath) agent.touchedFloor = this.book.touchedFloor(c.filePath, agent.floor);
    agent.away = false;
    if (NEW_TURN.has(c.event)) agent.file = null;
    if (c.event === 'PreToolUse' && c.filePath && FILE_TOOLS.has(c.tool ?? '')) agent.file = this.book.fileLabel(c.filePath, session);
    const isMain = agent.key === session.sessionId;
    if (c.event === 'UserPromptSubmit' && isMain) {
      const task = taskLine(publicText(text(e.prompt), kind));
      if (task) {
        agent.task = task;
        this.stall.openTask(agent, now);
      }
      const plan = planSlugIn(text(e.prompt));
      if (plan) this.setPlan(agent, plan);
      if (isUserPrompt(text(e.prompt))) this.gates.userInstructed(session.sessionId, now);
    }
    if (c.event === 'PostToolUse' && isMain && c.tool === 'AskUserQuestion') this.gates.userInstructed(session.sessionId, now);
    if (c.event === 'PostToolUse' && c.tool === 'SendMessage' && agent.taskOpenSince !== null && DONE_PREFIX.test(text(record(e.tool_input).message) ?? '')) {
      this.stall.closeTask(agent);
    }
    const closing = text(e.last_assistant_message);
    if (closing && remembers(kind) && (c.event === 'SubagentStop' || c.event === 'Stop')) agent.closing = closing;
    const closingProtocol = closing && c.event === 'Stop' && remembers(kind) ? parseProtocol(closing) : null;
    if (closingProtocol?.kind === 'waiting') this.stall.declareWaiting(agent, closingProtocol.rest, now);
    agent.updatedAt = now;

    if (c.edit !== null) {
      this.sql.insertEdit.run(now, agent.key, session.floor, publicText(c.edit, kind) ?? '');
      this.board.editOutside(agent, c.filePath);
    }
    if (this.live) this.guards.bashWrites(e, c, agent, session, kind, matchers, now);
    if (c.test === 'pass' || c.test === 'fail') {
      const ok = c.test === 'pass';
      const command = publicText(c.command, kind) ?? '';
      this.sql.insertVerdict.run(now, agent.key, agent.role, session.floor, 'tests', ok ? 1 : 0, command, null, null, null);
      agent.lastTest = { ok, ts: now, command };
    }
    if (c.task) this.recordTask(e, c, agent, session, now);

    this.sql.insertEvent.run(
      now,
      e.session_id,
      agent.key,
      session.floor,
      c.event,
      c.tool,
      nextState,
      c.filePath,
      storedPayload(e, kind),
    );
    this.book.persistAgent(agent);
    this.book.emitAgent(agent, now);
    if (c.message) this.recordMessage(c.message, agent, session, now);
    this.pushActivity({ ts: now, agentKey: agent.key, event: c.event, tool: c.tool, state: nextState, summary: publicSummary(c, kind) });
    if (c.event === 'SessionStart' && e.source === 'compact') this.noteCompaction(agent, now);
    if (this.live) {
      this.guards.trackDepartment(agent, c.event, ended);
      this.guards.trackChanges(agent, kind, c.event, ended);
    }
    this.asks.settlePermissions(agent.key, c.event, c.tool, e.tool_input);
    if (c.event === 'SubagentStop' || c.event === 'Stop' || c.event === 'SessionEnd') this.context.storeReport(agent, now);

    if (TURN_OVER.has(c.event)) this.measure(agent);
    if (c.sessionEnded) this.endSession(session, now);
    if (c.event === 'SubagentStart' || c.event === 'SessionStart' || c.event === 'UserPromptSubmit') return this.context.injection(c.event, agent, session);
    if (c.event === 'PreToolUse' && c.tool && EDIT_TOOLS.has(c.tool) && c.filePath) return this.context.chatReminder(agent, session, c.filePath, now);
    return this.gates.readCap(c, agent, session, false, now);
  }

  ask(e: HookEvent, meta: HookMeta = EMPTY_META, signal?: AbortSignal): Promise<string | null> {
    return this.asks.ask(e, meta, signal);
  }

  permission(e: HookEvent, meta: HookMeta = EMPTY_META, signal?: AbortSignal): Promise<string | null> {
    return this.asks.permission(e, meta, signal);
  }

  answer(id: string, answers: unknown): 'ok' | 'closed' | 'invalid' {
    return this.desk.answer(id, answers);
  }

  release(id: string): 'ok' | 'closed' {
    return this.desk.release(id);
  }

  heartbeat(visible: boolean): void {
    this.desk.heartbeat(visible);
  }

  panelConnected(): void {
    this.desk.connect();
  }

  panelDisconnected(): void {
    this.desk.disconnect();
  }

  gate(e: HookEvent): GateDecision {
    return this.gates.gate(e);
  }

  gateMessage(e: HookEvent): GateDecision {
    return this.gates.gateMessage(e);
  }

  guard(e: HookEvent, meta: HookMeta = EMPTY_META): GateDecision {
    return this.gates.guard(e, meta);
  }

  memoryView(floor: string, role: RoleId): MemoryView {
    return this.context.memoryView(floor, role);
  }

  addLesson(raw: unknown): LessonResult {
    return this.context.addLesson(raw);
  }

  editLesson(id: number, raw: unknown): LessonResult | null {
    return this.context.editLesson(id, raw);
  }

  removeLesson(id: number): boolean {
    return this.context.removeLesson(id);
  }

  report(agentKey: string): ReportView | null {
    return this.context.report(agentKey);
  }

  order(sessionId: string, body: string): Promise<OrderResult> {
    return this.orders.order(sessionId, body);
  }

  requestStatus(sessionId: string): Promise<OrderResult> {
    return this.orders.requestStatus(sessionId);
  }

  postChat(raw: ChatPostRequest, meta: HookMeta): ChatPostResult {
    return this.room.postChat(raw, meta);
  }

  userChat(channel: string, body: string): Promise<UserChatResult> {
    return this.room.userChat(channel, body);
  }

  readChat(channel: string, afterId: number | null, waitMs: number, signal?: AbortSignal): Promise<ReadChatResult> {
    return this.room.readChat(channel, afterId, waitMs, signal);
  }

  chatHistory(channel: string, beforeId: number | null): ChatMessageView[] | 'no-channel' {
    return this.room.chatHistory(channel, beforeId);
  }

  diagnostics(): OfficeDiagnostics {
    return {
      dbFile: this.opts.db.filename,
      fts: this.searches.indexed,
      activeCheckRuns: this.checks.activeRuns,
      worktrees: this.store.withWorktree().length,
      sessions: [...this.book.sessions.values()].filter((s) => s.endedAt === null).length,
    };
  }

  tokenSummary(range: UsageRange): UsageSummary {
    return this.meter.summary(range);
  }

  dayDigest(day: string | null): OfficeDigest | 'bad-day' | 'future-day' {
    const now = this.now();
    return digest(this.opts.db, day ?? localDay(now), now);
  }

  documents(): DocumentView[] {
    return this.meter.withPlanTokens(this.docs.list());
  }

  documentContent(path: string): DocumentContent | null {
    return this.docs.content(path);
  }

  documentRounds(path: string): Promise<RoundsResult | null> {
    return this.docs.find(path) ? documentRounds(this.git, this.docsRoot(), path) : Promise.resolve(null);
  }

  documentRoundDiff(path: string, from: string, to: string): Promise<RoundDiffResult | null> {
    return this.docs.find(path) ? documentRoundDiff(this.git, this.docsRoot(), path, from, to) : Promise.resolve(null);
  }

  discardDocument(path: string): Promise<DiscardResult> {
    return this.orders.discardDocument(path);
  }

  restoreDocument(path: string): Promise<RestoreResult> {
    return this.orders.restoreDocument(path);
  }

  decidePlan(path: string, decision: PlanDecision): Promise<DecideResult> {
    return this.orders.decidePlan(path, decision);
  }

  syncSources(raw: unknown): Promise<SyncResult> {
    return this.orders.syncSources(raw);
  }

  expireSources(): Promise<string[]> {
    return this.orders.expireSources();
  }

  tick(): void {
    const now = this.now();
    this.desk.sweep();
    for (const agent of [...this.book.agents.values()]) {
      if (agent.endedAt !== null && now - agent.endedAt > FORGET_ENDED_MS) {
        this.book.agents.delete(agent.key);
        this.bus.emit({ type: 'agent-gone', key: agent.key });
        continue;
      }
      if (this.stall.goesHome(agent, now)) {
        agent.away = true;
        this.book.emitAgent(agent, now);
        continue;
      }
      if (this.book.view(agent, now).state !== agent.sentState) this.book.emitAgent(agent, now);
    }
    if (this.live) this.meter.sweep(now);
    for (const session of [...this.book.sessions.values()]) {
      if (session.endedAt === null && session.socket && !existsSync(session.socket)) this.endSession(session, now);
      else if (this.stall.isGhost(session, now)) this.endSession(session, now, true);
      if (session.endedAt !== null && now - session.endedAt > FORGET_ENDED_MS) this.book.sessions.delete(session.sessionId);
    }
    this.stall.detectStalls(now);
    if (this.live) this.rules.refreshSessionFlags(now);
  }

  floorInUse(slug: string): string[] {
    return this.book.floorInUse(slug);
  }

  boardOrders(): ReturnType<BoardDesk['list']> {
    return this.board.list();
  }

  createOrder(request: CreateOrderRequest): Promise<CreateOrderResult> {
    return this.board.createFromPanel(request);
  }

  moveOrder(id: number, to: OrderStatus, force = false): MoveResult {
    return this.board.move(id, to, force);
  }

  discardOrder(id: number): MoveResult {
    return this.board.discard(id);
  }

  async orderChecks(id: number): Promise<{ latest: CheckRunView | null; runs: CheckRunView[] } | null> {
    return this.store.get(id) ? { latest: this.checks.latest(id), runs: this.checks.history(id) } : null;
  }

  runOrderChecks(id: number, trigger: CheckTrigger): ReturnType<BoardDesk['checkNow']> {
    return this.board.checkNow(id, trigger);
  }

  cancelOrderChecks(id: number): boolean {
    return this.checks.cancel(id);
  }

  orderCheckpoints(id: number): { checkpoints: CheckpointView[]; skipped: SkippedFile[] } | null {
    const order = this.store.get(id);
    return order ? { checkpoints: this.checkpoints.list(id), skipped: this.checkpoints.skipped(order) } : null;
  }

  orderDiff(id: number): Promise<DiffResult> {
    return this.delivery.diff(id);
  }

  orderPrDraft(id: number, lang: TextLang): Promise<PrDraftResult> {
    return this.delivery.prDraft(id, lang);
  }

  orderDiffFile(id: number, path: string): Promise<DiffFileResult> {
    return this.delivery.diffFile(id, path);
  }

  reviewOrder(id: number, request: ReviewRequest): Promise<ReviewResult> {
    return this.reviews.send(id, request);
  }

  orderComments(id: number): OrderCommentView[] | null {
    return this.reviews.list(id);
  }

  orderScript(request: ScriptRequest, meta: HookMeta): Promise<ScriptResult> {
    return this.board.script(request, meta);
  }

  confirmOrderChecks(id: number): MoveResult {
    return this.board.confirmChecks(id);
  }

  retryOrderFolder(id: number): Promise<MoveResult> {
    return this.board.retryFolder(id);
  }

  markFinishedSeen(id: number): boolean {
    return this.board.markSeen(id);
  }

  listWorktrees(floor?: string): Promise<WorktreeSummary> {
    return this.worktrees.list(floor);
  }

  removeWorktree(orderId: number, opts: { deleteBranch: boolean; force: boolean }): Promise<RemoveResult> {
    return this.worktrees.remove(orderId, opts);
  }

  keepWorktree(orderId: number): boolean {
    return this.worktrees.keep(orderId) !== null;
  }

  // null: the floor does not exist or is not managed.
  async deletedBranches(floor: string): Promise<DeletedBranchView[] | null> {
    return this.branches.managed(floor) ? this.branches.list(floor) : null;
  }

  restoreBranch(floor: string, branch: unknown, sha: unknown): Promise<BranchRestoreResult> {
    return this.branches.restore(floor, branch, sha);
  }

  // Cleanup of folders nobody owns plus the daily expiry, on demand from the panel.
  async pruneWorktrees(): Promise<{ removed: number }> {
    await this.worktrees.cleanup();
    const { removed } = await this.worktrees.expire();
    return { removed };
  }

  expireWorktrees(): Promise<{ removed: number; pending: number; totalKb: number }> {
    return this.worktrees.expire();
  }

  private sessionInside(path: string): boolean {
    const folder = realPath(path);
    return [...this.book.sessions.values()].some((s) => s.endedAt === null && s.cwd !== null && isInside(realPath(s.cwd), folder));
  }

  async forgetFloor(slug: string, path: string, force = false): Promise<{ rows: number; worktrees: number }> {
    const dirty = await this.worktrees.dirtyIn(slug);
    if (dirty.length > 0 && !force) throw new FloorDirtyError(slug, dirty);
    await this.worktrees.removeAll(slug, force);
    const worktrees = await this.sync.removeFloor(slug);
    // A session may have opened on the floor while git was working.
    const open = this.floorInUse(slug);
    if (open.length > 0) throw new FloorInUseError(slug, open);
    const keys = new Set([...this.book.agents.values()].filter((agent) => agent.floor === slug).map((agent) => agent.key));
    const sessionIds = new Set([...this.book.sessions.values()].filter((session) => session.floor === slug).map((session) => session.sessionId));

    for (const q of this.desk.list()) if (sessionIds.has(q.sessionId)) this.desk.release(q.id);
    this.asks.forget(keys);
    for (const key of keys) this.book.agents.delete(key);
    this.meter.forget(keys);
    this.context.forgetChatNotes(keys);
    for (const id of sessionIds) this.book.sessions.delete(id);
    const keptMessages = this.messages.filter((message) => message.floor !== slug);
    this.messages.splice(0, this.messages.length, ...keptMessages);
    this.bus.forget(keys);

    this.chat.forgetFloor(slug);
    const rows = purgeFloorData(this.opts.db, slug, path);
    const now = this.now();
    this.pushActivity({ ts: now, agentKey: 'panel', event: 'FloorRemoved', tool: null, state: null, summary: { key: 'hub.act.floorRemoved', params: { slug } } });
    this.bus.emit({ type: 'snapshot', data: this.snapshot() });
    return { rows, worktrees };
  }

  reload(config: OfficeConfig, profiles: Profiles): void {
    this.config = config;
    this.profiles = profiles;
    const now = this.now();
    this.book.refloor(now);
    this.rules.refreshSessionFlags(now, true);
    this.bus.emit({ type: 'floors', data: this.floors.views() });
    this.bus.emit({ type: 'settings', data: settingsView(config, profiles) });
    if (this.live) this.docs.watch();
    this.refreshDocuments();
  }

  relaunch(sessionId: string, resume?: boolean): Promise<RelaunchResult> {
    return this.rules.relaunch(sessionId, resume);
  }

  private docsRoot(): string {
    return this.floors.docsRoot();
  }

  refreshDocuments(): void {
    if (this.live) this.docs.refresh();
  }

  private retire(agent: AgentRuntime, detail: HubText, now: number): void {
    agent.retiredAt = now;
    agent.retiredAwake = true;
    agent.blockedReason = null;
    agent.detail = detail;
    if (agent.state !== 'done') {
      agent.state = 'done';
      agent.stateSince = now;
    }
    if (agent.endedAt === null) agent.endedAt = now;
    agent.updatedAt = now;
    this.finishGuards(agent.key);
    this.book.persistAgent(agent);
    this.book.emitAgent(agent, now);
    this.context.storeReport(agent, now);
    this.measure(agent);
  }

  private ingestRetired(e: HookEvent, c: Classified, agent: AgentRuntime, session: SessionRuntime, now: number): void {
    const kind = this.book.privacyKind(session, text(e.team_name));
    this.sql.insertEvent.run(now, e.session_id, agent.key, session.floor, c.event, c.tool, null, c.filePath, storedPayload(e, kind));
    if (TURN_OVER.has(c.event)) {
      agent.retiredAwake = false;
      this.measure(agent);
    } else if (!agent.retiredAwake) {
      agent.retiredAwake = true;
      this.pushActivity({
        ts: now,
        agentKey: agent.key,
        event: 'Retired',
        tool: null,
        state: null,
        summary: { key: 'hub.act.retiredIgnored', params: { who: agent.name ?? agent.key } },
      });
    }
    if (c.message) this.recordMessage(c.message, agent, session, now);
    this.asks.settlePermissions(agent.key, c.event, c.tool, e.tool_input);
    if (c.sessionEnded) this.endSession(session, now);
  }

  private recordTask(e: HookEvent, c: Classified, agent: AgentRuntime, session: SessionRuntime, now: number): void {
    const task = c.task;
    if (!task?.taskId) return;
    const scope = c.team ?? agent.team ?? session.team ?? teamOfSession(e.session_id);
    this.sql.upsertTask.run(scope, task.taskId, task.subject, task.owner, task.status, now);
  }

  private recordMessage(message: { to: string; text: string }, from: AgentRuntime, session: SessionRuntime, now: number): void {
    const toKey = this.book.recipientKey(message.to, from);
    const body = publicText(message.text, this.book.privacyKind(session));
    const id = Number(this.sql.insertMessage.run(now, from.key, message.to, toKey, body, session.floor).lastInsertRowid);
    const view: MessageView = { id, ts: now, fromKey: from.key, toName: message.to, toKey, text: body, floor: session.floor };
    this.messages.push(view);
    this.searches.recordMessage(view);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.bus.emit({ type: 'message', data: view });
    const recipient = toKey ? this.book.agents.get(toKey) : undefined;
    this.stall.settleWaiting(from, recipient, body, now);
    if (recipient && recipient !== from) this.messageReceived(recipient, assigns(from, recipient) ? body : null, now);
    if (recipient && recipient !== from && recipient.awaitingAnswer) this.answerReceived(recipient, now);
    if (body) this.protocol.handleProtocol({ to: message.to, toKey, text: body }, from, session, now);
  }

  private messageReceived(agent: AgentRuntime, body: string | null, now: number): void {
    if (agent.retiredAt !== null || agent.endedAt !== null) return;
    const plan = planSlugIn(body);
    if (plan) this.setPlan(agent, plan);
    const task = taskLine(body);
    if (!task && !agent.away) return;
    if (task) {
      agent.task = task;
      this.stall.openTask(agent, now);
    }
    if (agent.away) {
      agent.away = false;
      agent.updatedAt = now;
    }
    this.book.emitAgent(agent, now);
  }

  private answerReceived(agent: AgentRuntime, now: number): void {
    agent.awaitingAnswer = false;
    agent.state = 'working';
    agent.stateSince = now;
    agent.detail = { key: 'hub.detail.answerReceived' };
    agent.updatedAt = now;
    this.book.persistAgent(agent);
    this.book.emitAgent(agent, now);
  }

  private endSession(session: SessionRuntime, now: number, ghost = false): void {
    const silent = now - session.updatedAt;
    session.endedAt = now;
    session.ghost = ghost;
    session.openTools.clear();
    this.book.persistSession(session);
    if (ghost) {
      this.pushActivity({
        ts: now,
        agentKey: session.sessionId,
        event: 'Ghost',
        tool: null,
        state: null,
        summary: { key: 'hub.act.sessionGhost', params: { who: session.name ?? session.sessionId.slice(0, 8), minutes: Math.round(silent / 60_000) } },
      });
    }
    this.book.emitSession(session);
    for (const agent of this.book.agents.values()) {
      if (agent.sessionId !== session.sessionId || agent.endedAt !== null) continue;
      agent.endedAt = now;
      agent.waiting = null;
      agent.stalledSince = null;
      this.context.forgetChatNotes(new Set([agent.key]));
      if (agent.state !== 'done') {
        agent.state = 'done';
        agent.stateSince = now;
      }
      this.book.persistAgent(agent);
      this.book.emitAgent(agent, now);
      this.context.storeReport(agent, now);
      this.measure(agent);
      this.finishGuards(agent.key);
    }
    for (const q of this.desk.list()) if (q.sessionId === session.sessionId) this.desk.release(q.id);
  }

  // Reading the transcript of an agent is the meter's job, and a replay has no transcripts.
  private measure(agent: AgentRuntime): void {
    if (this.live) this.meter.later(agent);
  }

  private setPlan(agent: AgentRuntime, slug: string): void {
    if (this.live) this.meter.setPlan(agent, slug);
    else agent.planSlug = slug;
  }

  private finishGuards(agentKey: string): void {
    if (this.live) this.guards.finish(agentKey);
  }

  // Where a line of activity happened: the agent, or the session when the line is about one that has no agent.
  private activityOwner(key: string): { floor: string | null; sessionId: string | null } {
    const agent = this.book.agents.get(key);
    if (agent) return { floor: agent.floor, sessionId: agent.sessionId };
    const session = this.book.sessions.get(key);
    return session ? { floor: session.floor, sessionId: session.sessionId } : { floor: null, sessionId: null };
  }

  // What buildRecording needs of the live office to rebuild a session next to it.
  replaySource(): { db: Database; deps: ReplayDeps } {
    return {
      db: this.opts.db,
      deps: { config: this.config, profiles: this.profiles, workspaceDir: this.opts.workspaceDir, hubId: this.opts.hubId, registry: this.opts.registry },
    };
  }

  search(query: SearchQuery): SearchResult {
    return this.searches.search(query);
  }

  private noteCompaction(agent: AgentRuntime, now: number): void {
    const { from, to } = this.meter.compacted(agent);
    const pct = (value: number | null): string => (value === null ? '?' : `${value} %`);
    const who = agent.name ?? agent.role ?? agent.key.slice(0, 8);
    this.pushActivity({
      ts: now,
      agentKey: agent.key,
      event: 'Compacted',
      tool: null,
      state: null,
      summary: { key: 'hub.act.compacted', params: { who, from: pct(from), to: pct(to) } },
    });
    this.book.emitAgent(agent, now);
  }

  private pushActivity(entry: ActivityView): void {
    this.bus.pushActivity(entry);
  }

  private dumpRaw(e: HookEvent, now: number): void {
    const dir = this.live ? this.opts.rawDir : null;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const name = `${now}-${e.hook_event_name}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(join(dir, name), `${JSON.stringify(e, null, 2)}\n`);
    } catch {
      this.opts.rawDir = null;
    }
  }
}

function assigns(from: AgentRuntime, to: AgentRuntime): boolean {
  return from.parentKey !== to.key && roleKind(to.role) !== 'director';
}
