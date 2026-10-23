import { el } from '../dom';
import { t } from '../i18n';
import { THEME_OPTIONS, theme, type ThemePref } from '../theme';

// Stateless: rebuilt with the rest of the settings form; it reads the preference when built.
export function mountThemeSection(): HTMLElement {
  const mode = el('select', 'setting-mode');
  mode.setAttribute('aria-label', t('settings.theme.label'));
  for (const value of THEME_OPTIONS) mode.append(new Option(t(`settings.theme.${value}`), value));
  mode.value = theme.get();
  mode.addEventListener('change', () => theme.set(mode.value as ThemePref));
  return el(
    'section',
    'settings-section',
    el('h2', 'settings-title', t('settings.theme.title')),
    el(
      'label',
      'setting-row',
      el('span', 'setting-text', el('span', 'setting-label', t('settings.theme.label')), el('span', 'setting-hint muted', t('settings.theme.hint'))),
      mode,
    ),
  );
}
