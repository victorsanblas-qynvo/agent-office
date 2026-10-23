import { REVIEW_MAX_SUMMARY } from '../../../shared/review-message';
import { button, el } from '../dom';
import { t } from '../i18n';
import { reviewPreview, targetLabel, type ReviewDraft } from './review-model';

export type ReviewDialogOpts = {
  slug: string;
  drafts: () => readonly ReviewDraft[];
  remove: (id: number) => void;
  // True once the hub took the review: the dialog closes.
  send: (summary: string) => Promise<boolean>;
};

// The drafts of a review before they go to the lead: an optional summary, the list (each one removable) and the
// message as the lead will read it.
export function openReviewDialog(host: HTMLElement, opts: ReviewDialogOpts): void {
  const summary = el('textarea', 'pr-draft-text');
  summary.rows = 3;
  summary.maxLength = REVIEW_MAX_SUMMARY;
  summary.id = 'review-summary';
  const summaryLabel = el('label', 'new-order-field', t('board.review.summary'), summary);
  summaryLabel.htmlFor = summary.id;
  const list = el('ul', 'review-drafts');
  const preview = el('pre', 'review-preview');
  const cancel = button(t('board.review.cancel'));
  const send = button(t('board.review.confirm'), 'primary');
  const dialog = el(
    'div',
    'pr-draft review-dialog',
    el('h3', 'new-order-heading', t('board.review.heading')),
    summaryLabel,
    el('b', 'review-dialog-label', t('board.review.list')),
    list,
    el('details', 'review-preview-box', el('summary', '', t('board.review.preview')), preview),
    el('div', 'new-order-actions', cancel, send),
  );
  const backdrop = el('div', 'dialog-backdrop', dialog);
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', t('board.review.heading'));

  const paint = (): void => {
    const drafts = opts.drafts();
    list.replaceChildren(
      ...drafts.map((draft) => {
        const remove = button(t('board.review.remove'), 'review-remove');
        remove.addEventListener('click', () => {
          opts.remove(draft.id);
          paint();
        });
        return el('li', 'review-draft-row', el('code', '', targetLabel(draft)), el('span', 'review-body', draft.body), remove);
      }),
    );
    preview.textContent = reviewPreview(opts.slug, summary.value, drafts);
    send.disabled = drafts.length === 0;
  };
  const dismiss = (): void => backdrop.remove();
  summary.addEventListener('input', () => {
    preview.textContent = reviewPreview(opts.slug, summary.value, opts.drafts());
  });
  cancel.addEventListener('click', dismiss);
  send.addEventListener('click', () => {
    send.disabled = true;
    void opts.send(summary.value).then((done) => {
      if (done) dismiss();
      else send.disabled = opts.drafts().length === 0;
    });
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    dismiss();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });
  paint();
  host.append(backdrop);
  summary.focus();
}
