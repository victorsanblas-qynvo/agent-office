export type Stack = 'flutter' | 'laravel' | 'node' | 'generic';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Text the hub shows in the panel. A string is raw text shown as is (commands, paths, names, what agents wrote,
// old recordings); an object is a key of the hub.* dictionary (shared/i18n) with its parameters, which may be
// HubText themselves. The panel translates it, so the same payload serves every language.
export type HubTextParams = {
  'hub.detail.waiting': undefined;
  'hub.detail.thinking': undefined;
  'hub.detail.permission': { tool: string };
  'hub.detail.starting': undefined;
  'hub.detail.finished': undefined;
  'hub.detail.end': undefined;
  'hub.detail.testsGreen': undefined;
  'hub.detail.testsRed': undefined;
  'hub.detail.testsInterrupted': undefined;
  'hub.detail.questionCancelled': undefined;
  'hub.detail.awaitingAnswer': undefined;
  'hub.detail.delegates': { what: HubText };
  'hub.detail.createsTask': { subject: string };
  'hub.detail.updatesTask': { id: string };
  'hub.detail.noAnswer': { detail: HubText };
  'hub.detail.blocked': undefined;
  'hub.detail.checking': undefined;
  'hub.detail.tests': undefined;
  'hub.detail.question': undefined;
  'hub.detail.delegatesTo': { who: HubText; what: string };
  'hub.detail.asks': { question: HubText };
  'hub.detail.answerReceived': undefined;
  'hub.detail.verdictApproved': undefined;
  'hub.detail.verdictImprove': undefined;
  'hub.detail.verdictNoAgreement': undefined;
  'hub.detail.waitingFor': { who: string; what: string };

  'hub.act.sessionStart': { source: string };
  'hub.act.compacted': { who: string; from: string; to: string };
  'hub.act.newTurn': undefined;
  'hub.act.permission': { tool: string };
  'hub.act.subagentStart': { who: HubText };
  'hub.act.done': undefined;
  'hub.act.turnEnd': undefined;
  'hub.act.sessionEnd': { reason: string };
  'hub.act.teammateIdle': { who: HubText };
  'hub.act.taskCreated': { subject: string };
  'hub.act.tests': { command: string };
  'hub.act.check': { command: string };
  'hub.act.run': { command: string };
  'hub.act.edit': { name: string };
  'hub.act.read': { what: string };
  'hub.act.question': { text: HubText };
  'hub.act.message': { to: string; text: string };
  'hub.act.blockedMessage': { to: string; text: string };
  'hub.act.delegate': { who: HubText };
  'hub.act.taskCreate': { subject: string };
  'hub.act.taskUpdate': { id: string };
  'hub.act.ok': { what: string };
  'hub.act.testsGreen': { command: string };
  'hub.act.edited': { name: string };
  'hub.act.subagentRunning': undefined;
  'hub.act.taskCreatedId': { id: string };
  'hub.act.taskCreatedPlain': undefined;
  'hub.act.questionAnswered': undefined;
  'hub.act.testsInterrupted': { command: string };
  'hub.act.testsRed': { command: string };
  'hub.act.toolFailed': { tool: string; error: string };
  'hub.act.awaits': { message: string };
  'hub.act.awaitingUser': undefined;
  'hub.act.notice': { message: string };
  'hub.act.taskClosed': { subject: string };
  'hub.act.taskBlocked': { subject: string };
  'hub.act.doneAccepted': { text: string };
  'hub.act.doneBlocked': undefined;
  'hub.act.guardBlocked': { who: string; target: string };
  'hub.act.order': { text: string };
  'hub.act.planDiscarded': { path: string };
  'hub.act.planRestored': { path: string };
  'hub.act.sessionGhost': { who: string; minutes: number };
  'hub.act.sourcesReady': { slug: string; floors: string };
  'hub.act.sourcesForeign': { n: number; dirs: string };
  'hub.act.guardAlert.one': { level: HubText; n: number; floor: string; who: string };
  'hub.act.guardAlert.other': { level: HubText; n: number; floor: string; who: string };
  'hub.act.memoryDelivered': { lessons: number; reports: number };
  'hub.act.deliveryAccepted': { path: string };
  'hub.act.deliveryBlockedStale': { path: string };
  'hub.act.deliveryBlockedNoPath': undefined;
  'hub.act.reviewRequested': { path: string; round: HubText };
  'hub.act.verdictApproved': { path: string; round: HubText; score: HubText };
  'hub.act.verdictImprove': { path: string; round: HubText; score: HubText };
  'hub.act.verdictNoAgreement': { path: string; round: HubText; score: HubText };
  'hub.act.commitFailed': { path: string; root: string };
  'hub.act.lessonSaved': { role: HubText; floor: HubText };
  'hub.act.lessonDuplicate': undefined;
  'hub.act.lessonCap': { max: number };
  'hub.act.lessonEmpty': undefined;
  'hub.act.permissionWaiting': { detail: string };
  'hub.act.questionWaiting': undefined;
  'hub.act.floorRemoved': { slug: string };
  'hub.act.asks': { to: string; question: HubText };
  'hub.act.planExecuting': { path: string };
  'hub.act.planAnalysisSent': { path: string };
  'hub.act.planParked': { path: string };
  'hub.act.planClosed': { path: string };
  'hub.act.planNotice': { to: string; path: string };
  'hub.act.verdictIgnored': { who: string; path: string };
  'hub.act.retiredIgnored': { who: string };

  'hub.act.reviewBlockedOverMax': { path: string; round: number; max: number };
  'hub.act.reviewIgnoredOverMax': { path: string; round: number; max: number };
  'hub.act.reviewBlockedTooLong': { path: string; kb: number; max: number };
  'hub.act.reviewIgnoredTooLong': { path: string; kb: number; max: number };
  'hub.act.readCapReached': { who: string; n: number };
  'hub.act.splitRequested': { who: string; path: string };
  'hub.act.briefsCapped': { n: number; max: number };
  'hub.act.rulesReloaded': { who: string };
  'hub.act.relaunched': { who: string };
  'hub.act.waitingDeclared': { who: string; to: string; what: string };
  'hub.act.stalled': { who: string; minutes: number };
  'hub.act.statusRequested': { who: string };
  'hub.act.chatPost': { who: string; channel: string; text: string };
  'hub.act.chatClaim': { who: string; channel: string; files: string };
  'hub.act.chatRelease': { who: string; channel: string; files: string };
  'hub.act.chatUser': { channel: string; text: string };
  'hub.act.chatCommand': undefined;
  'hub.act.orderCreated': { floor: string; title: string };
  'hub.act.orderMoved': { floor: string; title: string; status: HubText };
  'hub.act.orderDiscarded': { floor: string; title: string };
  'hub.act.orderFinished': { floor: string; title: string; cycle: number };
  'hub.act.orderFinishedManual': { floor: string; title: string };
  'hub.act.planFinished': { title: string; floors: string; cycle: number };
  'hub.act.worktreeFailed': { slug: string; reason: string };
  'hub.act.folderUnsent': { slug: string };
  'hub.act.reviewSent': { floor: string; title: string; n: number };
  'hub.act.reviewUnsent': { slug: string };
  'hub.act.editOutsideWorktree': { who: string; slug: string };
  'hub.act.checkpointSkipped': { slug: string; files: string };
  'hub.act.checkpointFailed': { slug: string };
  'hub.act.checkpointReset': { slug: string; n: number; ref: string };
  'hub.act.checkpointResetUndone': { slug: string; target: string; ref: string };
  'hub.act.checkpointResetFailed': { slug: string; ref: string };
  'hub.act.worktreesOrphan': { n: number; paths: string };
  'hub.act.worktreesPending': { n: number; sizeKb: number };
  'hub.act.worktreesHeavy': { gb: number; max: number };
  'hub.act.worktreesUnknown': { n: number; slugs: string };
  'hub.act.branchDeleted': { branch: string; sha: string };
  'hub.act.branchRestored': { branch: string; sha: string };
  'hub.act.branchMoved': { branch: string; sha: string };
  'hub.round': { n: number };
  'hub.score': { n: number };

  'hub.who.subagent': undefined;
  'hub.who.teammate': undefined;
  'hub.role.director': undefined;
  'hub.role.lead': undefined;
  'hub.role.dev': undefined;
  'hub.role.tester': undefined;
  'hub.role.reviewer': undefined;
  'hub.role.redactor': undefined;
  'hub.role.revisor-planes': undefined;
  'hub.role.artesano': undefined;
  'hub.role.revisor-skills': undefined;
  'hub.floor.direccion': undefined;
  'hub.floor.redaccion': undefined;
  'hub.floor.mantenimiento': undefined;
  'hub.floor.other': { slug: string };
  'hub.orderStatus.pendiente': undefined;
  'hub.orderStatus.en-curso': undefined;
  'hub.orderStatus.revision': undefined;
  'hub.orderStatus.hecho': undefined;
  'hub.orderStatus.descartado': undefined;
  'hub.alertLevel.alerta': undefined;
  'hub.alertLevel.posible': undefined;

  'hub.permission.bash': { who: string };
  'hub.permission.edit': { who: string };
  'hub.permission.read': { who: string };
  'hub.permission.web': { who: string };
  'hub.permission.other': { who: string; tool: string };

  'hub.report.counts': { files: HubText; tests: HubText };
  'hub.report.files.one': { n: number };
  'hub.report.files.other': { n: number };
  'hub.report.tests.one': { n: number };
  'hub.report.tests.other': { n: number };
  'hub.report.lastMessage': { to: string; text: string };
  'hub.report.empty': undefined;

  'hub.settings.saved': undefined;
  'hub.settings.noChanges': undefined;
  'hub.settings.regenerateFailed': { slug: string; error: HubText };
  'hub.settings.unknownRole': { id: string };
  'hub.settings.badModel': { id: string };
  'hub.settings.badEffort': { id: string };
  'hub.settings.badDepartment': { key: string };
  'hub.settings.badRange': { key: string; min: number; max: number };
  'hub.settings.noFloor': { slug: string };
  'hub.settings.badBranch': { branch: string; slug: string };
  'hub.settings.noTarget': { slug: string };
  'hub.settings.badPermissionMode': { slug: string };
  'hub.settings.roleNotOnFloor': { id: string; slug: string };
  'hub.settings.badFloorRole': { id: string; slug: string };
  'hub.settings.badFloorModel': { id: string; slug: string };
  'hub.settings.badFloorEffort': { id: string; slug: string };
  'hub.settings.badChecks': { slug: string };
  'hub.settings.badSetup': { slug: string };
  'hub.settings.badDelivery': { slug: string };
  'hub.settings.badGateMode': { slug: string };
  'hub.settings.badLinkDirs': { slug: string };
  'hub.settings.badCheckFiles': { slug: string };
  'hub.settings.badSkipGlobs': undefined;

  'hub.api.questionClosed': undefined;
  'hub.api.answerMissing': undefined;
  'hub.api.orderFields': undefined;
  'hub.api.orderTooLong': undefined;
  'hub.api.sessionNotFound': undefined;
  'hub.api.sessionNotOffice': undefined;
  'hub.api.transcriptMissing': undefined;
  'hub.api.orderFailed': undefined;
  'hub.api.statusBusy': undefined;
  'hub.api.settingsUnavailable': undefined;
  'hub.api.floorsUnavailable': undefined;
  'hub.api.badMemoryTarget': undefined;
  'hub.api.badId': undefined;
  'hub.api.lessonNotFound': undefined;
  'hub.api.noReport': undefined;
  'hub.api.searchBad': undefined;
  'hub.api.noRecording': undefined;
  'hub.api.recordingTooLarge': { max: number };
  'hub.api.documentNotFound': undefined;
  'hub.api.roundSha': undefined;
  'hub.api.roundsFailed': undefined;
  'hub.api.pathRequired': undefined;
  'hub.api.planClosed': undefined;
  'hub.api.planNotFound': undefined;
  'hub.api.decisionFields': undefined;
  'hub.api.planBadState': undefined;
  'hub.api.planBusy': undefined;
  'hub.api.planNotDiscarded': undefined;
  'hub.api.bodyTooLarge': undefined;
  'hub.api.internalError': undefined;
  'hub.api.directorClosed': undefined;
  'hub.api.directorUnreachable': undefined;
  'hub.api.floorRequired': undefined;
  'hub.api.roleInvalid': undefined;
  'hub.api.lessonEmpty': undefined;
  'hub.api.lessonDuplicate': undefined;
  'hub.api.lessonSaveFailed': undefined;
  'hub.api.chatFields': undefined;
  'hub.api.chatTooLong': undefined;
  'hub.api.chatKind': undefined;
  'hub.api.usageRange': undefined;
  'hub.api.digestDay': undefined;
  'hub.api.digestRange': undefined;
  'hub.api.metricsDays': undefined;
  'hub.api.timelineHours': undefined;
  'hub.api.flakyDays': undefined;
  'hub.api.flakyFloor': undefined;
  'hub.api.chatAuthorUnknown': undefined;
  'hub.api.chatFloorUnknown': undefined;
  'hub.api.chatChannelUnknown': undefined;
  'hub.api.chatChannelForbidden': undefined;
  'hub.api.chatSessionUnknown': undefined;
  'hub.api.relaunchBusy': undefined;
  'hub.api.relaunchNoWindow': undefined;
  'hub.api.relaunchNoTmux': undefined;
  'hub.api.relaunchNoScript': undefined;
  'hub.api.relaunchFailed': undefined;
  'hub.api.panelLinkInvalid': undefined;
  'hub.move.red': { name: string };
  'hub.move.touched': { files: string };
  'hub.api.noFolder': undefined;
  'hub.api.noChecks': undefined;
  'hub.api.checkpointNotFound': undefined;
  'hub.api.checkpointNotOnBranch': undefined;
  'hub.api.restoreNoFolder': undefined;
  'hub.api.restoreChecksRunning': undefined;
  'hub.api.restoreBusy': { who: string };
  'hub.api.restoreOffBranch': undefined;
  'hub.api.restoreCheckpointFailed': undefined;
  'hub.api.restoreLeftovers': { files: string };
  'hub.api.restoreFailed': undefined;
  'hub.api.safetyRefInvalid': undefined;
  'hub.api.safetyRefNotFound': undefined;
  'hub.api.restorePrOpen': undefined;
  'hub.api.restoreDone': undefined;
  'hub.api.forkViaLead': undefined;
  'hub.api.forkBranchExists': { branch: string };
  'hub.api.forkStartFailed': { reason: string };
  'hub.api.boardFields': undefined;
  'hub.api.floorNotManaged': undefined;
  'hub.api.deliveryOff': { floor: string };
  'hub.api.leadClosed': undefined;
  'hub.api.orderNotFound': undefined;
  'hub.api.alertNotFound': undefined;
  'hub.api.orderBadState': undefined;
  'hub.api.moveNeedsForce': { reason: HubText };
  'hub.api.worktreeNotFound': undefined;
  'hub.api.worktreeBusy': undefined;
  'hub.api.worktreeDirty': undefined;
  'hub.api.branchUnmerged': undefined;
  'hub.api.branchMoved': undefined;
  'hub.api.worktreeFailed': undefined;
  'hub.api.branchRestoreBad': undefined;
  'hub.api.branchDeletionNotFound': undefined;
  'hub.api.branchRestoreExists': undefined;
  'hub.api.branchCommitGone': undefined;
  'hub.api.branchRestoreFailed': undefined;
  'hub.api.orderNoBranch': undefined;
  'hub.api.orderNoFolder': undefined;
  'hub.api.diffPath': undefined;
  'hub.api.reviewFields': undefined;
  'hub.api.reviewUnsent': undefined;
  'hub.api.reviewNothingUnsent': undefined;
  'hub.api.diffFailed': undefined;
  'hub.api.logFailed': undefined;

  'hub.layouts.unavailable': undefined;
  'hub.layouts.invalid': undefined;
  'hub.layouts.slug': { slug: string };
  'hub.layouts.tooManyFloors': { max: number };
  'hub.layouts.tooManyDesks': { max: number };
  'hub.layouts.spot': { where: string };
  'hub.layouts.furniture': { name: string };
  'hub.layouts.role': { role: string };
  'hub.layouts.model': { role: string };
  'hub.layouts.saveFailed': undefined;

  'hub.doc.tooLarge': undefined;

  'hub.floors.pathRequired': undefined;
  'hub.floors.notFound': { slug: string };
  'hub.floors.conflictManaged': { path: string; slug: string };
  'hub.floors.inUse': { slug: string; sessions: string };
  'hub.floors.removing': { slug: string };
  'hub.floors.dirtyWorktrees': { slug: string; orders: string };
  'hub.floors.added': { slug: string; startCommand: string };
  'hub.floors.notGitRepo': { path: string };
  'hub.floors.insideRepo': { path: string; top: string };
  'hub.floors.slugInvalid': { slug: string };
  'hub.floors.slugReserved': { slug: string };
  'hub.floors.missing': { path: string };
  'hub.floors.notDir': { path: string };
  'hub.floors.liveCopy': { path: string };
  'hub.floors.slugTaken': { slug: string; path: string };
  'hub.floors.pathTaken': { path: string; other: string };

  'hub.pr.summary': undefined;
  'hub.pr.commits': undefined;
  'hub.pr.commitsMore': { n: number };
  'hub.pr.noCommits': undefined;
  'hub.pr.checks': undefined;
  'hub.pr.noChecks': undefined;
  'hub.pr.staleChecks': { sha: string };
  'hub.pr.colCheck': undefined;
  'hub.pr.colResult': undefined;
  'hub.pr.colDuration': undefined;
  'hub.pr.diff': undefined;
  'hub.pr.diffTotals': { files: number; adds: number; dels: number };
  'hub.pr.branches': { branch: string; base: string };
  'hub.pr.status.pending': undefined;
  'hub.pr.status.running': undefined;
  'hub.pr.status.passed': undefined;
  'hub.pr.status.failed': undefined;
  'hub.pr.status.timeout': undefined;
  'hub.pr.status.cancelled': undefined;
  'hub.review.header': { slug: string };
  'hub.review.intro': undefined;
  'hub.review.summary': { text: string };
  'hub.review.line': { path: string; line: number; body: string };
  'hub.review.oldLine': { path: string; line: number; body: string };
  'hub.review.file': { path: string; body: string };
};

export type HubTextKey = keyof HubTextParams;

type HubTextOf<K extends HubTextKey> = HubTextParams[K] extends undefined ? { key: K; params?: undefined } : { key: K; params: HubTextParams[K] };

export type HubText = string | { [K in HubTextKey]: HubTextOf<K> }[HubTextKey];

export type RoleId =
  | 'director'
  | 'lead'
  | 'dev'
  | 'tester'
  | 'reviewer'
  | 'redactor'
  | 'revisor-planes'
  | 'artesano'
  | 'revisor-skills';

export type RoleSettings = { model: string; effort: Effort };

export type PermissionMode = 'auto' | 'manual' | 'acceptEdits' | 'plan' | 'dontAsk';

export type Profile = {
  label: string;
  skill: string | null;
  testRegex: string;
  checkRegex: string;
  testCommand: string;
  // Files whose change alters how the floor is checked: a glob, or file#key for "only if that key changes".
  checkFiles: string[];
};

export type CheckSpec = { name: string; command: string };

// checks: the hub runs the checks and the tester is optional; checks+tester: both; tester: as before the Tablero.
export type GateMode = 'checks' | 'checks+tester' | 'tester';

export type ReviewMode = 'always' | 'large' | 'off';

// Every optional field has a default that keeps the floor as it was: undefined means "the profile's", and for
// checks and setup an empty list or null means "none".
export type FloorConfig = {
  path: string;
  stack: Stack;
  managed: boolean;
  baseBranch: string;
  checks?: CheckSpec[];
  setup?: string | null;
  linkDirs?: string[];
  // Opt-in: the floor works with a card, a branch and a folder per order. Absent or false is the flow before the Tablero.
  delivery?: boolean;
  gateMode?: GateMode;
  review?: ReviewMode;
  reviewLargeLines?: number;
  checkFiles?: string[];
};

export type ChecksConfig = { timeoutMinutes: number; maxParallel: number; tailBytes: number };

export type WorktreesConfig = { retentionDays: number; maxActivePerFloor: number; warnTotalGb: number };

export type CheckpointsConfig = { maxFileKb: number; skipGlobs: string[] };

export type DepartmentsConfig = { redaccion: boolean; mantenimiento: boolean };

export type ReviewConfig = { maxRounds: number; maxPlanBytes: number; maxReviewerReads: number };

export type LimitsConfig = { maxBriefsPerOrder: number; stalledAfterMinutes: number };

export type MemoryConfig = { maxLessons: number; maxLessonsPerSession: number; maxContextChars: number };

export type FloorRoles = Record<string, Partial<Record<RoleId, RoleSettings>>>;

export type OfficeConfig = {
  configVersion: number;
  floors: Record<string, FloorConfig>;
  roles: Record<RoleId, RoleSettings>;
  floorRoles: FloorRoles;
  docsRepo: string;
  departments: DepartmentsConfig;
  review: ReviewConfig;
  memory: MemoryConfig;
  limits: LimitsConfig;
  permissionModes: Record<string, PermissionMode>;
  checksConfig: ChecksConfig;
  worktrees: WorktreesConfig;
  checkpoints: CheckpointsConfig;
  blockedAfterMinutes: number;
  leaveAfterMinutes: number;
  retentionDays: number;
  port: number;
};

export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  source?: string;
  reason?: string;
  prompt?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  teammate_name?: string;
  team_name?: string;
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  session_title?: string;
  model?: string;
  [key: string]: unknown;
};

