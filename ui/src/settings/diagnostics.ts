import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import type { DiagnosticsView } from '../types';
import { bytesText, diagnosticsMarkdown, msText, uptimeText } from './diagnostics-model';

const decimal = (value: number): string => new Intl.NumberFormat(currentLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const whole = (value: number): string => new Intl.NumberFormat(currentLang(), { maximumFractionDigits: 1 }).format(value);

// What the hub reports about itself: loaded on demand, never pushed.
export function mountDiagnosticsPanel(host: HTMLElement, api: OfficeApi): void {
  const title = el('h2', 'settings-title');
  const hint = el('p', 'settings-hint muted');
  const reload = button('');
  const copy = button('');
  const status = el('p', 'settings-status');
  const facts = el('div', 'diagnostics-facts');
  const log = el('pre', 'diagnostics-log');
  const section = el('section', 'settings-section diagnostics', title, hint, el('div', 'worktrees-head', status, copy, reload), facts, log);
  host.append(section);

  let view: DiagnosticsView | null = null;
  let error: string | null = null;
  let busy = false;
  let seq = 0;

  const load = async (): Promise<void> => {
    const ticket = ++seq;
    busy = true;
    paint();
    const result = await api.diagnostics();
    if (ticket !== seq) return;
    busy = false;
    if (result.ok) {
      view = result.data;
      error = null;
    } else error = result.message;
    paint();
  };

  const row = (label: string, value: string): HTMLElement => el('div', 'setting-row', el('span', 'setting-text', el('span', 'setting-label', label)), el('code', 'setting-path', value));

  function paint(): void {
    title.textContent = t('settings.diagnostics.title');
    hint.textContent = t('settings.diagnostics.hint');
    reload.textContent = t('settings.diagnostics.reload');
    reload.disabled = busy;
    copy.textContent = t('settings.diagnostics.copy');
    copy.disabled = view === null;
    status.textContent = error ?? (view === null ? t('board.loading') : '');
    status.className = error ? 'settings-status error' : 'settings-status';
    if (view === null) {
      facts.replaceChildren();
      log.textContent = '';
      return;
    }
    const d = view;
    facts.replaceChildren(
      row(t('settings.diagnostics.version'), d.version ?? '—'),
      row(t('settings.diagnostics.schema'), String(d.schema)),
      row(t('settings.diagnostics.uptime'), uptimeText(d.uptimeMs)),
      row(t('settings.diagnostics.db'), bytesText(d.dbBytes, whole)),
      row(t('settings.diagnostics.fts'), t(d.fts ? 'settings.diagnostics.on' : 'settings.diagnostics.off')),
      row(t('settings.diagnostics.hookCount'), String(d.hook.count)),
      row(t('settings.diagnostics.hookLatency'), `p50 ${msText(d.hook.p50, decimal)} · p95 ${msText(d.hook.p95, decimal)} · p99 ${msText(d.hook.p99, decimal)}`),
      row(t('settings.diagnostics.checks'), String(d.activeCheckRuns)),
      row(t('settings.diagnostics.worktrees'), String(d.worktrees)),
      row(t('settings.diagnostics.sessions'), String(d.sessions)),
    );
    log.textContent = d.logTail.length > 0 ? d.logTail.join('\n') : t('settings.diagnostics.logEmpty');
  }

  reload.addEventListener('click', () => void load());
  copy.addEventListener('click', () => {
    if (view === null) return;
    void navigator.clipboard
      .writeText(diagnosticsMarkdown(view, { userAgent: navigator.userAgent, lang: currentLang() }))
      .then(() => {
        copy.textContent = t('settings.diagnostics.copied');
        window.setTimeout(paint, 1500);
      })
      .catch(() => {
        copy.textContent = t('settings.diagnostics.copyFailed');
        window.setTimeout(paint, 1500);
      });
  });
  paint();
  void load();
}
