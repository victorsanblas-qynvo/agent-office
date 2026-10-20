import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TemplateError, agentPath, floorsList } from '../src/agents';
import { DEFAULT_ROLES, PROFILES_DIR, TEMPLATES_DIR, loadConfig, saveConfig, type Paths } from '../src/config';
import {
  FloorConflictError,
  FloorError,
  agentFile,
  listFloors,
  planFloor,
  purgeFloor,
  regenerateAgents,
  regenerateAll,
  removeFloor,
  render,
  writeFloor,
} from '../src/floor-cli';
import { detectStack, loadProfiles } from '../src/profiles';
import { fakePaths, floor, makeRepo, tempDir, testConfig } from './helpers';

const profiles = loadProfiles(PROFILES_DIR);

// Turns the folders and checks per order on for floors already written, and writes their agents again.
function deliveryOn(p: Paths, ...slugs: string[]): void {
  const config = loadConfig(p);
  for (const slug of slugs) config.floors[slug] = { ...config.floors[slug]!, delivery: true };
  saveConfig(p, config);
  regenerateAgents(p, profiles);
}

describe('floor CLI', () => {
  let ctx: { dir: string; cleanup: () => void };
  let p: Paths;

  beforeEach(() => {
    ctx = tempDir();
    p = fakePaths(ctx.dir);
    saveConfig(p, testConfig({ docsRepo: join(ctx.dir, 'docs'), departments: { redaccion: true, mantenimiento: true } }));
  });
  afterEach(() => ctx.cleanup());

  test('a Flutter repository becomes a managed floor with its three agents and its launcher', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' });
    const plan = planFloor(p, profiles, repo);
    expect(plan).toMatchObject({ slug: 'mobile', stack: 'flutter', existing: [] });
    writeFloor(p, profiles, plan);

    const lead = readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8');
    expect(lead).toContain('name: office-lead-mobile');
    expect(lead).toContain('flutter test <ruta del test>');
    expect(lead).toContain(plan.path);
    expect(readFileSync(agentFile(p, 'dev', 'mobile'), 'utf8')).toContain('`senior-flutter`');
    expect(readFileSync(agentFile(p, 'tester', 'mobile'), 'utf8')).toContain('name: office-tester-mobile');
    for (const role of ['lead', 'dev', 'tester'] as const) {
      expect(readFileSync(agentFile(p, role, 'mobile'), 'utf8')).not.toContain('{{');
    }

    expect(loadConfig(p).floors.mobile).toEqual(floor(plan.path));
    const launcher = readFileSync(join(p.sessionsDir, 'lead-mobile.sh'), 'utf8');
    expect(launcher).toContain("'--agent' 'office-lead-mobile'");
    expect(launcher).toContain('export CLAUDE_CODE_ENABLE_TODO_TOOLS=1');
    expect(launcher).toContain("export AGENT_OFFICE_ROLE='office-lead-mobile'");
    expect(readFileSync(p.officeSh, 'utf8')).toContain("NAMES='director lead-mobile lead-redaccion lead-mantenimiento'");
    expect(readFileSync(p.directorFloors, 'utf8')).toContain('`mobile`: Flutter');
  });

  test('a Laravel repository gets the Laravel skill and test command', () => {
    const repo = makeRepo(ctx.dir, 'backend', { 'composer.json': '{}', artisan: '' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    const dev = readFileSync(agentFile(p, 'dev', 'backend'), 'utf8');
    expect(dev).toContain('`laravel-senior-backend`');
    expect(dev).toContain('php artisan test --filter=<Clase>');
  });

  test('a Node floor takes its test command from the package.json scripts and its lockfile', () => {
    const bun = makeRepo(ctx.dir, 'office-dev', {
      'package.json': JSON.stringify({ scripts: { test: 'cd hub && bun test', typecheck: 'tsc --noEmit' } }),
      'bun.lock': '',
    });
    writeFloor(p, profiles, planFloor(p, profiles, bun));
    const tester = readFileSync(agentFile(p, 'tester', 'office-dev'), 'utf8');
    expect(tester).toContain('bun run test (el script test de package.json');
    expect(tester).toContain('bun run typecheck si cambió código TypeScript');
    expect(tester).not.toContain('vitest');

    const npm = makeRepo(ctx.dir, 'web', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    writeFloor(p, profiles, planFloor(p, profiles, npm));
    expect(readFileSync(agentFile(p, 'lead', 'web'), 'utf8')).toContain('El comando de tests de esta planta es: npm test (el script test');
    deliveryOn(p, 'web');
    expect(readFileSync(agentFile(p, 'lead', 'web'), 'utf8')).toContain('el comando de tests base de esta planta es: npm test (el script test');

    const bare = makeRepo(ctx.dir, 'scripts-node', { 'package.json': '{}' });
    writeFloor(p, profiles, planFloor(p, profiles, bare));
    expect(readFileSync(agentFile(p, 'tester', 'scripts-node'), 'utf8')).toContain('npx vitest run <spec>');
  });

  test('the agents of a floor carry the delivery cycle: folder, checks, the encargo script and the tester rule of its gate mode', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    deliveryOn(p, 'mobile');
    const script = join(TEMPLATES_DIR, '..', 'scripts', 'office-encargo.sh');
    const lead = readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8');
    expect(lead).toContain(`\`${script} carpeta\``);
    expect(lead).toContain('## Carpeta de cada encargo');
    expect(lead).toContain('EnterWorktree');
    expect(lead).toContain('[Agent Office] CARPETA: encargo/<slug> → <ruta>');
    expect(lead).toContain('analyze (`flutter analyze`), test (`flutter test`)');
    expect(lead).toContain('HECHO: encargo/<slug> —');
    expect(lead).toContain('El tester no es obligatorio en esta planta');
    expect(lead).toContain('Nadie cambia de rama, hace commit ni push');
    expect(lead).toContain('el `HECHO:` espera a que el usuario lo confirme');
    for (const role of ['dev', 'tester'] as const) {
      const text = readFileSync(agentFile(p, role, 'mobile'), 'utf8');
      expect(text).toContain('EnterWorktree');
      expect(text).toContain('.claude/worktrees/office-<slug>');
      expect(text).not.toContain('{{');
    }
    expect(readFileSync(agentFile(p, 'tester', 'mobile'), 'utf8')).toContain('tools: Read, Grep, Glob, Bash, SendMessage, EnterWorktree');
    expect(readFileSync(agentFile(p, 'dev', 'mobile'), 'utf8')).toContain('`listo`');
    expect(readFileSync(agentFile(p, 'dev', 'mobile'), 'utf8')).toContain('No hagas commits');
    const director = readFileSync(agentPath(p, 'office-director'), 'utf8');
    expect(director).toContain('ENCARGO: <título corto> — <qué conseguir> — criterios: … — fuera: …');
    expect(director).toContain('(carpetas por encargo)');
    expect(director).toContain('cada encargo es una rama y una tarjeta en el Tablero');
    expect(director).toContain('nunca fusionas nada');
  });

  test('a floor without delivery keeps the flow before the Tablero: no folder, no CARPETA, no EnterWorktree', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(loadConfig(p).floors.mobile?.delivery).toBeUndefined();
    const lead = readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8');
    expect(lead).toContain('exige un tester antes de cerrar cada tarea');
    expect(lead).toContain('salvo el script del chat');
    expect(lead).toContain('Cuando el desarrollador termine, pide al tester que pruebe exactamente lo que cambió. El comando de tests de esta planta es: flutter test');
    expect(lead).toContain('HECHO: <qué se hizo> — validado por <tester y comando> — pendiente: <qué queda>');
    expect(lead).toContain('Hace falta el tester.');
    for (const gone of ['CARPETA', 'EnterWorktree', 'Carpeta de cada encargo', 'office-encargo', 'COMPROBACIONES', 'encargo/<slug>', 'listo']) {
      expect(lead).not.toContain(gone);
    }
    const dev = readFileSync(agentFile(p, 'dev', 'mobile'), 'utf8');
    expect(dev).toContain('No hagas commits salvo que la tarea lo pida.');
    for (const gone of ['EnterWorktree', 'Tu carpeta de trabajo', 'worktrees', '`listo` (más abajo)']) expect(dev).not.toContain(gone);
    const tester = readFileSync(agentFile(p, 'tester', 'mobile'), 'utf8');
    expect(tester).toContain('tools: Read, Grep, Glob, Bash, SendMessage\n');
    for (const gone of ['EnterWorktree', 'Tu carpeta de trabajo', 'worktrees']) expect(tester).not.toContain(gone);
    for (const text of [lead, dev, tester]) expect(text).not.toContain('{{');
  });

  test('turning delivery on and off again renders each floor with its own text, and the lists mark the delivery floors', () => {
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' })));
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'web', { 'package.json': '{}' })));
    deliveryOn(p, 'web');
    expect(readFileSync(agentFile(p, 'lead', 'web'), 'utf8')).toContain('## Carpeta de cada encargo');
    expect(readFileSync(agentFile(p, 'tester', 'web'), 'utf8')).toContain('EnterWorktree');
    expect(readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8')).not.toContain('CARPETA');
    expect(readFileSync(agentFile(p, 'tester', 'mobile'), 'utf8')).not.toContain('EnterWorktree');
    const list = floorsList(loadConfig(p), profiles);
    expect(list).toContain('- `web` (carpetas por encargo): ');
    expect(list).toContain('- `mobile`: ');
    const config = loadConfig(p);
    delete config.floors.web!.delivery;
    saveConfig(p, config);
    regenerateAgents(p, profiles);
    expect(readFileSync(agentFile(p, 'lead', 'web'), 'utf8')).not.toContain('CARPETA');
    expect(floorsList(loadConfig(p), profiles)).not.toContain('(carpetas por encargo)');
  });

  test('the tester rule follows the gate mode of the floor and a floor without checks keeps the tester', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': '' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    const config = loadConfig(p);
    config.floors.mobile = { ...config.floors.mobile!, gateMode: 'checks+tester', delivery: true };
    config.floors.backend = { path: makeRepo(ctx.dir, 'backend', { 'artisan': '', 'composer.json': '{}' }), stack: 'laravel', managed: true, baseBranch: 'develop', checks: [], delivery: true };
    saveConfig(p, config);
    regenerateAgents(p, profiles);
    const both = readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8');
    expect(both).toContain('La puerta del HECHO exige las dos cosas');
    const tester = readFileSync(agentFile(p, 'lead', 'backend'), 'utf8');
    expect(tester).toContain('La puerta del HECHO exige un test en verde del tester posterior al último cambio');
    expect(tester).toContain('ninguna configurada');
    expect(tester).toContain('php artisan test --filter=<Clase>');
  });

  test('adding a floor again keeps the delivery settings it already had', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': '' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    const config = loadConfig(p);
    config.floors.mobile = { ...config.floors.mobile!, checks: [{ name: 'test', command: 'make test' }], gateMode: 'checks', linkDirs: ['vendor'], baseBranch: 'main' };
    saveConfig(p, config);
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(loadConfig(p).floors.mobile).toMatchObject({ checks: [{ name: 'test', command: 'make test' }], gateMode: 'checks', linkDirs: ['vendor'], baseBranch: 'main' });
  });

  test('a repository without a profile skill says so', () => {
    const repo = makeRepo(ctx.dir, 'scripts');
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(readFileSync(agentFile(p, 'dev', 'scripts'), 'utf8')).toContain('no tiene una skill propia');
  });

  test('two folders with the same name need --slug', () => {
    const first = makeRepo(join(ctx.dir, 'a'), 'mobile');
    const second = makeRepo(join(ctx.dir, 'b'), 'mobile');
    writeFloor(p, profiles, planFloor(p, profiles, first));
    expect(() => planFloor(p, profiles, second)).toThrow(FloorError);
    expect(planFloor(p, profiles, second, 'mobile-b').slug).toBe('mobile-b');
  });

  test('the same folder cannot be two floors and reserved names are refused', () => {
    const repo = makeRepo(ctx.dir, 'mobile');
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(() => planFloor(p, profiles, repo, 'otra')).toThrow(FloorError);
    expect(() => planFloor(p, profiles, repo, 'direccion')).toThrow(FloorError);
    expect(() => planFloor(p, profiles, join(ctx.dir, 'nope'))).toThrow(FloorError);
  });

  test('existing agents are reported before overwriting', () => {
    const repo = makeRepo(ctx.dir, 'mobile');
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(planFloor(p, profiles, repo).existing).toHaveLength(3);
  });

  test('removing a floor deletes its agents and its launcher and keeps it observed', () => {
    const repo = makeRepo(ctx.dir, 'mobile');
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(removeFloor(p, profiles, 'mobile')).toHaveLength(3);
    expect(existsSync(agentFile(p, 'lead', 'mobile'))).toBe(false);
    expect(existsSync(join(p.sessionsDir, 'lead-mobile.sh'))).toBe(false);
    expect(loadConfig(p).floors.mobile?.managed).toBe(false);
    expect(readFileSync(p.officeSh, 'utf8')).toContain("NAMES='director lead-redaccion lead-mantenimiento'");
    expect(() => removeFloor(p, profiles, 'nope')).toThrow(FloorError);
  });

  test('purging a floor removes its config, agents and launcher and leaves the fixed agents without it', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': '' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    const config = loadConfig(p);
    config.permissionModes.mobile = 'plan';
    config.permissionModes.redaccion = 'manual';
    config.floorRoles.mobile = { dev: { model: 'haiku', effort: 'low' } };
    config.floorRoles.redaccion = { redactor: { model: 'sonnet', effort: 'high' } };
    saveConfig(p, config);

    expect(purgeFloor(p, profiles, 'mobile')).toHaveLength(3);
    const after = loadConfig(p);
    expect(after.floors.mobile).toBeUndefined();
    expect(after.permissionModes.mobile).toBeUndefined();
    expect(after.floorRoles.mobile).toBeUndefined();
    expect(after.permissionModes.redaccion).toBe('manual');
    expect(after.floorRoles.redaccion).toEqual({ redactor: { model: 'sonnet', effort: 'high' } });
    for (const role of ['lead', 'dev', 'tester'] as const) expect(existsSync(agentFile(p, role, 'mobile'))).toBe(false);
    expect(existsSync(join(p.sessionsDir, 'lead-mobile.sh'))).toBe(false);
    expect(readFileSync(p.officeSh, 'utf8')).not.toContain('mobile');
    expect(readFileSync(p.directorFloors, 'utf8')).not.toContain('mobile');
    expect(() => purgeFloor(p, profiles, 'mobile')).toThrow(FloorError);
    expect(() => purgeFloor(p, profiles, 'redaccion')).toThrow(FloorError);
  });

  test('a repository that is already a floor is a conflict', () => {
    const repo = makeRepo(ctx.dir, 'mobile');
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    expect(() => planFloor(p, profiles, repo, 'otra')).toThrow(FloorConflictError);
    expect(() => planFloor(p, profiles, makeRepo(join(ctx.dir, 'b'), 'mobile'))).toThrow(FloorConflictError);
  });

  test('regenerating all floors applies a changed template without asking', () => {
    const repo = makeRepo(ctx.dir, 'mobile');
    writeFloor(p, profiles, planFloor(p, profiles, repo));
    const templates = join(ctx.dir, 'templates');
    cpSync(TEMPLATES_DIR, templates, { recursive: true });
    writeFileSync(join(templates, 'lead.md.tpl'), `${readFileSync(join(templates, 'lead.md.tpl'), 'utf8')}\nVERSIÓN 2\n`);
    expect(regenerateAll(p, profiles, templates)).toEqual([{ slug: 'mobile' }]);
    expect(readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8')).toContain('VERSIÓN 2');
  });

  test('every agent carries the model and effort of its role', () => {
    const config = loadConfig(p);
    config.roles = { ...DEFAULT_ROLES, dev: { model: 'haiku', effort: 'low' }, redactor: { model: 'claude-opus-5-5', effort: 'max' } };
    saveConfig(p, config);
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': '' })));
    const dev = readFileSync(agentFile(p, 'dev', 'mobile'), 'utf8');
    expect(dev).toContain('model: haiku\neffort: low');
    expect(readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8')).toContain('model: sonnet\neffort: medium');
    expect(readFileSync(agentPath(p, 'office-director'), 'utf8')).toContain('model: fable\neffort: xhigh');
    expect(readFileSync(agentPath(p, 'office-redactor'), 'utf8')).toContain('model: claude-opus-5-5\neffort: max');
    expect(readFileSync(agentPath(p, 'office-revisor-planes'), 'utf8')).toContain('tools: Read, Grep, Glob, SendMessage');
    for (const name of ['office-director', 'office-reviewer', 'office-lead-redaccion', 'office-redactor', 'office-revisor-planes', 'office-lead-mantenimiento', 'office-artesano', 'office-revisor-skills']) {
      const content = readFileSync(agentPath(p, name), 'utf8');
      expect(content).toContain(`name: ${name}`);
      expect(content).not.toContain('{{');
    }
    expect(readFileSync(agentPath(p, 'office-lead-redaccion'), 'utf8')).toContain(join(ctx.dir, 'docs'));
    expect(readFileSync(agentPath(p, 'office-lead-redaccion'), 'utf8')).toContain('`mobile`: Flutter');
    expect(readFileSync(agentPath(p, 'office-lead-mantenimiento'), 'utf8')).toContain(p.skillsDir);
  });

  test('a floor override reaches only the agents of that floor and its department', () => {
    const config = loadConfig(p);
    config.floorRoles = {
      mobile: { dev: { model: 'fable', effort: 'xhigh' }, lead: { model: 'opus', effort: 'low' } },
      redaccion: { 'revisor-planes': { model: 'sonnet', effort: 'low' }, lead: { model: 'haiku', effort: 'medium' } },
    };
    saveConfig(p, config);
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': '' })));
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'backend', { 'artisan': '' })));
    expect(readFileSync(agentFile(p, 'dev', 'mobile'), 'utf8')).toContain('model: fable\neffort: xhigh');
    expect(readFileSync(agentFile(p, 'lead', 'mobile'), 'utf8')).toContain('model: opus\neffort: low');
    expect(readFileSync(agentFile(p, 'tester', 'mobile'), 'utf8')).toContain('model: sonnet\neffort: medium');
    expect(readFileSync(agentFile(p, 'dev', 'backend'), 'utf8')).toContain('model: opus\neffort: high');
    expect(readFileSync(agentFile(p, 'lead', 'backend'), 'utf8')).toContain('model: sonnet\neffort: medium');
    expect(readFileSync(agentPath(p, 'office-revisor-planes'), 'utf8')).toContain('model: sonnet\neffort: low');
    expect(readFileSync(agentPath(p, 'office-lead-redaccion'), 'utf8')).toContain('model: haiku\neffort: medium');
    expect(readFileSync(agentPath(p, 'office-redactor'), 'utf8')).toContain('model: opus\neffort: high');
    expect(readFileSync(agentPath(p, 'office-lead-mantenimiento'), 'utf8')).toContain('model: sonnet\neffort: medium');
    expect(readFileSync(agentPath(p, 'office-director'), 'utf8')).toContain('model: fable\neffort: xhigh');
  });

  test('turning a department off removes its agents and its launcher', () => {
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile')));
    expect(existsSync(agentPath(p, 'office-artesano'))).toBe(true);
    const config = loadConfig(p);
    config.departments.mantenimiento = false;
    saveConfig(p, config);
    const result = regenerateAgents(p, profiles);
    expect(result.floors).toEqual([{ slug: 'mobile' }]);
    expect(result.files).toBe(3 + 5);
    for (const name of ['office-lead-mantenimiento', 'office-artesano', 'office-revisor-skills']) expect(existsSync(agentPath(p, name))).toBe(false);
    expect(existsSync(agentPath(p, 'office-redactor'))).toBe(true);
    expect(existsSync(join(p.sessionsDir, 'lead-mantenimiento.sh'))).toBe(false);
    expect(existsSync(join(p.sessionsDir, 'lead-redaccion.sh'))).toBe(true);
  });

  test('a floor whose folder disappeared is reported and the rest is regenerated', () => {
    const config = loadConfig(p);
    config.floors.gone = floor(join(ctx.dir, 'gone'));
    saveConfig(p, config);
    const result = regenerateAgents(p, profiles);
    expect(result.floors[0]?.error).toContain('No existe');
    expect(existsSync(agentPath(p, 'office-director'))).toBe(true);
  });

  test('department names are reserved', () => {
    const repo = makeRepo(ctx.dir, 'redaccion');
    expect(() => planFloor(p, profiles, repo)).toThrow(FloorError);
    expect(() => planFloor(p, profiles, makeRepo(ctx.dir, 'x'), 'mantenimiento')).toThrow(FloorError);
  });

  test('listing shows each floor with its kind', () => {
    expect(listFloors(p, profiles)).toContain('No hay plantas');
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': '' })));
    expect(listFloors(p, profiles)).toMatch(/mobile\s+gestionada\s+Flutter/);
  });
});