export type HookMeta = {
  socket: string | null;
  token: string | null;
  role: string | null;
  name: string | null;
};

export type AgentState =
  | 'idle'
  | 'working'
  | 'reading'
  | 'testing'
  | 'checking'
  | 'asking'
  | 'talking'
  | 'blocked'
  | 'done'
  | 'failed';

export type RoleKind =
  | 'director'
  | 'lead'
  | 'dev'
  | 'tester'
  | 'reviewer'
  | 'writer'
  | 'planReviewer'
  | 'skillwright'
  | 'skillReviewer'
  | 'intern';

export type FloorKind = 'direccion' | 'managed' | 'observed' | 'redaccion' | 'mantenimiento';

export type Building = 'principal' | 'mantenimiento';

export type TestResult = { ok: boolean; ts: number; command: string };

export type ContextSource = 'statusline' | 'transcript';

// How full the window of an agent is. Main sessions report it through the status line; teammates and
// subagents are measured from the last turn of their transcript.
export type AgentContext = {
  usedPct: number;
  tokens: number;
  window: number;
  compactions: number;
  source: ContextSource;
  at: number;
};

export type AgentView = {
  key: string;
  sessionId: string;
  parentKey: string | null;
  name: string | null;
  role: string | null;
  roleId: RoleId | null;
  roleKind: RoleKind;
  floor: string;
  touchedFloor: string | null;
  state: AgentState;
  detail: HubText;
  tool: string | null;
  lastTest: TestResult | null;
  stateSince: number;
  updatedAt: number;
  endedAt: number | null;
  file: string | null;
  task: string | null;
  away: boolean;
  tokens: TokenTotals | null;
  waiting: { who: string; what: string; since: number } | null;
  stalledSince: number | null;
  // When the oldest tool still open (leaving out the ones that wait by design) began, and its name; null with none open. Not persisted.
  toolSince: number | null;
  openTool: string | null;
  context: AgentContext | null;
};

