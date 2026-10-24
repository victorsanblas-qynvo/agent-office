import { agentNoteKey } from '../notes';
import { mountNoteEditor, type NoteEditor } from '../notes-editor';
import type { Store } from '../store';

// The private notes of the selected agent, under the header. The editor lives while the selection stays on
// the same agent, so its autosave and its cursor are not disturbed by the other re-renders of the panel.
export function mountNotes(host: HTMLElement, store: Store): void {
  let editor: NoteEditor | null = null;
  let shown: string | null = null;
  let lang = store.lang;

  store.watch(['selection', 'agents', 'lang', 'noteJump'], () => {
    const key = store.selectedKey !== null && store.agents.has(store.selectedKey) ? agentNoteKey(store.selectedKey) : null;
    if (key !== shown || lang !== store.lang) {
      editor?.destroy();
      editor = key === null ? null : mountNoteEditor(store, key);
      shown = key;
      lang = store.lang;
      host.replaceChildren(...(editor ? [editor.node] : []));
    }
    if (key !== null && store.noteJump === key) {
      store.noteJump = null;
      editor?.reveal();
    }
  });
}
