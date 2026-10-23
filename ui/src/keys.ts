import { t, type MessageKey } from './i18n';
import type { CardDirection } from './board/columns';
import { TABS } from './topbar';

export type KeyAction =
  | { type: 'palette' }
  | { type: 'tab'; index: number }
  | { type: 'need'; step: 1 | -1 }
  | { type: 'history' }
  | { type: 'orders' }
  | { type: 'help' }
  | { type: 'board'; move: BoardMove }
  | { type: 'escape' };

// What the keyboard does on the Tablero: step the highlight, open its drawer or ask to move its card.
export type BoardMove = CardDirection | 'open' | 'prev' | 'next';

// A hidden row is an alias of another one and stays out of the help.
export type Binding = { combo: string; action: KeyAction; label: () => string; hidden?: boolean };

const tabBindings: Binding[] = TABS.map(({ labelKey }, index) => ({
  combo: String(index + 1),
  action: { type: 'tab', index },
  label: () => t('keys.tab', { tab: t(labelKey) }),
}));

const fixed = (combo: string, action: KeyAction, key: MessageKey): Binding => ({ combo, action, label: () => t(key) });

const alias = (combo: string, action: KeyAction, key: MessageKey): Binding => ({ ...fixed(combo, action, key), hidden: true });

// The one table the listener, the help overlay and the palette read.
export const BINDINGS: readonly Binding[] = [
  fixed('mod+k', { type: 'palette' }, 'keys.palette'),
  ...tabBindings,
  fixed('n', { type: 'need', step: 1 }, 'keys.needNext'),
  fixed('shift+n', { type: 'need', step: -1 }, 'keys.needPrev'),
  fixed('/', { type: 'history' }, 'keys.history'),
  fixed('o', { type: 'orders' }, 'keys.orders'),
  fixed('?', { type: 'help' }, 'keys.help'),
  fixed('j', { type: 'board', move: 'down' }, 'keys.boardDown'),
  fixed('k', { type: 'board', move: 'up' }, 'keys.boardUp'),
  fixed('h', { type: 'board', move: 'left' }, 'keys.boardLeft'),
  fixed('l', { type: 'board', move: 'right' }, 'keys.boardRight'),
  alias('ArrowDown', { type: 'board', move: 'down' }, 'keys.boardDown'),
  alias('ArrowUp', { type: 'board', move: 'up' }, 'keys.boardUp'),
  alias('ArrowLeft', { type: 'board', move: 'left' }, 'keys.boardLeft'),
  alias('ArrowRight', { type: 'board', move: 'right' }, 'keys.boardRight'),
  fixed('Enter', { type: 'board', move: 'open' }, 'keys.boardOpen'),
  fixed('[', { type: 'board', move: 'prev' }, 'keys.boardPrev'),
  fixed(']', { type: 'board', move: 'next' }, 'keys.boardNext'),
  fixed('esc', { type: 'escape' }, 'keys.escape'),
];

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

const TYPING_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!node) return false;
  if (node.isContentEditable === true) return true;
  return typeof node.tagName === 'string' && TYPING_TAGS.has(node.tagName.toUpperCase());
}

// The combo of an event as written in BINDINGS, or null when it carries a modifier no binding uses.
export function comboOf(event: KeyLike): string | null {
  if (event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key === 'Escape' ? 'esc' : event.key;
  const letter = key.length === 1 && key.toLowerCase() !== key.toUpperCase();
  const name = letter ? key.toLowerCase() : key;
  if (mod) return `mod+${name}`;
  return letter && event.shiftKey ? `shift+${name}` : name;
}

export function resolveKey(event: KeyLike): KeyAction | null {
  const combo = comboOf(event);
  return BINDINGS.find((binding) => binding.combo === combo)?.action ?? null;
}

export type KeyContext = { typing: boolean; modalOpen: boolean; boardReady: boolean };

// Cmd/Ctrl+K and Esc always work; the help toggles over a dialog; the rest wait while the user types or a dialog is up.
// The board keys also wait until the Tablero can use them, so the arrows and Enter keep their usual job elsewhere.
// The board keys act only on the board tab, with no order drawer over it, and Enter only on a highlighted card.
export function boardKeysReady(onBoard: boolean, drawerOpen: boolean, opens: boolean, hasHighlight: boolean): boolean {
  return onBoard && !drawerOpen && (!opens || hasHighlight);
}

export function shouldRun(action: KeyAction, context: KeyContext): boolean {
  if (action.type === 'palette' || action.type === 'escape') return true;
  if (context.typing) return false;
  if (action.type === 'help') return true;
  if (action.type === 'board' && !context.boardReady) return false;
  return !context.modalOpen;
}

const OWN_ENTER_TAGS: ReadonlySet<string> = new Set(['BUTTON', 'A', 'SUMMARY']);

// Enter on a button or a link does that element's own job, not the board's.
export function keepsEnter(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: unknown } | null)?.tagName;
  return typeof tag === 'string' && OWN_ENTER_TAGS.has(tag.toUpperCase());
}

// Closes the first layer that is open, in priority order, and says whether there was one.
export function dismissTopLayer(layers: readonly (() => boolean)[]): boolean {
  for (const close of layers) if (close()) return true;
  return false;
}

export function displayCombo(combo: string, mac: boolean): string {
  return combo
    .split('+')
    .map((part) => {
      switch (part) {
        case 'mod':
          return mac ? '⌘' : 'Ctrl';
        case 'shift':
          return mac ? '⇧' : 'Shift';
        case 'esc':
          return 'Esc';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(mac ? '' : '+');
}

export type KeyHandlers = {
  run(action: KeyAction): void;
  layers: readonly (() => boolean)[];
  modalOpen(): boolean;
  // Whether the Tablero is showing and can take this board move.
  boardReady(move: BoardMove): boolean;
};

// The only keydown listener of the shortcuts: capture phase on the document, so the layers it closes
// never reach the Esc handler of the viewer or the dialogs underneath.
export function mountKeys(handlers: KeyHandlers): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const action = resolveKey(event);
    if (!action) return;
    if (action.type === 'escape') {
      if (!dismissTopLayer(handlers.layers)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const boardReady = action.type === 'board' && handlers.boardReady(action.move) && !(action.move === 'open' && keepsEnter(event.target));
    if (!shouldRun(action, { typing: isTypingTarget(event.target), modalOpen: handlers.modalOpen(), boardReady })) return;
    event.preventDefault();
    handlers.run(action);
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
