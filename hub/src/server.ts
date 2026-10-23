import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { BranchRestoreResult } from './branch-restore';
import { collectDiagnostics, SampleRing } from './diagnostics';
import { clampWait, errorTextFor } from './chat';
import type { FloorAdmin } from './floor-admin';
import { hookResponse, runHook } from './hook';
import { MAX_LAYOUTS_BYTES } from './layouts';
import { clampTail } from './transcript-tail';
import { isRoleId } from './memory';
import type { Log } from './log';
import { isHookEvent, type Office, type RelaunchResult } from './office';
import { claimLaunchToken, mintPanelToken, verifyPanelToken } from './panel-auth';
import { hostAllowed, keyMatches, originAllowed } from './security';
import { buildRecording, MAX_REPLAY_EVENTS } from './replay-build';
import { INBOX_MAX_TEXT } from '../../shared/review-message';
import { parseReview } from './review-desk';
import { parseSearchParams } from './search';
import type { SettingsService } from './settings';
import { record, text } from './state-machine';
import { parseFlakyDays } from './flaky-report';
import { parseTimelineHours } from './timeline';
import type { ChatKind, ChatPostRequest, ClientMessage, HookMeta, HubText, HubTextKey, OrderStatus, PlanDecision, ServerMessage } from './types';
import type { RemoveResult } from './worktrees';

type WsData = { authed: boolean; timer: ReturnType<typeof setTimeout> | null };

export type ServerOptions = {
  office: Office;
  port: number;
  key: () => string;
  publicDir: string;
  dev?: boolean;
  settings?: SettingsService;
  floors?: FloorAdmin;
  log?: Log;
  logFile?: string;
};

export type RunningServer = { server: Server<WsData>; stop: () => void };

export const AUTH_TIMEOUT_MS = 1000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_API_BODY_BYTES = 1024 * 1024;
export const MAX_WS_PAYLOAD = 16 * 1024;
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};
const HOOK_ROUTE = /^\/(events|hook|ask|permission|gate[a-z-]*|guard|usage|chat|encargo)(\/|$)/;
const PLAN_DECISIONS: readonly PlanDecision[] = ['ejecutar', 'aparcar', 'cerrar'];
const ORDER_STATUSES: readonly OrderStatus[] = ['pendiente', 'en-curso', 'revision', 'hecho'];
const RELAUNCH_FAILURES: Record<Exclude<RelaunchResult, 'ok'>, { key: HubTextKey; status: 403 | 404 | 409 | 501 | 502 }> = {
  'not-found': { key: 'hub.api.sessionNotFound', status: 404 },
  'not-office': { key: 'hub.api.sessionNotOffice', status: 403 },
  busy: { key: 'hub.api.relaunchBusy', status: 409 },
  'no-script': { key: 'hub.api.relaunchNoScript', status: 404 },
  'no-tmux': { key: 'hub.api.relaunchNoTmux', status: 501 },
  'no-window': { key: 'hub.api.relaunchNoWindow', status: 409 },
  failed: { key: 'hub.api.relaunchFailed', status: 502 },
};
const WORKTREE_FAILURES: Record<Exclude<RemoveResult, 'ok'>, { key: HubTextKey; status: 404 | 409 | 500 }> = {
  'not-found': { key: 'hub.api.worktreeNotFound', status: 404 },
  busy: { key: 'hub.api.worktreeBusy', status: 409 },
  dirty: { key: 'hub.api.worktreeDirty', status: 409 },
  unmerged: { key: 'hub.api.branchUnmerged', status: 409 },
  'branch-moved': { key: 'hub.api.branchMoved', status: 409 },
  failed: { key: 'hub.api.worktreeFailed', status: 500 },
};
const RESTORE_FAILURES: Record<Exclude<BranchRestoreResult, 'ok'>, { key: HubTextKey; status: 400 | 404 | 409 | 410 | 500 }> = {
  bad: { key: 'hub.api.branchRestoreBad', status: 400 },
  floor: { key: 'hub.api.floorNotManaged', status: 404 },
  'not-found': { key: 'hub.api.branchDeletionNotFound', status: 404 },
  exists: { key: 'hub.api.branchRestoreExists', status: 409 },
  gone: { key: 'hub.api.branchCommitGone', status: 410 },
  git: { key: 'hub.api.branchRestoreFailed', status: 500 },
};
const PENDING_MESSAGE: HubText = { key: 'hub.api.questionClosed' };

