import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILES_DIR,
  PUBLIC_DIR,
  RAW_FIXTURES_DIR,
  WORKSPACE_DIR,
  createIdIfMissing,
  loadConfig,
  paths,
  readKey,
  writeHeaders,
  writePortFile,
  type Paths,
} from './config';
import { configTargets, watchTargets } from './config-watch';
import { dbRegistry, openDb } from './db';
import { createFloorAdmin } from './floor-admin';
import { LayoutStore } from './layouts';
import { createLog } from './log';
import { Office } from './office';
import { newNonce } from './panel-auth';
import { panelUrl } from './panel-url';
import { loadProfiles } from './profiles';
import { pruneInChunks } from './prune';
import { startRecording } from './recorder';
import { startServer } from './server';
import { createSettings } from './settings';
import { shutdownSequence } from './shutdown';

const DAY_MS = 86_400_000;
const TICK_MS = 5000;

export function main(argv: string[]): void {
  const p = paths();
  const logLine = createLog(p.home);
  const key = readKey(p);
  if (!key) {
    console.error('No hay key de Agent Office. Ejecuta primero: bun run setup');
    process.exit(1);
  }
  writeHeaders(p, key);
  // An install updated without going through setup again has no id yet: without it, it could not mark its snapshots.
  const { id: hubId } = createIdIfMissing(p);
  let config = loadConfig(p);
  writePortFile(p, config.port);
  const db = openDb(p.db);
  const office = new Office({
    db,
    hubId,
    config,
    profiles: loadProfiles(PROFILES_DIR),
    workspaceDir: WORKSPACE_DIR,
    claudeHome: p.claudeHome,
    launch: { agentsDir: p.agentsDir, sessionsDir: p.sessionsDir, directorFloors: p.directorFloors },
    registry: dbRegistry(db),
    layouts: new LayoutStore(p.layouts, logLine),
    rawDir: process.env.AGENT_OFFICE_RAW === '1' ? RAW_FIXTURES_DIR : null,
    log: (text) => {
      console.error(`Agent Office: ${text}`);
      logLine(text);
    },
  });
  const recorder = process.env.AGENT_OFFICE_RECORD ? startRecording(office, process.env.AGENT_OFFICE_RECORD) : null;
  const reload = () => {
    try {
      config = loadConfig(p);
      office.reload(config, loadProfiles(PROFILES_DIR));
      console.log('Configuración recargada');
    } catch (error) {
      const message = `No se pudo recargar la configuración: ${(error as Error).message}`;
      console.error(message);
      logLine(message);
    }
  };
  const settings = createSettings(p, () => loadProfiles(PROFILES_DIR), reload);
  const floors = createFloorAdmin(p, () => loadProfiles(PROFILES_DIR), office, reload);
  const { stop } = startServer({
    office,
    port: config.port,
    key: () => key,
    publicDir: PUBLIC_DIR,
    dev: process.env.AGENT_OFFICE_DEV === '1',
    settings,
    floors,
    log: logLine,
    logFile: join(p.home, 'hub.log'),
  });
  const stopWatching = watchTargets(configTargets(p.home, PROFILES_DIR), reload);
  office.start();
  const daily = () => {
    pruneInChunks(db, Date.now(), config.retentionDays).catch((error: unknown) => {
      const message = `no se pudo aplicar la retención: ${(error as Error).message}`;
      console.error(`Agent Office: ${message}`);
      logLine(message);
    });
    office.expireSources().catch((error: unknown) => console.error(`No se pudieron retirar fuentes antiguas: ${(error as Error).message}`));
    office.expireWorktrees().catch((error: unknown) => console.error(`No se pudieron revisar las carpetas de encargos: ${(error as Error).message}`));
  };
  daily();
  const pruneTimer = setInterval(daily, DAY_MS);
  const tickTimer = setInterval(() => office.tick(), TICK_MS);

  const url = `http://127.0.0.1:${config.port}`;
  console.log(`Agent Office escuchando en ${url}`);
  logLine(`hub arrancado en ${url} (pid ${process.pid})`);
  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) console.log('La interfaz no está compilada: bun run build');
  if (process.env.AGENT_OFFICE_RECORD) console.log(`Grabando en ${process.env.AGENT_OFFICE_RECORD}`);
  if (argv.includes('--open')) openSessions(p, panelUrl(config.port, key, Date.now(), newNonce()));
  else console.log('Panel: bun run panel');

  process.on('uncaughtException', (error) => {
    const message = `error no capturado: ${error.stack ?? String(error)}`;
    console.error(`Agent Office: ${message}`);
    logLine(message);
  });
  process.on('unhandledRejection', (reason) => {
    const message = `promesa rechazada sin capturar: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`;
    console.error(`Agent Office: ${message}`);
    logLine(message);
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      console.log(`Agent Office: ${signal} otra vez, salgo sin esperar`);
      process.exit(1);
    }
    closing = true;
    console.log(`Agent Office: ${signal} recibido, cerrando el hub`);
    clearInterval(pruneTimer);
    clearInterval(tickTimer);
    stopWatching();
    recorder?.stop();
    shutdownSequence({ stopServer: stop, office, db })
      .then(({ timedOut }) => logLine(`${signal} recibido, hub cerrado${timedOut ? ' (había tareas sin terminar)' : ''}`))
      .catch((error: unknown) => logLine(`error al cerrar: ${(error as Error).message}`))
      .finally(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => shutdown(signal));
}

function openSessions(p: Paths, panel: string): void {
  if (process.platform === 'darwin') Bun.spawn(['open', panel]);
  else console.log('Panel: bun run panel --print');
  if (!existsSync(p.officeSh)) {
    console.log('No hay sesiones que abrir: añade una planta con bun run floor add <ruta>');
    return;
  }
  Bun.spawn(['sh', p.officeSh], { stdout: 'inherit', stderr: 'inherit' });
}

if (import.meta.main) main(process.argv.slice(2));
