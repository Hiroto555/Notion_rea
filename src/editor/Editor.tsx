import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { DOMSerializer, Fragment } from "@tiptap/pm/model";
import { validDocument } from "../shared/validation";
import { fileFits } from "../shared/limits";
import { BlockClipboard, BLOCK_CLIPBOARD_TYPE } from "./block-clipboard";
import {
  useEditor,
  EditorContent,
  type Editor as TiptapEditor,
} from "@tiptap/react";
import {
  Bold,
  Italic,
  Code,
  Undo2,
  Redo2,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Copy,
  Trash2,
  Link2,
} from "lucide-react";
import { composing } from "../shared/keyboard";
import { textOf, type Doc } from "../shared/types";
import {
  editBlocks,
  editNestedBlock,
  resolveTopSelection,
  nestedSiblingRange,
  editNestedSiblings,
  topSiblingRange,
} from "./blocks";
import { closeHistory } from "@tiptap/pm/history";
import type { ChainedCommands } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
export { extensions } from "../shared/editor-schema";
import { extensions } from "../shared/editor-schema";
type Command = {
  name: string;
  hint: string;
  key: string;
  run: (chain: ChainedCommands) => ChainedCommands;
};
const commands: Command[] = [
  {
    name: "テキスト",
    hint: "シンプルな文章",
    key: "text paragraph",
    run: (chain) => chain.setParagraph(),
  },
  ...([1, 2, 3] as const).map((level) => ({
    name: `見出し ${level}`,
    hint: `Heading ${level}`,
    key: `h${level} heading 見出し`,
    run: (chain: ChainedCommands) => chain.setHeading({ level }),
  })),
  {
    name: "箇条書き",
    hint: "Bulleted list",
    key: "bullet list",
    run: (chain) => chain.toggleBulletList(),
  },
  {
    name: "番号付きリスト",
    hint: "Numbered list",
    key: "number ordered",
    run: (chain) => chain.toggleOrderedList(),
  },
  {
    name: "To-do リスト",
    hint: "チェックボックス",
    key: "todo task check",
    run: (chain) => chain.toggleTaskList(),
  },
  {
    name: "トグル",
    hint: "折りたたみできるブロック",
    key: "toggle details",
    run: (chain) => chain.setDetails(),
  },
  {
    name: "引用",
    hint: "Quote",
    key: "quote",
    run: (chain) => chain.toggleBlockquote(),
  },
  {
    name: "コード",
    hint: "Code block",
    key: "code",
    run: (chain) => chain.toggleCodeBlock(),
  },
  {
    name: "区切り線",
    hint: "Divider",
    key: "divider hr",
    run: (chain) => chain.setHorizontalRule(),
  },
];
function matchingCommands(query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const text = `${command.name} ${command.hint} ${command.key}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function Editor({
  documentId,
  doc,
  onChange,
  onReady,
  onLink,
  onError,
  editable = true,
}: {
  documentId: string;
  editable?: boolean;
  doc: Doc;
  onChange: (d: Doc) => void;
  onReady: (e: TiptapEditor) => void;
  onLink: () => void;
  onError: (error: unknown) => void;
}) {
  const [clipboard] = useState(() => new BlockClipboard(documentId));
  const [slash, setSlash] = useState<{
      query: string;
      from: number;
      to: number;
      top: number;
      left: number;
    } | null>(null),
    [choice, setChoice] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [nestedSelected, setNestedSelected] = useState<{
      id: string;
      path: number[];
      ids: string[];
    } | null>(null),
    [nestedHandles, setNestedHandles] = useState<
      { top: number; left: number; id: string; path: number[] }[]
    >([]),
    [handles, setHandles] = useState<
      { top: number; index: number; pos: number; id: string }[]
    >([]);
  const host = useRef<HTMLDivElement>(null),
    slashRef = useRef(slash),
    slashMenu = useRef<HTMLDivElement>(null),
    dismissedSlash = useRef<string | null>(null),
    choiceRef = useRef(choice),
    changeRef = useRef(onChange),
    drag = useRef<string[]>([]),
    nestedDrag = useRef<string | null>(null),
    selectionRef = useRef(selected),
    invalid = useRef(false);
  changeRef.current = onChange;
  slashRef.current = slash;
  choiceRef.current = choice;
  selectionRef.current = selected;
  function apply(e: TiptapEditor, c: Command) {
    if (invalid.current || !e.isEditable) {
      onError("読み取り専用の文書は変更できません。");
      return;
    }
    const s = slashRef.current;
    if (!s) return;
    const { $from, empty } = e.state.selection;
    if (
      !empty ||
      $from.start() !== s.from ||
      $from.pos !== s.to ||
      $from.parent.textBetween(0, $from.parentOffset).toLowerCase() !==
        `/${s.query}`
    ) {
      slashRef.current = null;
      setSlash(null);
      onError("入力位置が変わったためコマンドを取り消しました。");
      return;
    }
    const range = { from: s.from, to: s.to };
    // Check the whole transform first: a command that cannot run must not
    // delete the user's query. Query removal and conversion share one tr.
    if (!c.run(e.can().chain().deleteRange(range)).run()) {
      onError("この位置ではそのブロックへ変換できません。");
      return;
    }
    const chain = e
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr);
        return true;
      })
      .deleteRange(range);
    c.run(chain).run();
    // Keep later typing out of the conversion's Undo event as well.
    e.view.dispatch(closeHistory(e.state.tr));
    slashRef.current = null;
    setSlash(null);
  }
  const editor = useEditor({
    extensions: extensions(),
    content: doc,
    editable,
    enableContentCheck: true,
    onContentError: ({ editor, error }) => {
      invalid.current = true;
      queueMicrotask(() => {
        editor.setEditable(false);
        onError(
          "文書を読めません。原本を保全して編集を停止しました: " +
            error.message,
        );
      });
    },
    editorProps: {
      attributes: {
        class: "folio-editor",
        "aria-label": "ページ本文",
        "data-document-id": documentId,
      },
      handleKeyDown: (view, event) => {
        if (event.defaultPrevented || composing(event)) return false;
        const s = slashRef.current;
        if (!s) return false;
        const list = matchingCommands(s.query);
        if (event.key === "Escape") {
          dismissedSlash.current = `${s.from}:${s.to}:${s.query}`;
          slashRef.current = null;
          setSlash(null);
          return true;
        }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          const next =
            (choiceRef.current +
              (event.key === "ArrowDown" ? 1 : -1) +
              list.length) %
            Math.max(1, list.length);
          choiceRef.current = next;
          setChoice(next);
          return true;
        }
        if (event.key === "Enter" && list.length && editor) {
          apply(editor, list[choiceRef.current % list.length]);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      if (!invalid.current)
        changeRef.current({ ...e.getJSON(), schemaVersion: 1 } as Doc);
    },
    onSelectionUpdate: () => {
      setSelected([]);
      setNestedSelected(null);
    },
  });
  useEffect(() => {
    if (editor && !invalid.current && editor.isEditable !== editable) editor.setEditable(editable, false);
    if (!editable) {
      slashRef.current = null;
      setSlash(null);
    }
  }, [editor, editable]);
  useEffect(() => {
    slashMenu.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [choice, slash?.query]);
  useEffect(() => {
    const forget = () => clipboard.forget();
    window.addEventListener("blur", forget);
    return () => window.removeEventListener("blur", forget);
  }, [clipboard]);
  useEffect(() => {
    if (!editor) return;
    onReady(editor);
    const layout = () => {
      if (!host.current || editor.isDestroyed) return;
      const base = host.current.getBoundingClientRect();
      const result: { top: number; index: number; pos: number; id: string }[] =
        [];
      editor.state.doc.forEach((node, pos, index) => {
        const el = editor.view.nodeDOM(pos);
        if (el instanceof HTMLElement && typeof node.attrs.id === "string")
          result.push({
            id: node.attrs.id,
            top: el.getBoundingClientRect().top - base.top,
            index,
            pos,
          });
      });
      setHandles(result);
      const nested: {
        top: number;
        left: number;
        id: string;
        path: number[];
      }[] = [];
      editor.state.doc.descendants((node, pos, parent, index) => {
        if (parent?.type.name === "doc" || !node.attrs.id) return;
        if (!(
          node.isTextblock ||
          node.isAtom ||
          ["listItem", "taskItem"].includes(node.type.name)
        ))
          return;
        if (["detailsSummary", "detailsContent"].includes(node.type.name))
          return;
        // The first paragraph of a list item occupies the same line as the item;
        // its parent handle already gives access without covering the text.
        if (
          node.type.name === "paragraph" &&
          index === 0 &&
          ["listItem", "taskItem"].includes(parent?.type.name ?? "")
        )
          return;
        const el = editor.view.nodeDOM(pos);
        if (!(el instanceof HTMLElement)) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const $pos = editor.state.doc.resolve(pos);
        const path = Array.from({ length: $pos.depth + 1 }, (_, depth) =>
          $pos.index(depth),
        );
        nested.push({
          top: rect.top - base.top,
          left: Math.max(-27, rect.left - base.left - 24),
          id: node.attrs.id,
          path,
        });
      });
      setNestedHandles(nested);
    };
    const update = () => {
      layout();
      const { $from, empty } = editor.state.selection;
      const text = $from.parent.textBetween(0, $from.parentOffset);
      const match = text.match(/^\/([^\n]*)$/);
      if (editor.isEditable && empty && match) {
        const query = match[1].toLowerCase();
        const signature = `${$from.start()}:${$from.pos}:${query}`;
        if (dismissedSlash.current === signature) return;
        dismissedSlash.current = null;
        const rect = editor.view.coordsAtPos($from.pos),
          base = host.current?.getBoundingClientRect();
        const next = {
          query,
          from: $from.start(),
          to: $from.pos,
          top: rect.bottom - (base?.top ?? 0) + 8,
          left: Math.max(0, rect.left - (base?.left ?? 0)),
        };
        if (
          slashRef.current?.query !== query ||
          slashRef.current.from !== next.from
        ) {
          choiceRef.current = 0;
          setChoice(0);
        }
        slashRef.current = next;
        setSlash(next);
      } else {
        dismissedSlash.current = null;
        slashRef.current = null;
        setSlash(null);
      }
    };
    editor.on("transaction", update);
    const ro = new ResizeObserver(layout);
    if (host.current) ro.observe(host.current);
    requestAnimationFrame(layout);
    return () => {
      editor.off("transaction", update);
      ro.disconnect();
    };
  }, [editor]);
  function manipulate(action: "duplicate" | "delete" | "move", target = 0) {
    if (!editor) return;
    if (invalid.current || !editor.isEditable) {
      onError("読み取り専用の文書は変更できません。");
      return;
    }
    const currentContent = (editor.getJSON().content as Doc[]) ?? [];
    const indices = resolveTopSelection(currentContent, selectionRef.current);
    if (!indices.length) {
      onError("選択したブロックが変更されたため操作を中止しました。");
      setSelected([]);
      return;
    }
    const content = editBlocks(currentContent, indices, action, target);
    const next = editor.schema.nodeFromJSON({ type: "doc", content });
    // A same-position drop must not consume an Undo step.
    if (next.eq(editor.state.doc)) return;
    const tr = closeHistory(editor.state.tr).replaceWith(
      0,
      editor.state.doc.content.size,
      next.content,
    );
    // Keep the cursor near the manipulated blocks. Mapping through a complete
    // replacement otherwise leaves it at the end and Undo/Redo scrolls there.
    const at = Math.max(
      0,
      Math.min(
        next.childCount - 1,
        action === "move"
          ? target - indices.filter((i) => i < target).length
          : Math.min(...indices),
      ),
    );
    let pos = 0;
    next.forEach((_node, offset, index) => {
      if (index === at) pos = offset;
    });
    tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)));
    editor.view.dispatch(tr);
    setSelected([]);
    // Whole-document replacement maps the old cursor; do not scroll a completed
    // pointer operation to that cursor while the user starts the next drag.
    editor.commands.focus(undefined, { scrollIntoView: false });
  }
  function manipulateNested(
    action: "duplicate" | "delete" | "up" | "down" | "before",
    id: string,
    beforeId?: string,
    selectedIds: string[] = [id],
  ) {
    if (!editor) return;
    if (invalid.current || !editor.isEditable) {
      onError("読み取り専用の文書は変更できません。");
      return;
    }
    try {
      const changed =
        action === "before"
          ? editNestedBlock(editor.getJSON() as Doc, id, action, beforeId)
          : editNestedSiblings(editor.getJSON() as Doc, selectedIds, action);
      const next = editor.schema.nodeFromJSON(changed);
      next.check();
      if (next.eq(editor.state.doc)) return;
      const tr = closeHistory(editor.state.tr).replaceWith(
        0,
        editor.state.doc.content.size,
        next.content,
      );
      tr.setSelection(
        Selection.near(
          tr.doc.resolve(
            Math.min(tr.doc.content.size, editor.state.selection.from),
          ),
        ),
      );
      editor.view.dispatch(tr);
      setNestedSelected(null);
      editor.commands.focus(undefined, { scrollIntoView: false });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  function copySelected(
    event: ReactClipboardEvent<HTMLDivElement>,
    operation: "copy" | "cut",
  ) {
    clipboard.forget();
    if (!editor || (!selectionRef.current.length && !nestedSelected)) return;
    event.preventDefault();
    if (operation === "cut" && (invalid.current || !editor.isEditable)) {
      onError("読み取り専用の文書は変更できません。");
      return;
    }
    try {
      const state = editor.state;
      let nodes: import("@tiptap/pm/model").Node[];
      let from: number, to: number;
      let context: "bulletList" | "orderedList" | "taskList" | undefined;
      if (nestedSelected && !selectionRef.current.length) {
        const found: {
          node: import("@tiptap/pm/model").Node;
          pos: number;
          parent: import("@tiptap/pm/model").Node;
          index: number;
        }[] = [];
        state.doc.descendants((node, pos, parent, index) => {
          if (parent && nestedSelected.ids.includes(node.attrs.id))
            found.push({ node, pos, parent, index });
        });
        found.sort((a, b) => a.pos - b.pos);
        if (
          found.length !== nestedSelected.ids.length ||
          found.some(
            (n, i) =>
              n.parent !== found[0].parent ||
              (i > 0 &&
                (n.index !== found[i - 1].index + 1 ||
                  n.pos !== found[i - 1].pos + found[i - 1].node.nodeSize)),
          )
        )
          throw new Error(
            "選択したブロックが変更されたため操作を中止しました。",
          );
        const type = found[0].parent.type.name;
        if (
          type !== "bulletList" &&
          type !== "orderedList" &&
          type !== "taskList"
        )
          throw new Error(
            "このネストブロックのコピー・切り取りはまだ対応していません。",
          );
        if (operation === "cut" && found.length === found[0].parent.childCount)
          throw new Error("最後のブロックは切り取れません。");
        context = type;
        nodes = found.map((n) => n.node);
        from = found[0].pos;
        to =
          found[found.length - 1].pos + found[found.length - 1].node.nodeSize;
      } else {
        const indices = resolveTopSelection(
          (state.doc.toJSON().content as Doc[]) ?? [],
          selectionRef.current,
        );
        if (!indices.length)
          throw new Error(
            "選択したブロックが変更されたため操作を中止しました。",
          );
        nodes = indices.map((i) => state.doc.child(i));
        from = 0;
        for (let i = 0; i < indices[0]; i++)
          from += state.doc.child(i).nodeSize;
        to = from + nodes.reduce((sum, node) => sum + node.nodeSize, 0);
      }
      const raw = clipboard.serialize(nodes, operation, context);
      const div = document.createElement("div");
      div.appendChild(
        DOMSerializer.fromSchema(editor.schema).serializeFragment(
          context
            ? Fragment.from(
                editor.schema.nodes[context].create(
                  null,
                  Fragment.fromArray(nodes),
                ),
              )
            : Fragment.fromArray(nodes),
        ),
      );
      const html = div.innerHTML;
      const plain = nodes.map((n) => textOf(n.toJSON() as Doc)).join("\n");
      let cutTransaction = state.tr;
      if (operation === "cut") {
        cutTransaction = closeHistory(state.tr).delete(from, to);
        cutTransaction.doc.check();
        if (
          !validDocument(cutTransaction.doc.toJSON()) ||
          !fileFits(JSON.stringify(cutTransaction.doc.toJSON()))
        )
          throw new Error("この選択は切り取れません。");
      }
      event.clipboardData.setData(BLOCK_CLIPBOARD_TYPE, raw);
      event.clipboardData.setData("text/html", html);
      event.clipboardData.setData("text/plain", plain);
      if (
        event.clipboardData.getData(BLOCK_CLIPBOARD_TYPE) !== raw ||
        !event.clipboardData.types.includes("text/html") ||
        !event.clipboardData.types.includes("text/plain") ||
        event.clipboardData.getData("text/html") !== html ||
        event.clipboardData.getData("text/plain") !== plain
      )
        throw new Error("クリップボードへの書き込みを確認できません。");
      if (operation === "cut") {
        if (!editor.state.doc.eq(state.doc))
          throw new Error(
            "選択したブロックが変更されたため操作を中止しました。",
          );
        editor.view.dispatch(cutTransaction);
        clipboard.confirmCut(raw);
        setSelected([]);
        setNestedSelected(null);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  function pasteBlocks(event: ReactClipboardEvent<HTMLDivElement>) {
    if (!editor) return;
    if (!event.clipboardData.types.includes(BLOCK_CLIPBOARD_TYPE)) {
      clipboard.forget();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (invalid.current || !editor.isEditable) {
      onError("読み取り専用の文書は変更できません。");
      return;
    }
    try {
      const prepared = clipboard.preparePaste(
        editor.state,
        event.clipboardData.getData(BLOCK_CLIPBOARD_TYPE),
      );
      editor.view.dispatch(prepared.tr);
      prepared.consume();
      setSelected([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  function selectNestedAtCursor() {
    if (!editor) return;
    const $from = editor.state.selection.$from;
    for (let depth = $from.depth; depth >= 2; depth--) {
      const node = $from.node(depth);
      if (node.isBlock && typeof node.attrs.id === "string") {
        const path = Array.from({ length: depth }, (_, index) =>
          $from.index(index),
        );
        setSelected([]);
        setNestedSelected({ id: node.attrs.id, path, ids: [node.attrs.id] });
        return;
      }
    }
  }
  if (!editor) return null;
  const runEditable = (action: () => void) => {
    if (invalid.current || !editor.isEditable) {
      onError("読み取り専用の文書は変更できません。");
      return;
    }
    action();
  };
  const selectedIndices = resolveTopSelection(
    (editor.getJSON().content as Doc[]) ?? [],
    selected,
  );
  const filtered = matchingCommands(slash?.query ?? "");
  return (
    <div className="editor-root">
      <div className="format-bar">
        <button
          title="太字 ⌘B"
          aria-label="太字"
          onClick={() =>
            runEditable(() => {
              editor.chain().focus().toggleBold().run();
            })
          }
        >
          <Bold size={15} />
        </button>
        <button
          title="斜体 ⌘I"
          onClick={() =>
            runEditable(() => {
              editor.chain().focus().toggleItalic().run();
            })
          }
        >
          <Italic size={15} />
        </button>
        <button
          title="コード"
          onClick={() =>
            runEditable(() => {
              editor.chain().focus().toggleCode().run();
            })
          }
        >
          <Code size={15} />
        </button>
        <button title="ページへのリンク" onClick={() => runEditable(onLink)}>
          <Link2 size={15} />
        </button>
        <button
          title="カーソルのネストブロックを選択"
          aria-label="カーソルのネストブロックを選択"
          onClick={selectNestedAtCursor}
        >
          <GripVertical size={15} />
        </button>
        <span />
        <button
          title="元に戻す ⌘Z"
          aria-label="元に戻す"
          onClick={() =>
            runEditable(() => {
              editor.chain().focus().undo().run();
            })
          }
        >
          <Undo2 size={15} />
        </button>
        <button
          title="やり直す ⌘⇧Z"
          aria-label="やり直す"
          onClick={() =>
            runEditable(() => {
              editor.chain().focus().redo().run();
            })
          }
        >
          <Redo2 size={15} />
        </button>
        <small>Markdown · / コマンド</small>
      </div>
      {selected.length > 0 && (
        <div className="block-actions">
          <span>{selected.length} ブロック</span>
          <button
            aria-label="ブロックを上へ"
            onClick={() => manipulate("move", Math.min(...selectedIndices) - 1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            aria-label="ブロックを下へ"
            onClick={() => manipulate("move", Math.max(...selectedIndices) + 2)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            aria-label="ブロックを複製"
            onClick={() => manipulate("duplicate")}
          >
            <Copy size={14} />
          </button>
          <button
            aria-label="ブロックを削除"
            onClick={() => manipulate("delete")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
      {nestedSelected && (
        <div className="block-actions" aria-label="ネストブロック操作">
          <span>
            ネスト {nestedSelected.path.map((n) => n + 1).join(".")} (
            {nestedSelected.ids.length} ブロック)
          </span>
          <button
            aria-label="ネストブロックを上へ"
            onClick={() =>
              manipulateNested(
                "up",
                nestedSelected.id,
                undefined,
                nestedSelected.ids,
              )
            }
          >
            <ArrowUp size={14} />
          </button>
          <button
            aria-label="ネストブロックを下へ"
            onClick={() =>
              manipulateNested(
                "down",
                nestedSelected.id,
                undefined,
                nestedSelected.ids,
              )
            }
          >
            <ArrowDown size={14} />
          </button>
          <button
            aria-label="ネストブロックを複製"
            onClick={() =>
              manipulateNested(
                "duplicate",
                nestedSelected.id,
                undefined,
                nestedSelected.ids,
              )
            }
          >
            <Copy size={14} />
          </button>
          <button
            aria-label="ネストブロックを削除"
            onClick={() =>
              manipulateNested(
                "delete",
                nestedSelected.id,
                undefined,
                nestedSelected.ids,
              )
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
      <div
        ref={host}
        className="editor-host"
        onCopy={(event) => copySelected(event, "copy")}
        onCut={(event) => copySelected(event, "cut")}
        onPasteCapture={pasteBlocks}
        onKeyDown={(event) => {
          if (event.defaultPrevented || composing(event.nativeEvent)) return;
          if ((selected.length || nestedSelected) && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setSelected([]);
            setNestedSelected(null);
            return;
          }
          if (
            nestedSelected &&
            (event.key === "Backspace" || event.key === "Delete")
          ) {
            event.preventDefault();
            manipulateNested(
              "delete",
              nestedSelected.id,
              undefined,
              nestedSelected.ids,
            );
            return;
          }
          if (
            selected.length &&
            (event.key === "Backspace" || event.key === "Delete")
          ) {
            event.preventDefault();
            manipulate("delete");
          }
        }}
      >
        <EditorContent editor={editor} />
        {handles.map((h) => (
          <button
            key={h.index}
            aria-label={`ブロック ${h.index + 1} を選択`}
            title="ドラッグで移動・Shiftクリックで複数選択"
            className={
              "block-handle " + (selected.includes(h.id) ? "selected" : "")
            }
            style={{ top: h.top }}
            draggable
            onDragStart={(event) => {
              drag.current = selected.includes(h.id) ? selected : [h.id];
              event.dataTransfer.setData(
                "application/x-folio-blocks",
                JSON.stringify(drag.current),
              );
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              drag.current = [];
            }}
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes("application/x-folio-blocks")
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (
                !drag.current.length ||
                event.dataTransfer.getData("application/x-folio-blocks") !==
                  JSON.stringify(drag.current)
              )
                return;
              const content = (editor.getJSON().content as Doc[]) ?? [];
              const target = content.findIndex(
                (node) => node.attrs?.id === h.id,
              );
              if (target < 0) {
                onError("移動先のブロックが変更されたため操作を中止しました。");
                return;
              }
              selectionRef.current = drag.current;
              manipulate("move", target);
            }}
            onClick={(event) => {
              const nodes = (editor.getJSON().content as Doc[]) ?? [];
              const target = nodes.findIndex((n) => n.attrs?.id === h.id);
              if (target < 0) {
                onError("対象ブロックが変更されたため選択を中止しました。");
                return;
              }
              setNestedSelected(null);
              setSelected((prev) => {
                if (!event.shiftKey || !prev.length) return [h.id];
                return topSiblingRange(nodes, prev[0], h.id);
              });
            }}
          >
            <GripVertical size={15} />
          </button>
        ))}
        {nestedHandles.map((h) => (
          <button
            key={h.id}
            aria-label={`ネストブロック ${h.path.map((n) => n + 1).join(".")} を選択`}
            title="ドラッグで対象の前へ移動"
            className={
              "block-handle " +
              (nestedSelected?.ids.includes(h.id) ? "selected" : "")
            }
            style={{ top: h.top, left: h.left, width: 18 }}
            draggable
            onDragStart={(event) => {
              if (nestedSelected && nestedSelected.ids.length > 1) {
                event.preventDefault();
                nestedDrag.current = null;
                onError(
                  "複数のネストブロックのドラッグ移動はまだ対応していません。上下の移動ボタンを使用してください。",
                );
                return;
              }
              nestedDrag.current = h.id;
              event.dataTransfer.setData(
                "application/x-folio-nested-block",
                h.id,
              );
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              nestedDrag.current = null;
            }}
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes(
                  "application/x-folio-nested-block",
                )
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const id = event.dataTransfer.getData(
                "application/x-folio-nested-block",
              );
              if (nestedSelected && nestedSelected.ids.length > 1) {
                nestedDrag.current = null;
                onError(
                  "複数のネストブロックのドラッグ移動はまだ対応していません。上下の移動ボタンを使用してください。",
                );
                return;
              }
              if (id && id === nestedDrag.current)
                manipulateNested("before", id, h.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              setSelected([]);
              const range =
                event.shiftKey && nestedSelected
                  ? nestedSiblingRange(
                      editor.getJSON() as Doc,
                      nestedSelected.id,
                      h.id,
                    )
                  : [];
              setNestedSelected({
                id: range.length ? nestedSelected!.id : h.id,
                path: h.path,
                ids: range.length ? range : [h.id],
              });
            }}
          >
            <GripVertical size={15} />
          </button>
        ))}
        <div
          className="block-end-drop"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("application/x-folio-blocks"))
              e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (
              !drag.current.length ||
              e.dataTransfer.getData("application/x-folio-blocks") !==
                JSON.stringify(drag.current)
            )
              return;
            selectionRef.current = drag.current;
            manipulate("move", editor.state.doc.childCount);
          }}
        />
        {slash && (
          <div
            className="slash-menu"
            ref={slashMenu}
            role="listbox"
            aria-label="ブロックコマンド"
            style={{ top: slash.top, left: slash.left }}
          >
            <div className="menu-caption">ブロックを挿入</div>
            {filtered.length ? (
              filtered.map((c, i) => (
                <button
                  role="option"
                  aria-selected={i === choice}
                  key={c.name}
                  className={i === choice ? "active" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => apply(editor, c)}
                >
                  <span className="command-symbol">
                    {c.key.startsWith("h")
                      ? c.key.slice(0, 2).toUpperCase()
                      : "⁝"}
                  </span>
                  <span>
                    {c.name}
                    <small>{c.hint}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>該当するコマンドがありません</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
