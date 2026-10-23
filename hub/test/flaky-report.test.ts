import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { flakyChecks } from '../../ui/src/board/flaky';
import type { CheckRunView } from '../../ui/src/types';
import { flakyReport, parseFlakyDays } from '../src/flaky-report';
import { createApp } from '../src/server';
import { deliveryRig, type Rig } from './delivery-rig';

const KEY = 'k'.repeat(64);
const PORT = 4747;
const DAY = 86_400_000;
let rig: Rig | undefined;
afterEach(() => {
  rig?.h.cleanup();
  rig = undefined;
});

let runId = 0;
function addRun(db: Database, o: { floor?: string; order: number; sha: string; at: number; checks: [string, string][] }): void {
  runId += 1;
  db.query("INSERT INTO check_runs (id, order_id, floor, slug, sha, trigger, status, started_at) VALUES (?, ?, ?, 's', ?, 'comprobar', 'passed', ?)").run(runId, o.order, o.floor ?? 'mobile', o.sha, o.at);
  for (const [name, status] of o.checks) db.query("INSERT INTO checks (run_id, floor, slug, name, command, status) VALUES (?, ?, 's', ?, 'x', ?)").run(runId, o.floor ?? 'mobile', name, status);
}

function setup(): { db: Database; now: number } {
  rig = deliveryRig();
  return { db: rig.h.db, now: rig.h.clock.now };
}

describe('flakyReport', () => {
  test('a check that failed and then passed on the same sha counts', () => {
    const { db, now } = setup();
    addRun(db, { order: 1, sha: 'aaa', at: now - 3000, checks: [['test', 'failed']] });
    addRun(db, { order: 1, sha: 'aaa', at: now - 2000, checks: [['test', 'passed']] });
    expect(flakyReport(db, now, 14)).toEqual([{ floor: 'mobile', check: 'test', flakyCount: 1, lastAt: now - 2000, orders: 1 }]);
  });

  test('a timeout counts as a failure', () => {
    const { db, now } = setup();
    addRun(db, { order: 1, sha: 'aaa', at: now - 3000, checks: [['test', 'timeout']] });
    addRun(db, { order: 1, sha: 'aaa', at: now - 2000, checks: [['test', 'passed']] });
    expect(flakyReport(db, now, 14)).toHaveLength(1);
  });

  test('dirty runs are ignored', () => {
    const { db, now } = setup();
    addRun(db, { order: 1, sha: 'aaa-dirty', at: now - 3000, checks: [['test', 'failed']] });
    addRun(db, { order: 1, sha: 'aaa-dirty', at: now - 2000, checks: [['test', 'passed']] });
    expect(flakyReport(db, now, 14)).toEqual([]);
  });

  test('a pass on another sha is not flaky', () => {
    const { db, now } = setup();
    addRun(db, { order: 1, sha: 'aaa', at: now - 3000, checks: [['test', 'failed']] });
    addRun(db, { order: 1, sha: 'bbb', at: now - 2000, checks: [['test', 'passed']] });
    expect(flakyReport(db, now, 14)).toEqual([]);
  });

  test('a fail and a pass in different orders is not flaky', () => {
    const { db, now } = setup();
    addRun(db, { order: 1, sha: 'aaa', at: now - 3000, checks: [['test', 'failed']] });
    addRun(db, { order: 2, sha: 'aaa', at: now - 2000, checks: [['test', 'passed']] });
    expect(flakyReport(db, now, 14)).toEqual([]);
  });

  test('runs outside the window are left out', () => {
    const { db, now } = setup();
    addRun(db, { order: 1, sha: 'aaa', at: now - 20 * DAY, checks: [['test', 'failed']] });
    addRun(db, { order: 1, sha: 'aaa', at: now - 19 * DAY, checks: [['test', 'passed']] });
    expect(flakyReport(db, now, 14)).toEqual([]);
    expect(flakyReport(db, now, 30)).toHaveLength(1);
  });

  test('counts per floor and check, sorted by count, with the orders involved', () => {
    const { db, now } = setup();
    for (const order of [1, 2]) {
      addRun(db, { order, sha: `s${order}`, at: now - 5000 - order, checks: [['lint', 'failed'], ['test', 'failed']] });
      addRun(db, { order, sha: `s${order}`, at: now - 4000 - order, checks: [['lint', 'passed'], ['test', order === 1 ? 'passed' : 'failed']] });
    }
    const report = flakyReport(db, now, 14);
    expect(report.map((row) => [row.check, row.flakyCount, row.orders])).toEqual([
      ['lint', 2, 2],
      ['test', 1, 1],
    ]);
    expect(report[0]?.lastAt).toBe(now - 4001);
  });

  test('the floor filter keeps only that floor', () => {
    const { db, now } = setup();
    for (const floor of ['mobile', 'backend']) {
      addRun(db, { floor, order: 1, sha: 'aaa', at: now - 3000, checks: [['test', 'failed']] });
      addRun(db, { floor, order: 1, sha: 'aaa', at: now - 2000, checks: [['test', 'passed']] });
    }
    expect(flakyReport(db, now, 14)).toHaveLength(2);
    expect(flakyReport(db, now, 14, 'backend').map((row) => row.floor)).toEqual(['backend']);
  });

  test('agrees with the rule the board uses on a run history', () => {
    const { db, now } = setup();
    const history: [string, string, string][] = [
      ['aaa', 'failed', 'test'],
      ['aaa', 'passed', 'test'],
      ['bbb', 'failed', 'lint'],
      ['ccc', 'passed', 'lint'],
      ['ddd-dirty', 'failed', 'x'],
      ['ddd-dirty', 'passed', 'x'],
      ['eee', 'timeout', 'build'],
      ['eee', 'passed', 'build'],
    ];
    const views: CheckRunView[] = history.map(([sha, status, name], index) => {
      addRun(db, { order: 1, sha, at: now - 10_000 + index, checks: [[name, status]] });
      return { id: index + 1, orderId: 1, sha, trigger: 'comprobar', status: 'passed', startedAt: now - 10_000 + index, endedAt: null, checks: [{ name, command: 'x', status: status as 'passed', exitCode: 0, durationMs: 1, outputTail: null }] } as CheckRunView;
    });
    expect(new Set(flakyReport(db, now, 14).map((row) => row.check))).toEqual(flakyChecks(views));
  });
});

