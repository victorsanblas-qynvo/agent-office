import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultText } from '../src/checks';
import { runGit, type GitRunner } from '../src/git';
import { runShell } from '../src/shell';
import type { OfficeConfig } from '../src/types';
import { deskRig, type DeskRig } from './desk-rig';
import { git } from './helpers';

let rig: DeskRig | undefined;
afterEach(() => {
  rig?.cleanup();
  rig = undefined;
});

const checksOf = (...specs: [string, string][]) => (config: OfficeConfig) => {
  const floor = config.floors.mobile;
  if (floor) floor.checks = specs.map(([name, command]) => ({ name, command }));
};

async function startAndWait(r: DeskRig, trigger: 'listo' | 'comprobar' | 'panel' | 'hecho' = 'comprobar') {
  const started = await r.checks.start(r.order.id, trigger);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  return { started, view: await started.done };
}

describe('a run', () => {
  test('green: every check passes, the lead is told which sha to repeat the HECHO on', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'echo hola'], ['dos', 'exit 0']) });
    const { started, view } = await startAndWait(rig);
    expect(view).toMatchObject({ status: 'passed', trigger: 'comprobar', sha: git(rig.path, 'rev-parse', 'HEAD') });
    expect(view.checks.map((c) => [c.name, c.status, c.exitCode])).toEqual([['uno', 'passed', 0], ['dos', 'passed', 0]]);
    expect(view.checks[0]?.outputTail).toBe('hola\n');
    expect(view.checks[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(started.run.status).toBe('running');
    expect(rig.notified).toEqual([{ slug: 'login-a1b2', text: `[Agent Office] COMPROBACIONES encargo/login-a1b2 en verde @${view.sha.slice(0, 7)}: repite el HECHO` }]);
    expect(rig.checks.summary(rig.order)).toMatchObject({ status: 'passed', passed: 2, total: 2, sha: view.sha, touched: [], forced: false });
    expect(rig.messages.filter((m) => m.type === 'checks').length).toBeGreaterThan(1);
    expect(rig.checks.latest(rig.order.id)?.id).toBe(view.id);
  });

  test('red: the first failing check, its code and the end of its output reach the lead', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `linea ${i + 1}`).join('\\n');
    rig = deskRig({ configure: checksOf(['lint', 'exit 0'], ['test', `printf '${lines}\\n'; exit 3`]) });
    const { view } = await startAndWait(rig);
    expect(view.status).toBe('failed');
    expect(view.checks.map((c) => c.status)).toEqual(['passed', 'failed']);
    const text = rig.notified[0]?.text ?? '';
    expect(text).toContain('en rojo');
    expect(text).toContain('test terminó con código 3');
    expect(text).toContain('linea 60');
    expect(text).toContain('linea 21');
    expect(text).not.toContain('linea 20\n');
    expect(rig.checks.summary(rig.order)).toMatchObject({ status: 'failed', passed: 1, total: 2 });
  });

  test('a checkpoint comes first, so the run is about the new HEAD', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']) });
    const before = git(rig.path, 'rev-parse', 'HEAD');
    writeFileSync(join(rig.path, 'nuevo.txt'), 'x');
    const { view } = await startAndWait(rig, 'listo');
    expect(view.sha).not.toBe(before);
    expect(view.sha).toBe(git(rig.path, 'rev-parse', 'HEAD'));
    expect(rig.checkpoints.list(rig.order.id)).toHaveLength(1);
    expect(git(rig.path, 'log', '-1', '--format=%s')).toBe('encargo(login-a1b2): listo');
  });

  test('a failed commit runs the checks on HEAD-dirty, which never matches a HEAD', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']) });
    const hook = join(git(rig.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks', 'pre-commit');
    await Bun.$`mkdir -p ${join(hook, '..')}`;
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    await Bun.$`chmod +x ${hook}`;
    writeFileSync(join(rig.path, 'nuevo.txt'), 'x');
    const head = git(rig.path, 'rev-parse', 'HEAD');
    const { view } = await startAndWait(rig);
    expect(view.sha).toBe(`${head}-dirty`);
    expect(rig.checks.gateReading(rig.order)).toMatchObject({ head, dirty: ['nuevo.txt'], run: { sha: `${head}-dirty`, status: 'passed' } });
  });

  test('without checks or without a folder nothing starts', async () => {
    rig = deskRig({ configure: (config) => (config.floors.mobile!.checks = []) });
    expect(await rig.checks.start(rig.order.id, 'panel')).toEqual({ ok: false, reason: 'no-checks' });
    expect(await rig.checks.start(999, 'panel')).toEqual({ ok: false, reason: 'no-folder' });
    expect(rig.checks.summary(rig.order)).toBeNull();
    expect(rig.checks.latest(rig.order.id)).toBeNull();
  });

  test('the output keeps only the last tailBytes', async () => {
    rig = deskRig({
      configure: (config) => {
        checksOf(['ruido', "yes abcdefghij | head -c 20000; echo FINAL; exit 1"])(config);
        config.checksConfig.tailBytes = 1000;
      },
    });
    const { view } = await startAndWait(rig);
    const tail = view.checks[0]?.outputTail ?? '';
    expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(1000);
    expect(tail.endsWith('FINAL\n')).toBe(true);
  });
});

