import { button, el } from './dom';
import { t } from './i18n';
import { floorLabel } from './labels';
import type { Store } from './store';

// "Enfocado: <planta> ×" in the header while the panel is narrowed to one floor; a click lifts the focus.
export function mountFocusPill(store: Store, onClear: (floor: null) => void): HTMLElement {
  const root = el('div', 'focus-pill');
  const name = el('span', 'focus-pill-name');
  const clear = button('\u00d7', 'focus-pill-clear');
  root.append(name, clear);
  clear.addEventListener('click', () => onClear(null));

  store.watch(['focus', 'floors', 'agents', 'lang'], () => {
    const slug = store.focusedFloor();
    root.hidden = slug === null;
    if (slug === null) return;
    const floor = store.floorBySlug(slug);
    name.textContent = t('focus.pill', { name: floor ? floorLabel(floor) : slug });
    clear.title = t('focus.clear');
    clear.setAttribute('aria-label', t('focus.clear'));
  });
  return root;
}
