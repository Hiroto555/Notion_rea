import { describe, expect, it, vi } from "vitest";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Selection,
} from "@tiptap/pm/state";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { documentSchema } from "../src/shared/editor-schema";
import {
  COMPOSING_EDIT_MESSAGE,
  READONLY_EDIT_MESSAGE,
  blurTransactionFocusTarget,
  placeFloatingToolbar,
  runEditorUiCommand,
  selectionToolbarFocusTarget,
  selectionToolbarOwnsFocus,
  selectionToolbarVisible,
  shouldRestoreMenuFocus,
  type EditorUiActions,
  type EditorUiContext,
} from "../src/editor/editor-ui-actions";

function makeDoc() {
  return documentSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "a" },
        content: [{ type: "text", text: "Alpha beta" }],
      },
      { type: "horizontalRule", attrs: { id: "hr" } },
      {
        type: "paragraph",
        attrs: { id: "b" },
        content: [{ type: "text", text: "Tail" }],
      },
    ],
  });
}

function stateWith(kind: "text" | "empty" | "node"): EditorState {
  const doc = makeDoc();
  const selection: Selection =
    kind === "text"
      ? TextSelection.create(doc, 2, 6)
      : kind === "empty"
        ? TextSelection.create(doc, 2)
        : NodeSelection.create(doc, doc.child(0).nodeSize);
  return EditorState.create({ schema: documentSchema, doc, selection });
}

function fakeEditor(
  options: {
    isEditable?: boolean;
    isDestroyed?: boolean;
    composing?: boolean;
    state?: EditorState;
  } = {},
) {
  const run = vi.fn(() => true);
  const chain = { run } as Record<string, unknown> & { run: () => boolean };
  for (const method of [
    "focus",
    "toggleBold",
    "toggleItalic",
    "toggleCode",
    "undo",
    "redo",
  ])
    chain[method] = vi.fn(() => chain);
  const editor = {
    isEditable: options.isEditable ?? true,
    isDestroyed: options.isDestroyed ?? false,
    state: options.state ?? stateWith("text"),
    view: { composing: options.composing ?? false, dispatch: vi.fn() },
    chain: vi.fn(() => chain),
    commands: { focus: vi.fn() },
  } as unknown as TiptapEditor;
  return { editor, chain, run };
}

const makeActions = (): EditorUiActions & {
  onLink: ReturnType<typeof vi.fn>;
  selectNestedAtCursor: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} => ({
  onLink: vi.fn(),
  selectNestedAtCursor: vi.fn(),
  onError: vi.fn(),
});

describe("selectionToolbarVisible", () => {
  it("is true only for a non-empty TextSelection in an editable, valid, idle editor", () => {
    expect(
      selectionToolbarVisible(fakeEditor().editor, false),
    ).toBe(true);
    expect(
      selectionToolbarVisible(
        fakeEditor({ state: stateWith("empty") }).editor,
        false,
      ),
    ).toBe(false);
    expect(
      selectionToolbarVisible(
        fakeEditor({ state: stateWith("node") }).editor,
        false,
      ),
    ).toBe(false);
    expect(
      selectionToolbarVisible(fakeEditor({ isEditable: false }).editor, false),
    ).toBe(false);
    expect(selectionToolbarVisible(fakeEditor().editor, true)).toBe(false);
    expect(
      selectionToolbarVisible(fakeEditor({ composing: true }).editor, false),
    ).toBe(false);
    expect(
      selectionToolbarVisible(fakeEditor({ isDestroyed: true }).editor, false),
    ).toBe(false);
    expect(selectionToolbarVisible(null, false)).toBe(false);
    expect(selectionToolbarVisible(undefined, false)).toBe(false);
  });

  it("honours the shared lane's own composing signal", () => {
    const shared = {
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      isComposing: () => true,
    };
    expect(selectionToolbarVisible(fakeEditor().editor, false, shared)).toBe(
      false,
    );
    shared.isComposing = () => false;
    expect(selectionToolbarVisible(fakeEditor().editor, false, shared)).toBe(
      true,
    );
  });

  it("reads display state only: no dispatch, no transaction, no selection write", () => {
    const { editor } = fakeEditor();
    const before = editor.state.selection;
    const dispatch = editor.view
      .dispatch as unknown as ReturnType<typeof vi.fn>;
    selectionToolbarVisible(editor, false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.state.selection).toBe(before);
  });
});

type FakeElement = Element & { append(child: Element): void };

