import { afterEach, describe, expect, test } from 'bun:test';
import { openHistory, type Nav } from '../src/navigate';
import { loadRecording, replayFetchUrl } from '../src/replay';
import { dayBound, EMPTY_FILTERS, hitKey, matchesQuery, mergeHits, normalize, PAGE_SIZE, readTableView, replayHref, searchPath } from '../src/table/history';
import { HISTORY_COLUMNS, historyFilename, historyRows, historyToCsv, historyToJson, isoLocal, type HistoryRow } from '../src/table/history-export';
import type { SearchHit } from '../src/types';

const hit = (kind: SearchHit['kind'], id: string, ts = 1): SearchHit => ({ kind, id, ts, floor: 'mobile', agent: 'lead', sessionId: 's1', text: `texto ${id}` });

describe('searchPath', () => {
  test('an empty form asks for the latest things', () => {
    expect(searchPath(EMPTY_FILTERS, null)).toBe(`/api/search?limit=${PAGE_SIZE}`);
  });

  test('every filter and the cursor go in the query string', () => {
    const path = searchPath({ q: '  redacción  ', floor: 'mobile', agent: 'dev-1', kind: 'chat', from: '2026-10-01', to: '2026-10-02' }, '123:45', 10);
    const params = new URL(`http://x${path}`).searchParams;
    expect(params.get('q')).toBe('redacción');
    expect(params.get('floor')).toBe('mobile');
    expect(params.get('agent')).toBe('dev-1');
    expect(params.get('kind')).toBe('chat');
    expect(params.get('before')).toBe('123:45');
    expect(params.get('limit')).toBe('10');
    expect(Number(params.get('from'))).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime());
    expect(Number(params.get('to'))).toBe(new Date(2026, 9, 2, 23, 59, 59, 999).getTime());
  });

  test('a date that is not one is left out', () => {
    expect(dayBound('2026-02-31', false)).toBeNull();
    expect(dayBound('ayer', true)).toBeNull();
    expect(searchPath({ ...EMPTY_FILTERS, from: 'ayer' }, null)).not.toContain('from=');
  });
});

describe('mergeHits', () => {
  test('appends the next page without repeating what the cursor let through twice', () => {
    const shown = [hit('activity', '1'), hit('message', '1')];
    const merged = mergeHits(shown, [hit('message', '1'), hit('chat', '1'), hit('activity', '2')]);
    expect(merged.map(hitKey)).toEqual(['activity:1', 'message:1', 'chat:1', 'activity:2']);
    expect(shown).toHaveLength(2);
  });
});

describe('replayHref', () => {
  test('opens the replay of the hub, compressed', () => {
    expect(replayHref('abc', { pathname: '/', search: '' })).toBe('/?replay=%2Fapi%2Freplay%2Fabc&compress=1');
  });

  test('keeps the 3D view and encodes the session', () => {
    const href = replayHref('a/b', { pathname: '/', search: '?view=3d&t=zzz' });
    const params = new URL(`http://x${href}`).searchParams;
    expect(params.get('replay')).toBe('/api/replay/a%2Fb');
    expect(params.get('view')).toBe('3d');
    expect(params.get('t')).toBeNull();
  });

  test('the fetch URL of a hub recording carries compress, a file does not', () => {
    const compress = new URLSearchParams('replay=x&compress=1');
    expect(replayFetchUrl('/api/replay/abc', compress)).toBe('/api/replay/abc?compress=1');
    expect(replayFetchUrl('/api/replay/abc?compress=1', compress)).toBe('/api/replay/abc?compress=1');
    expect(replayFetchUrl('/api/replay/abc', new URLSearchParams())).toBe('/api/replay/abc');
    expect(replayFetchUrl('/recordings/a.json', compress)).toBe('/recordings/a.json');
  });
});

describe('client-side filter', () => {
  test('ignores case and accents and matches by word prefix, all words', () => {
    expect(normalize('Redacción')).toBe('redaccion');
    expect(matchesQuery('Revisión de Redacción terminada', 'redac')).toBe(true);
    expect(matchesQuery('Revisión de Redacción terminada', 'REVISION termin')).toBe(true);
    expect(matchesQuery('Revisión de Redacción terminada', 'cción')).toBe(false);
    expect(matchesQuery('Revisión de Redacción terminada', 'revisión nada')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(matchesQuery('lo que sea', '')).toBe(true);
    expect(matchesQuery('', '  ')).toBe(true);
  });
});

describe('table view preference', () => {
  test('only history is remembered, anything else is now', () => {
    expect(readTableView('history')).toBe('history');
    expect(readTableView('now')).toBe('now');
    expect(readTableView(null)).toBe('now');
    expect(readTableView(3)).toBe('now');
  });
});

describe('the slash shortcut', () => {
  const calls: string[] = [];
  const nav = (api: object | null): Nav =>
    ({
      api,
      showTab: (tab: string) => calls.push(`tab:${tab}`),
      table: () => ({ showHistory: () => (calls.push('history'), true) }),
    }) as unknown as Nav;

  test('opens the Tabla on the history and focuses its box, in that order', () => {
    calls.length = 0;
    openHistory(nav({}));
    expect(calls).toEqual(['tab:table', 'history']);
  });

  test('in a replay there is no history to ask: the timeline section opens and the tab stays', () => {
    calls.length = 0;
    openHistory(nav(null));
    expect(calls).toEqual([]);
  });
});

describe('loadRecording', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub(response: Response): { calls: { url: string; headers: Record<string, string> }[] } {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return response;
    }) as unknown as typeof fetch;
    return { calls };
  }

  const recording = JSON.stringify({ version: 1, startedAt: 5, messages: [{ t: 2, msg: { type: 'worktrees', floor: 'x' } }, { t: 1, msg: { type: 'worktrees', floor: 'y' } }] });

  test('sends the panel credential to the routes of the hub and sorts the messages', async () => {
    const { calls } = stub(new Response(recording));
    const loaded = await loadRecording('/api/replay/s1?compress=1', 'token-1');
    expect(calls[0].headers['X-Office-Panel']).toBe('token-1');
    expect(loaded.messages.map((message) => message.t)).toEqual([1, 2]);
  });

  test('never sends it to a file or without having one', async () => {
    const file = stub(new Response(recording));
    await loadRecording('/recordings/a.json', 'token-1');
    expect(file.calls[0].headers).toEqual({});
    const bare = stub(new Response(recording));
    await loadRecording('/api/replay/s1');
    expect(bare.calls[0].headers).toEqual({});
  });

  test('a refusal of the hub says why', async () => {
    stub(new Response(JSON.stringify({ error: { key: 'hub.api.noRecording' } }), { status: 404 }));
    await expect(loadRecording('/api/replay/s1', 'token-1')).rejects.toThrow(/eventos/);
    stub(new Response('x', { status: 500 }));
    await expect(loadRecording('/api/replay/s1', 'token-1')).rejects.toThrow('HTTP 500');
  });
});

