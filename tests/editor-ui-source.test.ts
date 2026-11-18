import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}
const nodes = (file: ts.SourceFile): ts.Node[] => [...walk(file)];
const calls = (file: ts.SourceFile, callee: string): ts.CallExpression[] =>
  nodes(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText(file).replace(/\s+/g, "") ===
        callee.replace(/\s+/g, ""),
  );

const editorPath = "src/editor/Editor.tsx";
const helperPath = "src/editor/editor-ui-actions.ts";
const chromePath = "src/editor/editor-chrome.css";
const editorFile = parse(editorPath);
const helperFile = parse(helperPath);
const editorSource = read(editorPath);
const helperSource = read(helperPath);

describe("Editor.tsx wires the shared UI-action helpers", () => {
  it("imports the helper module and the owned chrome stylesheet", () => {
    expect(editorSource).toContain('from "./editor-ui-actions"');
    expect(editorSource).toContain('import "./editor-chrome.css"');
    for (const marker of [
      "selectionToolbarVisible",
      "selectionToolbarOwnsFocus",
      "selectionToolbarFocusTarget",
      "blurTransactionFocusTarget",
      "placeFloatingToolbar",
      "runEditorUiCommand",
      "shouldRestoreMenuFocus",
    ])
      expect(calls(editorFile, marker).length).toBeGreaterThan(0);
  });

  it("gates the floating toolbar on this instance's own focus ownership", () => {
    expect(
      calls(editorFile, "selectionToolbarOwnsFocus").length,
    ).toBeGreaterThan(0);
    for (const marker of [
      'document.addEventListener("focusin"',
      'document.addEventListener("focusout"',
      'window.addEventListener("focus"',
      'window.addEventListener("blur"',
      'window.addEventListener("pointerdown"',
      'window.addEventListener("keydown"',
    ])
      expect(editorSource).toContain(marker);
    // Ownership stays scoped to the component ref, never a document-wide
    // lookup that could adopt another Editor or an outside input.
    expect(editorSource).toContain('<div ref={root} className="editor-root">');
    expect(editorSource).toContain("chrome: root.current");
    // focusout must feed relatedTarget as the next focus before
    // document.activeElement moves; focusin/normal updates use actual active.
    expect(editorSource).toContain(
      'document.addEventListener("focusout", onFocusOut, true)',
    );
    expect(editorSource).toContain(
      "event.relatedTarget instanceof Element ? event.relatedTarget : null",
    );
    expect(editorSource).toContain("leaving: true");
    expect(editorSource).toContain(
      "const onFocusIn = () => syncBarWith(document.activeElement)",
    );
  });

  it("feeds Tiptap blur transaction metadata into the layout focus path", () => {
    expect(
      calls(editorFile, "blurTransactionFocusTarget").length,
    ).toBeGreaterThan(0);
    // Read the existing blur meta only; do not create a transaction.
    expect(editorSource).toContain('event.transaction.getMeta("blur")');
    expect(editorSource).toContain("layout(blurTransactionFocusTarget(");
    // Ordinary transactions and viewport callbacks still use actual active.
    expect(editorSource).toContain(
      "syncBarWith(focus ? focus.active : document.activeElement)",
    );
    expect(editorSource).toContain(
      "const layoutFromViewport = () => layout()",
    );
    expect(editorSource).toContain(
      "new ResizeObserver(layoutFromViewport)",
    );
    expect(editorSource).toContain(
      "requestAnimationFrame(layoutFromViewport)",
    );
    // The layout receives only the parsed focus object, never an observer
    // entry array or a RAF timestamp.
    expect(editorSource).not.toContain("new ResizeObserver(layout)");
    expect(editorSource).not.toContain("requestAnimationFrame(layout)");
  });

  it("announces onReady for the instance lifetime only, not on editable changes", () => {
    const readyEffect = calls(editorFile, "useEffect").find((call) =>
      call.arguments[0]?.getText(editorFile).includes("readyRef.current(editor)"),
    );
    expect(readyEffect).toBeTruthy();
    expect(
      readyEffect!.arguments[1]?.getText(editorFile).replace(/\s+/g, ""),
    ).toBe("[editor]");
    // Editable changes re-sync the bar but must not call onReady again.
    const editableEffect = calls(editorFile, "useEffect").find((call) =>
      call.arguments[0]?.getText(editorFile).includes("syncBarRef.current()"),
    );
    expect(editableEffect).toBeTruthy();
    expect(
      editableEffect!.arguments[1]?.getText(editorFile).replace(/\s+/g, ""),
    ).toBe("[editor,editable]");
  });

  it("closes a stale edit menu after success, focus loss and editor Escape", () => {
    expect(calls(editorFile, "closeEditMenu").length).toBeGreaterThanOrEqual(3);
    // Successful edit-menu commands close through the wrapper and restore
    // focus only when the menu itself still owned it.
    expect(editorSource).toContain("if (ran && closeMenu) closeEditMenu(true);");
    expect(calls(editorFile, "shouldRestoreMenuFocus").length).toBeGreaterThan(
      0,
    );
    expect(helperSource).toContain("input.menu.contains(input.active)");
    // Focus leaving the disclosure closes it without stealing focus back.
    expect(editorSource).toContain("event.currentTarget.contains(next)");
    // Own-editor Escape closes the menu only after block/slash Escape.
    const blockEscape = editorSource.indexOf(
      '(selected.length || nestedSelected) && event.key === "Escape"',
    );
    const chromeEscape = editorSource.indexOf(
      'event.key === "Escape" && editMenu.current?.open',
    );
    expect(blockEscape).toBeGreaterThan(-1);
    expect(chromeEscape).toBeGreaterThan(blockEscape);
    // Closing from the body must not pull focus to a menu that is gone.
    expect(editorSource).not.toContain(
      "if (ran && closeMenu) editMenu.current",
    );
  });

  it("keeps a single useEditor instance and never re-creates or re-sets content", () => {
    expect(calls(editorFile, "useEditor")).toHaveLength(1);
    expect(calls(editorFile, "new Editor")).toHaveLength(0);
    for (const forbidden of [
      "setContent(",
      "recreate(",
      "createEditor(",
      "format-bar",
    ])
      expect(editorSource).not.toContain(forbidden);
  });

  it("keeps every hook before the early editor null return", () => {
    const earlyReturn = editorSource.indexOf("if (!editor) return null;");
    expect(earlyReturn).toBeGreaterThan(0);
    const tail = editorSource.slice(earlyReturn);
    for (const hook of ["useEditor(", "useState(", "useRef(", "useEffect("])
      expect(tail).not.toContain(hook);
  });

  it("renders the floating toolbar and the persistent edit disclosure", () => {
    expect(editorSource).toContain("editor-selection-toolbar");
    expect(editorSource).toContain("editor-edit__menu");
    expect(editorSource).toContain("<summary>編集</summary>");
    // Pointer presses must not steal the text selection before commands run.
    expect(
      editorSource.match(/onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/g)
        ?.length,
    ).toBeGreaterThanOrEqual(11);
    // The menu is reachable only when open so Escape inside the editor does not
    // treat a closed disclosure as an open menu.
    expect(editorSource).toContain('role={editOpen ? "menu" : undefined}');
    // Escape inside chrome must not propagate to the record close handler.
    expect(editorSource).toContain("event.stopPropagation()");
  });
});