describe('time, cancel and sharing', () => {
  test('a check past its timeout is killed with everything it started', async () => {
    rig = deskRig({
      configure: (config) => {
        checksOf(['lento', 'sleep 37 & sleep 38; echo no'])(config);
        config.checksConfig.timeoutMinutes = 0.02;
      },
    });
    const started = Date.now();
    const { view } = await startAndWait(rig);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(view).toMatchObject({ status: 'failed' });
    expect(view.checks[0]).toMatchObject({ status: 'timeout' });
    expect(rig.notified[0]?.text).toContain('lento se pasó del tiempo');
    const left = Bun.spawnSync(['sh', '-c', 'ps -axo command | grep "sleep 3[78]" | grep -v grep']).stdout.toString();
    expect(left).toBe('');
    expect(rig.checks.gateReading(rig.order).run).toMatchObject({ status: 'failed', failed: { name: 'lento', timedOut: true } });
  });

  test('cancelling stops the run, marks it cancelled and tells nobody', async () => {
    rig = deskRig({ configure: checksOf(['lento', 'sleep 39']) });
    const started = await rig.checks.start(rig.order.id, 'panel');
    if (!started.ok) throw new Error('start');
    await Bun.sleep(100);
    expect(rig.checks.cancel(rig.order.id)).toBe(true);
    const view = await started.done;
    expect(view.status).toBe('cancelled');
    expect(view.checks[0]?.status).toBe('cancelled');
    expect(rig.notified).toEqual([]);
    expect(rig.checks.cancel(rig.order.id)).toBe(false);
    expect(rig.checks.summary(rig.order)).toMatchObject({ status: 'none' });
    expect(rig.checks.gateReading(rig.order).run).toMatchObject({ status: 'cancelled' });
  });

  test('a second request on the same HEAD joins the run; a new HEAD restarts it', async () => {
    const marks = () => join(rig?.root ?? '', 'marks.txt');
    rig = deskRig();
    rig.config.floors.mobile!.checks = [{ name: 'cuenta', command: `echo run >> ${marks()}; sleep 0.4` }];
    const first = await rig.checks.start(rig.order.id, 'panel');
    const joined = await rig.checks.start(rig.order.id, 'comprobar');
    if (!first.ok || !joined.ok) throw new Error('start');
    expect(joined.run.id).toBe(first.run.id);
    await first.done;
    expect(readFileSync(marks(), 'utf8').trim().split('\n')).toHaveLength(1);

    const slow = await rig.checks.start(rig.order.id, 'panel');
    if (!slow.ok) throw new Error('start');
    writeFileSync(join(rig.path, 'otro.txt'), 'x');
    const restarted = await rig.checks.start(rig.order.id, 'listo');
    if (!restarted.ok) throw new Error('start');
    expect(restarted.run.id).not.toBe(slow.run.id);
    expect((await slow.done).status).toBe('cancelled');
    expect((await restarted.done).status).toBe('passed');
    expect(rig.notified).toHaveLength(2);
  });

  test('maxParallel caps the checks that run at once across the hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'checks-'));
    const log = () => join(dir, 'order.txt');
    const spec = (name: string): [string, string] => [name, `echo start >> ${log()}; sleep 0.3; echo end >> ${log()}`];
    rig = deskRig({
      configure: (config) => {
        checksOf(spec('a'), spec('b'), spec('c'))(config);
        config.checksConfig.maxParallel = 1;
      },
    });
    await startAndWait(rig);
    expect(readFileSync(log(), 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);

    writeFileSync(log(), '');
    rig.config.checksConfig.maxParallel = 3;
    writeFileSync(join(rig.path, 'x.txt'), 'x');
    await startAndWait(rig);
    expect(readFileSync(log(), 'utf8').trim().split('\n').slice(0, 3)).toEqual(['start', 'start', 'start']);

    writeFileSync(log(), '');
    rig.config.checksConfig.maxParallel = 2;
    const other = rig.second();
    writeFileSync(join(other.worktree_path as string, 'y.txt'), 'y');
    writeFileSync(join(rig.path, 'z.txt'), 'z');
    const [one, two] = await Promise.all([rig.checks.start(rig.order.id, 'panel'), rig.checks.start(other.id, 'panel')]);
    if (!one.ok || !two.ok) throw new Error('start');
    await Promise.all([one.done, two.done]);
    const lines = readFileSync(log(), 'utf8').trim().split('\n');
    let running = 0;
    let peak = 0;
    for (const line of lines) {
      running += line === 'start' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(lines).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('listo schedules one run after the delay however many times it is said', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']), listoDelayMs: 80 });
    rig.checks.scheduleListo(rig.order);
    await Bun.sleep(40);
    rig.checks.scheduleListo(rig.order);
    expect(rig.checks.latest(rig.order.id)).toBeNull();
    await Bun.sleep(60);
    expect(rig.checks.latest(rig.order.id)).toBeNull();
    await Bun.sleep(150);
    await rig.checks.idle();
    expect(rig.checks.latest(rig.order.id)).toMatchObject({ trigger: 'listo', status: 'passed' });
    expect(rig.notified).toHaveLength(1);
  });

  test('stop drops the pending listo', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']), listoDelayMs: 50 });
    rig.checks.scheduleListo(rig.order);
    rig.checks.stop();
    await Bun.sleep(120);
    expect(rig.checks.latest(rig.order.id)).toBeNull();
  });
});

describe('starts that arrive at once', () => {
  // Counts the git calls that write the index of each folder, and can hold the commit of one folder.
  function watchedGit() {
    const writes: { cwd: string; op: string }[] = [];
    let inFlight = 0;
    let peak = 0;
    let hold: { cwd: string; reached: () => void; release: Promise<void> } | null = null;
    const runner: GitRunner = async (cwd, args, ...rest) => {
      const op = args[0] ?? '';
      if (op !== 'add' && op !== 'commit') return runGit(cwd, args, ...rest);
      writes.push({ cwd, op });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (op === 'commit' && hold?.cwd === cwd) {
          hold.reached();
          await hold.release;
        }
        return await runGit(cwd, args, ...rest);
      } finally {
        inFlight -= 1;
      }
    };
    const holdCommit = (cwd: string) => {
      let release = () => {};
      let reached = () => {};
      const atCommit = new Promise<void>((resolve) => (reached = resolve));
      hold = { cwd, reached: () => reached(), release: new Promise<void>((resolve) => (release = resolve)) };
      return { atCommit, release: () => release() };
    };
    return { runner, writes, peak: () => peak, holdCommit };
  }

  const slowCheck = (r: DeskRig) => {
    r.config.floors.mobile!.checks = [{ name: 'cuenta', command: `echo run >> ${join(r.root, 'marks.txt')}; sleep 0.5` }];
    return () => readFileSync(join(r.root, 'marks.txt'), 'utf8').trim().split('\n');
  };

  for (const triggers of [['listo', 'comprobar'], ['listo', 'panel', 'hecho']] as const) {
    test(`${triggers.length} starts of one order at once make one checkpoint and one run they all share`, async () => {
      const watched = watchedGit();
      rig = deskRig({ checkpoints: { git: watched.runner } });
      const runs = slowCheck(rig);
      const before = git(rig.path, 'rev-parse', 'HEAD');
      writeFileSync(join(rig.path, 'nuevo.txt'), 'x');
      const r = rig;
      const started = await Promise.all(triggers.map((trigger) => r.checks.start(r.order.id, trigger)));
      const ids = started.map((one) => (one.ok ? one.run.id : null));
      expect(new Set(ids)).toEqual(new Set([ids[0] as number]));
      const views = await Promise.all(started.map((one) => (one.ok ? one.done : null)));
      expect(views.map((view) => view?.status)).toEqual(triggers.map(() => 'passed'));
      expect(runs()).toHaveLength(1);
      expect(watched.writes.map((write) => write.op)).toEqual(['add', 'commit']);
      expect(watched.peak()).toBe(1);
      expect(rig.checkpoints.list(rig.order.id)).toHaveLength(1);
      expect(git(rig.path, 'rev-list', '--count', `${before}..HEAD`)).toBe('1');
      expect(views[0]?.sha).toBe(git(rig.path, 'rev-parse', 'HEAD'));
      expect(rig.activity.map((a) => a.summary)).not.toContainEqual({ key: 'hub.act.checkpointFailed', params: { slug: 'login-a1b2' } });
      expect(rig.checks.history(rig.order.id)).toHaveLength(1);
      expect(rig.notified).toHaveLength(1);
    });
  }

  test('a start waits for the one of its order still committing, while another order starts freely', async () => {
    const watched = watchedGit();
    rig = deskRig({ checkpoints: { git: watched.runner } });
    slowCheck(rig);
    const other = rig.second();
    writeFileSync(join(rig.path, 'a.txt'), 'a');
    writeFileSync(join(other.worktree_path as string, 'b.txt'), 'b');
    const held = watched.holdCommit(rig.path);
    const first = rig.checks.start(rig.order.id, 'listo');
    await held.atCommit;
    let secondSettled = false;
    const second = rig.checks.start(rig.order.id, 'comprobar').then((result) => {
      secondSettled = true;
      return result;
    });

    const elsewhere = await rig.checks.start(other.id, 'panel');
    if (!elsewhere.ok) throw new Error('start');
    expect(elsewhere.run.orderId).toBe(other.id);
    await Bun.sleep(50);
    expect(secondSettled).toBe(false);
    expect(rig.checks.latest(rig.order.id)).toBeNull();

    held.release();
    const [one, two] = await Promise.all([first, second]);
    if (!one.ok || !two.ok) throw new Error('start');
    expect(two.run.id).toBe(one.run.id);
    expect((await one.done).status).toBe('passed');
    expect((await elsewhere.done).status).toBe('passed');
    expect(watched.writes.filter((write) => write.cwd === rig?.path).map((write) => write.op)).toEqual(['add', 'commit']);
  });

  test('an order without a folder refuses before touching git or running anything', async () => {
    const commands: string[] = [];
    const gitCalls: string[][] = [];
    rig = deskRig({
      checks: (command, opts) => {
        commands.push(command);
        return runShell(command, opts);
      },
      checkpoints: {
        git: (cwd, args, ...rest) => {
          gitCalls.push(args);
          return runGit(cwd, args, ...rest);
        },
      },
    });
    const bare = rig.store.update(rig.order.id, { worktree_path: null })!;
    expect(await rig.checks.start(bare.id, 'hecho')).toEqual({ ok: false, reason: 'no-folder' });
    expect(await rig.checks.start(bare.id, 'panel')).toEqual({ ok: false, reason: 'no-folder' });
    expect(commands).toEqual([]);
    expect(gitCalls).toEqual([]);
    expect(rig.checks.latest(bare.id)).toBeNull();
  });
});