describe('templates and stacks', () => {
  test('rendering refuses unknown variables', () => {
    expect(render('hola {{slug}}', { slug: 'x' })).toBe('hola x');
    expect(() => render('hola {{nadie}}', {})).toThrow(TemplateError);
  });

  test('stack detection', () => {
    const { dir, cleanup } = tempDir();
    expect(detectStack(makeRepo(dir, 'f', { 'pubspec.yaml': '' }))).toBe('flutter');
    expect(detectStack(makeRepo(dir, 'l', { 'composer.json': '{}', artisan: '' }))).toBe('laravel');
    expect(detectStack(makeRepo(dir, 'c', { 'composer.json': '{}' }))).toBe('generic');
    expect(detectStack(makeRepo(dir, 'n', { 'package.json': '{}' }))).toBe('node');
    cleanup();
  });
});

describe('floor CLI as a command', () => {
  let ctx: { dir: string; cleanup: () => void };
  let p: Paths;

  function run(args: string[]): { code: number; out: string; err: string } {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'src', 'floor-cli.ts'), ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AGENT_OFFICE_HOME: p.home, AGENT_OFFICE_CLAUDE_HOME: p.claudeHome },
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }

  beforeEach(() => {
    ctx = tempDir();
    p = fakePaths(ctx.dir);
    saveConfig(p, testConfig({ docsRepo: join(ctx.dir, 'docs'), departments: { redaccion: true, mantenimiento: true } }));
  });
  afterEach(() => ctx.cleanup());

  test('list prints the floors and says so when there are none', () => {
    const empty = run(['list']);
    expect(empty.code).toBe(0);
    expect(empty.out).toContain('No hay plantas configuradas');

    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' })));
    const listed = run(['list']);
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/mobile\s+gestionada\s+Flutter/);
  });

  test('add writes the floor and its agents without asking with --yes', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' });
    const result = run(['add', repo, '--yes']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Planta mobile (Flutter) gestionada en');
    expect(result.out).toContain('Arranca su jefe de planta con bun run office');
    expect(existsSync(agentFile(p, 'lead', 'mobile'))).toBe(true);
    expect(loadConfig(p).floors.mobile?.managed).toBe(true);
  });

  test('add takes the slug from --slug', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' });
    const result = run(['add', repo, '--slug', 'app-movil', '--yes']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Planta app-movil (Flutter) gestionada en');
    expect(loadConfig(p).floors['app-movil']?.managed).toBe(true);
  });

  test('add asks before overwriting and cancels without a terminal', () => {
    const repo = makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' });
    writeFloor(p, profiles, planFloor(p, profiles, repo));

    const result = run(['add', repo]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Cancelado');
  });

  test('add --all regenerates every floor', () => {
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' })));
    const result = run(['add', '--all']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('mobile: agentes regenerados');
    expect(result.out).toContain(`agentes escritos en ${p.agentsDir}`);
  });

  test('remove passes the floor to observed and an unknown one fails', () => {
    writeFloor(p, profiles, planFloor(p, profiles, makeRepo(ctx.dir, 'mobile', { 'pubspec.yaml': 'name: app\n' })));
    const removed = run(['remove', 'mobile']);

    expect(removed.code).toBe(0);
    expect(removed.out).toContain('Planta mobile pasa a observada. Agentes borrados: 3');
    expect(loadConfig(p).floors.mobile?.managed).toBe(false);

    const missing = run(['remove', 'nope']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('No hay ninguna planta "nope"');
  });

  test('without arguments it prints the usage and fails', () => {
    const result = run([]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Uso:');
  });
});