export type FloorView = {
  slug: string;
  label: string;
  path: string | null;
  stack: Stack;
  kind: FloorKind;
  building: Building;
  // A managed floor that works with a folder per order: the only ones the Tablero takes new orders for.
  delivery?: boolean;
};

export type AskOption = { label: string; description?: string };

export type AskQuestion = {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
};

export type QuestionKind = 'ask' | 'permission';

export type QuestionView = {
  id: string;
  kind?: QuestionKind;
  detail?: string;
  tool?: string;
  // What the panel shows above the options (permissions); questions[0].question stays the answer key.
  prompt?: HubText;
  agentKey: string;
  sessionId: string;
  floor: string;
  questions: AskQuestion[];
  createdAt: number;
  expiresAt: number;
};

export type QuestionOutcome = 'answered' | 'released' | 'expired';

export type MessageView = {
  id: number;
  ts: number;
  fromKey: string;
  toName: string;
  toKey: string | null;
  text: string | null;
  floor: string;
};

export type ChatKind = 'texto' | 'toca' | 'listo' | 'pregunta';

export type ChatOrigin = 'agent' | 'user';

export type ChatMessageView = {
  id: number;
  ts: number;
  channel: string;
  floor: string;
  authorKey: string;
  authorName: string;
  role: string | null;
  roleId: RoleId | null;
  origin: ChatOrigin;
  kind: ChatKind;
  text: string;
  files: string[];
};

