import { projectSharedDocument } from "./shared-projection";
import {sharedImage,type SharedImageResolver} from "./shared-image";
import { RichBlockControls } from "./RichBlockControls";
import "./rich-blocks.css";
import "./editor-chrome.css";
import {
  blurTransactionFocusTarget,
  placeFloatingToolbar,
  runEditorUiCommand,
  selectionToolbarFocusTarget,
  selectionToolbarOwnsFocus,
  selectionToolbarVisible,
  shouldRestoreMenuFocus,
  type EditorUiCommand,
} from "./editor-ui-actions";
import { RichStructureGuard } from "./rich-structure-guard";
import { assertSupportedRichHTML } from "../document-io/rich-html-guard";
import { versionDocument } from "../shared/rich-document";
import {
  useEffect,
  useLayoutEffect,
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
import {
  blockHandleClass,
  caretCueVisible,
  caretTargetAt,
  nestedHandleEligible,
  resolveElementHit,
} from "./block-affordance";
import { closeHistory } from "@tiptap/pm/history";
import type { ChainedCommands } from "@tiptap/core";
import { Selection, type Transaction } from "@tiptap/pm/state";
export { extensions } from "../shared/editor-schema";
import { extensions } from "../shared/editor-schema";
type Command = {
  name: string;
  hint: string;
  key: string;
  run: (chain: ChainedCommands) => ChainedCommands;
};
const commands: Command[] = [
  {name: "簡易表", hint: "本文に3行・3列の表を追加", key: "table 表", run: chain => chain.insertSimpleTable()},
  {name: "コールアウト", hint: "メモ・ヒント・注意を目立たせる", key: "callout メモ 注意", run: chain => chain.setCallout()},
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
  shared,
}: {
  documentId: string;
  editable?: boolean;
  shared?:{revision:string;onUndo:()=>void;onRedo:()=>void;isComposing?:()=>boolean;resolveImage?:SharedImageResolver};
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
    >([]),
    [selectionBar, setSelectionBar] = useState<{
      top: number;
      left: number;
    } | null>(null),
    [nearby, setNearby] = useState<string | null>(null),
    [caretBlock, setCaretBlock] = useState<string | null>(null),
    [kbd, setKbd] = useState(false),
    [bodyFocus, setBodyFocus] = useState(false),
    [editOpen, setEditOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null),
    root = useRef<HTMLDivElement>(null),
    slashRef = useRef(slash),
    slashMenu = useRef<HTMLDivElement>(null),
    selectionBarEl = useRef<HTMLDivElement>(null),
    editMenu = useRef<HTMLDetailsElement>(null),
    dismissedSlash = useRef<string | null>(null),
    choiceRef = useRef(choice),
    changeRef = useRef(onChange),
    readyRef = useRef(onReady),
    sharedRef = useRef(shared),
    syncBarRef = useRef<() => void>(() => {}),
    rehitRef = useRef<() => void>(() => {}),
    keyboardFocus = useRef(false),
    windowFocused = useRef(true),
    drag = useRef<string[]>([]),
    nestedDrag = useRef<string | null>(null),
    selectionRef = useRef(selected),
    nearbyRef = useRef<string | null>(null),
    affordance = useRef<{
      resolve: (target: EventTarget | null, x: number, y: number) => void;
      leave: () => void;
    } | null>(null),
    invalid = useRef(false);
  changeRef.current = onChange;
  readyRef.current = onReady;
  sharedRef.current = shared;
  slashRef.current = slash;
  choiceRef.current = choice;
  selectionRef.current = selected;
  function closeEditMenu(restoreFocus = false) {
    const menu = editMenu.current;
    const restore =
      restoreFocus &&
      shouldRestoreMenuFocus({
        open: !!menu?.open,
        menu,
        active: document.activeElement,
      });
    if (menu?.open) menu.open = false;
    setEditOpen(false);
    // Restore only when focus is still inside the menu being hidden. A body
    // focus, a link dialog or an outside pane is never pulled back here.
    if (restore) menu?.querySelector<HTMLElement>("summary")?.focus();
  }
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
    extensions: [...(shared?.resolveImage?[...extensions({sharedHistory:true}).filter(extension=>extension.name!=="image"),sharedImage(shared.resolveImage)]:extensions({sharedHistory:!!shared})), RichStructureGuard.configure({onRejected: () => onError("この操作では表の形を保てません。内容を保持しています。")})],
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
      // Let native IME confirmation continue without running any editor keymap.
      // handleDOMEvents does not preventDefault when it returns true.
      handleDOMEvents: {keydown: (_view, event) => composing(event)},
      attributes: {
        class: "folio-editor",
        "aria-label": "ページ本文",
        "data-document-id": documentId,
      },
      handleKeyDown: (view, event) => {
        if (event.defaultPrevented || composing(event)) return false;
        if(shared&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="z"){event.preventDefault();if(event.shiftKey)shared.onRedo();else shared.onUndo();return true;}
        const s = slashRef.current;
        if (!s) return false;
        const list = matchingCommands(s.query);
        if (event.key === "Escape") {
          // Slash owns Escape first; keep the close from reaching the page.
          event.preventDefault();
          event.stopPropagation();
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
    onUpdate: ({ editor: e, transaction }) => {
      if (!invalid.current && !transaction.getMeta("folio.shared.projection"))
        changeRef.current(versionDocument(e.getJSON() as Doc));
    },
    onSelectionUpdate: () => {
      setSelected([]);
      setNestedSelected(null);
    },
  });
  useEffect(() => {
    if (!editor || !shared || invalid.current || shared.isComposing?.()) return;
    try {
      const target = editor.schema.nodeFromJSON(doc);
      const projection = projectSharedDocument(editor.state.doc, target);
      if (projection.steps.length) {
        const transaction = editor.state.tr;
        for (const step of projection.steps) transaction.step(step);
        transaction.setMeta("folio.shared.projection", true).setMeta("addToHistory", false).setMeta("preventUpdate", true);
        editor.view.dispatch(transaction);
      }
    } catch (error) { invalid.current = true; editor.setEditable(false, false); onError(error); }
  }, [editor, shared?.revision]);
  useEffect(() => {
    if (editor && !invalid.current && editor.isEditable !== editable) editor.setEditable(editable, false);
    if (!editable) {
      slashRef.current = null;
      setSlash(null);
    }
    // Editable changes affect the bar's display state, not the editor identity.
    syncBarRef.current();
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
    // Instance lifetime only: changing `editable` must not re-announce a
    // ready editor, recreate the editor, or replace its session/key.
    readyRef.current(editor);
  }, [editor]);
  useLayoutEffect(() => {
    // Re-hit only after React commits the freshly positioned handles. A
    // same-height reorder would otherwise resolve the previous frame's grip
    // geometry and keep lighting the block the pointer used to be over.
    rehitRef.current();
  }, [handles, nestedHandles]);
  useEffect(() => {
    if (!editor) return;
    const computeBar = (active: Element | null | undefined) => {
      if (!host.current || editor.isDestroyed) return null;
      if (
        !selectionToolbarVisible(editor, invalid.current, sharedRef.current)
      )
        return null;
      // A stale non-empty selection alone is not enough. This Editor or its
      // own chrome must own focus; external panes/editors must hide the bar.
      if (
        !selectionToolbarOwnsFocus({
          active,
          editorDom: editor.view.dom,
          chrome: root.current,
          keyboard: keyboardFocus.current,
          // A deactivated window is external focus too, even though
          // activeElement can still point at the old editor node.
          windowFocused: windowFocused.current,
        })
      )
        return null;
      try {
        const { from, to } = editor.state.selection;
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to, -1);
        const base = host.current.getBoundingClientRect();
        const bar = selectionBarEl.current;
        return placeFloatingToolbar({
          host: { top: base.top, left: base.left },
          selection: {
            top: Math.min(start.top, end.top),
            bottom: Math.max(start.bottom, end.bottom),
            left: start.left,
          },
          toolbar: {
            width: bar?.offsetWidth || 176,
            height: bar?.offsetHeight || 40,
          },
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        });
      } catch {
        return null;
      }
    };
    // The affordance modality is separate from the toolbar's keyboardFocus
    // ref: a real pointer move/dragover ends the keyboard cue; a Tab starts it
    // again. Only the focused own body may show its caret handle.
    let affordanceKbd = false;
    // The localized caret cue is owned by this instance's focused body only:
    // keyboard modality plus real DOM focus inside this editor's content.
    // Tab into another editor, the sidebar or any pointer use keeps it dark.
    const syncKbd = (active: Element | null | undefined) => {
      const ownsBody =
        !!active &&
        windowFocused.current &&
        editor.view.dom.contains(active);
      setBodyFocus(ownsBody);
      setKbd(
        caretCueVisible({
          keyboard: affordanceKbd,
          windowFocused: windowFocused.current,
          ownsBody,
        }),
      );
    };
    const syncBarWith = (active: Element | null | undefined) => {
      syncKbd(active);
      const next = computeBar(active);
      setSelectionBar((previous) =>
        previous && next && previous.top === next.top && previous.left === next.left
          ? previous
          : next,
      );
    };
    // Ordinary updates read the actual active element. Only focusout passes
    // the next focus (relatedTarget) instead, because activeElement has not
    // moved yet at capture time.
    const syncBar = () => syncBarWith(document.activeElement);
    syncBarRef.current = syncBar;
    // Pointer tracking stays on this instance's own host. The single nearby
    // handle comes from the real hit element — a gutter grip's own id, or the
    // innermost block element mapped through the shared eligibility — never a
    // nearest-caret guess. No transaction or selection is touched.
    const pointer = { active: false, x: 0, y: 0 };
    const setNearbyIfChanged = (next: string | null) => {
      if (next === nearbyRef.current) return;
      nearbyRef.current = next;
      setNearby(next);
    };
    const asElement = (hit: EventTarget | null): Element | null => {
      if (hit instanceof Element) return hit;
      if (hit instanceof Node) return hit.parentElement;
      return null;
    };
    // The layout indexes each actually rendered eligible block element (the
    // same nodeDOM result used to position its handle) and every live handle
    // id. Rebuilt per layout; no document positions or sibling guesses.
    const hitIndex = new Map<Element, string>();
    const liveIds = new Set<string>();
    const resolveHit = (hit: EventTarget | null): string | null =>
      resolveElementHit({
        hit: asElement(hit),
        root: host.current,
        index: hitIndex,
        live: liveIds,
      });
    // Re-hit whatever is actually under a possibly stationary pointer so a
    // block that moved, split or vanished — or chrome now covering the spot —
    // never leaves a stale handle lit.
    const rehitPointer = () => {
      if (!pointer.active || !host.current) return;
      const hit = host.current.ownerDocument.elementFromPoint(
        pointer.x,
        pointer.y,
      );
      setNearbyIfChanged(resolveHit(hit));
    };
    rehitRef.current = rehitPointer;
    affordance.current = {
      resolve(target, x, y) {
        // A real pointer move/dragover switches to pointer modality: the
        // keyboard caret cue hides so the nearby handle stays the single grip.
        affordanceKbd = false;
        setKbd(false);
        pointer.active = true;
        pointer.x = x;
        pointer.y = y;
        setNearbyIfChanged(resolveHit(target));
      },
      leave() {
        pointer.active = false;
        setNearbyIfChanged(null);
      },
    };
    const layout = (focus?: { active: Element | null }) => {
      if (!host.current || editor.isDestroyed) return;
      const base = host.current.getBoundingClientRect();
      // Every indexed element is one the pointer can actually hit; only
      // eligible rendered blocks enter, so excluded children (list first
      // paragraphs, cell contents) resolve through their indexed ancestor
      // and custom NodeViews need no special case.
      hitIndex.clear();
      liveIds.clear();
      const result: { top: number; index: number; pos: number; id: string }[] =
        [];
      editor.state.doc.forEach((node, pos, index) => {
        const el = editor.view.nodeDOM(pos);
        if (el instanceof HTMLElement && typeof node.attrs.id === "string") {
          hitIndex.set(el, node.attrs.id);
          liveIds.add(node.attrs.id);
          result.push({
            id: node.attrs.id,
            top: el.getBoundingClientRect().top - base.top,
            index,
            pos,
          });
        }
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
        if (!nestedHandleEligible(node, parent, index)) return;
        const el = editor.view.nodeDOM(pos);
        if (!(el instanceof HTMLElement)) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        hitIndex.set(el, node.attrs.id);
        liveIds.add(node.attrs.id);
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
      // The caret block's own handle is the localized keyboard cue; it follows
      // the selection head without a transaction, selection change or history.
      const caret =
        caretTargetAt(editor.state.doc, editor.state.selection)?.id ?? null;
      setCaretBlock((previous) => (previous === caret ? previous : caret));
      // Re-hitting under a possibly stationary pointer happens in the
      // post-commit layout effect (fresh grip geometry) and on scroll.
      syncBarWith(focus ? focus.active : document.activeElement);
    };
    // ResizeObserver and requestAnimationFrame pass their own argument; this
    // no-arg wrapper keeps it from being read as a focus target.
    const layoutFromViewport = () => layout();
    const update = (event: { transaction: Transaction }) => {
      // Tiptap's blur transaction carries the native event. Use its
      // relatedTarget when present, while ordinary transactions keep reading
      // the actual active element.
      layout(blurTransactionFocusTarget(event.transaction.getMeta("blur")));
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
    const ro = new ResizeObserver(layoutFromViewport);
    if (host.current) ro.observe(host.current);
    requestAnimationFrame(layoutFromViewport);
    const onScroll = () => {
      syncBar();
      // Scrolling moves the document under a stationary pointer; re-hit it.
      rehitPointer();
    };
    window.addEventListener("resize", syncBar);
    window.addEventListener("scroll", onScroll, true);
    editor.view.dom.addEventListener("compositionstart", syncBar);
    editor.view.dom.addEventListener("compositionend", syncBar);
    // Focus ownership is re-evaluated on every focus move and window blur.
    // The button/pointer distinction is tracked only for this instance's
    // chrome so another pane or editor can never inherit this bar.
    const onFocusIn = () => syncBarWith(document.activeElement);
    const onFocusOut = (event: FocusEvent) => {
      // Capture-time focusout runs before document.activeElement moves, so
      // the element about to receive focus decides ownership. A body→own-bar
      // Tab move therefore keeps the conditional bar it is entering.
      const related =
        event.relatedTarget instanceof Element ? event.relatedTarget : null;
      syncBarWith(
        selectionToolbarFocusTarget({
          active: document.activeElement,
          relatedTarget: related,
          leaving: true,
        }),
      );
    };
    const onWindowFocus = () => {
      windowFocused.current = true;
      syncBar();
    };
    const onWindowBlur = () => {
      // A deactivated window is always non-owned, whatever activeElement says.
      windowFocused.current = false;
      syncBar();
      pointer.active = false;
      setNearbyIfChanged(null);
    };
    const onPointerDown = () => {
      keyboardFocus.current = false;
      affordanceKbd = false;
      syncKbd(document.activeElement);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        keyboardFocus.current = true;
        affordanceKbd = true;
        // Keyboard navigation abandons this instance's pointer target even
        // while focus lives elsewhere, and disarms the cached pointer so the
        // next layout cannot re-enable a stale nearby handle.
        pointer.active = false;
        setNearbyIfChanged(null);
        syncKbd(document.activeElement);
      }
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      syncBarRef.current = () => {};
      rehitRef.current = () => {};
      affordance.current = null;
      editor.off("transaction", update);
      ro.disconnect();
      window.removeEventListener("resize", syncBar);
      window.removeEventListener("scroll", onScroll, true);
      editor.view.dom.removeEventListener("compositionstart", syncBar);
      editor.view.dom.removeEventListener("compositionend", syncBar);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
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
      if (!validDocument(changed)) throw new Error("この操作では表の形を保てません。内容を保持しています。");
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
      try {
        const html = event.clipboardData.getData("text/html");
        assertSupportedRichHTML(html);
        const {$from} = editor.state.selection;
        if (/<table\b/i.test(html) && Array.from({length:$from.depth}, (_,i)=>$from.node(i+1).type.name).some(name=>name === "tableCell" || name === "tableHeader"))
          throw new Error("表全体はセルの中に貼り付けられません。表の外に貼り付けてください。内容を保持しています。");
      }
      catch (error) { event.preventDefault(); event.stopPropagation(); onError(error); }
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
    for (let depth = $from.depth; depth >= 1; depth--) {
      const node = $from.node(depth);
      if (["tableRow", "tableCell", "tableHeader"].includes(node.type.name) ||
          ["tableCell", "tableHeader"].includes($from.node(depth - 1).type.name)) continue;
      if (depth === 1) {
        if (node.type.name === "table" && typeof node.attrs.id === "string") {setSelected([node.attrs.id]); setNestedSelected(null);}
        return;
      }
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
  const runUiCommand = (command: EditorUiCommand, closeMenu = false) => {
    const ran = runEditorUiCommand(
      {
        editor,
        invalid: invalid.current,
        shared,
        actions: { onLink, selectNestedAtCursor, onError },
      },
      command,
    );
    // A successful edit-menu command must not leave a stale open menu behind.
    // If focus never left the menu (shared Undo/Redo, nested, link), restoring
    // it to the visible summary keeps the keyboard start point; commands that
    // already focused the body are left untouched.
    if (ran && closeMenu) closeEditMenu(true);
    return ran;
  };
  const selectedIndices = resolveTopSelection(
    (editor.getJSON().content as Doc[]) ?? [],
    selected,
  );
  const filtered = matchingCommands(slash?.query ?? "");
  return (
    <div ref={root} className="editor-root">
      <details
        ref={editMenu}
        className="editor-edit"
        onToggle={() => setEditOpen(!!editMenu.current?.open)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          // Focus leaving the disclosure closes the stale menu; never pull
          // focus back from the body to a menu that is already gone.
          closeEditMenu();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !editMenu.current?.open) return;
          if (composing(event.nativeEvent)) return;
          event.preventDefault();
          event.stopPropagation();
          // Focus was inside the open menu, so return it to the summary that
          // remains visible. No menu item or editor transaction is touched.
          closeEditMenu(true);
        }}
      >
        <summary>編集</summary>
        <div
          className="editor-edit__menu"
          role={editOpen ? "menu" : undefined}
          aria-label="編集"
        >
          <button
            type="button"
            title="太字 ⌘B"
            aria-label="太字"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("bold", true)}
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            title="斜体 ⌘I"
            aria-label="斜体"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("italic", true)}
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            title="コード"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("code", true)}
          >
            <Code size={15} />
          </button>
          <button
            type="button"
            title="ページへのリンク"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("link", true)}
          >
            <Link2 size={15} />
          </button>
          <button
            type="button"
            title="カーソルのネストブロックを選択"
            aria-label="カーソルのネストブロックを選択"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("nested", true)}
          >
            <GripVertical size={15} />
          </button>
          <button
            type="button"
            title="元に戻す ⌘Z"
            aria-label="元に戻す"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("undo", true)}
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            title="やり直す ⌘⇧Z"
            aria-label="やり直す"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runUiCommand("redo", true)}
          >
            <Redo2 size={15} />
          </button>
          <small>Markdown · / コマンド</small>
        </div>
      </details>
      <RichBlockControls editor={editor} disabled={invalid.current || !editable} onError={onError} />
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
        className={`editor-host${kbd ? " kbd" : ""}${bodyFocus ? " body" : ""}`}
        onPointerMove={(event) =>
          affordance.current?.resolve(
            event.target,
            event.clientX,
            event.clientY,
          )
        }
        onPointerLeave={() => affordance.current?.leave()}
        onDragOver={(event) =>
          affordance.current?.resolve(
            event.target,
            event.clientX,
            event.clientY,
          )
        }
        onCopy={(event) => copySelected(event, "copy")}
        onCut={(event) => copySelected(event, "cut")}
        onPasteCapture={pasteBlocks}
        onDropCapture={(event) => {
          try {
            const html = event.dataTransfer.getData("text/html");
            assertSupportedRichHTML(html);
            if (/<table\b/i.test(html) && event.target instanceof Element && event.target.closest("td, th"))
              throw new Error("表全体はセルの中に移動できません。内容を保持しています。");
          }
          catch (error) { event.preventDefault(); event.stopPropagation(); onError(error); }
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || composing(event.nativeEvent)) return;
          if ((selected.length || nestedSelected) && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setSelected([]);
            setNestedSelected(null);
            return;
          }
          if (event.key === "Escape" && editMenu.current?.open) {
            // Slash/block Escape already won above; this closes only the
            // chrome disclosure. Focus stays in the body and the selection
            // is left untouched.
            event.preventDefault();
            event.stopPropagation();
            closeEditMenu();
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
        {selectionBar && (
          <div
            ref={selectionBarEl}
            className="editor-selection-toolbar"
            role="toolbar"
            aria-label="選択したテキストの書式"
            style={{ top: selectionBar.top, left: selectionBar.left }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                editor.commands.focus();
              }
            }}
          >
            <button
              type="button"
              title="太字 ⌘B"
              aria-label="太字"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runUiCommand("bold")}
            >
              <Bold size={15} />
            </button>
            <button
              type="button"
              title="斜体 ⌘I"
              aria-label="斜体"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runUiCommand("italic")}
            >
              <Italic size={15} />
            </button>
            <button
              type="button"
              title="コード"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runUiCommand("code")}
            >
              <Code size={15} />
            </button>
            <button
              type="button"
              title="ページへのリンク"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runUiCommand("link")}
            >
              <Link2 size={15} />
            </button>
          </div>
        )}
        {handles.map((h) => (
          <button
            key={h.id}
            data-block-id={h.id}
            aria-label={`ブロック ${h.index + 1} を選択`}
            title="ドラッグで移動・Shiftクリックで複数選択"
            className={blockHandleClass({
              id: h.id,
              nearby,
              caret: caretBlock,
              selected,
            })}
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
              affordance.current?.leave();
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
            data-block-id={h.id}
            aria-label={`ネストブロック ${h.path.map((n) => n + 1).join(".")} を選択`}
            title="ドラッグで対象の前へ移動"
            className={blockHandleClass({
              id: h.id,
              nearby,
              caret: caretBlock,
              selected: nestedSelected?.ids ?? [],
            })}
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
              affordance.current?.leave();
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
