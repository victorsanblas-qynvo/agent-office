import { el } from '../dom';
import { t } from '../i18n';
import { MOTION_OPTIONS, motion, type MotionPref } from '../motion';

// Stateless: rebuilt with the rest of the settings form; it reads the preference when built.
export function mountMotionSection(): HTMLElement {
  const mode = el('select', 'setting-mode');
  mode.setAttribute('aria-label', t('settings.motion.label'));
  for (const value of MOTION_OPTIONS) mode.append(new Option(t(`settings.motion.${value}`), value));
  mode.value = motion.get();
  mode.addEventListener('change', () => motion.set(mode.value as MotionPref));
  return el(
    'section',
    'settings-section',
    el('h2', 'settings-title', t('settings.motion.title')),
    el(
      'label',
      'setting-row',
      el('span', 'setting-text', el('span', 'setting-label', t('settings.motion.label')), el('span', 'setting-hint muted', t('settings.motion.hint'))),
      mode,
    ),
  );
}
