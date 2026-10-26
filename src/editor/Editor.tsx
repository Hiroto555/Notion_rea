import { useEffect, useRef, useState } from "react";
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
import type { Doc } from "../shared/types";
import { editBlocks } from "./blocks";
export { extensions } from "../shared/editor-schema";
import { extensions } from "../shared/editor-schema";
type Command = {
  name: string;
  hint: string;
  key: string;
  run: (e: TiptapEditor) => void;
};
const commands: Command[] = [
  {
    name: "テキスト",
    hint: "シンプルな文章",
    key: "text paragraph",
    run: (e) => {
      e.chain().focus().setParagraph().run();
    },
  },
  ...([1, 2, 3] as const).map((level) => ({
    name: `見出し ${level}`,
    hint: `Heading ${level}`,
    key: `h${level} heading 見出し`,
    run: (e: TiptapEditor) => {
      e.chain().focus().toggleHeading({ level }).run();
    },
  })),
  {
    name: "箇条書き",
    hint: "Bulleted list",
    key: "bullet list",
    run: (e) => {
      e.chain().focus().toggleBulletList().run();
    },
  },
  {
    name: "番号付きリスト",
    hint: "Numbered list",
    key: "number ordered",
    run: (e) => {
      e.chain().focus().toggleOrderedList().run();
    },
  },
  {
    name: "To-do リスト",
    hint: "チェックボックス",
    key: "todo task check",
    run: (e) => {
      e.chain().focus().toggleTaskList().run();
    },
  },
  {
    name: "トグル",
    hint: "折りたたみできるブロック",
    key: "toggle details",
    run: (e) => {
      e.chain().focus().setDetails().run();
    },
  },
  {
    name: "引用",
    hint: "Quote",
    key: "quote",
    run: (e) => {
      e.chain().focus().toggleBlockquote().run();
    },
  },
  {
    name: "コード",
    hint: "Code block",
    key: "code",
    run: (e) => {
      e.chain().focus().toggleCodeBlock().run();
    },
  },
  {
    name: "区切り線",
    hint: "Divider",
    key: "divider hr",
    run: (e) => {
      e.chain().focus().setHorizontalRule().run();
    },
  },
];
export function Editor({
  doc,
  onChange,
  onReady,
  onLink,
  onError,
}: {
  doc: Doc;
  onChange: (d: Doc) => void;
  onReady: (e: TiptapEditor) => void;
  onLink: () => void;
  onError: (error: unknown) => void;
}) {
  const [slash, setSlash] = useState<{
      query: string;
      from: number;
      to: number;
      top: number;
      left: number;
    } | null>(null),
    [choice, setChoice] = useState(0),
    [selected, setSelected] = useState<number[]>([]),
    [handles, setHandles] = useState<
      { top: number; index: number; pos: number }[]
    >([]);
  const host = useRef<HTMLDivElement>(null),
    slashRef = useRef(slash),
    choiceRef = useRef(choice),
    changeRef = useRef(onChange),
    drag = useRef<number[]>([]),
    selectionRef = useRef(selected),
    invalid = useRef(false);
  changeRef.current = onChange;
  slashRef.current = slash;
  choiceRef.current = choice;
  selectionRef.current = selected;
  function apply(e: TiptapEditor, c: Command) {
    const s = slashRef.current;
    if (s) e.chain().focus().deleteRange({ from: s.from, to: s.to }).run();
    setSlash(null);
    c.run(e);
  }
  const editor = useEditor({
    extensions: extensions(),
    content: doc,
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
      attributes: { class: "folio-editor", "aria-label": "ページ本文" },
      handleKeyDown: (view, event) => {
        if (event.defaultPrevented || composing(event)) return false;
        const s = slashRef.current;
        if (!s) return false;
        const list = commands.filter((c) =>
          (c.name + " " + c.key).toLowerCase().includes(s.query),
        );
        if (event.key === "Escape") {
          setSlash(null);
          return true;
        }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          setChoice(
            (i) =>
              (i + (event.key === "ArrowDown" ? 1 : -1) + list.length) %
              Math.max(1, list.length),
          );
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
    onSelectionUpdate: () => setSelected([]),
  });
  useEffect(() => {
    if (!editor) return;
    onReady(editor);
    const layout = () => {
      if (!host.current || editor.isDestroyed) return;
      const base = host.current.getBoundingClientRect();
      const result: { top: number; index: number; pos: number }[] = [];
      editor.state.doc.forEach((_n, pos, index) => {
        const el = editor.view.nodeDOM(pos);
        if (el instanceof HTMLElement)
          result.push({
            top: el.getBoundingClientRect().top - base.top,
            index,
            pos,
          });
      });
      setHandles(result);
    };
    const update = () => {
      layout();
      const { $from, empty } = editor.state.selection;
      const text = $from.parent.textBetween(0, $from.parentOffset);
      const match = text.match(/^\/([^\n]*)$/);
      if (empty && match) {
        const rect = editor.view.coordsAtPos($from.pos),
          base = host.current?.getBoundingClientRect();
        setSlash({
          query: match[1].toLowerCase(),
          from: $from.start(),
          to: $from.pos,
          top: rect.bottom - (base?.top ?? 0) + 8,
          left: Math.max(0, rect.left - (base?.left ?? 0)),
        });
        setChoice(0);
      } else setSlash(null);
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
    const content = editBlocks(
      (editor.getJSON().content as Doc[]) ?? [],
      selectionRef.current,
      action,
      target,
    );
    const next = editor.schema.nodeFromJSON({ type: "doc", content });
    editor.view.dispatch(
      editor.state.tr.replaceWith(
        0,
        editor.state.doc.content.size,
        next.content,
      ),
    );
    setSelected([]);
    editor.commands.focus();
  }
  if (!editor) return null;
  const filtered = commands.filter((c) =>
    (c.name + " " + c.key).toLowerCase().includes(slash?.query ?? ""),
  );
  return (
    <div className="editor-root">
      <div className="format-bar">
        <button
          title="太字 ⌘B"
          aria-label="太字"
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={15} />
        </button>
        <button
          title="斜体 ⌘I"
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={15} />
        </button>
        <button
          title="コード"
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code size={15} />
        </button>
        <button title="ページへのリンク" onClick={onLink}>
          <Link2 size={15} />
        </button>
        <span />
        <button
          title="元に戻す ⌘Z"
          aria-label="元に戻す"
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 size={15} />
        </button>
        <button
          title="やり直す ⌘⇧Z"
          aria-label="やり直す"
          onClick={() => editor.chain().focus().redo().run()}
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
            onClick={() => manipulate("move", Math.min(...selected) - 1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            aria-label="ブロックを下へ"
            onClick={() => manipulate("move", Math.max(...selected) + 2)}
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
      <div
        ref={host}
        className="editor-host"
        onKeyDown={(event) => {
          if (event.defaultPrevented || composing(event.nativeEvent)) return;
          if (selected.length && event.key === "Escape") setSelected([]);
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
              "block-handle " + (selected.includes(h.index) ? "selected" : "")
            }
            style={{ top: h.top }}
            draggable
            onDragStart={(event) => {
              drag.current = selected.includes(h.index) ? selected : [h.index];
              event.dataTransfer.setData(
                "application/x-folio-blocks",
                JSON.stringify(drag.current),
              );
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes("application/x-folio-blocks")
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              selectionRef.current = drag.current;
              manipulate("move", h.index);
            }}
            onClick={(event) => {
              setSelected((prev) =>
                event.shiftKey && prev.length
                  ? Array.from(
                      { length: Math.abs(h.index - prev[0]) + 1 },
                      (_, i) => Math.min(h.index, prev[0]) + i,
                    )
                  : [h.index],
              );
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
            selectionRef.current = drag.current;
            manipulate("move", handles.length);
          }}
        />
        {slash && (
          <div
            className="slash-menu"
            role="listbox"
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
