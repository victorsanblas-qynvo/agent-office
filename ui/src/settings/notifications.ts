import { formatTokenShorthand, parseTokenShorthand, readFloorBudgets, writeFloorBudgets } from '../budgets';
import { button, el } from '../dom';
import { t, type MessageKey } from '../i18n';
import { NOTIFY_EVENTS, notificationsSupported, type Notifier } from '../notify';
import { FINISHED_MODES, readFinishedMode, writeFinishedMode, type FinishedMode } from '../panel/finished';
import { floorLabel } from '../labels';
import { BOARD_STALE_OPTIONS, EDITOR_OPTIONS, CONTEXT_WARN_OPTIONS, HUNG_OPTIONS, REMIND_OPTIONS, inQuietHours, isClock, readBoardStaleHours, readEditor, writeEditor, readContextWarn, readHungMinutes, readMutedFloors, readQuietHours, readRemindMinutes, writeBoardStaleHours, writeContextWarn, writeHungMinutes, writeMutedFloors, writeQuietHours, writeRemindMinutes } from '../prefs';
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

  const contextWarn = el('select', 'setting-mode');
  contextWarn.setAttribute('aria-label', t('settings.notifications.context.label'));
  for (const pct of CONTEXT_WARN_OPTIONS) contextWarn.append(new Option(pct === 0 ? t('settings.notifications.context.off') : t('settings.notifications.context.pct', { n: pct }), String(pct)));
  contextWarn.value = String(readContextWarn());
  contextWarn.addEventListener('change', () => writeContextWarn(Number(contextWarn.value)));
  const contextRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.notifications.context.label')), el('span', 'setting-hint muted', t('settings.notifications.context.hint'))),
    contextWarn,
  );

  const remindAfter = el('select', 'setting-mode');
  remindAfter.setAttribute('aria-label', t('settings.notifications.remind.label'));
  for (const minutes of REMIND_OPTIONS) remindAfter.append(new Option(minutes === 0 ? t('settings.notifications.remind.off') : t('settings.notifications.hung.minutes', { n: minutes }), String(minutes)));
  remindAfter.value = String(readRemindMinutes());
  remindAfter.addEventListener('change', () => writeRemindMinutes(Number(remindAfter.value)));
  const remindRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.notifications.remind.label')), el('span', 'setting-hint muted', t('settings.notifications.remind.hint'))),
    remindAfter,
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

  const editorSelect = el('select', 'setting-mode');
  editorSelect.setAttribute('aria-label', t('settings.board.editor.label'));
  for (const editor of EDITOR_OPTIONS) editorSelect.append(new Option(t(`settings.board.editor.${editor}`), editor));
  editorSelect.value = readEditor();
  editorSelect.addEventListener('change', () => {
    const chosen = EDITOR_OPTIONS.find((editor) => editor === editorSelect.value);
    if (chosen) writeEditor(chosen);
  });
  const editorRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.board.editor.label')), el('span', 'setting-hint muted', t('settings.board.editor.hint'))),
    editorSelect,
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
  const quietClock = setInterval(() => {
    if (quietOn.root.isConnected) syncQuiet();
    else clearInterval(quietClock);
  }, 60_000);
  const quietRow = el(
    'label',
    'setting-row',
    el('span', 'setting-text', el('span', 'setting-label', t('settings.notifications.quiet.range'))),
    el('span', 'setting-range-pair', quietFrom, quietTo),
  );

  const muteRows = notifier.floors.map((floor) => {
    const row = toggleRow(floorLabel(floor), '');
    row.input.checked = readMutedFloors().includes(floor.slug);
    row.input.addEventListener('change', () => {
      const rest = readMutedFloors().filter((slug) => slug !== floor.slug);
      writeMutedFloors(row.input.checked ? [...rest, floor.slug] : rest);
    });
    return row.root;
  });
  const muteBlock = el(
    'div',
    'notify-mute',
    el('p', 'setting-label', t('settings.notifications.mute.title')),
    el('p', 'settings-hint muted', t('settings.notifications.mute.hint')),
    ...(muteRows.length > 0 ? muteRows : [el('p', 'settings-hint muted', t('settings.notifications.mute.none'))]),
  );

  const budgetRows = notifier.floors
    .filter((floor) => floor.kind === 'managed')
    .map((floor) => {
      const input = el('input', 'setting-number');
      input.type = 'text';
      input.placeholder = t('settings.budgets.placeholder');
      input.setAttribute('aria-label', t('settings.budgets.label', { floor: floorLabel(floor) }));
      const stored = readFloorBudgets()[floor.slug];
      input.value = stored === undefined ? '' : formatTokenShorthand(stored);
      input.addEventListener('change', () => {
        const { [floor.slug]: _old, ...rest } = readFloorBudgets();
        const parsed = parseTokenShorthand(input.value);
        const empty = input.value.trim() === '';
        input.setAttribute('aria-invalid', String(!empty && parsed === null));
        if (!empty && parsed === null) return;
        writeFloorBudgets(parsed === null ? rest : { ...rest, [floor.slug]: parsed });
        input.value = parsed === null ? '' : formatTokenShorthand(parsed);
      });
      return el('label', 'setting-row', el('span', 'setting-text', el('span', 'setting-label', floorLabel(floor))), input);
    });
  const budgetBlock = el(
    'div',
    'notify-mute',
    el('p', 'setting-label', t('settings.budgets.title')),
    el('p', 'settings-hint muted', t('settings.budgets.hint')),
    ...(budgetRows.length > 0 ? budgetRows : [el('p', 'settings-hint muted', t('settings.notifications.mute.none'))]),
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
    contextRow,
    remindRow,
    staleRow,
    editorRow,
    quietOn.root,
    quietRow,
    quietPermissions.root,
    el('div', 'notify-events', ...events.map((row) => row.root)),
    muteBlock,
    budgetBlock,
    el('div', 'notify-actions', test),
  );
}