describe('parseFlakyDays', () => {
  test('defaults to 14 and accepts 1 to 60', () => {
    expect(parseFlakyDays(undefined)).toBe(14);
    expect(parseFlakyDays('1')).toBe(1);
    expect(parseFlakyDays('60')).toBe(60);
    for (const bad of ['0', '61', '-1', '1.5', 'x']) expect(parseFlakyDays(bad)).toBeNull();
  });
});

describe('GET /api/checks/flaky', () => {
  function call(r: Rig) {
    const app = createApp({ office: r.h.office, port: PORT, key: () => KEY, publicDir: r.h.root }, () => {});
    return async (path: string, key: string | null = KEY) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${PORT}` };
      if (key) headers['x-office-key'] = key;
      const response = await app.request(`http://127.0.0.1:${PORT}${path}`, { headers });
      const text = await response.text();
      return { status: response.status, body: (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, any> };
    };
  }

  test('needs the panel credential', async () => {
    rig = deliveryRig();
    expect((await call(rig)('/api/checks/flaky', null)).status).toBe(401);
  });

  test('rejects bad days and unknown floors with 400', async () => {
    rig = deliveryRig();
    const get = call(rig);
    expect(await get('/api/checks/flaky?days=0')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.flakyDays' } } });
    expect(await get('/api/checks/flaky?days=61')).toMatchObject({ status: 400 });
    expect(await get('/api/checks/flaky?floor=nope')).toMatchObject({ status: 400, body: { error: { key: 'hub.api.flakyFloor' } } });
  });

  test('answers the report of a known floor', async () => {
    rig = deliveryRig();
    const now = rig.h.clock.now;
    addRun(rig.h.db, { order: 1, sha: 'aaa', at: now - 3000, checks: [['test', 'failed']] });
    addRun(rig.h.db, { order: 1, sha: 'aaa', at: now - 2000, checks: [['test', 'passed']] });
    const answer = await call(rig)('/api/checks/flaky?floor=mobile');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ days: 14, flaky: [{ floor: 'mobile', check: 'test', flakyCount: 1, lastAt: now - 2000, orders: 1 }] });
  });
});
