import { el } from './dom';
import { BINDINGS, displayCombo } from './keys';
import { t } from './i18n';

export type HelpOverlay = {
  toggle(): void;
  // Closes the overlay if it is open and says whether it was.
  close(): boolean;
  isOpen(): boolean;
};

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);
}

// The shortcuts overlay, written from the same table the key listener reads.
export function mountHelp(host: HTMLElement): HelpOverlay {
  let backdrop: HTMLElement | null = null;
  let previous: Element | null = null;

  const build = (): HTMLElement => {
    const mac = isMac();
    const rows = BINDINGS.filter((binding) => binding.hidden !== true).map((binding) => el('li', 'help-row', el('kbd', 'help-keys', displayCombo(binding.combo, mac)), el('span', 'help-label', binding.label())));
    const close = el('button', 'primary', t('keys.close'));
    close.type = 'button';
    close.addEventListener('click', () => api.close());
    const dialog = el('div', 'help', el('h3', 'help-heading', t('keys.title')), el('ul', 'help-rows', ...rows), el('p', 'help-note muted', t('keys.note')), el('div', 'help-actions', close));
    const wrapper = el('div', 'dialog-backdrop help-backdrop', dialog);
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-label', t('keys.title'));
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper) api.close();
    });
    wrapper.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      close.focus();
    });
    queueMicrotask(() => close.focus());
    return wrapper;
  };

  const api: HelpOverlay = {
    isOpen: () => backdrop !== null,
    close() {
      if (!backdrop) return false;
      backdrop.remove();
      backdrop = null;
      if (previous instanceof HTMLElement) previous.focus();
      previous = null;
      return true;
    },
    toggle() {
      if (backdrop) {
        api.close();
        return;
      }
      previous = document.activeElement;
      backdrop = build();
      host.append(backdrop);
    },
  };
  return api;
}
