import { button, el } from './dom';
import { t } from './i18n';
import { NEEDS_TOPICS, activeNeeds, canSnooze, loadSnoozes, menuStart, menuStep, needLabel, needsOf, pruneSnoozes, saveSnoozes, shouldPruneSnoozes, snoozeNeed, snoozedNeeds, triggerSignature, wakeNeed, type Need } from './needs';
import type { Snoozes } from './prefs';
import type { Store } from './store';
import { relativeTime } from './time';

export type NeedsMenu = {
  root: HTMLElement;
  // Closes the menu if it is open and says whether it was.
  close(): boolean;
};

type Item = { need: Need; node: HTMLButtonElement; age: HTMLElement };

// The button "Te necesitan N" and the menu that lists what waits for the user, most urgent first.
export function mountNeedsMenu(store: Store, onPick: (need: Need) => void): NeedsMenu {
  const count = el('b', 'pending-count');
  const trigger = button('', 'pending');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'needs-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const root = el('div', 'needs', trigger, menu);

  let items: Item[] = [];
  // What the arrows walk: the entries, the toggle of the postponed ones and their wake buttons.
  let stops: HTMLElement[] = [];
  let toggle: HTMLButtonElement | null = null;
  let signature = '';
  let face = '';
  let snoozes: Snoozes = loadSnoozes(store);
  let snoozedOpen = false;

  const SNOOZE_CHOICES: readonly { key: 'needs.snooze.15m' | 'needs.snooze.1h' | 'needs.snooze.change'; minutes: number | null }[] = [
    { key: 'needs.snooze.15m', minutes: 15 },
    { key: 'needs.snooze.1h', minutes: 60 },
    { key: 'needs.snooze.change', minutes: null },
  ];

  const isOpen = (): boolean => !menu.hidden;

  const focusStart = (): void => {
    const start = menuStart(items.length, toggle ? 1 : 0);
    if (start === 'entry') items[0]?.node.focus();
    else if (start === 'snoozed') toggle?.focus();
  };

  const save = (next: Snoozes): void => {
    snoozes = next;
    saveSnoozes(store, snoozes);
    signature = '';
    render();
    if (isOpen()) focusStart();
  };

  const snoozeControl = (need: Need): HTMLElement => {
    const group = el('div', 'needs-snooze');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('needs.snooze'));
    group.title = t('needs.snooze');
    for (const choice of SNOOZE_CHOICES) {
      const option = button(t(choice.key), 'needs-snooze-choice');
      option.addEventListener('click', () => save(snoozeNeed(snoozes, need, choice.minutes === null ? null : store.now() + choice.minutes * 60_000)));
      group.append(option);
    }
    return group;
  };

  const close = (): boolean => {
    if (!isOpen()) return false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus();
    return true;
  };

  const paintAges = (): void => {
    const now = store.now();
    for (const { need, age } of items) age.textContent = relativeTime(need.since, now);
  };

  const open = (): void => {
    if (menuStart(items.length, toggle ? 1 : 0) === null) return;
    paintAges();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    focusStart();
  };

  const render = (): void => {
    const all = needsOf(store);
    const now = store.now();
    snoozes = loadSnoozes(store);
    if (shouldPruneSnoozes(store)) {
      const pruned = pruneSnoozes(snoozes, all, now);
      if (Object.keys(pruned).length !== Object.keys(snoozes).length) {
        snoozes = pruned;
        saveSnoozes(store, snoozes);
      }
    }
    const needs = activeNeeds(all, snoozes, now);
    const later = snoozedNeeds(all, snoozes, now);
    const nextFace = triggerSignature(store.lang, needs.length, all.length);
    if (nextFace !== face) {
      face = nextFace;
      count.textContent = String(needs.length);
      trigger.disabled = all.length === 0;
      trigger.classList.toggle('has-pending', needs.length > 0);
      trigger.replaceChildren(t('needs.button'), ' ', count);
      trigger.title = t('needs.title');
      menu.setAttribute('aria-label', t('needs.title'));
    }
    const next = JSON.stringify([store.lang, snoozedOpen, needs.map((need) => [need.id, need.kind, need.instance, need.name]), later.map((need) => [need.id, need.kind, need.instance, need.name])]);
    if (all.length === 0 && isOpen()) close();
    if (next === signature) return;
    signature = next;
    items = needs.map((need) => {
      const age = el('time', 'needs-age muted');
      const node = button('', `needs-item needs-${need.kind}`);
      node.setAttribute('role', 'menuitem');
      node.append(el('span', 'needs-label', needLabel(need)), age);
      node.addEventListener('click', () => {
        close();
        onPick(need);
      });
      return { need, node, age };
    });
    stops = items.map((item) => item.node);
    toggle = null;
    const rows = items.map((item) => (canSnooze(item.need) ? el('div', 'needs-row', item.node, snoozeControl(item.need)) : item.node));
    if (later.length > 0) {
      const shown = button(t('needs.snoozed', { n: later.length }), 'needs-snoozed-toggle muted');
      shown.setAttribute('aria-expanded', String(snoozedOpen));
      shown.addEventListener('click', () => {
        snoozedOpen = !snoozedOpen;
        signature = '';
        render();
        toggle?.focus();
      });
      toggle = shown;
      stops.push(shown);
      rows.push(shown);
      if (snoozedOpen) {
        for (const need of later) {
          const wake = button(t('needs.wake'), 'needs-wake');
          wake.addEventListener('click', () => save(wakeNeed(snoozes, need.id)));
          stops.push(wake);
          rows.push(el('div', `needs-row needs-asleep needs-${need.kind}`, el('span', 'needs-label', needLabel(need)), wake));
        }
      }
    }
    menu.replaceChildren(...rows);
    paintAges();
  };

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const at = stops.findIndex((stop) => stop === document.activeElement);
    const next = menuStep(at, event.key === 'ArrowDown' ? 1 : -1, stops.length);
    if (next === null) return;
    event.preventDefault();
    stops[next]?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && event.target instanceof Node && !root.contains(event.target)) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

  store.watch(NEEDS_TOPICS, render);
  store.watch(['tick'], () => {
    if (isOpen()) paintAges();
  });

  return { root, close };
}
