import type { OfficeApi } from '../api';
import { button } from '../dom';
import { plural, t } from '../i18n';
import { agentName } from '../labels';
import type { Store } from '../store';
import { broadcast, broadcastRunning, leadTargets } from '../broadcast';
import { relaunchAll, relaunchCandidates, relaunchRunning } from '../relaunch-all';
import { duration } from '../time';
import type { AgentView, SessionView } from '../types';
import { openBroadcastMessage } from './broadcast-dialog';
import { orderable, relaunchable, statusAllowed } from './orderable';

export function mainSession(store: Store, agent: AgentView): SessionView | undefined {
  return agent.key === agent.sessionId ? store.sessions.get(agent.sessionId) : undefined;
}

export function canAskStatus(store: Store, agent: AgentView): boolean {
  return statusAllowed(store.sessions.get(agent.sessionId));
}

export function stalledText(since: number, now: number): string {
  return t('floors.stalled', { time: duration(now - since) });
}

export function statusButton(agent: AgentView): HTMLButtonElement {
  const control = button(t('floors.askStatus'), 'session-action', t('floors.askStatusHint'));
  control.dataset.action = 'status';
  control.dataset.session = agent.sessionId;
  return control;
}

export function relaunchButton(session: SessionView): HTMLButtonElement {
  const control = button(t('floors.relaunch'), 'session-action', t(session.canRelaunch ? 'floors.relaunchHint' : 'floors.relaunchBusy'));
  control.dataset.action = 'relaunch';
  control.dataset.session = session.sessionId;
  control.disabled = !session.canRelaunch;
  return control;
}

export type SessionAction = 'status' | 'relaunch';

export async function requestSession(api: OfficeApi | null, store: Store, sessionId: string, action: SessionAction): Promise<void> {
  const agent = store.agents.get(sessionId);
  if (api === null || !agent) return;
  const name = agentName(agent);
  if (action === 'relaunch') {
    const resumes = store.sessions.get(sessionId)?.relaunchResumes ?? false;
    const question = `${t('floors.relaunchConfirm', { name })} ${t(resumes ? 'floors.relaunchResumes' : 'floors.relaunchFresh')}`;
    if (!window.confirm(question)) return;
  }
  const result = await (action === 'relaunch' ? api.relaunch(sessionId) : api.requestStatus(sessionId));
  if (!result.ok) {
    store.toast(result.message, 'error');
    return;
  }
  store.toast(t(action === 'relaunch' ? 'toast.relaunched' : 'toast.statusRequested', { name }), 'ok');
}

export async function runSessionAction(api: OfficeApi | null, store: Store, control: HTMLButtonElement): Promise<void> {
  const sessionId = control.dataset.session;
  if (api === null || sessionId === undefined || !store.agents.has(sessionId)) return;
  control.disabled = true;
  await requestSession(api, store, sessionId, control.dataset.action === 'relaunch' ? 'relaunch' : 'status');
  control.disabled = false;
}

export async function requestRelaunchAll(api: OfficeApi | null, store: Store): Promise<void> {
  const ids = relaunchCandidates(store.sessions.values());
  if (api === null || ids.length === 0 || relaunchRunning()) return;
  if (!window.confirm(plural('floors.relaunchAllConfirm', ids.length))) return;
  const tally = await relaunchAll(
    ids,
    (sessionId) => api.relaunch(sessionId),
    (sessionId) => relaunchable(store.sessions.get(sessionId)),
  );
  if (tally) store.toast(t('toast.relaunchedAll', tally), tally.failed > 0 ? 'error' : 'ok');
}

const lastAsked = new Map<string, number>();

export function broadcastTargets(store: Store, withAsked: boolean): string[] {
  return leadTargets(store.sessions, store.agents.values(), Date.now(), withAsked ? lastAsked : new Map());
}

function reportBroadcast(store: Store, tally: Awaited<ReturnType<typeof broadcast>>): void {
  if (tally) store.toast(t('toast.broadcast', tally), tally.failed > 0 ? 'error' : 'ok');
}

export async function requestStatusAll(api: OfficeApi | null, store: Store): Promise<void> {
  const ids = broadcastTargets(store, true);
  if (api === null || ids.length === 0 || broadcastRunning()) return;
  if (!window.confirm(plural('floors.statusAllConfirm', ids.length))) return;
  const tally = await broadcast(
    ids,
    async (sessionId) => {
      lastAsked.set(sessionId, Date.now());
      return api.requestStatus(sessionId);
    },
    (sessionId) => statusAllowed(store.sessions.get(sessionId)),
  );
  reportBroadcast(store, tally);
}

export function requestMessageAll(api: OfficeApi | null, store: Store): void {
  if (api === null || broadcastRunning() || broadcastTargets(store, false).length === 0) return;
  openBroadcastMessage(document.querySelector<HTMLElement>('.overlay-host') ?? document.body, broadcastTargets(store, false).length, async (text) => {
    const ids = broadcastTargets(store, false);
    reportBroadcast(
      store,
      await broadcast(
        ids,
        (sessionId) => api.order({ sessionId, text }),
        (sessionId) => {
          const session = store.sessions.get(sessionId);
          return session !== undefined && orderable(session);
        },
      ),
    );
  });
}