describe('history export', () => {
  const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({ time: '2026-10-23T14:05:09.000+02:00', floor: 'mobile', agent: 'Lead', session: 's1', role: 'jefe', kind: 'chat', text: 'hola', ...over });

  test('csv has a header and one CRLF-terminated line per row', () => {
    expect(historyToCsv([row()])).toBe('\ufefftime,floor,agent,session,role,kind,text\r\n2026-10-23T14:05:09.000+02:00,mobile,Lead,s1,jefe,chat,hola\r\n');
  });

  test('no rows is the header only', () => {
    expect(historyToCsv([])).toBe('\ufefftime,floor,agent,session,role,kind,text\r\n');
  });

  test('fields with a comma, a quote or a line break are quoted and quotes doubled', () => {
    const csv = historyToCsv([row({ text: 'a, b' }), row({ text: 'dijo "hola"' }), row({ text: 'uno\ndos' }), row({ text: 'uno\r\ndos' })]);
    expect(csv).toContain(',"a, b"\r\n');
    expect(csv).toContain(',"dijo ""hola"""\r\n');
    expect(csv).toContain(',"uno\ndos"\r\n');
    expect(csv).toContain(',"uno\r\ndos"\r\n');
  });

  test('cells that start like a formula get a single quote', () => {
    for (const text of ['=SUM(A1)', '+1', '-1', '@x', '\tx', '＝1', '＋1', '－1', '＠x']) expect(historyToCsv([row({ text })])).toContain(`,'${text}\r\n`);
    expect(historyToCsv([row({ text: '=1,2' })])).toContain(`,"'=1,2"\r\n`);
    expect(historyToCsv([row({ text: '\r=1' })])).toContain(`,"'\r=1"\r\n`);
    expect(historyToCsv([row({ text: 'a=b' })])).toContain(',a=b\r\n');
  });

  test('the csv starts with a UTF-8 byte order mark', () => {
    expect(historyToCsv([row()]).charCodeAt(0)).toBe(0xfeff);
  });

  test('json is pretty and keeps the column order', () => {
    const json = historyToJson([row({ text: 'x' })]);
    expect(json).toBe(`${JSON.stringify([{ time: '2026-10-23T14:05:09.000+02:00', floor: 'mobile', agent: 'Lead', session: 's1', role: 'jefe', kind: 'chat', text: 'x' }], null, 2)}\n`);
    expect(Object.keys(JSON.parse(json)[0])).toEqual([...HISTORY_COLUMNS]);
    expect(historyToJson([])).toBe('[]\n');
  });

  test('rows come from the hits shown with the name and role of the agent', () => {
    const rows = historyRows([hit('chat', '1', Date.UTC(2026, 9, 23, 12)), { ...hit('agent', '2'), agent: 'gone', floor: null, sessionId: null }], (key) => (key === 'lead' ? { name: 'Ada', role: 'jefe' } : undefined));
    expect(rows[0]).toMatchObject({ floor: 'mobile', agent: 'Ada', role: 'jefe', session: 's1', kind: 'chat', text: 'texto 1' });
    expect(rows[0].time).toMatch(/^2026-10-2\dT\d\d:00:00\.000[+-]\d\d:\d\d$/);
    expect(rows[1]).toMatchObject({ floor: '', agent: 'gone', role: '', session: '' });
  });

  test('isoLocal carries the local offset', () => {
    const ts = new Date(2026, 9, 23, 14, 5, 9, 7).getTime();
    expect(isoLocal(ts)).toMatch(/^2026-10-23T14:05:09\.007[+-]\d\d:\d\d$/);
    expect(new Date(isoLocal(ts)).getTime()).toBe(ts);
  });

  test('filename is stamped with the local date and minute', () => {
    const now = new Date(2026, 0, 5, 9, 7, 59);
    expect(historyFilename('csv', now)).toBe('agent-office-historial-20260105-0907.csv');
    expect(historyFilename('json', now)).toBe('agent-office-historial-20260105-0907.json');
  });
});
