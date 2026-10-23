import { button, el } from '../dom';
import { fileStamp, saveFile } from '../download';
import { t } from '../i18n';
import { applyImport, exportPrefs, overwrittenKeys, planImport } from './prefs-transfer';

function shortKey(key: string): string {
  return key.replace(/^agent-office\./, '');
}

// Stateless apart from its own status line: the choices live in this browser's localStorage, and an import reloads the page to read them again.
export function mountPrefsTransferSection(): HTMLElement {
  const status = el('span', 'settings-status');
  const exportButton = button(t('settings.prefs.export'));
  const importButton = button(t('settings.prefs.import'));
  const input = el('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.hidden = true;

  const show = (text: string, kind: '' | 'ok' | 'error'): void => {
    status.textContent = text;
    status.className = kind ? `settings-status ${kind}` : 'settings-status';
  };

  exportButton.addEventListener('click', () => {
    const now = new Date();
    saveFile(`agent-office-prefs-${fileStamp(now)}.json`, `${exportPrefs(localStorage, now)}\n`, 'application/json');
  });
  importButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void file.text().then((text) => {
      const plan = planImport(text, localStorage);
      const error = plan.errors[0];
      if (error) return show(t(`settings.prefs.error.${error}`), 'error');
      if (plan.apply.length === 0) return show(t('settings.prefs.nothing'), 'error');
      const over = overwrittenKeys(plan);
      const message = over.length > 0 ? t('settings.prefs.confirmOverwrite', { count: String(plan.apply.length), keys: over.map(shortKey).join(', ') }) : t('settings.prefs.confirm', { count: String(plan.apply.length) });
      if (!confirm(message)) return show('', '');
      applyImport(plan, localStorage);
      location.reload();
    });
  });

  return el(
    'section',
    'settings-section',
    el('h2', 'settings-title', t('settings.prefs.title')),
    el('p', 'settings-hint muted', t('settings.prefs.hint')),
    el('div', 'layout-actions', exportButton, importButton, input, status),
  );
}
