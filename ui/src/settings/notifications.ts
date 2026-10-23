import { button, el } from '../dom';
import { t, type MessageKey } from '../i18n';
import { NOTIFY_EVENTS, notificationsSupported, type Notifier } from '../notify';
import { FINISHED_MODES, readFinishedMode, writeFinishedMode, type FinishedMode } from '../panel/finished';
import { BOARD_STALE_OPTIONS, HUNG_OPTIONS, inQuietHours, isClock, readBoardStaleHours, readHungMinutes, readQuietHours, writeBoardStaleHours, writeHungMinutes, writeQuietHours } from '../prefs';
import { toggleRow } from './settings';

const HOLD_EVENTS: ReadonlySet<string> = new Set(['permission', 'question']);

function permissionHint(): MessageKey {
  if (!notificationsSupported()) return 'settings.notifications.unsupported';
  if (Notification.permission === 'denied') return 'settings.notifications.denied';
  if (Notification.permission === 'granted') return 'settings.notifications.granted';
  return 'settings.notifications.ask';
}

// Stateless: rebuilt with the rest of the settings form; it reads the notifier and the browser permission when built.
export function mountNotifySection(notifier: Notifier): HTMLElement {
  const general = toggleRow(t('settings.notifications.enable'), t(permissionHint()));
  const generalHint = general.root.querySelector('.switch-hint');
  const test = button(t('settings.notifications.test'));
  test.addEventListener('click', () => notifier.test());

  const finishedMode = el('select', 'setting-mode');
  finishedMode.setAttribute('aria-label', t('settings.notifications.finished.label'));
  for (const mode of FINISHED_MODES) finishedMode.append(new Option(t(`settings.notifications.finished.${mode}`), mode));
  finishedMode.value = readFinishedMode();
  finishedMode.addEventListener('change', () => writeFinishedMode(finishedMode.value as FinishedMode));
  const finishedRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.notifications.finished.label')), el('span', 'setting-hint muted', t('settings.notifications.finished.hint'))),
    finishedMode,
  );

  const hungAfter = el('select', 'setting-mode');
  hungAfter.setAttribute('aria-label', t('settings.notifications.hung.label'));
  for (const minutes of HUNG_OPTIONS) hungAfter.append(new Option(minutes === 0 ? t('settings.notifications.hung.off') : t('settings.notifications.hung.minutes', { n: minutes }), String(minutes)));
  hungAfter.value = String(readHungMinutes());
  hungAfter.addEventListener('change', () => writeHungMinutes(Number(hungAfter.value)));
  const hungRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.notifications.hung.label')), el('span', 'setting-hint muted', t('settings.notifications.hung.hint'))),
    hungAfter,
  );

  const staleAfter = el('select', 'setting-mode');
  staleAfter.setAttribute('aria-label', t('settings.board.stale.label'));
  for (const hours of BOARD_STALE_OPTIONS) staleAfter.append(new Option(hours === 0 ? t('settings.board.stale.off') : t('settings.board.stale.hours', { n: hours }), String(hours)));
  staleAfter.value = String(readBoardStaleHours());
  staleAfter.addEventListener('change', () => writeBoardStaleHours(Number(staleAfter.value)));
  const staleRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.board.stale.label')), el('span', 'setting-hint muted', t('settings.board.stale.hint'))),
    staleAfter,
  );

  const quiet = readQuietHours();
  const quietOn = toggleRow(t('settings.notifications.quiet.enable'), '');
  const quietNow = quietOn.root.querySelector('.switch-hint');
  quietOn.input.checked = quiet.enabled;
  const clockInput = (label: string, value: string): HTMLInputElement => {
    const input = el('input', 'setting-number');
    input.type = 'time';
    input.value = value;
    input.setAttribute('aria-label', label);
    return input;
  };
  const quietFrom = clockInput(t('settings.notifications.quiet.from'), quiet.from);
  const quietTo = clockInput(t('settings.notifications.quiet.to'), quiet.to);
  const quietPermissions = toggleRow(t('settings.notifications.quiet.permissions'), t('settings.notifications.quiet.permissionsHint'));
  quietPermissions.input.checked = quiet.allowPermissions;
  const syncQuiet = (): void => {
    quietFrom.disabled = !quietOn.input.checked;
    quietTo.disabled = !quietOn.input.checked;
    quietPermissions.input.disabled = !quietOn.input.checked;
    if (quietNow) quietNow.textContent = inQuietHours(readQuietHours(), new Date()) ? t('settings.notifications.quiet.now') : '';
  };
  const saveQuiet = (): void => {
    const current = readQuietHours();
    writeQuietHours({
      enabled: quietOn.input.checked,
      from: isClock(quietFrom.value) ? quietFrom.value : current.from,
      to: isClock(quietTo.value) ? quietTo.value : current.to,
      allowPermissions: quietPermissions.input.checked,
    });
    syncQuiet();
  };
  for (const control of [quietOn.input, quietFrom, quietTo, quietPermissions.input]) control.addEventListener('change', saveQuiet);
  syncQuiet();
  const quietRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.notifications.quiet.range'))),
    el('span', 'setting-range-pair', quietFrom, quietTo),
  );

  const events = NOTIFY_EVENTS.map((event) => {
    const row = toggleRow(t(`settings.notifications.event.${event}`), HOLD_EVENTS.has(event) ? t('settings.notifications.holdHint') : '');
    row.input.checked = notifier.preferences.events[event];
    row.input.addEventListener('change', () => {
      const prefs = notifier.preferences;
      prefs.events[event] = row.input.checked;
      notifier.save(prefs);
    });
    return row;
  });

  const sync = (): void => {
    const supported = notificationsSupported();
    const on = notifier.preferences.enabled && supported && Notification.permission === 'granted';
    general.input.checked = on;
    general.input.disabled = !supported;
    if (generalHint) generalHint.textContent = t(permissionHint());
    for (const row of events) row.input.disabled = !on;
    test.disabled = !on;
  };

  general.input.addEventListener('change', () => {
    void (async () => {
      let enabled = general.input.checked;
      // The permission prompt must come from this click.
      if (enabled && notificationsSupported() && Notification.permission === 'default') {
        enabled = (await Notification.requestPermission()) === 'granted';
      }
      if (enabled && (!notificationsSupported() || Notification.permission !== 'granted')) enabled = false;
      const prefs = notifier.preferences;
      prefs.enabled = enabled;
      notifier.save(prefs);
      sync();
    })();
  });

  sync();
  return el(
    'section',
    'settings-section',
    el('h2', 'settings-title', t('settings.notifications.title')),
    el('p', 'settings-hint muted', t('settings.notifications.hint')),
    general.root,
    finishedRow,
    hungRow,
    staleRow,
    quietOn.root,
    quietRow,
    quietPermissions.root,
    el('div', 'notify-events', ...events.map((row) => row.root)),
    el('div', 'notify-actions', test),
  );
}
