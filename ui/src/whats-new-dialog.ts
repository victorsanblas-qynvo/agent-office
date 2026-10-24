import { el } from './dom';
import { t } from './i18n';
import { WHATS_NEW, markWhatsNewSeen } from './whats-new';

export type WhatsNewDialog = {
  open(): void;
  // Closes the dialog if it is open and says whether it was.
  close(): boolean;
  isOpen(): boolean;
};

// The dialog with what the panel gained lately; opening it, by itself or not, marks the version as seen.
export function mountWhatsNew(host: HTMLElement): WhatsNewDialog {
  let backdrop: HTMLElement | null = null;
  let previous: Element | null = null;

  const build = (): HTMLElement => {
    const sections = WHATS_NEW.map((section) => el('section', 'whats-new-section', el('h4', 'whats-new-heading', t(section.title)), el('ul', 'whats-new-items', ...section.items.map((key) => el('li', '', t(key))))));
    const close = el('button', 'primary', t('whatsNew.close'));
    close.type = 'button';
    close.addEventListener('click', () => api.close());
    const body = el('div', 'whats-new-body', ...sections);
    body.tabIndex = 0;
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', t('whatsNew.title'));
    const dialog = el('div', 'help whats-new', el('h3', 'help-heading', t('whatsNew.title')), el('p', 'muted', t('whatsNew.intro')), body, el('div', 'help-actions', close));
    const wrapper = el('div', 'dialog-backdrop help-backdrop', dialog);
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-label', t('whatsNew.title'));
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper) api.close();
    });
    wrapper.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      (document.activeElement === close ? body : close).focus();
    });
    queueMicrotask(() => close.focus());
    return wrapper;
  };

  const api: WhatsNewDialog = {
    isOpen: () => backdrop !== null,
    close() {
      if (!backdrop) return false;
      backdrop.remove();
      backdrop = null;
      if (previous instanceof HTMLElement) previous.focus();
      previous = null;
      return true;
    },
    open() {
      if (backdrop) return;
      previous = document.activeElement;
      markWhatsNewSeen();
      backdrop = build();
      host.append(backdrop);
    },
  };
  return api;
}