describe("editor-ui-actions.ts dispatches only the existing commands", () => {
  it("dispatches the same mark commands, onLink and nested selection", () => {
    for (const marker of [
      "editor.chain().focus().toggleBold().run()",
      "editor.chain().focus().toggleItalic().run()",
      "editor.chain().focus().toggleCode().run()",
      "actions.onLink()",
      "actions.selectNestedAtCursor()",
    ])
      expect(helperSource).toContain(marker);
  });

  it("routes shared Undo/Redo to the shared bridge before any local history", () => {
    expect(helperSource).toContain("shared.onUndo()");
    expect(helperSource).toContain("shared.onRedo()");
    expect(helperSource).toContain("editor.chain().focus().undo().run()");
    expect(helperSource).toContain("editor.chain().focus().redo().run()");
    const undo = helperSource.indexOf("shared.onUndo()");
    expect(helperSource.indexOf("if (shared)", helperSource.indexOf('"undo"')))
      .toBeLessThan(helperSource.indexOf("editor.chain().focus().undo().run()"));
    expect(undo).toBeGreaterThan(-1);
  });

  it("creates no editor, no save decision and no new Undo history", () => {
    for (const forbidden of [
      "useEditor(",
      "new Editor(",
      "createEditor(",
      "setContent(",
      "closeHistory",
      "addToHistory",
      "view.dispatch",
      "setSelection",
      "window.addEventListener",
      "document.createElement",
    ])
      expect(helperSource).not.toContain(forbidden);
    expect(helperFile.getText()).not.toMatch(/from\s+["']@tiptap\/pm\/history["']/);
  });
});
