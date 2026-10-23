import type { OfficeApi } from '../api';
import { el } from '../dom';
import { t } from '../i18n';
import { parseDiff } from '../board/diff-parse';
import { patchRows } from '../board/diff-model';
import type { DocumentRound } from '../types';
import { defaultPair, orderedPair, roundOptionText, type RoundPair } from './rounds-model';

function patchView(patch: string, truncated: boolean): HTMLElement {
  const lines = parseDiff(patch)
    .flatMap(patchRows)
    .map((row) => el('div', row.className, el('span', 'diff-no', row.oldNo), el('span', 'diff-no', row.newNo), el('span', 'diff-marker', row.marker), el('span', 'diff-text', row.text)));
  return el(
    'div',
    'diff-patch-wrap',
    truncated ? el('p', 'order-warning', t('deliverables.rounds.truncated')) : null,
    lines.length === 0 ? el('p', 'muted hint', t('deliverables.rounds.noChanges')) : el('div', 'diff-patch', ...lines),
  );
}

function picker(label: string, rounds: readonly DocumentRound[], value: string, now: number): HTMLSelectElement {
  const select = el('select', 'rounds-select');
  select.setAttribute('aria-label', label);
  for (const round of rounds) {
    const option = el('option', '', roundOptionText(round, now));
    option.value = round.sha;
    select.append(option);
  }
  select.value = value;
  return select;
}

// The rounds of a document and the diff between two of them; the first paint compares the last two.
export async function roundsView(api: OfficeApi, path: string, now: number): Promise<HTMLElement> {
  const listed = await api.documentRounds(path);
  if (!listed.ok) return el('p', 'doc-error hint', listed.message);
  const rounds = listed.data;
  const initial = defaultPair(rounds);
  if (rounds.length === 0) return el('p', 'muted hint', t('deliverables.rounds.empty'));
  if (initial === null) return el('p', 'muted hint', t('deliverables.rounds.needTwo'));

  const result = el('div', 'rounds-result');
  const from = picker(t('deliverables.rounds.from'), rounds, initial.from, now);
  const to = picker(t('deliverables.rounds.to'), rounds, initial.to, now);
  let ticket = 0;

  const show = async (pair: RoundPair | null): Promise<void> => {
    const mine = ++ticket;
    if (pair === null) {
      result.replaceChildren(el('p', 'muted hint', t('deliverables.rounds.samePick')));
      return;
    }
    result.replaceChildren(el('p', 'muted hint', t('deliverables.loading')));
    const diff = await api.documentRoundDiff(path, pair.from, pair.to);
    if (mine !== ticket) return;
    result.replaceChildren(diff.ok ? patchView(diff.data.patch, diff.data.truncated) : el('p', 'doc-error hint', diff.message));
  };
  const change = (): void => {
    const pair = orderedPair(rounds, from.value, to.value);
    if (pair) [from.value, to.value] = [pair.from, pair.to];
    void show(pair);
  };
  from.addEventListener('change', change);
  to.addEventListener('change', change);
  void show(initial);

  return el(
    'div',
    'rounds',
    el('div', 'rounds-pick', el('label', '', t('deliverables.rounds.from'), from), el('label', '', t('deliverables.rounds.to'), to)),
    result,
  );
}
