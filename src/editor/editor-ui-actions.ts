import type { Editor as TiptapEditor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/**
 * Pure UI-action helpers for the editor chrome (the always-reachable 「編集」
 * disclosure and the floating selection toolbar). These functions only judge
 * display state and dispatch the commands the previous format-bar already
 * ran. They never create a save decision, an editor instance, or a new Undo
 * history.
 */

/** Shared-workbench history bridge. Own Undo/Redo must reach the shared lane;
 * the local ProseMirror history must never receive them. */
export type SharedHistoryBridge = {
  onUndo: () => void;
  onRedo: () => void;
  isComposing?: () => boolean;
};

export type EditorUiCommand =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "undo"
  | "redo"
  | "nested";

/** Render-owned callbacks the commands delegate to. */
export type EditorUiActions = {
  onLink: () => void;
  selectNestedAtCursor: () => void;
  onError: (error: unknown) => void;
};

export type EditorUiContext = {
  editor: TiptapEditor;
  invalid: boolean;
  shared?: SharedHistoryBridge;
  actions: EditorUiActions;
};

export const READONLY_EDIT_MESSAGE =
  "読み取り専用の文書は変更できません。";
export const COMPOSING_EDIT_MESSAGE =
  "文字の変換を確定してから操作してください。入力を保持しています。";

/** IME composition must win over every chrome command, including the shared
 * lane's own composing signal. */
export function editorIsComposing(
  editor: Pick<TiptapEditor, "view"> | null | undefined,
  shared?: SharedHistoryBridge,
): boolean {
  return !!editor?.view?.composing || !!shared?.isComposing?.();
}

/** The floating toolbar exists only for a non-empty TextSelection inside an
 * editable, valid, non-composing editor. Node selections, block selections
 * and the slash menu are different surfaces and do not qualify. This reads
 * display state only; it never dispatches a transaction or a selection. */
export function selectionToolbarVisible(
  editor: TiptapEditor | null | undefined,
  invalid: boolean,
  shared?: SharedHistoryBridge,
): boolean {
  if (!editor || editor.isDestroyed || invalid || !editor.isEditable)
    return false;
  if (editorIsComposing(editor, shared)) return false;
  const selection = editor.state.selection;
  return selection instanceof TextSelection && !selection.empty;
}

/**
 * Focus ownership for the floating toolbar. A selection alone is not enough:
 * the bar belongs to this Editor while its own editable surface holds DOM
 * focus, or while keyboard focus (Tab) has moved into this instance's own
 * chrome. Pointer focus in another pane, another Editor, or an input outside
 * the body is not ownership, so the stale bar disappears on focus/blur.
 *
 * `chrome` must be this instance's own root, never a document-wide lookup, so
 * a neighbouring Editor cannot be mistaken for ours. This predicate reads
 * DOM focus only: it never touches the ProseMirror selection, dispatches a
 * transaction, or remounts an editor.
 */
export function selectionToolbarOwnsFocus(input: {
  active: Element | null | undefined;
  editorDom: Element | null | undefined;
  chrome: Element | null | undefined;
  keyboard: boolean;
  windowFocused?: boolean;
}): boolean {
  const {
    active,
    editorDom,
    chrome,
    keyboard,
    windowFocused = true,
  } = input;
  if (!windowFocused || !active) return false;
  if (editorDom?.contains(active)) return true;
  if (!keyboard || !chrome || !chrome.contains(active)) return false;
  // A focused input/textarea/select (or another contenteditable) inside the
  // component root is still an outside-body input, never this editor's chrome.
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  return (active as HTMLElement).isContentEditable !== true;
}

/**
 * focusout fires before document.activeElement moves. The ownership target at
 * that moment is the element that is about to receive focus (relatedTarget),
 * not the stale active element. focusin and every ordinary update read the
 * actual active element. A missing relatedTarget means focus went nowhere and
 * is not owned. This keeps a body→own-toolbar Tab move from hiding the bar it
 * is moving into; it is still a focus-ownership predicate, not `isFocused`.
 */
export function selectionToolbarFocusTarget(input: {
  active: Element | null | undefined;
  relatedTarget: Element | null | undefined;
  leaving: boolean;
}): Element | null | undefined {
  if (!input.leaving) return input.active;
  return input.relatedTarget ?? null;
}

/**
 * Tiptap's FocusEvents blur handler dispatches a transaction with
 * meta("blur", { event }) before the DOM focusout. That transaction can run
 * before activeElement moves, so its relatedTarget must decide ownership too.
 * This reads the existing metadata only: ordinary transactions return
 * undefined (the caller keeps using the actual active element), while a blur
 * transaction returns an explicit next owner (relatedTarget when element-like,
 * otherwise null = non-owned). It never dispatches, edits selection, or
 * changes history.
 */
export function blurTransactionFocusTarget(
  meta: unknown,
): { active: Element | null } | undefined {
  if (!meta || typeof meta !== "object" || !("event" in meta))
    return undefined;
  const event = (meta as { event?: unknown }).event;
  if (!event || typeof event !== "object") return { active: null };
  const related = (event as { relatedTarget?: unknown }).relatedTarget;
  if (
    related &&
    typeof related === "object" &&
    typeof (related as Element).contains === "function"
  )
    return { active: related as Element };
  return { active: null };
}

/**
 * After a successful chrome command the disclosure may still hold focus (for
 * example shared Undo/Redo or nested selection, which do not call chain.focus).
 * Only then may the menu restore focus to its still-visible summary. If focus
 * already moved to the body, a link dialog or another pane, it is left alone.
 * This reads DOM focus only; summary.focus never dispatches an editor
 * transaction or selection.
 */
export function shouldRestoreMenuFocus(input: {
  open: boolean;
  menu: Element | null | undefined;
  active: Element | null | undefined;
}): boolean {
  return (
    input.open &&
    !!input.menu &&
    !!input.active &&
    input.menu.contains(input.active)
  );
}

/**
 * Dispatch one existing command through the same editor instance. Read-only,
 * invalid and composing states report and run zero commands; shared Undo/Redo
 * goes to the shared bridge instead of the local history. "nested" stays the
 * display-only block selection the previous bar exposed, unguarded exactly as
 * before because it never mutates the document.
 */
export function runEditorUiCommand(
  context: EditorUiContext,
  command: EditorUiCommand,
): boolean {
  const { editor, shared, actions } = context;
  if (command === "nested") {
    actions.selectNestedAtCursor();
    return true;
  }
  if (editor.isDestroyed) return false;
  if (context.invalid || !editor.isEditable) {
    actions.onError(READONLY_EDIT_MESSAGE);
    return false;
  }
  if (editorIsComposing(editor, shared)) {
    actions.onError(COMPOSING_EDIT_MESSAGE);
    return false;
  }
  switch (command) {
    case "bold":
      return editor.chain().focus().toggleBold().run();
    case "italic":
      return editor.chain().focus().toggleItalic().run();
    case "code":
      return editor.chain().focus().toggleCode().run();
    case "link":
      actions.onLink();
      return true;
    case "undo":
      if (shared) {
        shared.onUndo();
        return true;
      }
      return editor.chain().focus().undo().run();
    case "redo":
      if (shared) {
        shared.onRedo();
        return true;
      }
      return editor.chain().focus().redo().run();
  }
}

export type ToolbarLayoutInput = {
  /** Editor host's bounding position (positioning parent). */
  host: { top: number; left: number };
  /** Selection bounding box in viewport coordinates. */
  selection: { top: number; bottom: number; left: number };
  toolbar: { width: number; height: number };
  viewport: { width: number; height: number };
  margin?: number;
};

/**
 * Pure geometry for the floating toolbar: prefer above the selection, flip
 * below at the top edge and clamp horizontally inside the viewport. The
 * result is a position relative to the host element. Display state only.
 */
export function placeFloatingToolbar(input: ToolbarLayoutInput): {
  top: number;
  left: number;
} {
  const margin = input.margin ?? 8;
  const above = input.selection.top - input.toolbar.height - margin;
  const below = input.selection.bottom + margin;
  const bottomLimit = Math.max(
    margin,
    input.viewport.height - input.toolbar.height - margin,
  );
  let absoluteTop = above >= margin ? above : below;
  if (absoluteTop > bottomLimit) absoluteTop = bottomLimit;
  const leftLimit = Math.max(
    margin,
    input.viewport.width - input.toolbar.width - margin,
  );
  const absoluteLeft = Math.min(
    Math.max(input.selection.left, margin),
    leftLimit,
  );
  return {
    top: absoluteTop - input.host.top,
    left: absoluteLeft - input.host.left,
  };
}
