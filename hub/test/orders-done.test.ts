import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { FinishedView } from '../src/types';
import { DEV, LEAD, boardOrders, checksConfig, deliveryRig, done, leadMessages, newOrder, orderOf, write, commitAll, type Rig } from './delivery-rig';
import { ev, git } from './helpers';

let rig: Rig | undefined;
afterEach(async () => {
  const closing = rig?.h.close();
  rig = undefined;
  await closing;
});

const finished = (r: Rig): FinishedView[] => r.h.office.snapshot().finished;

// The HECHO is blocked, the hub runs the checks, tells the lead, and the repeated HECHO goes through.
async function greenHecho(r: Rig, folder: string, message: string): Promise<void> {
  const first = done(r, message, folder);
  expect(first.pass).toBe(false);
  await r.h.office.idle();
  expect(leadMessages(r).at(-1)).toContain('en verde');
}

describe('the HECHO of a lead with checks', () => {
  test('is blocked until the hub has a green run on HEAD, then finishes the card and raises the alert', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    write(folder, 'lib/a.dart', 'a');
    rig.h.office.ingest(ev(LEAD, folder, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(folder, 'README.md') } }));
    expect(orderOf(rig, card.slug).status).toBe('en-curso');

    const blocked = done(rig, 'HECHO: login listo — validado por el hub — pendiente: nada', folder);
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('Hay cambios sin comprobar');
    expect(orderOf(rig, card.slug).status).toBe('en-curso');
    expect(finished(rig)).toEqual([]);
    await rig.h.office.idle();

    const sha = git(folder, 'rev-parse', 'HEAD');
    expect(leadMessages(rig).at(-1)).toBe(`[Agent Office] COMPROBACIONES encargo/${card.slug} en verde @${sha.slice(0, 7)}: repite el HECHO`);
    expect(orderOf(rig, card.slug).checks).toMatchObject({ status: 'passed', passed: 1, total: 1, sha });

    const accepted = done(rig, 'HECHO: login listo — validado por el hub — pendiente: nada', folder);
    expect(accepted).toMatchObject({ pass: true, reason: `comprobaciones en verde sobre ${sha.slice(0, 7)}` });
    expect(orderOf(rig, card.slug)).toMatchObject({ status: 'hecho', cycle: 1 });
    expect(finished(rig)).toEqual([
      expect.objectContaining({
        kind: 'order',
        slug: card.slug,
        branch: card.branch,
        cycle: 1,
        manual: false,
        summary: 'login listo — validado por el hub — pendiente: nada',
        checks: { passed: 1, total: 1 },
        touched: [],
      }),
    ]);
    expect(rig.h.office.snapshot().activity.map((a) => a.summary)).toContainEqual({ key: 'hub.act.orderFinished', params: { floor: 'mobile', title: card.title, cycle: 1 } });
  });

  test('repeating the HECHO in the same cycle makes no second alert, and a new commit needs new checks', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    await greenHecho(rig, folder, 'HECHO: uno');
    expect(done(rig, 'HECHO: uno', folder).pass).toBe(true);
    expect(done(rig, 'HECHO: uno otra vez', folder).pass).toBe(true);
    expect(finished(rig)).toHaveLength(1);
    expect(boardOrders(rig)).toHaveLength(1);
    write(folder, 'otro.txt', 'x');
    expect(done(rig, 'HECHO: uno de nuevo', folder).pass).toBe(false);
    await rig.h.office.idle();
    expect(finished(rig)).toHaveLength(1);
  });

  test('reopened by hand and finished again, the alert says cycle 2', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    await greenHecho(rig, folder, 'HECHO: uno');
    expect(done(rig, 'HECHO: uno', folder).pass).toBe(true);
    expect(rig.h.office.moveOrder(card.id, 'en-curso')).toMatchObject({ ok: true, order: { status: 'en-curso', cycle: 2 } });
    expect(done(rig, 'HECHO: uno otra vez', folder).pass).toBe(true);
    expect(finished(rig).map((f) => [f.cycle, f.manual])).toEqual([[1, false], [2, false]]);
  });

  test('red checks block the HECHO with the check named, and a BLOQUEADO is not an end', async () => {
    rig = deliveryRig({ configure: checksConfig(['lint', 'exit 0'], ['test', 'echo roto; exit 4']) });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    write(folder, 'a.txt', 'a');
    expect(done(rig, 'HECHO: uno', folder).pass).toBe(false);
    await rig.h.office.idle();
    expect(leadMessages(rig).at(-1)).toContain('test terminó con código 4');
    const again = done(rig, 'HECHO: uno', folder);
    expect(again.pass).toBe(false);
    expect(again.reason).toContain('Rojo en test (código 4)');
    expect(done(rig, 'BLOQUEADO: me falta algo — necesito x de y', folder).pass).toBe(true);
    expect(finished(rig)).toEqual([]);
    expect(orderOf(rig, card.slug).status).not.toBe('hecho');
  });

  test('a manual move to hecho with red checks asks for force and then marks the alert manual', async () => {
    rig = deliveryRig({ configure: checksConfig(['test', 'exit 4']) });
    const card = await newOrder(rig);
    const started = await rig.h.office.runOrderChecks(card.id, 'panel');
    if (!started?.ok) throw new Error('start');
    await started.done;
    const refused = rig.h.office.moveOrder(card.id, 'hecho');
    expect(refused).toMatchObject({ ok: false, status: 409, error: { key: 'hub.api.moveNeedsForce', params: { reason: { key: 'hub.move.red', params: { name: 'test' } } } } });
    expect(orderOf(rig, card.slug).status).toBe('pendiente');
    expect(rig.h.office.moveOrder(card.id, 'hecho', true)).toMatchObject({ ok: true, order: { status: 'hecho' } });
    expect(finished(rig).map((f) => f.manual)).toEqual([true]);
  });

  test('the HECHO names its order, or the lead is in its folder, or it is the only one in progress', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    const first = await newOrder(rig, 'Primero');
    const second = await newOrder(rig, 'Segundo');
    const wt1 = first.worktree?.path ?? '';
    const wt2 = second.worktree?.path ?? '';
    for (const wt of [wt1, wt2]) rig.h.office.ingest(ev(LEAD, wt, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(wt, 'README.md') } }));
    expect(boardOrders(rig).map((o) => o.status)).toEqual(['en-curso', 'en-curso']);

    const ambiguous = done(rig, 'HECHO: ya está', rig.repo);
    expect(ambiguous.pass).toBe(false);
    expect(ambiguous.reason).toContain(`encargo/${first.slug}`);
    expect(ambiguous.reason).toContain('empieza el HECHO por encargo/<slug>');
    expect(done(rig, 'HECHO: encargo/no-existe-0000 — ya está', rig.repo).reason).toContain('No existe encargo/no-existe-0000');

    expect(done(rig, `HECHO: encargo/${second.slug} — ya está`, rig.repo).pass).toBe(false);
    await rig.h.office.idle();
    expect(done(rig, `HECHO: encargo/${second.slug} — ya está`, rig.repo).pass).toBe(true);
    expect(orderOf(rig, second.slug).status).toBe('hecho');
    expect(finished(rig)[0]?.summary).toBe('ya está');
    expect(orderOf(rig, first.slug).status).toBe('en-curso');

    expect(done(rig, 'HECHO: ya está', wt1).pass).toBe(false);
    await rig.h.office.idle();
    expect(done(rig, 'HECHO: ya está', wt1).pass).toBe(true);
    expect(orderOf(rig, first.slug).status).toBe('hecho');
    expect(finished(rig).map((f) => f.slug)).toEqual([second.slug, first.slug]);
  });

  test('with a single order in progress a HECHO from anywhere is about it', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.office.ingest(ev(LEAD, folder, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(folder, 'README.md') } }));
    expect(done(rig, 'HECHO: listo', rig.repo).pass).toBe(false);
    await rig.h.office.idle();
    expect(done(rig, 'HECHO: listo', rig.repo).pass).toBe(true);
    expect(orderOf(rig, card.slug).status).toBe('hecho');
  });

  test('a floor with no order in progress keeps the old tester gate', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']) });
    rig.h.office.ingest(ev(LEAD, rig.repo, 'PostToolUse', { agent_id: DEV, agent_type: 'office-dev-mobile', tool_name: 'Write', tool_input: { file_path: join(rig.repo, 'lib', 'a.dart') } }));
    const decision = done(rig, 'HECHO: algo — validado por tester');
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('Falta tester');
  });
});

