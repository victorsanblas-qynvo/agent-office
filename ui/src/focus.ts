export type FocusFilters = { query: string; floor: string | null };

// The floors that can be focused: the ones the hub manages and the ones it only observes.
export function focusable(floors: readonly { slug: string; kind: string }[]): string[] {
  return floors.filter((floor) => floor.kind === 'managed' || floor.kind === 'observed').map((floor) => floor.slug);
}

// A focus on a floor that is gone lapses; with no floors known yet it is kept, as they have not arrived.
export function liveFocus(focus: string | null, floors: readonly { slug: string; kind: string }[]): string | null {
  if (focus === null) return null;
  return floors.length === 0 || focusable(floors).includes(focus) ? focus : null;
}

// The Tablero's filters with the focused floor as one more predicate: the text filter still narrows within it.
export function applyFocus(filters: FocusFilters, focus: string | null): FocusFilters {
  return focus === null ? filters : { ...filters, floor: focus };
}

// The floor the "Te necesitan" chips show once the focus moves: the focused one, or none when the focus
// is cleared and the chip still is the one it set; a chip the user chose in the meantime stays.
export function needsFilterAfter(current: string | null, previous: string | null, next: string | null): string | null {
  if (next !== null) return next;
  return current === previous ? null : current;
}

export function focusToggle(current: string | null, floor: string): string | null {
  return current === floor ? null : floor;
}
