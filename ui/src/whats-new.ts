import type { MessageKey } from './i18n';
import { readJson, writeJson } from './prefs';

export const WHATS_NEW_VERSION = '2026-10-24';
export const WHATS_NEW_KEY = 'agent-office.whatsNewSeen';

export type WhatsNewSection = { id: string; title: MessageKey; items: readonly MessageKey[] };

export const WHATS_NEW: readonly WhatsNewSection[] = [
  {
    id: 'review',
    title: 'whatsNew.review.title',
    items: [
      'whatsNew.review.diff',
      'whatsNew.review.comments',
      'whatsNew.review.prDraft',
      'whatsNew.review.gh',
      'whatsNew.review.criteria',
      'whatsNew.review.points',
      'whatsNew.review.preview',
      'whatsNew.review.rounds',
    ],
  },
  {
    id: 'needs',
    title: 'whatsNew.needs.title',
    items: [
      'whatsNew.needs.limits',
      'whatsNew.needs.hung',
      'whatsNew.needs.collisions',
      'whatsNew.needs.context',
      'whatsNew.needs.budgets',
      'whatsNew.needs.snooze',
      'whatsNew.needs.floor',
      'whatsNew.needs.stale',
    ],
  },
  {
    id: 'notices',
    title: 'whatsNew.notices.title',
    items: [
      'whatsNew.notices.quiet',
      'whatsNew.notices.reminders',
      'whatsNew.notices.recap',
      'whatsNew.notices.inbox',
      'whatsNew.notices.muted',
      'whatsNew.notices.checks',
      'whatsNew.notices.away',
    ],
  },
  {
    id: 'board',
    title: 'whatsNew.board.title',
    items: [
      'whatsNew.board.filter',
      'whatsNew.board.age',
      'whatsNew.board.keys',
      'whatsNew.board.export',
      'whatsNew.board.lanes',
      'whatsNew.board.activity',
      'whatsNew.board.spend',
      'whatsNew.board.compose',
      'whatsNew.board.templates',
      'whatsNew.board.compare',
    ],
  },
  {
    id: 'table',
    title: 'whatsNew.table.title',
    items: [
      'whatsNew.table.history',
      'whatsNew.table.searches',
      'whatsNew.table.spend',
      'whatsNew.table.digest',
      'whatsNew.table.metrics',
      'whatsNew.table.timeline',
      'whatsNew.table.scoreboard',
    ],
  },
  {
    id: 'palette',
    title: 'whatsNew.palette.title',
    items: [
      'whatsNew.palette.orders',
      'whatsNew.palette.recent',
      'whatsNew.palette.pins',
      'whatsNew.palette.relaunch',
      'whatsNew.palette.statusAll',
      'whatsNew.palette.messageAll',
    ],
  },
  {
    id: 'panel',
    title: 'whatsNew.panel.title',
    items: [
      'whatsNew.panel.focus',
      'whatsNew.panel.theme',
      'whatsNew.panel.motion',
      'whatsNew.panel.contrast',
      'whatsNew.panel.tail',
      'whatsNew.panel.diagnostics',
      'whatsNew.panel.prefs',
      'whatsNew.panel.report',
      'whatsNew.panel.lessons',
      'whatsNew.panel.notes',
      'whatsNew.panel.commands',
    ],
  },
  {
    id: 'branches',
    title: 'whatsNew.branches.title',
    items: ['whatsNew.branches.deleted', 'whatsNew.branches.restore', 'whatsNew.branches.orphans'],
  },
  {
    id: 'replay',
    title: 'whatsNew.replay.title',
    items: ['whatsNew.replay.seek', 'whatsNew.replay.export'],
  },
  {
    id: 'safety',
    title: 'whatsNew.safety.title',
    items: ['whatsNew.safety.redaction', 'whatsNew.safety.git', 'whatsNew.safety.deletes', 'whatsNew.safety.controls'],
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