describe('a hub that went down in the middle of a run', () => {
  test('its running runs are cancelled at start, so the gate asks for a new run instead of waiting for ever', () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']) });
    const head = git(rig.path, 'rev-parse', 'HEAD');
    const db = (rig.checks as unknown as { opts: { db: import('bun:sqlite').Database } }).opts.db;
    db.query("INSERT INTO check_runs (order_id, floor, slug, sha, trigger, status, started_at) VALUES (?, 'mobile', 'login-a1b2', ?, 'hecho', 'running', 1)").run(rig.order.id, head);
    db.query("INSERT INTO checks (run_id, floor, slug, name, command, status) VALUES (1, 'mobile', 'login-a1b2', 'uno', 'exit 0', 'running')").run();
    expect(rig.checks.gateReading(rig.order).run).toMatchObject({ sha: head, status: 'running' });
    rig.checks.sweepStale();
    expect(rig.checks.gateReading(rig.order).run).toMatchObject({ sha: head, status: 'cancelled' });
    expect(rig.checks.latest(rig.order.id)?.checks[0]?.status).toBe('cancelled');
    expect(rig.checks.latest(rig.order.id)?.endedAt).not.toBeNull();
  });
});

describe('the reading of the gate', () => {
  test('HEAD, dirt, the last run and the definition files of the order', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']) });
    const head = git(rig.path, 'rev-parse', 'HEAD');
    expect(rig.checks.gateReading(rig.order)).toEqual({ head, dirty: [], run: null, touched: [], forcedSha: null, hasChecks: true });
    writeFileSync(join(rig.path, 'a.txt'), 'a');
    expect(rig.checks.gateReading(rig.order).dirty).toEqual(['a.txt']);
    const { view } = await startAndWait(rig);
    const clean = rig.checks.gateReading(rig.order);
    expect(clean).toMatchObject({ head: view.sha, dirty: [], run: { sha: view.sha, status: 'passed', failed: null } });
  });

  test('a changed package.json scripts key is touched, the force is valid for one HEAD only', async () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']) });
    rig.config.floors.mobile!.stack = 'node';
    const first = JSON.stringify({ name: 'x', scripts: { test: 'vitest' }, version: '1' });
    writeFileSync(join(rig.path, 'package.json'), first);
    git(rig.path, 'add', '-A');
    git(rig.path, 'commit', '-q', '-m', 'package.json');
    const base = git(rig.path, 'rev-parse', 'HEAD');
    rig.store.update(rig.order.id, { base_sha: base });
    const order = rig.store.get(rig.order.id)!;

    writeFileSync(join(rig.path, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'true' }, version: '2' }));
    await rig.checkpoints.commit(order, 'listo', 'listo');
    const reading = rig.checks.gateReading(order);
    expect(reading.touched).toEqual(['package.json#scripts']);
    expect(rig.checks.summary(order)).toMatchObject({ touched: ['package.json#scripts'], forced: false });

    const forcedAt = rig.checks.force(order);
    expect(forcedAt).toBe(reading.head);
    const forced = rig.store.get(order.id)!;
    expect(rig.checks.gateReading(forced)).toMatchObject({ forcedSha: reading.head, touched: ['package.json#scripts'] });
    expect(rig.checks.summary(forced)).toMatchObject({ forced: true });

    writeFileSync(join(rig.path, 'a.txt'), 'a');
    await rig.checkpoints.commit(forced, 'listo', 'listo');
    const next = rig.checks.gateReading(rig.store.get(order.id)!);
    expect(next.head).not.toBe(reading.head);
    expect(next.forcedSha).toBe(reading.head);
    expect(next.forcedSha === next.head).toBe(false);
  });

  test('resultText for a run without a red check', () => {
    expect(resultText(rig?.order ?? ({ slug: 'x' } as never), { id: 1, orderId: 1, sha: 'abcdef1234', trigger: 'panel', status: 'cancelled', startedAt: 1, endedAt: 2, checks: [] })).toContain('sin resultado');
  });

  test('a folder that does not exist reads as no HEAD', () => {
    rig = deskRig({ configure: checksOf(['uno', 'exit 0']) });
    const gone = rig.store.update(rig.order.id, { worktree_path: join(rig.root, 'nada') })!;
    expect(existsSync(gone.worktree_path as string)).toBe(false);
    expect(rig.checks.gateReading(gone)).toMatchObject({ head: null, dirty: [], run: null });
  });
});
