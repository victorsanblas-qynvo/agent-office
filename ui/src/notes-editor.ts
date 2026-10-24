import { el } from './dom';
import { t } from './i18n';
import { NOTE_MAX, NOTE_SAVE_MS, noteTitle, type Notes } from './notes';
import type { Store } from './store';

export type NoteEditor = {
  node: HTMLDetailsElement;
  // Opens the note and puts the cursor at its end.
  reveal(): void;
  // Keeps the cursor of the textarea through a re-render that moves it; call the result afterwards.
  holdFocus(): () => void;
  // Saves what is pending and releases the node.
  destroy(): void;
};

// The collapsible "Mis notas" box of an order or an agent. It is built once and moved by the renders around
// it, so typing never depends on them; the note goes to the store 500 ms after the last key.
export function mountNoteEditor(store: Store, key: string): NoteEditor {
  const area = el('textarea', 'note-input');
  area.maxLength = NOTE_MAX;
  area.rows = 4;
  area.placeholder = t('notes.placeholder');
  area.value = store.notes[key]?.text ?? '';
  area.setAttribute('aria-label', t('notes.title'));
  const hint = el('span', 'note-hint muted');
  hint.setAttribute('role', 'status');
  const node = el('details', 'note-card', el('summary', 'note-summary', t('notes.title')), area, hint);
  node.open = area.value !== '';
  let timer: number | undefined;
  let pending = false;

  const save = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    pending = false;
    store.setNote(key, area.value);
    hint.textContent = t('notes.saved');
  };

  area.addEventListener('input', () => {
    pending = true;
    hint.textContent = '';
    window.clearTimeout(timer);
    timer = window.setTimeout(save, NOTE_SAVE_MS);
  });

  return {
    node,
    reveal() {
      node.open = true;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    },
    holdFocus() {
      if (document.activeElement !== area) return () => undefined;
      const { selectionStart, selectionEnd } = area;
      return () => {
        area.focus();
        area.setSelectionRange(selectionStart, selectionEnd);
      };
    },
    destroy() {
      save();
    },
  };
}

// The small mark of a card or a row that has a note; its title is the first line of the note.
export function noteIcon(notes: Notes, key: string): HTMLElement | null {
  const note = notes[key];
  if (!note) return null;
  const icon = el('span', 'note-icon', '✎');
  icon.title = noteTitle(note.text);
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', `${t('notes.title')}: ${icon.title}`);
  return icon;
}