describe('a floor without delivery', () => {
  test('never resolves an order: the HECHO goes through the tester gate even with a card left from before', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']), office: { listoDelayMs: 0 } });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.office.ingest(ev(LEAD, folder, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(folder, 'README.md') } }));
    rig.h.config.floors.mobile!.delivery = false;
    rig.h.office.ingest(ev(LEAD, rig.repo, 'PostToolUse', { agent_id: DEV, agent_type: 'office-dev-mobile', tool_name: 'Write', tool_input: { file_path: join(rig.repo, 'lib', 'a.dart') } }));
    for (const cwd of [folder, rig.repo]) {
      const decision = done(rig, 'HECHO: encargo/' + card.slug + ' — algo', cwd);
      expect(decision.pass).toBe(false);
      expect(decision.reason).toContain('Falta tester');
    }
    await rig.h.office.idle();
    expect(orderOf(rig, card.slug).status).toBe('en-curso');
    expect(orderOf(rig, card.slug).checks?.status).toBe('none');
    expect(leadMessages(rig).filter((t) => t.includes('COMPROBACIONES'))).toEqual([]);
  });

  test('a listo runs no checks and a manual move to hecho asks for nothing', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 1']), office: { listoDelayMs: 0 } });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.config.floors.mobile!.delivery = false;
    write(folder, 'lib/a.dart', 'a');
    rig.h.office.postChat(
      { channel: 'mobile', kind: 'listo', text: '', files: ['lib/a.dart'], cwd: join(folder, 'lib') },
      { socket: null, token: 'lead-token', role: 'office-lead-mobile', name: 'lead-mobile' },
    );
    await Bun.sleep(60);
    await rig.h.office.idle();
    expect(orderOf(rig, card.slug).checks?.status).toBe('none');
    expect(rig.h.office.moveOrder(card.id, 'hecho')).toMatchObject({ ok: true });
  });
});

