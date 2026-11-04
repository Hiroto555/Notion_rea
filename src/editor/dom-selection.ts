import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/** Browser selectionchange may arrive after the next keyboard shortcut. Read
 * the visible text range before opening a dialog, while the editor still owns
 * focus. Keep node selections and selections outside this editor untouched. */
export function syncEditorTextSelection(editor: Editor): void {
  if (editor.isDestroyed || !editor.view.hasFocus() ||
      !(editor.state.selection instanceof TextSelection)) return;
  const root = editor.view.dom;
  const native = root.ownerDocument.getSelection();
  if (!native?.anchorNode || !native.focusNode ||
      !root.contains(native.anchorNode) || !root.contains(native.focusNode)) return;
  const anchor = editor.view.posAtDOM(native.anchorNode, native.anchorOffset);
  const head = editor.view.posAtDOM(native.focusNode, native.focusOffset);
  const doc = editor.state.doc;
  if (!doc.resolve(anchor).parent.inlineContent || !doc.resolve(head).parent.inlineContent) return;
  const selection = TextSelection.create(doc, anchor, head);
  if (!selection.eq(editor.state.selection))
    editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false));
}
