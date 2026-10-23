import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { t, type MessageKey, type Params } from '../i18n';
import { readJson, writeJson } from '../prefs';
import type { Store } from '../store';
import type { FinishedView } from '../types';
import { safeExternalUrl } from './markdown-safe';

export type FinishedMode = 'popup' | 'desktop' | 'both';

export const FINISHED_KEY = 'agent-office.finished';
export const FINISHED_MODES: readonly FinishedMode[] = ['popup', 'desktop', 'both'];

export function readFinishedMode(): FinishedMode {
  const stored = readJson(FINISHED_KEY);
  return FINISHED_MODES.includes(stored as FinishedMode) ? (stored as FinishedMode) : 'both';
}

export function writeFinishedMode(mode: FinishedMode): void {
  writeJson(FINISHED_KEY, mode);
}

export const wantsPopup = (mode: FinishedMode): boolean => mode !== 'desktop';
export const wantsDesktop = (mode: FinishedMode): boolean => mode !== 'popup';

// The popups pending, in the order they arrived. A reload rebuilds it from the alerts nobody closed.
export class FinishedQueue {
  private items: FinishedView[] = [];

  rebuild(list: readonly FinishedView[]): void {
    this.items = [...list].sort((a, b) => a.ts - b.ts || a.id - b.id);
  }

  add(view: FinishedView): boolean {
    if (this.items.some((item) => item.id === view.id)) return false;
    this.items.push(view);
    return true;
  }

  current(): FinishedView | null {
    return this.items[0] ?? null;
  }

  // The popup on screen is the n-th of total waiting.
  position(): { n: number; total: number } {
    return { n: this.items.length > 0 ? 1 : 0, total: this.items.length };
  }

  close(): FinishedView | null {
    return this.items.shift() ?? null;
  }

  get size(): number {
    return this.items.length;
  }
}

// What the heading of a popup says: "Encargo terminado", or "Plan terminado de nuevo (ciclo 2)" once reopened.
export function finishedHeading(view: Pick<FinishedView, 'kind' | 'cycle'>): { key: MessageKey; params: Params } {
  const again = view.cycle > 1;
  if (view.kind === 'plan') return { key: again ? 'finished.heading.planAgain' : 'finished.heading.plan', params: { cycle: view.cycle } };
  return { key: again ? 'finished.heading.orderAgain' : 'finished.heading.order', params: { cycle: view.cycle } };
}

// The title of the desktop notification.
export function finishedNotice(view: Pick<FinishedView, 'kind' | 'title'>): { key: MessageKey; params: Params } {
  return { key: view.kind === 'plan' ? 'notify.finished.plan' : 'notify.finished.order', params: { title: view.title } };
}

export type FinishedHandlers = { openBoard: ((view: FinishedView) => void) | null };

// The popup of an order or plan that has finished for good: a modal that does not close by itself, with the
// next ones queued behind it.
export function mountFinished(host: HTMLElement, store: Store, api: OfficeApi | null, handlers: FinishedHandlers): void {
  if (api === null) return;
  const client = api;
  const queue = new FinishedQueue();
  let backdrop: HTMLElement | null = null;
  let shownId: number | null = null;

  const markSeen = (view: FinishedView): void => {
    store.dropFinished(view.id);
    void client.markFinishedSeen(view.id);
  };

  const close = (): void => {
    const view = queue.current();
    if (view) markSeen(view);
  };

  const build = (view: FinishedView): HTMLElement => {
    const heading = finishedHeading(view);
    const { total } = queue.position();
    const checks = view.checks ? el('span', 'checks-badge checks-passed', el('span', 'checks-mark', '✓'), el('span', '', t('finished.checks', { passed: view.checks.passed, total: view.checks.total }))) : null;
    const prUrl = view.prUrl ? safeExternalUrl(view.prUrl) : null;
    const pr = prUrl ? el('a', 'finished-pr', t('finished.pr')) : null;
    if (pr && prUrl) {
      pr.href = prUrl;
      pr.target = '_blank';
      pr.rel = 'noopener noreferrer';
    }
    const board = handlers.openBoard ? button(t('finished.board'), 'primary') : null;
    const dismiss = button(t('finished.close'), board ? '' : 'primary');
    board?.addEventListener('click', () => {
      const current = queue.current();
      if (!current) return;
      markSeen(current);
      handlers.openBoard?.(current);
    });
    dismiss.addEventListener('click', close);
    const dialog = el(
      'div',
      'finished',
      el('header', 'finished-head', el('h3', 'finished-heading', t(heading.key, heading.params)), total > 1 ? el('span', 'chip finished-count', t('finished.counter', { n: 1, total })) : null),
      el('p', 'finished-title', view.title),
      el(
        'div',
        'finished-meta',
        ...view.floors.map((floor) => el('span', 'chip', floor)),
        view.branch ? el('code', 'muted', view.branch) : null,
        checks,
        pr,
      ),
      view.manual ? el('p', 'finished-note', t('finished.manual')) : null,
      view.touched.length > 0 ? el('p', 'finished-note finished-warning', t('finished.touched', { files: view.touched.join(', ') })) : null,
      view.summary ? el('p', 'finished-summary', view.summary) : null,
      el('div', 'finished-actions', dismiss, board),
    );
    const wrapper = el('div', 'dialog-backdrop finished-backdrop', dialog);
    wrapper.setAttribute('role', 'alertdialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-label', t(heading.key, heading.params));
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    queueMicrotask(() => dismiss.focus());
    return wrapper;
  };

  const render = (): void => {
    const view = queue.current();
    if (!view) {
      backdrop?.remove();
      backdrop = null;
      shownId = null;
      return;
    }
    backdrop?.remove();
    backdrop = build(view);
    shownId = view.id;
    host.append(backdrop);
  };

  store.watch(['finished'], () => {
    const mode = readFinishedMode();
    if (!wantsPopup(mode)) {
      // Desktop only: the notification is the notice, so what is waiting is marked seen and nothing is queued.
      for (const view of [...store.finished]) markSeen(view);
      queue.rebuild([]);
      render();
      return;
    }
    queue.rebuild(store.finished);
    if (queue.current()?.id !== shownId) render();
    else if (backdrop) updateCounter(backdrop, queue.position().total);
  });
  store.watch(['lang'], () => {
    if (queue.current()) render();
  });
}

function updateCounter(backdrop: HTMLElement, total: number): void {
  const counter = backdrop.querySelector('.finished-count');
  if (counter) counter.textContent = t('finished.counter', { n: 1, total });
}