describe('gate modes', () => {
  test('tester: the old gate decides and an accepted HECHO still finishes the card', async () => {
    rig = deliveryRig({ configure: (config) => (config.floors.mobile!.gateMode = 'tester') });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.office.ingest(ev(LEAD, folder, 'PostToolUse', { agent_id: DEV, agent_type: 'office-dev-mobile', tool_name: 'Write', tool_input: { file_path: join(folder, 'lib', 'a.dart') } }));
    const blocked = done(rig, 'HECHO: algo', folder);
    expect(blocked.reason).toContain('Falta tester');
    expect(orderOf(rig, card.slug).status).not.toBe('hecho');
    rig.h.clock.advance(1000);
    rig.h.office.ingest(
      ev(LEAD, folder, 'PostToolUse', {
        agent_id: 'a-tester-1',
        agent_type: 'office-tester-mobile',
        tool_name: 'Bash',
        tool_input: { command: 'flutter test' },
        tool_response: { exit_code: 0 },
      }),
    );
    rig.h.db.query("INSERT INTO verdicts (ts, agent_key, role, floor, kind, ok, command) VALUES (?, 'a-tester-1', 'office-tester-mobile', 'mobile', 'tests', 1, 'flutter test')").run(rig.h.clock.now + 5);
    expect(done(rig, 'HECHO: algo', folder).pass).toBe(true);
    expect(orderOf(rig, card.slug).status).toBe('hecho');
    expect(finished(rig)).toHaveLength(1);
  });

  test('checks+tester: green checks are not enough without the tester', async () => {
    rig = deliveryRig({
      configure: (config) => {
        checksConfig(['uno', 'exit 0'])(config);
        config.floors.mobile!.gateMode = 'checks+tester';
      },
    });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.office.ingest(ev(LEAD, folder, 'PostToolUse', { agent_id: DEV, agent_type: 'office-dev-mobile', tool_name: 'Write', tool_input: { file_path: join(folder, 'lib', 'a.dart') } }));
    write(folder, 'lib/a.dart', 'a');
    expect(done(rig, 'HECHO: algo', folder).pass).toBe(false);
    await rig.h.office.idle();
    const blocked = done(rig, 'HECHO: algo', folder);
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('Falta tester');
    rig.h.db.query("INSERT INTO verdicts (ts, agent_key, role, floor, kind, ok, command) VALUES (?, 'a-tester-1', 'office-tester-mobile', 'mobile', 'tests', 1, 'flutter test')").run(rig.h.clock.now + 5);
    expect(done(rig, 'HECHO: algo', folder).pass).toBe(true);
  });

  test('a floor with no checks configured and checks mode passes without running anything', async () => {
    rig = deliveryRig({ configure: (config) => { config.floors.mobile!.checks = []; config.floors.mobile!.gateMode = 'checks'; } });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.office.ingest(ev(LEAD, folder, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(folder, 'README.md') } }));
    expect(done(rig, 'HECHO: algo', folder).pass).toBe(true);
    expect(orderOf(rig, card.slug)).toMatchObject({ status: 'hecho', checks: null });
  });
});

