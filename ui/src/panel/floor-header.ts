import { t } from '../i18n';
import { formatTokens } from '../labels';
import type { FloorScore } from '../boards';

export type FloorChipKind = 'open' | 'red' | 'blocked' | 'spend' | 'muted' | 'focus';

export type FloorChip = { kind: FloorChipKind; label: string; title: string; tone: 'plain' | 'warn' | 'danger'; action: boolean };

export type FloorHeaderInputs = {
  score: Pick<FloorScore, 'open' | 'red' | 'blocked'> | null;
  spent: number | null;
  budget: number | null;
  muted: boolean;
  focused: boolean;
};

// The chips of a floor's header, left to right; the ones with nothing to say are left out.
export function floorHeaderChips(inputs: FloorHeaderInputs): FloorChip[] {
  const { score, spent, budget } = inputs;
  const chips: FloorChip[] = [];
  if (score && score.open > 0) chips.push({ kind: 'open', label: t('floors.chip.open', { n: score.open }), title: t('floors.chip.openHint'), tone: 'plain', action: true });
  if (score && score.red > 0) chips.push({ kind: 'red', label: t('floors.chip.red', { n: score.red }), title: t('floors.chip.redHint'), tone: 'danger', action: true });
  if (score && score.blocked > 0) chips.push({ kind: 'blocked', label: t('floors.chip.blocked', { n: score.blocked }), title: t('floors.chip.blockedHint'), tone: 'danger', action: true });
  if (spent !== null && spent > 0) {
    const pct = budget !== null ? Math.round((spent / budget) * 100) : null;
    const label = pct === null ? formatTokens(spent) : t('floors.chip.spendBudget', { tokens: formatTokens(spent), pct });
    chips.push({ kind: 'spend', label, title: t('floors.chip.spendHint'), tone: pct !== null && pct >= 100 ? 'danger' : pct !== null && pct >= 80 ? 'warn' : 'plain', action: true });
  }
  if (inputs.muted) chips.push({ kind: 'muted', label: t('floors.chip.muted'), title: t('floors.chip.mutedHint'), tone: 'plain', action: false });
  if (inputs.focused) chips.push({ kind: 'focus', label: t('floors.chip.focus'), title: t('floors.chip.focusHint'), tone: 'plain', action: false });
  return chips;
}

export function chipSignature(chips: readonly FloorChip[]): string {
  return chips.map((chip) => `${chip.kind}:${chip.label}:${chip.tone}`).join('|');
}
