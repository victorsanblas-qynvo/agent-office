import { button, el } from './dom';
import { t } from './i18n';
import { NEEDS_TOPICS, activeNeeds, canSnooze, needLabel, needsOf, pruneSnoozes, snoozeNeed, snoozedNeeds, wakeNeed, type Need } from './needs';
import { readSnoozes, writeSnoozes, type Snoozes } from './prefs';
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
  let signature = '';
  let snoozes: Snoozes = readSnoozes();
  let snoozedOpen = false;

  const SNOOZE_CHOICES: readonly { key: 'needs.snooze.15m' | 'needs.snooze.1h' | 'needs.snooze.change'; minutes: number | null }[] = [
    { key: 'needs.snooze.15m', minutes: 15 },
    { key: 'needs.snooze.1h', minutes: 60 },
    { key: 'needs.snooze.change', minutes: null },
  ];

  const save = (next: Snoozes): void => {
    snoozes = next;
    writeSnoozes(snoozes);
    signature = '';
    render();
  };

  const snoozeControl = (need: Need): HTMLSelectElement => {
    const select = el('select', 'needs-snooze');
    select.title = t('needs.snooze');
    select.setAttribute('aria-label', t('needs.snooze'));
    const head = el('option', '', t('needs.snooze'));
    head.value = '';
    select.append(head, ...SNOOZE_CHOICES.map((choice) => Object.assign(el('option', '', t(choice.key)), { value: String(choice.minutes) })));
    select.addEventListener('change', () => {
      if (select.value === '') return;
      const minutes = select.value === 'null' ? null : Number(select.value);
      save(snoozeNeed(snoozes, need, minutes === null ? null : store.now() + minutes * 60_000));
    });
    return select;
  };

  const isOpen = (): boolean => !menu.hidden;

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
    if (items.length === 0) return;
    paintAges();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    items[0]?.node.focus();
  };

  const render = (): void => {
    const all = needsOf(store);
    const now = store.now();
    if (all.length > 0) {
      const pruned = pruneSnoozes(snoozes, all, now);
      if (Object.keys(pruned).length !== Object.keys(snoozes).length) {
        snoozes = pruned;
        writeSnoozes(snoozes);
      }
    }
    const needs = activeNeeds(all, snoozes, now);
    const later = snoozedNeeds(all, snoozes, now);
    count.textContent = String(needs.length);
    trigger.disabled = all.length === 0;
    trigger.classList.toggle('has-pending', needs.length > 0);
    trigger.replaceChildren(t('needs.button'), ' ', count);
    trigger.title = t('needs.title');
    menu.setAttribute('aria-label', t('needs.title'));
    const next = JSON.stringify([store.lang, snoozedOpen, needs.map((need) => [need.id, need.kind, need.name]), later.map((need) => [need.id, need.kind, need.name])]);
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
    const rows = items.map((item) => (canSnooze(item.need) ? el('div', 'needs-row', item.node, snoozeControl(item.need)) : item.node));
    if (later.length > 0) {
      const toggle = button(t('needs.snoozed', { n: later.length }), 'needs-snoozed-toggle muted');
      toggle.setAttribute('aria-expanded', String(snoozedOpen));
      toggle.addEventListener('click', () => {
        snoozedOpen = !snoozedOpen;
        signature = '';
        render();
      });
      rows.push(toggle);
      if (snoozedOpen) {
        for (const need of later) {
          const wake = button(t('needs.wake'), 'needs-wake');
          wake.addEventListener('click', () => save(wakeNeed(snoozes, need.id)));
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
    event.preventDefault();
    const at = items.findIndex((item) => item.node === document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.node.focus();
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
