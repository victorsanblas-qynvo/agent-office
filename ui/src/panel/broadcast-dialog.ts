import { BROADCAST_MAX_TEXT, broadcastTextValid } from '../broadcast';
import { button, el } from '../dom';
import { plural, t } from '../i18n';

// The small dialog of "Mensaje a todos los jefes": the text goes as typed, to every lead, through the same route as the orders box.
export function openBroadcastMessage(host: HTMLElement, count: number, onSend: (text: string) => Promise<void>): void {
  const textarea = el('textarea', 'broadcast-text');
  textarea.rows = 5;
  textarea.placeholder = t('broadcast.placeholder');
  textarea.setAttribute('aria-label', t('broadcast.heading'));
  const counter = el('p', 'broadcast-count muted');
  const send = button(t('broadcast.send'), 'primary');
  const cancel = button(t('board.form.cancel'));
  const form = el(
    'form',
    'new-order broadcast',
    el('h3', 'new-order-heading', t('broadcast.heading')),
    el('p', 'muted', plural('broadcast.to', count)),
    textarea,
    counter,
    el('div', 'new-order-actions', cancel, send),
  );
  const backdrop = el('div', 'dialog-backdrop', form);
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', t('broadcast.heading'));

  const close = (): void => backdrop.remove();
  const refresh = (): void => {
    counter.textContent = t('orders.brief.count', { n: textarea.value.length, max: BROADCAST_MAX_TEXT });
    counter.classList.toggle('error', textarea.value.length > BROADCAST_MAX_TEXT);
    send.disabled = !broadcastTextValid(textarea.value);
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (send.disabled) return;
    const text = textarea.value.trim();
    close();
    void onSend(text);
  });
  cancel.addEventListener('click', close);
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  textarea.addEventListener('input', refresh);
  refresh();
  host.append(backdrop);
  textarea.focus();
}
