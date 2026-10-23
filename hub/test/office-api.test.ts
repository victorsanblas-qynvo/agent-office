import { afterEach, describe, expect, test } from 'bun:test';
import * as officeModule from '../src/office';
import type {
  DecideResult,
  DiscardResult,
  LaunchPaths,
  LessonResult,
  OfficeOptions,
  OrderResult,
  RelaunchResult,
  RestoreResult,
  TmuxFn,
} from '../src/office';
import { harness, type Harness } from './helpers';

const PUBLIC_METHODS = [
  'answer',
  'ask',
  'addLesson',
  'boardOrders',
  'cancelOrderChecks',
  'confirmOrderChecks',
  'chatHistory',
  'createOrder',
  'decidePlan',
  'discardDocument',
  'discardOrder',
  'documentContent',
  'documentRoundDiff',
  'documentRounds',
  'documents',
  'expireSources',
  'expireWorktrees',
  'floorInUse',
  'forgetFloor',
  'gate',
  'gateMessage',
  'guard',
  'heartbeat',
  'idle',
  'ingest',
  'ingestUsage',
  'keepWorktree',
  'layouts',
  'listWorktrees',
  'markFinishedSeen',
  'memoryView',
  'moveOrder',
  'order',
  'orderCheckpoints',
  'orderChecks',
  'orderScript',
  'panelConnected',
  'panelDisconnected',
  'permission',
  'postChat',
  'pruneWorktrees',
  'readChat',
  'refreshDocuments',
  'release',
  'relaunch',
  'reload',
  'removeLesson',
  'removeWorktree',
  'report',
  'requestStatus',
  'restoreDocument',
  'retryOrderFolder',
  'runOrderChecks',
  'saveLayouts',
  'snapshot',
  'start',
  'stop',
  'subscribe',
  'syncSources',
  'tick',
  'tokenSummary',
  'userChat',
];

const RUNTIME_EXPORTS = [
  'DISCARDED_MARK',
  'GHOST_MS',
  'GHOST_TOOL_MS',
  'Office',
  'PERSIST_EVERY_MS',
  'ROLE_LABELS',
  'SNAPSHOT_CLOSED_DOCS',
  'STATUS_REQUEST',
  'UNDO_MS',
  'analysisOrderText',
  'chatFreeCommand',
  'executeOrderText',
  'floorLabel',
  'historyPath',
  'isChatCommand',
  'isHookEvent',
  'isUserPrompt',
  'permissionDetail',
  'permissionMatch',
  'permissionPrompt',
  'recentDocuments',
  'taskLine',
  'teamOfSession',
  'withoutDiscardMark',
];

// Compile-time only: the exported types must keep resolving from '../src/office'.
export type ExportedTypes = [DecideResult, DiscardResult, LaunchPaths, LessonResult, OfficeOptions, OrderResult, RelaunchResult, RestoreResult, TmuxFn];

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe('public API of Office', () => {
  test('every public method is a function of the prototype', () => {
    const proto = officeModule.Office.prototype as unknown as Record<string, unknown>;
    for (const name of PUBLIC_METHODS) expect(typeof proto[name]).toBe('function');
  });

  test('desk and chat are readonly properties of the instance', () => {
    h = harness();
    expect(h.office.desk).toBeDefined();
    expect(h.office.chat).toBeDefined();
    expect(typeof h.office.desk.list).toBe('function');
    expect(typeof h.office.chat.recent).toBe('function');
  });

  test('the module exports are exactly the known ones', () => {
    expect(Object.keys(officeModule).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });

  test('the exported constants keep their values', () => {
    expect(officeModule.GHOST_MS).toBe(30 * 60_000);
    expect(officeModule.GHOST_TOOL_MS).toBe(4 * 60 * 60_000);
    expect(officeModule.PERSIST_EVERY_MS).toBe(60_000);
    expect(officeModule.UNDO_MS).toBe(10_000);
    expect(officeModule.SNAPSHOT_CLOSED_DOCS).toBe(100);
    expect(officeModule.DISCARDED_MARK).toBe('> **Descartado**');
    expect(officeModule.STATUS_REQUEST).toContain('ESPERO');
    expect(officeModule.ROLE_LABELS.director).toBe('director');
  });
});
