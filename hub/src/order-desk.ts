import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './config';
import { broadcastText, encodeInbox, orderText, type deliver } from './courier';
import { commitDocument } from './docs-repo';
import type { DocumentDesk } from './documents';
import type { GitQueue, GitRunner } from './git';
import type { OfficeBus } from './office-bus';
import {
  DAY_MS,
  DECISION_FROM,
  NOT_DISCARDABLE,
  type AgentRuntime,
  type DecideResult,
  type DiscardResult,
  type OrderResult,
  type RestoreResult,
} from './office-state';
import { DISCARDED_MARK, STATUS_REQUEST, analysisOrderText, executeOrderText, taskLine, withoutDiscardMark } from './office-texts';
import { publicText } from './privacy';
import type { DocRef } from './protocol';
import type { SessionBook } from './session-book';
import { short } from './state-machine';
import type { SyncDesk, SyncResult } from './sync';
import { planSlugIn } from './tokens';
import type { HubText, OfficeConfig, PlanDecision } from './types';

export type OrderDeskOpts = {
  now: () => number;
  bus: OfficeBus;
  book: SessionBook;
  config: () => OfficeConfig;
  docs: DocumentDesk;
  sync: SyncDesk;
  git: GitRunner;
  queue: GitQueue;
  deliver: typeof deliver;
  undoMs: number;
  docsRoot: () => string;
  refreshDocuments: () => void;
  instructed: (sessionId: string, now: number) => void;
  allowBriefs: (sessionId: string, floors: number) => void;
  setPlan: (agent: AgentRuntime, slug: string) => void;
  openTask: (agent: AgentRuntime, now: number) => void;
  // A plan of implementation was sent to the director: one card per floor of the plan.
  planExecuting: (plan: { slug: string; title: string; floors: string[] }) => void;
};

const STATUS_COOLDOWN_MS = 2 * 60_000;

// task: the order is the agent's work from now on. message: a note that leaves its task and plan as they are.
type Delivery = 'task' | 'message' | 'status';

export class OrderDesk {
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deciding = new Set<string>();
  private readonly statusAsked = new Map<string, number>();

  constructor(private readonly opts: OrderDeskOpts) {}

  async order(sessionId: string, body: string, opts: { broadcast?: boolean } = {}): Promise<OrderResult> {
    const result = await this.deliverOrder(sessionId, body, opts.broadcast ? 'message' : 'task');
    if (result === 'ok') this.opts.instructed(sessionId, this.opts.now());
    return result;
  }

  // A session asked for its status less than two minutes ago is not asked again.
  async requestStatus(sessionId: string): Promise<OrderResult | 'busy'> {
    const now = this.opts.now();
    for (const [id, at] of this.statusAsked) if (now - at >= STATUS_COOLDOWN_MS) this.statusAsked.delete(id);
    if (this.statusAsked.has(sessionId)) return 'busy';
    this.statusAsked.set(sessionId, now);
    const result = await this.deliverOrder(sessionId, STATUS_REQUEST, 'status');
    if (result !== 'ok' && this.statusAsked.get(sessionId) === now) this.statusAsked.delete(sessionId);
    return result;
  }

  private async deliverOrder(sessionId: string, body: string, delivery: Delivery): Promise<OrderResult> {
    const session = this.opts.book.sessions.get(sessionId);
    if (!session || session.endedAt !== null) return 'not-found';
    if (!this.opts.book.sessionInOffice(session)) return 'not-office';
    if (!session.socket || !existsSync(session.socket)) return 'unreachable';
    try {
      await this.opts.deliver(session.socket, encodeInbox(session.token, delivery === 'message' ? broadcastText(body) : orderText(body)));
    } catch {
      return 'failed';
    }
    this.opts.bus.pushActivity({
      ts: this.opts.now(),
      agentKey: session.sessionId,
      event: delivery === 'status' ? 'Status' : 'Order',
      tool: null,
      state: null,
      summary:
        delivery === 'status'
          ? { key: 'hub.act.statusRequested', params: { who: session.name ?? session.sessionId.slice(0, 8) } }
          : { key: 'hub.act.order', params: { text: short(body, 60) } },
    });
    const main = this.opts.book.agents.get(sessionId);
    const asTask = delivery === 'task';
    const plan = asTask ? planSlugIn(body) : null;
    if (main && main.retiredAt === null && plan) this.opts.setPlan(main, plan);
    const task = asTask ? taskLine(publicText(body, session.floorKind)) : null;
    if (main && main.retiredAt === null && task) {
      main.task = task;
      main.away = false;
      this.opts.openTask(main, this.opts.now());
      this.opts.book.emitAgent(main, this.opts.now());
    }
    return 'ok';
  }

  async discardDocument(path: string): Promise<DiscardResult> {
    const doc = this.opts.docs.find(path);
    if (!doc || doc.kind !== 'plan') return 'not-found';
    if (NOT_DISCARDABLE.has(doc.status)) return 'closed';
    const now = this.opts.now();
    const ref: DocRef = { path: doc.path, kind: doc.kind, slug: doc.slug };
    this.opts.docs.markDiscarded(ref, now);
    this.markDiscardedFile(ref, now);
    this.opts.refreshDocuments();
    this.opts.bus.pushActivity({ ts: now, agentKey: 'panel', event: 'Discard', tool: null, state: null, summary: { key: 'hub.act.planDiscarded', params: { path: doc.path } } });
    if (this.opts.undoMs <= 0) {
      await this.opts.sync.remove(doc.slug);
      return 'ok';
    }
    // The sources go once the window to undo has passed; stop() cancels it and the next start() sweeps the orphans.
    const timer = setTimeout(() => {
      this.removals.delete(doc.path);
      this.opts.bus.background(this.opts.sync.remove(doc.slug));
    }, this.opts.undoMs);
    timer.unref?.();
    this.removals.set(doc.path, timer);
    return 'ok';
  }

