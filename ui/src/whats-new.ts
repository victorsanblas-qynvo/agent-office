import type { MessageKey } from './i18n';
import { readJson, writeJson } from './prefs';

export const WHATS_NEW_VERSION = '2026-10-24b';
export const WHATS_NEW_KEY = 'agent-office.whatsNewSeen';

export type WhatsNewSection = { id: string; title: MessageKey; items: readonly MessageKey[] };

export const WHATS_NEW: readonly WhatsNewSection[] = [
  {
    id: 'review',
    title: 'whatsNew.review.title',
    items: [
      'whatsNew.review.diff',
      'whatsNew.review.comments',
      'whatsNew.review.criteria',
      'whatsNew.review.prDraft',
      'whatsNew.review.points',
      'whatsNew.review.rounds',
    ],
  },
  {
    id: 'needs',
    title: 'whatsNew.needs.title',
    items: [
      'whatsNew.needs.floor',
      'whatsNew.needs.snooze',
      'whatsNew.needs.limits',
      'whatsNew.needs.budgets',
      'whatsNew.needs.context',
      'whatsNew.needs.hung',
      'whatsNew.needs.collisions',
      'whatsNew.needs.stale',
    ],
  },
  {
    id: 'notices',
    title: 'whatsNew.notices.title',
    items: [
      'whatsNew.notices.inbox',
      'whatsNew.notices.away',
      'whatsNew.notices.quiet',
      'whatsNew.notices.reminders',
      'whatsNew.notices.muted',
      'whatsNew.notices.checks',
    ],
  },
  {
    id: 'board',
    title: 'whatsNew.board.title',
    items: [
      'whatsNew.board.filter',
      'whatsNew.board.keys',
      'whatsNew.board.lanes',
      'whatsNew.board.age',
      'whatsNew.board.activity',
      'whatsNew.board.spend',
      'whatsNew.board.compare',
      'whatsNew.board.export',
      'whatsNew.board.compose',
    ],
  },
  {
    id: 'table',
    title: 'whatsNew.table.title',
    items: [
      'whatsNew.table.digest',
      'whatsNew.table.metrics',
      'whatsNew.table.history',
      'whatsNew.table.timeline',
      'whatsNew.table.spend',
      'whatsNew.table.scoreboard',
    ],
  },
  {
    id: 'palette',
    title: 'whatsNew.palette.title',
    items: [
      'whatsNew.palette.orders',
      'whatsNew.palette.recent',
      'whatsNew.palette.relaunch',
      'whatsNew.palette.statusAll',
      'whatsNew.palette.pins',
    ],
  },
  {
    id: 'panel',
    title: 'whatsNew.panel.title',
    items: [
      'whatsNew.panel.focus',
      'whatsNew.panel.floorHeaders',
      'whatsNew.panel.notes',
      'whatsNew.panel.tail',
      'whatsNew.panel.commands',
      'whatsNew.panel.report',
      'whatsNew.panel.lessons',
      'whatsNew.panel.theme',
      'whatsNew.panel.contrast',
      'whatsNew.panel.motion',
      'whatsNew.panel.prefs',
      'whatsNew.panel.diagnostics',
    ],
  },
  {
    id: 'chat',
    title: 'whatsNew.chat.title',
    items: [
      'whatsNew.chat.unread',
      'whatsNew.chat.search',
    ],
  },
  {
    id: 'branches',
    title: 'whatsNew.branches.title',
    items: [
      'whatsNew.branches.deleted',
      'whatsNew.branches.orphans',
    ],
  },
  {
    id: 'replay',
    title: 'whatsNew.replay.title',
    items: [
      'whatsNew.replay.seek',
      'whatsNew.replay.export',
    ],
  },
  {
    id: 'safety',
    title: 'whatsNew.safety.title',
    items: [
      'whatsNew.safety.redaction',
      'whatsNew.safety.git',
      'whatsNew.safety.deletes',
      'whatsNew.safety.controls',
    ],
  },
];

// Whether the dialog opens by itself: once per browser per version, never in a replay.
export function shouldShowWhatsNew(seen: unknown, live: boolean): boolean {
  return live && seen !== WHATS_NEW_VERSION;
}

export function readWhatsNewSeen(): unknown {
  return readJson(WHATS_NEW_KEY);
}

export function markWhatsNewSeen(): void {
  writeJson(WHATS_NEW_KEY, WHATS_NEW_VERSION);
}