describe('an order that changes how it is checked', () => {
  test('the HECHO waits for the user, and the confirmation is valid for one HEAD', async () => {
    rig = deliveryRig({ stack: 'node', configure: checksConfig(['test', 'exit 0']) });
    write(rig.repo, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }));
    commitAll(rig.repo, 'package.json');
    git(rig.repo, 'push', '-q', 'origin', 'HEAD:develop');
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    rig.h.office.ingest(ev(LEAD, folder, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(folder, 'README.md') } }));
    write(folder, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'true' } }));
    write(folder, 'lib.txt', 'x');
    commitAll(folder, 'cambia los scripts');

    const blocked = done(rig, 'HECHO: uno', folder);
    expect(blocked.pass).toBe(false);
    expect(blocked.reason).toContain('package.json#scripts');
    expect(blocked.reason).toContain('cambia cómo se comprueba');
    const started = await rig.h.office.runOrderChecks(card.id, 'panel');
    if (!started?.ok) throw new Error('start');
    await started.done;
    expect(orderOf(rig, card.slug).checks).toMatchObject({ status: 'passed', touched: ['package.json#scripts'], forced: false });
    expect(done(rig, 'HECHO: uno', folder).pass).toBe(false);

    expect(rig.h.office.confirmOrderChecks(card.id)).toMatchObject({ ok: true, order: { checks: { forced: true } } });
    write(folder, 'otro.txt', 'x');
    commitAll(folder, 'más cambios');
    const stale = done(rig, 'HECHO: uno', folder);
    expect(stale.pass).toBe(false);
    expect(stale.reason).toContain('cambia cómo se comprueba');

    rig.h.office.confirmOrderChecks(card.id);
    expect(done(rig, 'HECHO: uno', folder).reason).toContain('Hay cambios sin comprobar');
    await rig.h.office.idle();
    expect(done(rig, 'HECHO: uno', folder).pass).toBe(true);
    expect(finished(rig)[0]).toMatchObject({ touched: ['package.json#scripts'], checks: { passed: 1, total: 1 } });
  });

  test('a manual move to hecho needs force and the force confirms that HEAD', async () => {
    rig = deliveryRig({ stack: 'node', configure: checksConfig(['test', 'exit 0']) });
    write(rig.repo, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }));
    commitAll(rig.repo, 'package.json');
    git(rig.repo, 'push', '-q', 'origin', 'HEAD:develop');
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    write(folder, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'true' } }));
    commitAll(folder, 'cambia los scripts');
    const refused = rig.h.office.moveOrder(card.id, 'hecho');
    expect(refused).toMatchObject({ ok: false, status: 409, error: { key: 'hub.api.moveNeedsForce', params: { reason: { key: 'hub.move.touched', params: { files: 'package.json#scripts' } } } } });
    expect(rig.h.office.moveOrder(card.id, 'hecho', true)).toMatchObject({ ok: true, order: { status: 'hecho', checks: { forced: true } } });
    expect(finished(rig)[0]).toMatchObject({ manual: true, touched: ['package.json#scripts'] });
  });
});

describe('listo in the chat', () => {
  const listo = (r: Rig, cwd: string, kind = 'listo') =>
    r.h.office.postChat(
      { channel: 'mobile', kind: kind as 'listo', text: kind === 'texto' ? 'hola' : '', files: kind === 'texto' ? [] : ['lib/a.dart'], cwd },
      { socket: null, token: 'lead-token', role: 'office-lead-mobile', name: 'lead-mobile' },
    );

  test('from inside the folder it runs the checks of the order; from anywhere else it does nothing', async () => {
    rig = deliveryRig({ configure: checksConfig(['uno', 'exit 0']), office: { listoDelayMs: 0 } });
    const card = await newOrder(rig);
    const folder = card.worktree?.path ?? '';
    write(folder, 'lib/a.dart', 'a');
    expect(listo(rig, rig.repo)).toMatchObject({ ok: true });
    await Bun.sleep(30);
    await rig.h.office.idle();
    expect(orderOf(rig, card.slug).checks?.status).toBe('none');
    expect(leadMessages(rig).filter((t) => t.includes('COMPROBACIONES'))).toHaveLength(0);

    expect(listo(rig, join(folder, 'lib'), 'texto')).toMatchObject({ ok: true });
    await Bun.sleep(30);
    expect(leadMessages(rig).filter((t) => t.includes('COMPROBACIONES'))).toHaveLength(0);

    expect(listo(rig, join(folder, 'lib'))).toMatchObject({ ok: true });
    await Bun.sleep(60);
    await rig.h.office.idle();
    expect(leadMessages(rig).filter((t) => t.includes('COMPROBACIONES'))).toHaveLength(1);
    expect(git(folder, 'log', '-1', '--format=%s')).toBe('encargo(' + card.slug + '): listo');
  });

  test('in tester mode a listo runs nothing', async () => {
    rig = deliveryRig({ configure: (config) => { checksConfig(['uno', 'exit 0'])(config); config.floors.mobile!.gateMode = 'tester'; }, office: { listoDelayMs: 0 } });
    const card = await newOrder(rig);
    write(card.worktree?.path ?? '', 'lib/a.dart', 'a');
    listo(rig, card.worktree?.path ?? '');
    await Bun.sleep(60);
    await rig.h.office.idle();
    expect(orderOf(rig, card.slug).checks?.status).toBe('none');
  });
});