  async restoreDocument(path: string): Promise<RestoreResult> {
    const doc = this.opts.docs.find(path);
    if (!doc || doc.kind !== 'plan') return 'not-found';
    if (doc.status !== 'descartado') return 'not-discarded';
    const now = this.opts.now();
    const ref: DocRef = { path: doc.path, kind: doc.kind, slug: doc.slug };
    const timer = this.removals.get(doc.path);
    if (timer) clearTimeout(timer);
    this.removals.delete(doc.path);
    this.restoreFile(ref);
    this.opts.docs.clearDiscarded(ref, now);
    this.opts.refreshDocuments();
    this.opts.bus.pushActivity({ ts: now, agentKey: 'panel', event: 'Restore', tool: null, state: null, summary: { key: 'hub.act.planRestored', params: { path: doc.path } } });
    return 'ok';
  }

  // A second click on Ejecutar while the first order is still on its way must not send another one.
  async decidePlan(path: string, decision: PlanDecision): Promise<DecideResult> {
    if (this.deciding.has(path)) return 'busy';
    this.deciding.add(path);
    try {
      return await this.decide(path, decision);
    } finally {
      this.deciding.delete(path);
    }
  }

  private async decide(path: string, decision: PlanDecision): Promise<DecideResult> {
    const doc = this.opts.docs.find(path);
    if (!doc || doc.kind !== 'plan') return 'not-found';
    if (!DECISION_FROM[decision].includes(doc.status)) return 'invalid-state';
    if (decision === 'ejecutar') {
      const director = this.opts.book.directorSession();
      if (!director) return 'no-director';
      const text = doc.docType === 'analisis' ? analysisOrderText(doc, this.opts.docsRoot()) : executeOrderText(doc, this.opts.docsRoot());
      const sent = await this.order(director.sessionId, text);
      if (sent === 'not-found' || sent === 'not-office') return 'no-director';
      if (sent !== 'ok') return sent;
      this.opts.allowBriefs(director.sessionId, new Set(doc.base.map((b) => b.floor)).size);
      if (doc.docType !== 'analisis') this.opts.planExecuting({ slug: doc.slug, title: doc.title, floors: doc.base.map((b) => b.floor) });
    }
    const now = this.opts.now();
    this.opts.docs.markDecision({ path: doc.path, kind: doc.kind, slug: doc.slug }, decision, now);
    this.opts.refreshDocuments();
    const summary: HubText =
      decision === 'ejecutar'
        ? { key: doc.docType === 'analisis' ? 'hub.act.planAnalysisSent' : 'hub.act.planExecuting', params: { path: doc.path } }
        : decision === 'aparcar'
          ? { key: 'hub.act.planParked', params: { path: doc.path } }
          : { key: 'hub.act.planClosed', params: { path: doc.path } };
    this.opts.bus.pushActivity({ ts: now, agentKey: 'panel', event: 'Decision', tool: null, state: null, summary });
    return 'ok';
  }

  async syncSources(raw: unknown): Promise<SyncResult> {
    const result = await this.opts.sync.sync(raw);
    if (result.ok) {
      this.opts.bus.pushActivity({
        ts: this.opts.now(),
        agentKey: 'redaccion',
        event: 'Sync',
        tool: null,
        state: null,
        summary: { key: 'hub.act.sourcesReady', params: { slug: result.slug, floors: result.floors.map((f) => f.floor).join(', ') } },
      });
    }
    return result;
  }

  async expireSources(): Promise<string[]> {
    const cutoff = this.opts.now() - this.opts.config().retentionDays * DAY_MS;
    return this.opts.sync.expire(cutoff, (slug) => {
      const doc = this.opts.docs.list().find((d) => d.kind === 'plan' && d.slug === slug);
      return doc?.updatedAt ?? 0;
    });
  }

  private markDiscardedFile(ref: DocRef, now: number): void {
    const file = join(this.opts.docsRoot(), ref.path);
    try {
      const content = readFileSync(file, 'utf8');
      if (!content.startsWith(DISCARDED_MARK)) {
        const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
        writeAtomic(file, `${DISCARDED_MARK} desde el panel de Agent Office el ${stamp}. No se continúa: un encargo nuevo empieza con otro slug.\n\n${content}`, statSync(file).mode & 0o777);
      }
    } catch {
      return;
    }
    this.commitDocumentFile(ref, `redaccion: ${ref.slug} descartado`);
  }

  private restoreFile(ref: DocRef): void {
    const file = join(this.opts.docsRoot(), ref.path);
    try {
      const content = readFileSync(file, 'utf8');
      if (content.startsWith(DISCARDED_MARK)) writeAtomic(file, withoutDiscardMark(content), statSync(file).mode & 0o777);
    } catch {
      return;
    }
    this.commitDocumentFile(ref, `redaccion: ${ref.slug} restaurado`);
  }

  private commitDocumentFile(ref: DocRef, message: string): void {
    const root = this.opts.docsRoot();
    this.opts.bus.background(this.opts.queue.run(root, () => commitDocument(this.opts.git, root, ref.path, message)));
  }

  stop(): void {
    for (const timer of this.removals.values()) clearTimeout(timer);
    this.removals.clear();
  }
}
