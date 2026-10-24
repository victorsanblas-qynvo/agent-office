import { beforeEach, describe, expect, test } from 'bun:test';
import { AWAY_MAX_MS, AWAY_MIN_MS, awayMessages, awayParts, awaySummary, shouldSummarize, type AwayInputs } from '../src/away';
import { awaySearchPath, dayOf } from '../src/away-card';
import { applyLang } from '../src/i18n/index';
import type { SearchHit } from '../src/types';
import { agent, order } from './fixtures';

beforeEach(() => applyLang('es'));

const NOW = 10 * 24 * 3_600_000;
const HOUR = 3_600_000;
const none: AwayInputs = { messages: [], finished: [], checks: [], notices: [] };

describe('shouldSummarize', () => {
  test('needs a known lastSeen at least 30 minutes old', () => {
    expect(shouldSummarize(NOW - AWAY_MIN_MS, NOW, false)).toBe(true);
    expect(shouldSummarize(NOW - AWAY_MIN_MS + 1, NOW, false)).toBe(false);
    expect(shouldSummarize(null, NOW, false)).toBe(false);
    expect(shouldSummarize(Number.NaN, NOW, false)).toBe(false);
  });

  test('a lastSeen in the future or a replay never summarizes', () => {
    expect(shouldSummarize(NOW + HOUR, NOW, false)).toBe(false);
    expect(shouldSummarize(NOW - HOUR, NOW, true)).toBe(false);
  });
});

describe('awaySummary', () => {
  test('counts each kind since lastSeen, failed checks only', () => {
    const since = NOW - 3 * HOUR;
    const summary = awaySummary(
      {
        messages: [
          { ts: since + 1, kind: 'blocked' },
          { ts: since + 2, kind: 'done' },
          { ts: since - 1, kind: 'done' },
        ],
        finished: [{ ts: since + 5 }, { ts: since + 6 }],
        checks: [
          { endedAt: since + 7, status: 'failed' },
          { endedAt: since + 8, status: 'passed' },
          { endedAt: null, status: 'failed' },
        ],
        notices: [{ at: since + 9 }, { at: since + 10 }, { at: since + 11 }],
      },
      since,
      NOW,
    );
    expect(summary?.counts).toEqual({ delivery: 3, blocked: 1, checks: 1, notices: 3 });
    expect(summary?.elapsedMs).toBe(3 * HOUR);
  });

  test('is null when nothing happened', () => {
    expect(awaySummary(none, NOW - HOUR, NOW)).toBeNull();
    expect(awaySummary({ ...none, notices: [{ at: NOW - 2 * HOUR }] }, NOW - HOUR, NOW)).toBeNull();
  });

  test('looks back at most 7 days', () => {
    const old = NOW - 30 * 24 * HOUR;
    const summary = awaySummary({ ...none, notices: [{ at: old + 1 }, { at: NOW - AWAY_MAX_MS + 1 }] }, old, NOW);
    expect(summary?.counts.notices).toBe(1);
    expect(summary?.since).toBe(NOW - AWAY_MAX_MS);
    expect(summary?.elapsedMs).toBe(AWAY_MAX_MS);
  });
});

describe('awayParts', () => {
  test('only the non-zero parts, with singular and plural', () => {
    const summary = awaySummary({ ...none, finished: [{ ts: NOW - 1 }], notices: [{ at: NOW - 1 }, { at: NOW - 2 }] }, NOW - HOUR, NOW);
    expect(summary && awayParts(summary)).toEqual([
      { kind: 'delivery', text: '1 entrega' },
      { kind: 'notices', text: '2 avisos' },
    ]);
  });
});

describe('awayMessages', () => {
  const hit = (id: string, text: string, agentKey: string | null): SearchHit => ({ kind: 'message', id, ts: 5, floor: 'mobile', agent: agentKey, sessionId: null, text });

  test('classifies BLOQUEADO and a lead HECHO on a floor without orders, once per message', () => {
    const lead = agent('lead-a', { roleKind: 'lead', floor: 'mobile' });
    const dev = agent('dev-a', { floor: 'mobile' });
    const context = { agents: new Map([[lead.key, lead], [dev.key, dev]]), orders: [] };
    const hits = [hit('1', 'BLOQUEADO: falta x', 'dev-a'), hit('2', 'HECHO: listo', 'lead-a'), hit('2', 'HECHO: listo', 'lead-a'), hit('3', 'HECHO: listo', 'dev-a'), hit('4', 'hola', 'lead-a')];
    expect(awayMessages(hits, context)).toEqual([
      { ts: 5, kind: 'blocked' },
      { ts: 5, kind: 'done' },
    ]);
  });

  test('a HECHO of a lead whose floor tracks orders is left to the end of the order', () => {
    const lead = agent('lead-a', { roleKind: 'lead', floor: 'mobile' });
    const context = { agents: new Map([[lead.key, lead]]), orders: [order('o1', { floor: 'mobile', worktree: { path: '/w', state: 'listo', error: null, stale: false } })] };
    expect(awayMessages([hit('1', 'HECHO: listo', 'lead-a')], context)).toEqual([]);
  });
});

describe('card helpers', () => {
  test('dayOf is the local day', () => {
    expect(dayOf(new Date(2026, 9, 5, 23, 59).getTime())).toBe('2026-10-05');
  });

  test('awaySearchPath asks for the messages with the exact moment', () => {
    expect(awaySearchPath('HECHO', 1234)).toBe('/api/search?q=HECHO&kind=message&from=1234&limit=100');
  });
});
