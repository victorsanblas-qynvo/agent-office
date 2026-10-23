import { el } from '../dom';
import { t } from '../i18n';
import { buildEntries, searchEntries, type PaletteContext, type PaletteEntry, type PaletteResult } from './entries';

export type PaletteDeps = {
  context(): PaletteContext;
  run(entry: PaletteEntry): void;
};

export type Palette = {
  open(): void;
  // Closes the palette if it is open and says whether it was.
  close(): boolean;
  isOpen(): boolean;
};

function highlighted(label: string, indices: readonly number[]): (Node | string)[] {
  if (indices.length === 0) return [label];
  const marked = new Set(indices);
  const nodes: (Node | string)[] = [];
  let plain = '';
  for (let index = 0; index < label.length; index += 1) {
    if (!marked.has(index)) {
      plain += label[index];
      continue;
    }
    if (plain !== '') nodes.push(plain);
    plain = '';
    nodes.push(el('mark', 'palette-mark', label[index]));
  }
  if (plain !== '') nodes.push(plain);
  return nodes;
}

// The command palette: one input over every agent, floor, tab, plan and action, filtered by subsequence.
export function mountPalette(host: HTMLElement, deps: PaletteDeps): Palette {
  let backdrop: HTMLElement | null = null;
  let previous: Element | null = null;

  const open = (): void => {
    if (backdrop) {
      backdrop.querySelector('input')?.focus();
      return;
    }
    previous = document.activeElement;
    const context = deps.context();
    const entries = buildEntries(context);
    const input = el('input', 'palette-input');
    input.type = 'text';
    input.placeholder = t('palette.placeholder');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', t('palette.title'));
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'palette-list');
    const list = el('ul', 'palette-list');
    list.id = 'palette-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('palette.title'));
    const box = el('div', 'palette', input, list);
    const wrapper = el('div', 'dialog-backdrop palette-backdrop', box);
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-label', t('palette.title'));

    let results: PaletteResult[] = [];
    let active = 0;
    const rows: HTMLElement[] = [];

    const mark = (): void => {
      rows.forEach((row, index) => {
        row.setAttribute('aria-selected', String(index === active));
        row.classList.toggle('active', index === active);
      });
      const current = rows[active];
      if (current) {
        input.setAttribute('aria-activedescendant', current.id);
        current.scrollIntoView?.({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    };

    const run = (entry: PaletteEntry): void => {
      closePalette();
      deps.run(entry);
    };

    const heading = (): HTMLElement => {
      const item = el('li', 'palette-heading muted', t('palette.recent'));
      item.setAttribute('role', 'presentation');
      return item;
    };

    const paint = (): void => {
      results = searchEntries(entries, input.value, context.recent);
      active = 0;
      rows.length = 0;
      if (results.length === 0) {
        list.replaceChildren(el('li', 'palette-empty muted', t('palette.empty')));
        mark();
        return;
      }
      const children: HTMLElement[] = [];
      results.forEach(({ entry, indices, recent }, index) => {
        const row = el(
          'li',
          'palette-row',
          el('span', 'palette-label', ...highlighted(entry.label, indices)),
          el('span', 'palette-hint muted', entry.hint),
          el('span', 'chip palette-group', t(`palette.group.${entry.group}`)),
        );
        row.id = `palette-option-${index}`;
        row.setAttribute('role', 'option');
        row.addEventListener('pointermove', () => {
          if (active === index) return;
          active = index;
          mark();
        });
        row.addEventListener('click', () => run(entry));
        rows.push(row);
        if (index === 0 && recent) children.push(heading());
        children.push(row);
      });
      list.replaceChildren(...children);
      mark();
    };

    input.addEventListener('input', paint);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (rows.length === 0) return;
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        mark();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = results[active];
        if (chosen) run(chosen.entry);
      } else if (event.key === 'Tab') {
        event.preventDefault();
      }
    });
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper) closePalette();
    });

    backdrop = wrapper;
    host.append(wrapper);
    paint();
    input.focus();
  };

  const closePalette = (): boolean => {
    if (!backdrop) return false;
    backdrop.remove();
    backdrop = null;
    if (previous instanceof HTMLElement) previous.focus();
    previous = null;
    return true;
  };

  return { open, close: closePalette, isOpen: () => backdrop !== null };
}
