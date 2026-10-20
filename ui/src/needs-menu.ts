import { button, el } from './dom';
import { t } from './i18n';
import { needLabel, needsOf, type Need } from './needs';
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
    const needs = needsOf(store);
    count.textContent = String(needs.length);
    trigger.disabled = needs.length === 0;
    trigger.classList.toggle('has-pending', needs.length > 0);
    trigger.replaceChildren(t('needs.button'), ' ', count);
    trigger.title = t('needs.title');
    menu.setAttribute('aria-label', t('needs.title'));
    const next = JSON.stringify([store.lang, needs.map((need) => [need.id, need.kind, need.name])]);
    if (needs.length === 0 && isOpen()) close();
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
    menu.replaceChildren(...items.map((item) => item.node));
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

  store.watch(['agents', 'questions', 'documents', 'orders', 'lang'], render);
  store.watch(['tick'], () => {
    if (isOpen()) paintAges();
  });

  return { root, close };
}