function fakeElement(
  options: { tagName?: string; contentEditable?: boolean } = {},
): FakeElement {
  const children = new Set<Element>();
  const el = {
    tagName: options.tagName,
    isContentEditable: options.contentEditable ?? false,
    append(child: Element) {
      children.add(child);
    },
    contains(node: Node | null) {
      return (
        !!node && (node === (el as unknown as Node) || children.has(node as Element))
      );
    },
  };
  return el as unknown as FakeElement;
}

describe("selectionToolbarOwnsFocus", () => {
  function setup() {
    const chrome = fakeElement();
    const editorDom = fakeElement();
    const toolbar = fakeElement();
    const otherEditor = fakeElement();
    const titleInput = fakeElement();
    chrome.append(editorDom);
    chrome.append(toolbar);
    return { chrome, editorDom, toolbar, otherEditor, titleInput };
  }

  it("is false for a non-empty selection that only exists while focus is external", () => {
    const { chrome, editorDom, otherEditor, titleInput } = setup();
    // A stale TextSelection plus title/DB/other-pane focus must not keep the
    // bar visible, even when the focus move happened by keyboard.
    expect(
      selectionToolbarOwnsFocus({
        active: titleInput,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(false);
    expect(
      selectionToolbarOwnsFocus({
        active: otherEditor,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(false);
    expect(
      selectionToolbarOwnsFocus({
        active: null,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(false);
    // A blurred window is external focus even if activeElement is stale.
    expect(
      selectionToolbarOwnsFocus({
        active: editorDom,
        editorDom,
        chrome,
        keyboard: false,
        windowFocused: false,
      }),
    ).toBe(false);
    // An input or another contenteditable inside the component root is still
    // outside the body and must not be adopted as own chrome.
    for (const control of [
      fakeElement({ tagName: "INPUT" }),
      fakeElement({ tagName: "TEXTAREA" }),
      fakeElement({ tagName: "SELECT" }),
      fakeElement({ tagName: "DIV", contentEditable: true }),
    ]) {
      chrome.append(control);
      expect(
        selectionToolbarOwnsFocus({
          active: control,
          editorDom,
          chrome,
          keyboard: true,
        }),
      ).toBe(false);
    }
  });

  it("is true for own Editor focus and for keyboard focus in own chrome", () => {
    const { chrome, editorDom, toolbar } = setup();
    expect(
      selectionToolbarOwnsFocus({
        active: editorDom,
        editorDom,
        chrome,
        keyboard: false,
      }),
    ).toBe(true);
    expect(
      selectionToolbarOwnsFocus({
        active: toolbar,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(true);
    // Pointer focus in chrome is not a keyboard ownership transfer.
    expect(
      selectionToolbarOwnsFocus({
        active: toolbar,
        editorDom,
        chrome,
        keyboard: false,
      }),
    ).toBe(false);
  });

  it("reads focus state only: selection identity and dispatch are unchanged", () => {
    const { editor } = fakeEditor();
    const before = editor.state.selection;
    const dispatch = editor.view
      .dispatch as unknown as ReturnType<typeof vi.fn>;
    const { chrome, editorDom, toolbar } = setup();
    selectionToolbarOwnsFocus({
      active: editorDom,
      editorDom,
      chrome,
      keyboard: false,
    });
    selectionToolbarOwnsFocus({
      active: toolbar,
      editorDom,
      chrome,
      keyboard: true,
    });
    selectionToolbarOwnsFocus({
      active: null,
      editorDom,
      chrome,
      keyboard: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.state.selection).toBe(before);
  });

  it("combines a non-empty TextSelection with external focus into a hidden bar", () => {
    const { editor } = fakeEditor();
    expect(selectionToolbarVisible(editor, false)).toBe(true);
    const { chrome, editorDom, toolbar, otherEditor } = setup();
    expect(
      selectionToolbarOwnsFocus({
        active: editorDom,
        editorDom,
        chrome,
        keyboard: false,
      }),
    ).toBe(true);
    expect(
      selectionToolbarOwnsFocus({
        active: toolbar,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(true);
    expect(
      selectionToolbarOwnsFocus({
        active: otherEditor,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(false);
  });

  it("uses focusout's relatedTarget as the next focus, not stale activeElement", () => {
    const { chrome, editorDom, toolbar, otherEditor, titleInput } = setup();
    const body = fakeElement({ tagName: "BODY" });
    // activeElement is still body at capture time, but the next focus is the
    // bar: ownership must follow relatedTarget and keep the bar.
    const intoBar = selectionToolbarFocusTarget({
      active: body,
      relatedTarget: toolbar,
      leaving: true,
    });
    expect(intoBar).toBe(toolbar);
    expect(
      selectionToolbarOwnsFocus({
        active: intoBar,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(true);
    // own bar -> own bar also stays.
    const barToBar = selectionToolbarFocusTarget({
      active: toolbar,
      relatedTarget: toolbar,
      leaving: true,
    });
    expect(
      selectionToolbarOwnsFocus({
        active: barToBar,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(true);
    // outside/null next focus and a deactivated window are non-owned.
    for (const related of [titleInput, otherEditor, null]) {
      const next = selectionToolbarFocusTarget({
        active: toolbar,
        relatedTarget: related,
        leaving: true,
      });
      expect(
        selectionToolbarOwnsFocus({
          active: next,
          editorDom,
          chrome,
          keyboard: true,
        }),
      ).toBe(false);
    }
    expect(
      selectionToolbarOwnsFocus({
        active: toolbar,
        editorDom,
        chrome,
        keyboard: true,
        windowFocused: false,
      }),
    ).toBe(false);
    // focusin and ordinary updates still read the actual active element.
    expect(
      selectionToolbarFocusTarget({
        active: toolbar,
        relatedTarget: titleInput,
        leaving: false,
      }),
    ).toBe(toolbar);
    // The transition helper is pure: selection identity and dispatch stay.
    const { editor } = fakeEditor();
    const before = editor.state.selection;
    const dispatch = editor.view
      .dispatch as unknown as ReturnType<typeof vi.fn>;
    selectionToolbarFocusTarget({
      active: body,
      relatedTarget: toolbar,
      leaving: true,
    });
    selectionToolbarFocusTarget({
      active: toolbar,
      relatedTarget: titleInput,
      leaving: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.state.selection).toBe(before);
  });
});

describe("shouldRestoreMenuFocus", () => {
  it("restores only when the closing menu itself still holds focus", () => {
    const menu = fakeElement();
    const button = fakeElement({ tagName: "BUTTON" });
    const editorBody = fakeElement({ tagName: "DIV", contentEditable: true });
    const outside = fakeElement({ tagName: "INPUT" });
    menu.append(button);
    expect(shouldRestoreMenuFocus({ open: true, menu, active: button })).toBe(
      true,
    );
    expect(shouldRestoreMenuFocus({ open: true, menu, active: menu })).toBe(
      true,
    );
    // Body, link-dialog and outside focus are never pulled back.
    expect(
      shouldRestoreMenuFocus({ open: true, menu, active: editorBody }),
    ).toBe(false);
    expect(shouldRestoreMenuFocus({ open: true, menu, active: outside })).toBe(
      false,
    );
    expect(shouldRestoreMenuFocus({ open: false, menu, active: button })).toBe(
      false,
    );
    expect(shouldRestoreMenuFocus({ open: true, menu: null, active: button })).toBe(
      false,
    );
    expect(shouldRestoreMenuFocus({ open: true, menu, active: null })).toBe(
      false,
    );
    // This predicate is pure: it cannot dispatch a selection transaction.
    const { editor } = fakeEditor();
    const before = editor.state.selection;
    const dispatch = editor.view
      .dispatch as unknown as ReturnType<typeof vi.fn>;
    shouldRestoreMenuFocus({ open: true, menu, active: button });
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.state.selection).toBe(before);
  });
});

describe("blurTransactionFocusTarget", () => {
  it("reads Tiptap blur meta and uses relatedTarget as the next focus", () => {
    const chrome = fakeElement();
    const editorDom = fakeElement();
    const ownToolbar = fakeElement({ tagName: "BUTTON" });
    const outside = fakeElement({ tagName: "INPUT" });
    chrome.append(editorDom);
    chrome.append(ownToolbar);

    // Ordinary transactions return undefined so callers keep actual active.
    expect(blurTransactionFocusTarget(undefined)).toBeUndefined();
    expect(blurTransactionFocusTarget({})).toBeUndefined();
    // A blur meta without a usable relatedTarget is explicitly non-owned.
    expect(blurTransactionFocusTarget({ event: null })).toEqual({
      active: null,
    });
    expect(
      blurTransactionFocusTarget({ event: { relatedTarget: null } }),
    ).toEqual({ active: null });

    const intoBar = blurTransactionFocusTarget({
      event: { relatedTarget: ownToolbar },
    });
    expect(intoBar).toEqual({ active: ownToolbar });
    // The stale active=body is not used when the blur transaction names bar.
    expect(
      selectionToolbarOwnsFocus({
        active: intoBar?.active,
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(true);
    expect(
      selectionToolbarOwnsFocus({
        active: fakeElement({ tagName: "BODY" }),
        editorDom,
        chrome,
        keyboard: true,
      }),
    ).toBe(false);

    for (const related of [outside, null]) {
      const target = blurTransactionFocusTarget({
        event: { relatedTarget: related },
      });
      expect(
        selectionToolbarOwnsFocus({
          active: target?.active,
          editorDom,
          chrome,
          keyboard: true,
        }),
      ).toBe(false);
    }
    expect(
      selectionToolbarOwnsFocus({
        active: ownToolbar,
        editorDom,
        chrome,
        keyboard: true,
        windowFocused: false,
      }),
    ).toBe(false);
  });

  it("is metadata-only: selection identity and dispatch stay unchanged", () => {
    const { editor } = fakeEditor();
    const before = editor.state.selection;
    const dispatch = editor.view
      .dispatch as unknown as ReturnType<typeof vi.fn>;
    const ownToolbar = fakeElement();
    blurTransactionFocusTarget({ event: { relatedTarget: ownToolbar } });
    blurTransactionFocusTarget(undefined);
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.state.selection).toBe(before);
  });
});

describe("runEditorUiCommand", () => {
  it("runs each mark command exactly once through the same editor chain", () => {
    const { editor, chain, run } = fakeEditor();
    const actions = makeActions();
    const context: EditorUiContext = { editor, invalid: false, actions };
    const marks = [
      ["bold", "toggleBold"],
      ["italic", "toggleItalic"],
      ["code", "toggleCode"],
    ] as const;
    for (const [command, method] of marks) {
      vi.clearAllMocks();
      expect(runEditorUiCommand(context, command)).toBe(true);
      expect(editor.chain).toHaveBeenCalledTimes(1);
      expect(chain.focus).toHaveBeenCalledTimes(1);
      expect(chain[method]).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(actions.onError).not.toHaveBeenCalled();
    }
  });

  it("delegates link to the provided onLink and touches no chain", () => {
    const { editor } = fakeEditor();
    const actions = makeActions();
    expect(
      runEditorUiCommand({ editor, invalid: false, actions }, "link"),
    ).toBe(true);
    expect(actions.onLink).toHaveBeenCalledTimes(1);
    expect(editor.chain).not.toHaveBeenCalled();
  });

  it("keeps nested block selection a display-only action with no chain dispatch", () => {
    const { editor } = fakeEditor();
    const actions = makeActions();
    expect(
      runEditorUiCommand({ editor, invalid: false, actions }, "nested"),
    ).toBe(true);
    expect(actions.selectNestedAtCursor).toHaveBeenCalledTimes(1);
    expect(editor.chain).not.toHaveBeenCalled();
    expect(actions.onError).not.toHaveBeenCalled();
  });

  it("sends shared Undo/Redo to the shared bridge and never to the local history", () => {
    const { editor, chain } = fakeEditor();
    const shared = { onUndo: vi.fn(), onRedo: vi.fn() };
    const actions = makeActions();
    const context: EditorUiContext = {
      editor,
      invalid: false,
      shared,
      actions,
    };
    expect(runEditorUiCommand(context, "undo")).toBe(true);
    expect(runEditorUiCommand(context, "redo")).toBe(true);
    expect(shared.onUndo).toHaveBeenCalledTimes(1);
    expect(shared.onRedo).toHaveBeenCalledTimes(1);
    expect(editor.chain).not.toHaveBeenCalled();
    expect(chain.undo).not.toHaveBeenCalled();
    expect(chain.redo).not.toHaveBeenCalled();
  });

  it("keeps local Undo/Redo on the same editor when no shared bridge exists", () => {
    const { editor, chain, run } = fakeEditor();
    const actions = makeActions();
    const context: EditorUiContext = { editor, invalid: false, actions };
    runEditorUiCommand(context, "undo");
    runEditorUiCommand(context, "redo");
    expect(chain.undo).toHaveBeenCalledTimes(1);
    expect(chain.redo).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs zero commands and reports the read-only message in read-only or invalid states", () => {
    const commands = ["bold", "italic", "code", "link", "undo", "redo"] as const;
    for (const context of [
      { editor: fakeEditor({ isEditable: false }).editor, invalid: false },
      { editor: fakeEditor().editor, invalid: true },
    ]) {
      const actions = makeActions();
      for (const command of commands) {
        expect(
          runEditorUiCommand({ ...context, actions }, command),
        ).toBe(false);
      }
      expect(actions.onError).toHaveBeenCalledWith(READONLY_EDIT_MESSAGE);
      expect(actions.onLink).not.toHaveBeenCalled();
    }
  });

  it("runs zero commands while composing, for both view and shared signals", () => {
    const commands = ["bold", "italic", "code", "link", "undo", "redo"] as const;
    const shared = {
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      isComposing: () => true,
    };
    const setups: EditorUiContext[] = [
      {
        editor: fakeEditor({ composing: true }).editor,
        invalid: false,
        actions: makeActions(),
      },
      { editor: fakeEditor().editor, invalid: false, shared, actions: makeActions() },
    ];
    for (const context of setups) {
      const dispatch = context.editor.view
        .dispatch as unknown as ReturnType<typeof vi.fn>;
      for (const command of commands)
        expect(runEditorUiCommand(context, command)).toBe(false);
      expect(context.editor.chain).not.toHaveBeenCalled();
      expect(context.actions.onLink).not.toHaveBeenCalled();
      expect(shared.onUndo).not.toHaveBeenCalled();
      expect(shared.onRedo).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(context.actions.onError).toHaveBeenCalledWith(
        COMPOSING_EDIT_MESSAGE,
      );
    }
  });

  it("keeps shared Undo/Redo and nested callback-only with no local history or selection write", () => {
    for (const command of ["undo", "redo", "nested"] as const) {
      const { editor } = fakeEditor();
      const shared = { onUndo: vi.fn(), onRedo: vi.fn() };
      const actions = makeActions();
      const before = editor.state.selection;
      const dispatch = editor.view
        .dispatch as unknown as ReturnType<typeof vi.fn>;
      expect(
        runEditorUiCommand(
          { editor, invalid: false, shared, actions },
          command,
        ),
      ).toBe(true);
      if (command === "undo")
        expect(shared.onUndo).toHaveBeenCalledTimes(1);
      if (command === "redo")
        expect(shared.onRedo).toHaveBeenCalledTimes(1);
      if (command === "nested")
        expect(actions.selectNestedAtCursor).toHaveBeenCalledTimes(1);
      expect(editor.chain).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(editor.state.selection).toBe(before);
      expect(actions.onError).not.toHaveBeenCalled();
    }
  });

  it("keeps failed and IME-guarded commands callback-free and selection-stable", () => {
    const setups: EditorUiContext[] = [
      {
        editor: fakeEditor({ isEditable: false }).editor,
        invalid: false,
        actions: makeActions(),
      },
      { editor: fakeEditor().editor, invalid: true, actions: makeActions() },
      {
        editor: fakeEditor({ composing: true }).editor,
        invalid: false,
        actions: makeActions(),
      },
    ];
    const commands = ["bold", "italic", "code", "link", "undo", "redo"] as const;
    for (const context of setups) {
      const shared = { onUndo: vi.fn(), onRedo: vi.fn() };
      const guarded: EditorUiContext = { ...context, shared };
      const before = context.editor.state.selection;
      const dispatch = context.editor.view
        .dispatch as unknown as ReturnType<typeof vi.fn>;
      for (const command of commands)
        expect(runEditorUiCommand(guarded, command)).toBe(false);
      expect(context.editor.chain).not.toHaveBeenCalled();
      expect(context.actions.onLink).not.toHaveBeenCalled();
      expect(shared.onUndo).not.toHaveBeenCalled();
      expect(shared.onRedo).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(context.editor.state.selection).toBe(before);
    }
  });
});

describe("placeFloatingToolbar", () => {
  const base = {
    host: { top: 100, left: 40 },
    selection: { top: 300, bottom: 320, left: 200 },
    toolbar: { width: 160, height: 40 },
    viewport: { width: 800, height: 600 },
  };

  it("prefers above the selection and flips below at the top edge", () => {
    expect(placeFloatingToolbar(base)).toEqual({ top: 152, left: 160 });
    const flipped = placeFloatingToolbar({
      ...base,
      selection: { top: 20, bottom: 40, left: 200 },
    });
    expect(flipped.top).toBe(40 + 8 - 100);
    expect(flipped.left).toBe(160);
  });

  it("clamps horizontally inside narrow viewports", () => {
    const placed = placeFloatingToolbar({
      ...base,
      host: { top: 0, left: 0 },
      selection: { top: 100, bottom: 120, left: 700 },
      viewport: { width: 360, height: 600 },
    });
    expect(placed.left).toBe(360 - 160 - 8);
  });

  it("clamps vertically when a short viewport leaves no room below", () => {
    const placed = placeFloatingToolbar({
      ...base,
      selection: { top: 20, bottom: 38, left: 100 },
      viewport: { width: 800, height: 44 },
    });
    expect(placed.top).toBe(8 - 100);
  });
});