export type ChatClaimView = { file: string; authorKey: string; authorName: string; ts: number; id: number };

export type ChatPostRequest = { channel: string; kind?: ChatKind; text: string; files?: string[]; from?: string; cwd?: string };

export type ChatPostResult = { ok: true; message: ChatMessageView; warnings: ChatClaimView[] } | { ok: false; status: 400 | 403 | 404; error: HubText };

export type ChatUserResult = { message: ChatMessageView; delivered: number };

export type SessionView = {
  sessionId: string;
  agentKey: string;
  name: string | null;
  role: string | null;
  floor: string;
  canReceive: boolean;
  endedAt: number | null;
  needsRelaunch: boolean;
  rulesPending: boolean;
  canRelaunch: boolean;
  relaunchResumes: boolean;
  office: boolean;
  cwd: string | null;
};

export type ActivityView = {
  ts: number;
  agentKey: string;
  event: string;
  tool: string | null;
  state: AgentState | null;
  summary: HubText;
};

export const SEARCH_KINDS = ['activity', 'message', 'chat', 'agent'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

// One thing the office remembers: a line of activity, a message between agents, a chat message or an agent.
// id is the row of its table (the key of the agent); text is what the panel shows for it.
export type SearchHit = {
  kind: SearchKind;
  id: string;
  ts: number;
  floor: string | null;
  agent: string | null;
  sessionId: string | null;
  text: HubText;
};

// next is the cursor ("ts:id") to ask for the following page, null at the end. indexed is false when the
// full-text index is not available and the search ran as a plain substring match.
export type SearchResult = { hits: SearchHit[]; next: string | null; indexed: boolean };

export type VerdictKind = 'tests' | 'approved' | 'improve' | 'no-agreement';

export type LessonOrigin = 'agent' | 'user';

export type LessonView = {
  id: number;
  floor: string;
  role: RoleId;
  text: string;
  origin: LessonOrigin;
  agentKey: string | null;
  createdAt: number;
};

export type TranscriptEntry = { ts: number; role: 'assistant' | 'tool' | 'user'; text: string };

export type TranscriptTail = { entries: TranscriptEntry[]; hidden?: true };

export type ReportView = {
  agentKey: string;
  name: string | null;
  role: string | null;
  roleId: RoleId | null;
  floor: string;
  startedAt: number;
  endedAt: number | null;
  live: boolean;
  // summary is what agents read (Spanish); summaryText is the same in panel form, or null when it is agent text.
  summary: string;
  summaryText?: HubText | null;
  files: string[];
  tests: { ok: boolean; ts: number; command: string }[];
  verdicts: { kind: VerdictKind; ts: number; path: string | null; round: number | null; score: number | null }[];
  sent: { ts: number; to: string; text: string | null }[];
  received: { ts: number; from: string; text: string | null }[];
  questions: number;
  blocked: number;
  lessons: string[];
  closing: string | null;
  tokens: TokenTotals | null;
};

export type DocumentKind = 'plan' | 'skill';

export type DocumentType = 'implementacion' | 'analisis';

export type DocumentStatus =
  | 'borrador'
  | 'revision'
  | 'aprobado'
  | 'sin-acuerdo'
  | 'entregado'
  | 'aparcado'
  | 'ejecutando'
  | 'cerrado'
  | 'descartado';

export type PlanDecision = 'ejecutar' | 'aparcar' | 'cerrar';

export type DocumentBase = { floor: string; ref: string; sha: string; date: string | null; stale: boolean };

export type DocumentAhead = { floor: string; commits: number; files: string[] };

export type DocumentView = {
  path: string;
  kind: DocumentKind;
  slug: string;
  title: string;
  docType: DocumentType;
  status: DocumentStatus;
  round: number;
  maxRounds: number;
  score: number | null;
  updatedAt: number;
  deliveredAt: number | null;
  decidedAt: number | null;
  base: DocumentBase[];
  ahead: DocumentAhead[];
  installedAt: string[];
  tokens: TokenTotals | null;
};

export type OrderStatus = 'pendiente' | 'en-curso' | 'revision' | 'hecho' | 'descartado';

// director: an ENCARGO of the director to a lead; plan: a card made when a plan is executed; panel-lead and
// panel-director: a card made from the panel, briefed straight to the lead or through the director.
export type OrderSource = 'director' | 'plan' | 'panel-lead' | 'panel-director';

export type WorktreeState = 'creando' | 'preparando' | 'listo' | 'error' | 'retirado';

export type CheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled';

export type CheckRunStatus = 'running' | 'passed' | 'failed' | 'cancelled';

export type CheckTrigger = 'listo' | 'comprobar' | 'panel' | 'hecho';

export type CheckView = {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number | null;
  outputTail: string | null;
};

export type CheckRunView = {
  id: number;
  orderId: number;
  sha: string;
  trigger: CheckTrigger;
  status: CheckRunStatus;
  startedAt: number;
  endedAt: number | null;
  checks: CheckView[];
};

export type OrderChecksView = {
  status: 'none' | 'running' | 'passed' | 'failed';
  passed: number;
  total: number;
  sha: string | null;
  // Files of the diff that change how the floor is checked; the HECHO waits for a force while there are any.
  touched: string[];
  forced: boolean;
};

// A check that failed and later passed on the same commit within an order.
export type FlakyCheckView = { floor: string; check: string; flakyCount: number; lastAt: number; orders: number };

export type OrderWorktreeView = { path: string; state: WorktreeState; error: string | null; stale: boolean };

export type OrderView = {
  id: number;
  slug: string;
  floor: string;
  title: string;
  description: string;
  status: OrderStatus;
  source: OrderSource;
  planSlug: string | null;
  parentId: number | null;
  lead: string | null;
  branch: string | null;
  base: string | null;
  baseSha: string | null;
  worktree: OrderWorktreeView | null;
  checks: OrderChecksView | null;
  review: { state: string };
  pr: { url: string; state: string | null } | null;
  mergedAt: number | null;
  tokens: TokenTotals | null;
  cycle: number;
  createdAt: number;
  updatedAt: number;
  lastActivity: number | null;
};

export type CheckpointView = { id: number; sha: string; reason: string; label: string; createdAt: number };

// A HEAD a restore replaced, kept under refs/office/<slug>/before-reset-<at>.
export type SafetyRefView = { ref: string; sha: string; at: number };

export type RestorePreview = {
  dropped: string[];
  droppedTotal: number;
  stat: { files: number; adds: number; dels: number };
  dirty: string[];
  blocked: HubText | null;
};

export type SkippedFile = { path: string; size: number; mtime: number };

export type DiffFileStat = { path: string; oldPath: string | null; adds: number | null; dels: number | null; binary: boolean };

export type OrderDiff = { base: string; head: string; files: DiffFileStat[]; totals: { files: number; adds: number; dels: number }; truncated: boolean };

export type OrderDiffFile = { path: string; patch: string; truncated: boolean; binary: boolean };

// A review comment on the diff of an order: line null is about the whole file; cycle and sha are those of the
// order when it was written, sentAt null when the lead did not get it.
export type OrderCommentView = {
  id: number;
  path: string;
  line: number | null;
  side: 'new' | 'old';
  body: string;
  cycle: number | null;
  sha: string | null;
  createdAt: number;
  sentAt: number | null;
};

export type WorktreeView = {
  orderId: number;
  slug: string;
  floor: string;
  title: string;
  branch: string;
  base: string;
  baseSha: string;
  path: string;
  state: WorktreeState;
  setupError: string | null;
  ahead: number;
  behind: number;
  sizeKb: number | null;
  sizeAt: number | null;
  lastActivity: number | null;
  dirty: boolean;
  merged: boolean;
  orderStatus: OrderStatus;
  // A finished order whose branch was never merged and is past the retention: the user decides.
  pending: boolean;
  kept: boolean;
};

// Why a deleted branch cannot come back: a branch has that name again, git no longer has the commit, or git did not answer.
export type DeletedBranchBlock = 'exists' | 'gone' | 'unknown' | 'superseded';

export type DeletedBranchView = { floor: string; branch: string; sha: string; at: number; restorable: boolean; reason: DeletedBranchBlock | null };

// An order branch no live order owns; ahead and behind are against the floor's base, null when git could not count them.
export type OrphanBranchView = {
  branch: string;
  sha: string;
  committedAt: number;
  ahead: number | null;
  behind: number | null;
  order: { slug: string; status: OrderStatus } | null;
};

// What the popup of the end of an order or plan shows; it is a snapshot of the facts when the alert was made.
export type FinishedView = {
  id: number;
  ts: number;
  kind: 'order' | 'plan';
  slug: string;
  title: string;
  floors: string[];
  branch: string | null;
  summary: string;
  cycle: number;
  manual: boolean;
  checks: { passed: number; total: number } | null;
  touched: string[];
  prUrl: string | null;
  orderSlugs: string[];
};

export type GuardAlertLevel = 'alerta' | 'posible';

export type GuardAlert = {
  id: number;
  ts: number;
  level: GuardAlertLevel;
  floor: string;
  agentKey: string;
  files: string[];
};

export type SettingsTarget = { id: string; label: string; stack: Stack | null; roles: RoleId[] };

export type SettingsView = {
  roles: Record<RoleId, RoleSettings>;
  floorRoles: FloorRoles;
  targets: SettingsTarget[];
  departments: DepartmentsConfig;
  review: ReviewConfig;
  memory: MemoryConfig;
  limits: LimitsConfig;
  docsRepo: string;
  port: number;
  permissionModes: Record<string, PermissionMode>;
  leaveAfterMinutes: number;
  checksConfig: ChecksConfig;
  worktrees: WorktreesConfig;
  checkpoints: CheckpointsConfig;
  floors: SettingsFloor[];
};

// What the panel edits of a floor besides its branch. mode default is "what the stack of the floor does".
export type SettingsFloor = {
  slug: string;
  path: string;
  stack: Stack;
  managed: boolean;
  baseBranch: string;
  checks: { mode: 'default' | 'custom'; list: CheckSpec[] };
  setup: { mode: 'default' | 'none' | 'custom'; command: string | null };
  linkDirs: string[];
  delivery: boolean;
  gateMode: GateMode | null;
  effectiveGateMode: GateMode;
  checkFiles: string[];
  profileCheckFiles: string[];
};

export type SettingsFloorUpdate = {
  baseBranch?: string;
  checks?: { mode: 'default' } | { mode: 'custom'; list: CheckSpec[] };
  setup?: { mode: 'default' } | { mode: 'none' } | { mode: 'custom'; command: string };
  linkDirs?: string[];
  delivery?: boolean;
  gateMode?: GateMode | null;
  checkFiles?: string[];
};

export type SettingsUpdate = {
  roles?: Partial<Record<RoleId, Partial<RoleSettings>>>;
  floorRoles?: Record<string, Partial<Record<RoleId, Partial<RoleSettings> | null>>>;
  departments?: Partial<DepartmentsConfig>;
  review?: Partial<ReviewConfig>;
  memory?: Partial<MemoryConfig>;
  limits?: Partial<LimitsConfig>;
  floors?: Record<string, SettingsFloorUpdate>;
  permissionModes?: Record<string, PermissionMode>;
  leaveAfterMinutes?: number;
  checksConfig?: Partial<ChecksConfig>;
  worktrees?: Partial<WorktreesConfig>;
  checkpoints?: Partial<CheckpointsConfig>;
};

export type SettingsResult = { ok: true; regenerated: number; note: HubText[] } | { ok: false; error: HubText[] };

export type FloorAddRequest = { path: string; slug?: string };

export type FloorErrorStatus = 400 | 404 | 409 | 500;

export type FloorFailure = { ok: false; status: FloorErrorStatus; error: HubText };

export type FloorAddResult = { ok: true; slug: string; path: string; stack: Stack; startCommand: string; note: HubText } | FloorFailure;

export type FloorRemoveResult = { ok: true; slug: string; removed: { files: number; rows: number; worktrees: number } } | FloorFailure;

export type MemoryView = { floor: string; role: RoleId; lessons: LessonView[]; reports: ReportView[] };

export type LessonCreate = { floor: string; role: RoleId; text: string };

export type DocumentRound = { sha: string; at: number; subject: string; round?: number };

export type DocumentRoundDiff = { path: string; from: string; to: string; patch: string; truncated: boolean };

export type DocumentContent = { path: string; kind: DocumentKind; markdown: string; notice?: HubText };

// 'fit': pace and moment from a fit of the samples; 'thin': too few samples to say anything yet.
export type UsageForecast = { rate: number; exhaustsAt: number | null; safe: boolean; basis: 'fit' | 'thin' };

export type UsageWindow = { usedPct: number; resetsAt: number; forecast?: UsageForecast };

export type UsageView = { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; at: number | null };

export type TokenTotals = { turns: number; input: number; cacheRead: number; cacheCreate: number; output: number };

export type TokenRow = { key: string; tokens: TokenTotals; agents: number };

export type OrderSpend = {
  tokens: number;
  byModel: { model: string; tokens: number }[];
  byRole: { role: string; tokens: number }[];
  sessions: number;
  basis: 'plan+folder';
};

export type UsageRange = 'today' | 'week';

export type UsageDay = { day: string; tokens: number };

export type UsageSummary = {
  range: UsageRange;
  from: string;
  to: string;
  total: { tokens: TokenTotals; agents: number };
  byDay: UsageDay[];
  byRole: TokenRow[];
  byModel: TokenRow[];
  byFloor: TokenRow[];
  byPlan: TokenRow[];
};

export type DigestCounts = {
  blocked: number;
  redRuns: number;
  greenRuns: number;
  tokens: number;
  plans: { approved: number; noAgreement: number };
  lessons: number;
};

export type DigestFloor = DigestCounts & { floor: string; delivered: { slug: string; title: string }[] };

export type OfficeDigest = { day: string; floors: DigestFloor[]; totals: DigestCounts & { delivered: number } };

export type DeliveryStats = {
  delivered: number;
  medianLeadMs: number | null;
  p90LeadMs: number | null;
  reopenRate: number;
  firstPassGreen: number | null;
  avgRunsPerOrder: number;
};
export type FloorDeliveryMetrics = DeliveryStats & { floor: string };
export type DeliveryMetrics = { days: number; floors: FloorDeliveryMetrics[]; totals: DeliveryStats };
export type WeekDigest = { from: string; to: string; days: OfficeDigest[]; floors: DigestFloor[]; totals: DigestCounts & { delivered: number } };

export type TimelineSegment = { from: number; to: number; state: string };

export type AgentTimeline = { agent: string; floor: string; segments: TimelineSegment[] };

export type TimelineView = { hours: number; agents: AgentTimeline[] };

export type TokensEvent = {
  agentKey: string;
  tokens: TokenTotals;
  plan: { slug: string; tokens: TokenTotals } | null;
  context?: AgentContext | null;
};

// A place on a floor, normalised: u across the width and v across the depth, both from 0 to 1. The 3D and the
// 2D views turn it into their own coordinates.
export type Spot = { u: number; v: number };

export type FurnitureKind = 'coffee' | 'meeting' | 'lab' | 'board' | 'printer';

// What the user moved on one floor. A missing field is the default place; desks are by position in the plan, and
// a null leaves that desk where it is.
export type FloorLayoutOverride = {
  lead?: Spot;
  desks?: (Spot | null)[];
  furniture?: Partial<Record<FurnitureKind, Spot>>;
  // Model of the character of each role, `quaternius/<name>.glb` or `custom/<name>.glb`.
  characters?: Partial<Record<RoleKind, string>>;
};

// ~/.config/agent-office/layouts.json. `all` is what every floor starts from; a floor's own override wins.
export type LayoutsFile = { version: 1; floors: Record<string, FloorLayoutOverride>; all?: FloorLayoutOverride };

export type Snapshot = {
  now: number;
  floors: FloorView[];
  agents: AgentView[];
  sessions: SessionView[];
  questions: QuestionView[];
  messages: MessageView[];
  activity: ActivityView[];
  documents: DocumentView[];
  alerts: GuardAlert[];
  usage: UsageView;
  chat: ChatMessageView[];
  orders: OrderView[];
  finished: FinishedView[];
  layouts: LayoutsFile;
};

export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'floors'; data: FloorView[] }
  | { type: 'agent'; data: AgentView }
  | { type: 'agent-gone'; key: string }
  | { type: 'session'; data: SessionView }
  | { type: 'question'; data: QuestionView }
  | { type: 'question-closed'; id: string; outcome: QuestionOutcome }
  | { type: 'message'; data: MessageView }
  | { type: 'activity'; data: ActivityView }
  | { type: 'documents'; data: DocumentView[] }
  | { type: 'alert'; data: GuardAlert }
  | { type: 'memory'; floor: string; role: RoleId }
  | { type: 'settings'; data: SettingsView }
  | { type: 'usage'; data: UsageView }
  | { type: 'tokens'; data: TokensEvent }
  | { type: 'chat'; data: ChatMessageView }
  | { type: 'orders'; data: OrderView[] }
  | { type: 'order'; data: OrderView }
  | { type: 'checks'; orderId: number; data: CheckRunView }
  | { type: 'worktrees'; floor: string }
  | { type: 'finished'; data: FinishedView }
  | { type: 'layouts'; data: LayoutsFile };

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'heartbeat'; visible: boolean };

export type Recording = {
  version: 1;
  startedAt: number;
  messages: { t: number; msg: ServerMessage }[];
};

export type AnswerRequest = { answers: Record<string, string> } | { release: true };

export type OrderRequest = { sessionId: string; text: string; broadcast?: boolean };

export type PlanDecisionRequest = { path: string; decision: PlanDecision };

export type DiagnosticsView = {
  version: string | null;
  schema: number;
  uptimeMs: number;
  dbBytes: number | null;
  fts: boolean;
  hook: { count: number; p50: number | null; p95: number | null; p99: number | null };
  activeCheckRuns: number;
  worktrees: number;
  sessions: number;
  logTail: string[];
};
