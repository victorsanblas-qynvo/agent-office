import { EDIT_TOOLS, record, type Matchers } from './state-machine';
import type { AgentContext, AgentState, DocumentStatus, DocumentView, FloorKind, HookEvent, HookMeta, HubText, LessonView, PlanDecision, Stack, TestResult } from './types';

export type AgentRuntime = {
  key: string;
  sessionId: string;
  parentKey: string | null;
  name: string | null;
  role: string | null;
  spawnType: string | null;
  teammate: boolean;
  team: string | null;
  floor: string;
  floorKind: FloorKind;
  touchedFloor: string | null;
  state: AgentState;
  stateSince: number;
  detail: HubText;
  tool: string | null;
  blockedReason: HubText | null;
  lastTest: TestResult | null;
  startedAt: number;
  closing: string | null;
  updatedAt: number;
  endedAt: number | null;
  sentState: AgentState | null;
  retiredAt: number | null;
  retiredAwake: boolean;
  awaitingAnswer: boolean;
  file: string | null;
  task: string | null;
  away: boolean;
  planSlug: string | null;
  waiting: { who: string; what: string; since: number } | null;
  taskOpenSince: number | null;
  stalledSince: number | null;
  context: AgentContext | null;
};

export type SessionRuntime = {
  sessionId: string;
  cwd: string | null;
  floor: string;
  floorKind: FloorKind;
  stack: Stack;
  role: string | null;
  name: string | null;
  socket: string | null;
  token: string | null;
  team: string | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  rulesHash: string | null;
  launchHash: string | null;
  needsRelaunch: boolean;
  persistedAt: number;
  ghost: boolean;
  openTools: Map<string, { agentKey: string; tool: string; since: number }>;
};

export type OrderResult = 'ok' | 'not-found' | 'not-office' | 'unreachable' | 'failed';

export type LessonResult = { ok: true; lesson: LessonView } | { ok: false; status: number; error: HubText };

export type RelaunchResult = 'ok' | 'not-found' | 'not-office' | 'busy' | 'no-script' | 'no-tmux' | 'no-window' | 'failed';

export type DiscardResult = 'ok' | 'not-found' | 'closed';

export type DecideResult = 'ok' | 'not-found' | 'invalid-state' | 'busy' | 'no-director' | 'unreachable' | 'failed';

export type RestoreResult = 'ok' | 'not-found' | 'not-discarded';

export const DECISION_FROM: Record<PlanDecision, readonly DocumentStatus[]> = {
  aparcar: ['entregado', 'ejecutando'],
  ejecutar: ['entregado', 'aparcado'],
  cerrar: ['ejecutando'],
};

export const NOT_DISCARDABLE: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['ejecutando', 'cerrado', 'descartado']);

export type LaunchPaths = { agentsDir: string; sessionsDir: string; directorFloors: string };

export type TmuxFn = (args: string[]) => Promise<{ code: number; stdout: string }>;

export const MAX_ACTIVITY = 300;
export const MAX_MESSAGES = 200;
export const MAX_ALERTS = 50;
export const FORGET_ENDED_MS = 10 * 60_000;
export const RESTORE_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_SPAWNS = 500;
export const TEAM_CACHE_MS = 5000;
export const DAY_MS = 86_400_000;
export const EMPTY_META: HookMeta = { socket: null, token: null, role: null, name: null };
export const NO_TESTS: Matchers = { test: /(?!)/, check: /(?!)/ };
export const NOT_PERMISSIONS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);
export const TURN_OVER: ReadonlySet<string> = new Set(['SubagentStop', 'Stop', 'TeammateIdle', 'SessionEnd']);
export const HOLDS_QUESTION: ReadonlySet<string> = new Set(['SubagentStop', 'Stop', 'TeammateIdle', 'Notification', 'PostToolUse', 'PostToolUseFailure']);
export const ANSWERS_QUESTION: ReadonlySet<string> = new Set(['PreToolUse', 'UserPromptSubmit', 'SubagentStart']);
export const NEW_TURN: ReadonlySet<string> = new Set(['UserPromptSubmit', 'SubagentStart']);
export const FILE_TOOLS: ReadonlySet<string> = new Set([...EDIT_TOOLS, 'Read', 'NotebookRead']);
export const READ_CAP_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'Bash']);
export const LEAD_BUSY: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'reading', 'testing', 'checking', 'talking']);
export const TASK_MAX = 120;
export const FINGERPRINT_ACTIVITY = 10;
export const METER_SWEEP_MS = 60_000;
export const RULES_MAX_CHARS = 12_000;
export const LAUNCH_CHECK_MS = 30_000;
export const GHOST_MS = 30 * 60_000;
export const GHOST_TOOL_MS = 4 * 60 * 60_000;
export const PERSIST_EVERY_MS = 60_000;
export const UNDO_MS = 10_000;
export const SNAPSHOT_CLOSED_DOCS = 100;
export const CLOSED_DOCS: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['cerrado', 'descartado']);
export const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function recentDocuments(docs: DocumentView[], closedLimit = SNAPSHOT_CLOSED_DOCS): DocumentView[] {
  let closed = 0;
  return docs.filter((doc) => !CLOSED_DOCS.has(doc.status) || ++closed <= closedLimit);
}

export function isHookEvent(value: unknown): value is HookEvent {
  const r = record(value);
  return typeof r.session_id === 'string' && r.session_id.length > 0 && typeof r.hook_event_name === 'string';
}

export function teamOfSession(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}`;
}

export function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_SPAWNS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