const MISSING_UI = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Agent Office</title></head>
<body style="font-family:system-ui;padding:2rem"><h1>Agent Office</h1>
<p>El hub está en marcha, pero la interfaz no está compilada. Ejecuta <code>bun run build</code> en el repositorio y recarga.</p></body></html>`;

function secure(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

export function createApp(opts: ServerOptions, holdRequest: (req: Request) => void): Hono {
  const app = new Hono();
  const { office, port } = opts;
  const startedAt = Date.now();
  const hookTimes = new SampleRing();

  app.use('*', async (c, next) => {
    if (!hostAllowed(c.req.header('host'), port)) return secure(c.text('forbidden', 403));
    await next();
    return secure(c.res);
  });

  app.use('/api/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  // The scripts of the agents and the chat may carry whole files; the rest of the panel's API is small forms.
  const tooLarge = (c: Context) => c.json({ error: { key: 'hub.api.bodyTooLarge' } }, 413);
  const hookLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
  const apiLimit = bodyLimit({ maxSize: MAX_API_BODY_BYTES, onError: tooLarge });
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (HOOK_ROUTE.test(path) || path.startsWith('/api/chat/')) return hookLimit(c, next);
    if (path.startsWith('/api/')) return apiLimit(c, next);
    await next();
  });

  app.onError((error, c) => {
    opts.log?.(`${c.req.method} ${c.req.path}: ${error.stack ?? error.message}`);
    return c.json({ error: { key: 'hub.api.internalError' } }, 500);
  });

  const requireKey = async (c: Context, next: Next) => {
    if (!keyMatches(c.req.header('x-office-key'), opts.key())) return c.text('unauthorized', 401);
    await next();
  };

  const requirePanel = async (c: Context, next: Next) => {
    const key = opts.key();
    if (!keyMatches(c.req.header('x-office-key'), key) && !verifyPanelToken(key, c.req.header('x-office-panel'), Date.now())) {
      return c.text('unauthorized', 401);
    }
    await next();
  };

  const spentLinks = new Map<string, number>();

  app.get('/health', (c) => c.text('ok'));

  app.post('/events', requireKey, async (c) => {
    const event = await readJson(c);
    const output = isHookEvent(event) ? office.ingest(event, metaOf(c)) : null;
    return output ? c.body(output, 200, { 'Content-Type': 'application/json' }) : c.body(null, 200);
  });

  app.post('/hook', requireKey, async (c) => {
    const began = performance.now();
    try {
      const event = await readJson(c);
      if (!isHookEvent(event)) return c.text('pass');
      return c.text(hookResponse(runHook(office, event, metaOf(c), (error) => console.error(`Agent Office: /hook ingest: ${(error as Error).message}`))));
    } finally {
      hookTimes.record(performance.now() - began);
    }
  });

  app.post('/guard', requireKey, async (c) => {
    const event = await readJson(c);
    const decision = isHookEvent(event) ? office.guard(event, metaOf(c)) : { pass: true, reason: '' };
    return c.text(decision.pass ? 'pass' : `block:${decision.reason}`);
  });

  app.post('/ask', requireKey, async (c) => {
    const event = await readJson(c);
    if (!isHookEvent(event)) return c.body(null, 200);
    holdRequest(c.req.raw);
    const body = await office.ask(event, metaOf(c), c.req.raw.signal);
    return body ? c.body(body, 200, { 'Content-Type': 'application/json' }) : c.body(null, 200);
  });

  app.post('/permission', requireKey, async (c) => {
    const event = await readJson(c);
    if (!isHookEvent(event)) return c.body(null, 200);
    holdRequest(c.req.raw);
    const body = await office.permission(event, metaOf(c), c.req.raw.signal);
    return body ? c.body(body, 200, { 'Content-Type': 'application/json' }) : c.body(null, 200);
  });

  app.post('/gate', requireKey, async (c) => {
    const event = await readJson(c);
    const decision = isHookEvent(event) ? office.gate(event) : { pass: true, reason: '' };
    return c.text(decision.pass ? 'pass' : `block:${decision.reason}`);
  });

  app.post('/gate-message', requireKey, async (c) => {
    const event = await readJson(c);
    const decision = isHookEvent(event) ? office.gateMessage(event) : { pass: true, reason: '' };
    return c.text(decision.pass ? 'pass' : `block:${decision.reason}`);
  });

  app.post('/usage', requireKey, async (c) => c.text(office.ingestUsage(await readJson(c))));

  // The chat script of the agents: a form, and plain text back with ?format=text.
  app.post('/chat', requireKey, async (c) => {
    const asText = c.req.query('format') === 'text';
    const result = office.postChat(await readChatPost(c), metaOf(c));
    if (!result.ok) return asText ? c.text(`ERROR: ${errorTextFor(result.error)}\n`, result.status) : c.json({ error: result.error }, result.status);
    if (asText) return c.text(`${office.chat.postText(result.message, result.warnings)}\n`);
    return c.json({ message: result.message, warnings: result.warnings });
  });

  app.get('/chat/:channel', requireKey, async (c) => {
    const asText = c.req.query('format') === 'text';
    const channel = c.req.param('channel') ?? '';
    const waitMs = clampWait(c.req.query('esperar'));
    if (waitMs > 0) holdRequest(c.req.raw);
    const result = await office.readChat(channel, idOf(c.req.query('desde')), waitMs, c.req.raw.signal);
    if (result === 'no-channel') {
      const error: HubText = { key: 'hub.api.chatChannelUnknown' };
      return asText ? c.text(`ERROR: ${errorTextFor(error)}\n`, 404) : c.json({ error }, 404);
    }
    return asText ? c.text(`${office.chat.readText(channel, result.afterId, result.messages)}\n`) : c.json(result.messages);
  });

  // The encargo script of the agents: a form, and plain text back.
  app.post('/encargo', requireKey, async (c) => {
    const raw = await readForm(c);
    const result = await office.orderScript({ order: raw.order ?? '', slug: raw.slug, reason: raw.reason, cwd: raw.cwd }, metaOf(c));
    return c.text(`${result.text}\n`, result.status);
  });

  app.post('/api/panel/claim', async (c) => {
    const now = Date.now();
    if (!claimLaunchToken(opts.key(), record(await readJson(c)).t, now, spentLinks)) return c.json({ error: { key: 'hub.api.panelLinkInvalid' } }, 401);
    return c.json({ token: mintPanelToken(opts.key(), now) });
  });

  app.get('/api/state', requirePanel, (c) => c.json(office.snapshot()));

  app.post('/api/answers/:id', requirePanel, async (c) => {
    const body = record(await readJson(c));
    const id = c.req.param('id') ?? '';
    if (body.release === true) {
      return office.release(id) === 'ok' ? c.json({ ok: true }) : c.json({ error: PENDING_MESSAGE }, 409);
    }
    const result = office.answer(id, body.answers);
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'closed') return c.json({ error: PENDING_MESSAGE }, 409);
    return c.json({ error: { key: 'hub.api.answerMissing' } }, 400);
  });

  app.post('/api/orders', requirePanel, async (c) => {
    const body = record(await readJson(c));
    const sessionId = text(body.sessionId);
    const order = text(body.text);
    if (!sessionId || !order) return c.json({ error: { key: 'hub.api.orderFields' } }, 400);
    if (order.length > INBOX_MAX_TEXT) return c.json({ error: { key: 'hub.api.orderTooLong' } }, 400);
    const result = await office.order(sessionId, order);
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'not-found') return c.json({ error: { key: 'hub.api.sessionNotFound' } }, 404);
    if (result === 'not-office') return c.json({ error: { key: 'hub.api.sessionNotOffice' } }, 403);
    return c.json({ error: { key: 'hub.api.orderFailed' } }, 502);
  });

  app.post('/api/sessions/:id/status', requirePanel, async (c) => {
    const result = await office.requestStatus(c.req.param('id') ?? '');
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'not-found') return c.json({ error: { key: 'hub.api.sessionNotFound' } }, 404);
    if (result === 'not-office') return c.json({ error: { key: 'hub.api.sessionNotOffice' } }, 403);
    return c.json({ error: { key: 'hub.api.orderFailed' } }, 502);
  });

  app.get('/api/sessions/:id/tail', requirePanel, (c) => {
    const result = office.transcriptTail(c.req.param('id') ?? '', clampTail(c.req.query('n')), opts.key());
    if (result === 'not-found') return c.json({ error: { key: 'hub.api.sessionNotFound' } }, 404);
    if (result === 'missing') return c.json({ error: { key: 'hub.api.transcriptMissing' } }, 410);
    return c.json(result);
  });

  app.post('/api/sessions/:id/relaunch', requirePanel, async (c) => {
    const body = record(await readJson(c));
    const result = await office.relaunch(c.req.param('id') ?? '', typeof body.resume === 'boolean' ? body.resume : undefined);
    if (result === 'ok') return c.json({ ok: true });
    const failure = RELAUNCH_FAILURES[result];
    return c.json({ error: { key: failure.key } }, failure.status);
  });

  app.get('/api/settings', requirePanel, (c) => {
    if (!opts.settings) return c.json({ error: { key: 'hub.api.settingsUnavailable' } }, 503);
    return c.json(opts.settings.view());
  });

  app.get('/api/layouts', requirePanel, (c) => c.json(office.layouts()));

  app.put('/api/layouts', requirePanel, bodyLimit({ maxSize: MAX_LAYOUTS_BYTES, onError: tooLarge }), async (c) => {
    const result = office.saveLayouts(await readJson(c));
    if (result.ok) return c.json({ ok: true, data: result.data });
    if (!('failed' in result)) return c.json({ ok: false, error: result.error }, 400);
    const unavailable = typeof result.error !== 'string' && result.error.key === 'hub.layouts.unavailable';
    return c.json({ ok: false, error: result.error }, unavailable ? 503 : 500);
  });

  app.post('/api/settings', requirePanel, async (c) => {
    if (!opts.settings) return c.json({ ok: false, error: [{ key: 'hub.api.settingsUnavailable' }] }, 503);
    const result = opts.settings.update(await readJson(c));
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post('/api/floors', requirePanel, async (c) => {
    if (!opts.floors) return c.json({ ok: false, error: { key: 'hub.api.floorsUnavailable' } }, 503);
    const result = opts.floors.add(await readJson(c));
    return c.json(result, result.ok ? 200 : result.status);
  });

  app.delete('/api/floors/:slug', requirePanel, async (c) => {
    if (!opts.floors) return c.json({ ok: false, error: { key: 'hub.api.floorsUnavailable' } }, 503);
    holdRequest(c.req.raw);
    const result = await opts.floors.remove(c.req.param('slug') ?? '', c.req.query('force') === '1');
    return c.json(result, result.ok ? 200 : result.status);
  });

  app.get('/api/board', requirePanel, (c) => c.json({ orders: office.boardOrders() }));

  app.post('/api/board/orders', requirePanel, async (c) => {
    const body = record(await readJson(c));
    const via = body.via;
    const floor = text(body.floor);
    const title = text(body.title);
    if (!floor || !title || (via !== 'lead' && via !== 'director')) return c.json({ error: { key: 'hub.api.boardFields' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.createOrder({
      floor,
      title,
      description: text(body.description) ?? undefined,
      base: text(body.base) ?? undefined,
      via,
    });
    return result.ok ? c.json({ order: result.order }) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/board/orders/:id/move', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    const body = record(await readJson(c));
    const to = body.to;
    if (id === null || !isOrderStatus(to)) return c.json({ error: { key: 'hub.api.boardFields' } }, 400);
    const result = office.moveOrder(id, to, body.force === true);
    return result.ok ? c.json({ order: result.order }) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/board/orders/:id/discard', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = office.discardOrder(id);
    return result.ok ? c.json({ order: result.order }) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/board/orders/:id/folder', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.retryOrderFolder(id);
    return result.ok ? c.json({ order: result.order }) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/board/orders/:id/confirm-checks', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = office.confirmOrderChecks(id);
    return result.ok ? c.json({ order: result.order }) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/board/orders/:id/checks', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = await office.orderChecks(id);
    return result ? c.json(result) : c.json({ error: { key: 'hub.api.orderNotFound' } }, 404);
  });

  app.post('/api/board/orders/:id/checks', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    holdRequest(c.req.raw);
    const started = await office.runOrderChecks(id, 'panel');
    if (started === null) return c.json({ error: { key: 'hub.api.orderNotFound' } }, 404);
    if (!started.ok) return c.json({ error: { key: started.reason === 'no-checks' ? 'hub.api.noChecks' : 'hub.api.noFolder' } }, 409);
    return c.json({ run: started.run });
  });

  app.delete('/api/board/orders/:id/checks', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    return c.json({ ok: true, cancelled: office.cancelOrderChecks(id) });
  });

  app.get('/api/board/orders/:id/checkpoints', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = office.orderCheckpoints(id);
    return result ? c.json({ ...result, safetyRefs: await office.orderSafetyRefs(id) }) : c.json({ error: { key: 'hub.api.orderNotFound' } }, 404);
  });

  app.get('/api/board/orders/:id/spend', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = office.orderSpend(id);
    return result ? c.json(result) : c.json({ error: { key: 'hub.api.orderNotFound' } }, 404);
  });

  app.post('/api/board/orders/:id/checkpoints/undo-reset', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const body = record(await readJson(c));
    holdRequest(c.req.raw);
    const result = await office.undoOrderReset(id, body.safetyRef, body.force === true);
    return result.ok ? c.json(result) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/board/orders/:id/checkpoints/:cp/preview', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    const cp = idOf(c.req.param('cp'));
    if (id === null || cp === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = await office.previewOrderReset(id, cp);
    return result.ok ? c.json(result.preview) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/board/orders/:id/checkpoints/:cp/reset', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    const cp = idOf(c.req.param('cp'));
    if (id === null || cp === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const body = record(await readJson(c));
    holdRequest(c.req.raw);
    const result = await office.resetOrderToCheckpoint(id, cp, body.force === true);
    return result.ok ? c.json(result) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/board/orders/:id/checkpoints/:cp/fork', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    const cp = idOf(c.req.param('cp'));
    if (id === null || cp === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const body = record(await readJson(c));
    const via = body.via;
    if (via !== undefined && via !== 'lead' && via !== 'director') return c.json({ error: { key: 'hub.api.boardFields' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.forkOrder(id, cp, { title: text(body.title) ?? undefined, via });
    return result.ok ? c.json({ order: result.order }) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/board/orders/:id/diff', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.orderDiff(id);
    return result.ok ? c.json(result.diff) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/board/orders/:id/pr-draft', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.orderPrDraft(id, c.req.query('lang') === 'en' ? 'en' : 'es');
    return result.ok ? c.json(result.draft) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/board/orders/:id/diff/file', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    const path = c.req.query('path');
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    if (!path) return c.json({ error: { key: 'hub.api.pathRequired' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.orderDiffFile(id, path);
    return result.ok ? c.json(result.file) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/board/orders/:id/comments', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const comments = office.orderComments(id);
    return comments ? c.json({ comments }) : c.json({ error: { key: 'hub.api.orderNotFound' } }, 404);
  });

  app.post('/api/board/orders/:id/comments', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const request = parseReview(await readJson(c));
    if (!request) return c.json({ error: { key: 'hub.api.reviewFields' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.reviewOrder(id, request);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result.delivered ? { delivered: true, count: result.count } : { delivered: false, count: result.count, reason: result.reason });
  });

  app.post('/api/board/orders/:id/comments/resend', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const body = record(await readJson(c));
    holdRequest(c.req.raw);
    const result = await office.resendReview(id, body.lang === 'en' ? 'en' : 'es');
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result.delivered ? { delivered: true, count: result.count } : { delivered: false, count: result.count, reason: result.reason });
  });

  app.post('/api/alerts/:id/seen', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    return office.markFinishedSeen(id) ? c.json({ ok: true }) : c.json({ error: { key: 'hub.api.alertNotFound' } }, 404);
  });

  app.get('/api/worktrees', requirePanel, async (c) => c.json(await office.listWorktrees(c.req.query('floor') || undefined)));

  app.post('/api/worktrees/prune', requirePanel, async (c) => {
    holdRequest(c.req.raw);
    return c.json(await office.pruneWorktrees());
  });

  app.post('/api/worktrees/:orderId/keep', requirePanel, (c) => {
    const id = idOf(c.req.param('orderId'));
    return id !== null && office.keepWorktree(id) ? c.json({ ok: true }) : c.json({ error: { key: 'hub.api.worktreeNotFound' } }, 404);
  });

  app.delete('/api/worktrees/:orderId', requirePanel, async (c) => {
    const id = idOf(c.req.param('orderId'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    holdRequest(c.req.raw);
    const result = await office.removeWorktree(id, { deleteBranch: c.req.query('branch') === '1', force: c.req.query('force') === '1' });
    if (result === 'ok') return c.json({ ok: true });
    const failure = WORKTREE_FAILURES[result];
    return c.json({ error: { key: failure.key } }, failure.status);
  });

  app.get('/api/floors/:floor/deleted-branches', requirePanel, async (c) => {
    const branches = await office.deletedBranches(c.req.param('floor') ?? '');
    return branches ? c.json({ branches }) : c.json({ error: { key: 'hub.api.floorNotManaged' } }, 404);
  });

  app.get('/api/floors/:floor/orphan-branches', requirePanel, async (c) => {
    const branches = await office.orphanBranches(c.req.param('floor') ?? '');
    return branches ? c.json({ branches }) : c.json({ error: { key: 'hub.api.floorNotManaged' } }, 404);
  });

  app.post('/api/floors/:floor/deleted-branches/restore', requirePanel, async (c) => {
    const body = record(await readJson(c));
    holdRequest(c.req.raw);
    const result = await office.restoreBranch(c.req.param('floor') ?? '', body.branch, body.sha);
    if (result === 'ok') return c.json({ ok: true });
    const failure = RESTORE_FAILURES[result];
    return c.json({ error: { key: failure.key } }, failure.status);
  });

  app.get('/api/memory/:floor/:role', requirePanel, (c) => {
    const floor = c.req.param('floor') ?? '';
    const role = c.req.param('role');
    if (!floor || floor.length > 80 || !isRoleId(role)) return c.json({ error: { key: 'hub.api.badMemoryTarget' } }, 400);
    return c.json(office.memoryView(floor, role));
  });

  app.post('/api/memory', requirePanel, async (c) => {
    const result = office.addLesson(await readJson(c));
    if (result.ok) return c.json({ lesson: result.lesson });
    return c.json({ error: result.error }, result.status === 409 ? 409 : 400);
  });

  app.put('/api/memory/:id', requirePanel, async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    const result = office.editLesson(id, await readJson(c));
    if (result === null) return c.json({ error: { key: 'hub.api.lessonNotFound' } }, 404);
    if (result.ok) return c.json({ lesson: result.lesson });
    return c.json({ error: result.error }, result.status === 409 ? 409 : 400);
  });

  app.delete('/api/memory/:id', requirePanel, (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ error: { key: 'hub.api.badId' } }, 400);
    return office.removeLesson(id) ? c.json({ ok: true }) : c.json({ error: { key: 'hub.api.lessonNotFound' } }, 404);
  });

  app.get('/api/diagnostics', requirePanel, (c) => c.json(collectDiagnostics({ office, hook: hookTimes, key: opts.key(), logFile: opts.logFile, startedAt })));

  app.get('/api/usage/summary', requirePanel, (c) => {
    const range = c.req.query('range') ?? 'today';
    if (range !== 'today' && range !== 'week') return c.json({ error: { key: 'hub.api.usageRange' } }, 400);
    return c.json(office.tokenSummary(range));
  });

  app.get('/api/digest', requirePanel, (c) => {
    const [day, from, to] = [c.req.query('day'), c.req.query('from'), c.req.query('to')];
    if (from !== undefined || to !== undefined) {
      const week = day === undefined && from !== undefined && to !== undefined ? office.rangeDigest(from, to) : 'bad-range';
      return typeof week === 'string' ? c.json({ error: { key: 'hub.api.digestRange' } }, 400) : c.json(week);
    }
    const result = office.dayDigest(day ?? null);
    return typeof result === 'string' ? c.json({ error: { key: 'hub.api.digestDay' } }, 400) : c.json(result);
  });

  app.get('/api/timeline', requirePanel, (c) => {
    const hours = parseTimelineHours(c.req.query('hours'));
    if (hours === null) return c.json({ error: { key: 'hub.api.timelineHours' } }, 400);
    return c.json({ hours, agents: office.agentTimeline(hours) });
  });

  app.get('/api/checks/flaky', requirePanel, (c) => {
    const days = parseFlakyDays(c.req.query('days'));
    if (days === null) return c.json({ error: { key: 'hub.api.flakyDays' } }, 400);
    const result = office.flakyChecks(days, c.req.query('floor') || undefined);
    return result === 'bad-floor' ? c.json({ error: { key: 'hub.api.flakyFloor' } }, 400) : c.json({ days, flaky: result });
  });

  app.get('/api/reports/:agentKey', requirePanel, (c) => {
    const report = office.report(c.req.param('agentKey') ?? '');
    return report ? c.json(report) : c.json({ error: { key: 'hub.api.noReport' } }, 404);
  });

  app.get('/api/search', requirePanel, (c) => {
    const query = parseSearchParams((name) => c.req.query(name));
    return query ? c.json(office.search(query)) : c.json({ error: { key: 'hub.api.searchBad' } }, 400);
  });

  app.get('/api/replay/:sessionId', requirePanel, async (c) => {
    const { db, deps } = office.replaySource();
    holdRequest(c.req.raw);
    const built = await buildRecording(db, c.req.param('sessionId') ?? '', deps, { compress: c.req.query('compress') === '1' });
    if (built.ok) return c.json(built.recording);
    if (built.reason === 'too-large') return c.json({ error: { key: 'hub.api.recordingTooLarge', params: { max: MAX_REPLAY_EVENTS } } }, 413);
    return c.json({ error: { key: 'hub.api.noRecording' } }, 404);
  });

  app.get('/api/documents', requirePanel, (c) => c.json(office.documents()));

  app.get('/api/documents/content', requirePanel, (c) => {
    const content = office.documentContent(c.req.query('path') ?? '');
    return content ? c.json(content) : c.json({ error: { key: 'hub.api.documentNotFound' } }, 404);
  });

  app.get('/api/documents/rounds', requirePanel, async (c) => {
    const result = await office.documentRounds(c.req.query('path') ?? '');
    if (!result) return c.json({ error: { key: 'hub.api.documentNotFound' } }, 404);
    return result.ok ? c.json(result.rounds) : c.json({ error: result.error }, result.status);
  });

  app.get('/api/documents/rounds/diff', requirePanel, async (c) => {
    const result = await office.documentRoundDiff(c.req.query('path') ?? '', c.req.query('from') ?? '', c.req.query('to') ?? '');
    if (!result) return c.json({ error: { key: 'hub.api.documentNotFound' } }, 404);
    return result.ok ? c.json(result.diff) : c.json({ error: result.error }, result.status);
  });

  app.post('/api/documents/discard', requirePanel, async (c) => {
    const path = text(record(await readJson(c)).path);
    if (!path) return c.json({ error: { key: 'hub.api.pathRequired' } }, 400);
    const result = await office.discardDocument(path);
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'closed') return c.json({ error: { key: 'hub.api.planClosed' } }, 409);
    return c.json({ error: { key: 'hub.api.planNotFound' } }, 404);
  });

  app.post('/api/documents/restore', requirePanel, async (c) => {
    const path = text(record(await readJson(c)).path);
    if (!path) return c.json({ error: { key: 'hub.api.pathRequired' } }, 400);
    const result = await office.restoreDocument(path);
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'not-discarded') return c.json({ error: { key: 'hub.api.planNotDiscarded' } }, 409);
    return c.json({ error: { key: 'hub.api.planNotFound' } }, 404);
  });

  app.post('/api/documents/decide', requirePanel, async (c) => {
    const body = record(await readJson(c));
    const path = text(body.path);
    const decision = body.decision;
    if (!path || !isPlanDecision(decision)) return c.json({ error: { key: 'hub.api.decisionFields' } }, 400);
    const result = await office.decidePlan(path, decision);
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'not-found') return c.json({ error: { key: 'hub.api.planNotFound' } }, 404);
    if (result === 'invalid-state') return c.json({ error: { key: 'hub.api.planBadState' } }, 409);
    if (result === 'busy') return c.json({ error: { key: 'hub.api.planBusy' } }, 409);
    if (result === 'no-director') return c.json({ error: { key: 'hub.api.directorClosed' } }, 409);
    return c.json({ error: { key: 'hub.api.directorUnreachable' } }, 502);
  });

  app.post('/api/redaccion/sync', requirePanel, async (c) => {
    holdRequest(c.req.raw);
    const result = await office.syncSources(await readJson(c));
    const asText = c.req.query('format') === 'text';
    if (!result.ok) return asText ? c.text(`ERROR: ${result.error}\n`, 400) : c.json({ error: result.error }, 400);
    return asText ? c.text(`${result.text}\n`) : c.json(result);
  });

  app.get('/api/chat/:channel', requirePanel, (c) => {
    const result = office.chatHistory(c.req.param('channel') ?? '', idOf(c.req.query('before')));
    return result === 'no-channel' ? c.json({ error: { key: 'hub.api.chatChannelUnknown' } }, 404) : c.json(result);
  });

  app.post('/api/chat/:channel', requirePanel, async (c) => {
    const body = text(record(await readJson(c)).text);
    if (!body) return c.json({ error: { key: 'hub.api.chatFields' } }, 400);
    const result = await office.userChat(c.req.param('channel') ?? '', body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ message: result.message, delivered: result.delivered });
  });

  app.get('*', (c) => serveStatic(c.req.path, opts, c.req.header('if-none-match')));
  return app;
}

export function startServer(opts: ServerOptions): RunningServer {
  const clients = new Set<ServerWebSocket<WsData>>();
  let running: Server<WsData> | null = null;
  const app = createApp(opts, (req) => running?.timeout(req, 0));

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    idleTimeout: 30,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/live') {
        const allowed =
          hostAllowed(req.headers.get('host'), opts.port) &&
          originAllowed(req.headers.get('origin'), opts.port, !!opts.dev);
        if (!allowed) return new Response('forbidden', { status: 403 });
        if (srv.upgrade(req, { data: { authed: false, timer: null } })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      return app.fetch(req);
    },
    websocket: {
      data: {} as WsData,
      maxPayloadLength: MAX_WS_PAYLOAD,
      open(ws) {
        ws.data.timer = setTimeout(() => {
          if (!ws.data.authed) ws.close(4401, 'auth');
        }, AUTH_TIMEOUT_MS);
      },
      message(ws, raw) {
        const msg = parseClientMessage(raw);
        if (!ws.data.authed) {
          if (msg?.type === 'auth' && panelAllowed(msg.token, opts.key())) {
            ws.data.authed = true;
            opts.office.panelConnected();
            if (ws.data.timer) clearTimeout(ws.data.timer);
            clients.add(ws);
            const snapshot: ServerMessage = { type: 'snapshot', data: opts.office.snapshot() };
            ws.send(JSON.stringify(snapshot));
          } else {
            ws.close(4401, 'auth');
          }
          return;
        }
        if (msg?.type === 'heartbeat') opts.office.heartbeat(msg.visible === true);
      },
      close(ws) {
        if (clients.delete(ws)) opts.office.panelDisconnected();
        if (ws.data.timer) clearTimeout(ws.data.timer);
      },
    },
  });
  running = server;

  const unsubscribe = opts.office.subscribe((msg) => {
    broadcast(clients, JSON.stringify(msg), (ws) => {
      if (clients.delete(ws)) opts.office.panelDisconnected();
      opts.log?.('un panel dejó de recibir mensajes y se desconectó');
      try {
        ws.close(1011, 'send failed');
      } catch {}
    });
  });

  return {
    server,
    stop: () => {
      unsubscribe();
      server.stop(true);
    },
  };
}

type Sender = { send(payload: string): number | void };

// One client that cannot take the message must not leave the others without it: each send is its own try.
export function broadcast<C extends Sender>(clients: Iterable<C>, payload: string, drop: (client: C) => void): void {
  for (const client of [...clients]) {
    try {
      if (client.send(payload) === 0) drop(client);
    } catch {
      drop(client);
    }
  }
}

export const CUSTOM_MODELS_INDEX = '/assets/characters/custom/index.json';
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export function customModels(publicDir: string): string[] {
  try {
    return readdirSync(join(publicDir, 'assets', 'characters', 'custom'))
      .filter((name) => /^[A-Za-z0-9_-]+\.glb$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function serveStatic(path: string, opts: ServerOptions, ifNoneMatch?: string): Response {
  if (path === '/' || path === '/index.html') return indexResponse(opts);
  if (path === CUSTOM_MODELS_INDEX) {
    return new Response(JSON.stringify(customModels(opts.publicDir)), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const root = resolve(opts.publicDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const file = resolve(root, `.${normalize(decoded)}`);
  if (!file.startsWith(root + sep)) return new Response('not found', { status: 404 });
  let stat: Stats;
  try {
    stat = statSync(file);
    if (!stat.isFile()) return new Response('not found', { status: 404 });
  } catch {
    return new Response('not found', { status: 404 });
  }
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  // The hash in a Vite asset never changes; the rest revalidates, so a reload gets a 304 instead of the whole file.
  const cache = HASHED_ASSET.test(decoded) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const headers = new Headers({ ETag: etag, 'Cache-Control': cache });
  if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(file), { headers });
}

function etagMatches(header: string, etag: string): boolean {
  return header.split(',').some((candidate) => candidate.trim() === etag || candidate.trim() === '*');
}

function indexResponse(opts: ServerOptions): Response {
  let html = MISSING_UI;
  try {
    html = readFileSync(join(opts.publicDir, 'index.html'), 'utf8');
  } catch {}
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// Form fields as the script sends them (one files= per path), or the same as JSON.
async function readChatPost(c: Context): Promise<ChatPostRequest> {
  let raw: Record<string, unknown> = {};
  try {
    raw = (c.req.header('content-type') ?? '').includes('application/json') ? record(await c.req.json()) : await c.req.parseBody({ all: true });
  } catch {}
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
  const one = (value: unknown): string | undefined => strings(value)[0];
  return {
    channel: one(raw.channel) ?? '',
    kind: one(raw.kind) as ChatKind | undefined,
    text: one(raw.text) ?? '',
    files: strings(raw.files).filter((file) => file.trim() !== ''),
    from: one(raw.from),
    cwd: one(raw.cwd),
  };
}

// A form as the scripts send it, or the same as JSON: only strings, one value per field.
async function readForm(c: Context): Promise<Record<string, string | undefined>> {
  let raw: Record<string, unknown> = {};
  try {
    raw = (c.req.header('content-type') ?? '').includes('application/json') ? record(await c.req.json()) : await c.req.parseBody();
  } catch {}
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(raw)) out[name] = typeof value === 'string' ? value : undefined;
  return out;
}

function idOf(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

function metaOf(c: Context): HookMeta {
  const header = (name: string) => text(c.req.header(name) ?? null);
  return {
    socket: header('x-office-socket'),
    token: header('x-office-token'),
    role: header('x-office-role'),
    name: header('x-office-name'),
  };
}

function panelAllowed(given: string, key: string): boolean {
  return keyMatches(given, key) || verifyPanelToken(key, given, Date.now());
}

function parseClientMessage(raw: string | Buffer): ClientMessage | null {
  try {
    const value = record(JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')));
    if (value.type === 'auth' && typeof value.token === 'string') return { type: 'auth', token: value.token };
    if (value.type === 'heartbeat') return { type: 'heartbeat', visible: value.visible === true };
    return null;
  } catch {
    return null;
  }
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

function isPlanDecision(value: unknown): value is PlanDecision {
  return typeof value === 'string' && (PLAN_DECISIONS as readonly string[]).includes(value);
}
