import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import {
  Search,
  Plus,
  ChevronRight,
  ChevronDown,
  PanelLeft,
  PanelRight,
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  Star,
  Trash2,
  Copy,
  FolderInput,
  Moon,
  Sun,
  Download,
  Upload,
  Paperclip,
  History,
  Check,
  BookOpen,
  Command,
  Settings2,
  Link2,
  Database as DatabaseIcon,
} from "lucide-react";
import { Editor } from "../editor/Editor";
import { recoveryContent } from "../shared/recovery";
import { PendingEdits } from "./pending-edits";
import { composing } from "../shared/keyboard";
import { findText } from "../editor/text-search";
import { Database } from "../database/Database";
import {
  textOf,
  type Page,
  type PagePatch,
  type Snapshot,
  type Version,
  type Doc,
  type Request,
} from "../shared/types";
const api = <T,>(r: Request) => window.folio.request<T>(r);
const icons = [
  "📄",
  "✳️",
  "💡",
  "📚",
  "📝",
  "🌿",
  "🎯",
  "🗂️",
  "☕",
  "◈",
  "🏡",
  "🔬",
];
type Dialog =
  "search" | "templates" | "trash" | "move" | "history" | "link" | null;
export function App() {
  const [pages, setPages] = useState<Page[]>([]),
    [activeId, setActiveId] = useState(""),
    [theme, setTheme] = useState("light"),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [sidebar, setSidebar] = useState(true),
    [inspector, setInspector] = useState(true),
    [dialog, setDialog] = useState<Dialog>(null),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Page[]>([]),
    [searchIndex, setSearchIndex] = useState(0),
    [menu, setMenu] = useState(false),
    [iconMenu, setIconMenu] = useState(false),
    [versions, setVersions] = useState<Version[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(0),
    [ready, setReady] = useState(false),
    [pageFind, setPageFind] = useState(""),
    [findOpen, setFindOpen] = useState(false),
    [databaseEpoch, setDatabaseEpoch] = useState(0);
  const pageRef = useRef<Page[]>([]),
    activeRef = useRef(""),
    queue = useRef(Promise.resolve()),
    pendingRef = useRef(0),
    edits = useRef(new PendingEdits()),
    composition = useRef(false),
    dialogRef = useRef<Dialog>(null),
    editor = useRef<TiptapEditor | null>(null),
    editorId = useRef(""),
    history = useRef<string[]>([]),
    historyIndex = useRef(-1),
    querySeq = useRef(0);
  dialogRef.current = dialog;
  const commit = (next: Page[]) => {
    pageRef.current = next;
    setPages(next);
  };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  const refresh = async () => {
    const state = await api<Snapshot>({ type: "load" });
    const merged = edits.current.merge(state.pages);
    commit(merged);
    return { ...state, pages: merged };
  };
  useEffect(() => {
    if (!window.folio) {
      setError("Electronで起動してください。npm run dev または npm start");
      return;
    }
    void refresh()
      .then((s) => {
        setTheme(s.settings.theme || "light");
        if (s.settings.expanded)
          try {
            setExpanded(new Set(JSON.parse(s.settings.expanded) as string[]));
          } catch {}
        const id =
          s.pages.find((p) => p.id === s.settings.activePage && !p.deletedAt)
            ?.id ||
          s.pages.find((p) => !p.deletedAt)?.id ||
          "";
        activeRef.current = id;
        setActiveId(id);
        history.current = [id];
        historyIndex.current = 0;
        setReady(true);
      })
      .catch(fail);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const saveSetting = (
    key: "activePage" | "theme" | "sidebar" | "expanded",
    value: string,
  ) => {
    void api({ type: "setting", key, value }).catch(fail);
  };
  function select(id: string, push = true) {
    const changed = activeRef.current !== id;
    activeRef.current = id;
    setActiveId(id);
    if (changed) {
      editor.current = null;
      editorId.current = "";
    }
    setMenu(false);
    setDialog(null);
    setFindOpen(false);
    saveSetting("activePage", id);
    if (push && changed) {
      history.current = history.current.slice(0, historyIndex.current + 1);
      history.current.push(id);
      historyIndex.current++;
    }
  }
  function back(delta: number) {
    const next = historyIndex.current + delta;
    if (next >= 0 && next < history.current.length) {
      historyIndex.current = next;
      select(history.current[next], false);
    }
  }
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    pendingRef.current++;
    setPending(pendingRef.current);
    const operation = queue.current.then(action).finally(() => {
      pendingRef.current--;
      setPending(pendingRef.current);
    });
    queue.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  function assertNoFailed() {
    if (edits.current.failed.size)
      throw new Error(
        "未保存の変更があります。保存の再試行または退避を先に実行してください。",
      );
  }
  async function ensureSaved() {
    let current;
    do {
      current = queue.current;
      await current;
    } while (current !== queue.current);
    if (edits.current.size)
      throw new Error(
        "未保存の変更があります。保存の再試行または退避を先に実行してください。",
      );
  }
  function mutate<T>(action: () => Promise<T>) {
    return enqueue(async () => {
      assertNoFailed();
      return action();
    });
  }
  function update(id: string, patch: PagePatch) {
    const page = pageRef.current.find((p) => p.id === id);
    if (page?.documentError) {
      fail(page.documentError);
      return;
    }
    const seq = edits.current.add(id, patch);
    commit(edits.current.merge(pageRef.current));
    void enqueue(async () => {
      if (!edits.current.has(id, seq)) return;
      const existing = pageRef.current.find((p) => p.id === id);
      if (!existing)
        throw new Error("保存対象のページがありません。退避してください。");
      try {
        const saved = await api<Page>({
          type: "update",
          id,
          revision: existing.revision,
          patch: edits.current.patch(id, seq),
        });
        edits.current.ack(id, seq);
        commit(
          edits.current.merge(
            pageRef.current.map((p) => (p.id === id ? saved : p)),
          ),
        );
        if (!edits.current.failed.size) setError("");
      } catch (e) {
        edits.current.failed.add(id);
        throw e;
      }
    }).catch(fail);
  }
  const create = (
    parentId: string | null = null,
    kind: Page["kind"] = "page",
    title?: string,
    doc?: Doc,
  ) =>
    mutate(async () => {
      const p = await api<Page>({ type: "create", parentId, kind, title });
      commit([...pageRef.current, p]);
      if (parentId) {
        const next = new Set(expanded).add(parentId);
        setExpanded(next);
        saveSetting("expanded", JSON.stringify([...next]));
      }
      select(p.id);
      if (doc) update(p.id, { doc });
      return p;
    });
  const safe = (fn: () => Promise<unknown>) => {
    void fn().catch(fail);
  };
  const page = pages.find((p) => p.id === activeId && !p.deletedAt),
    live = pages.filter((p) => !p.deletedAt),
    children = live
      .filter((p) => p.parentId === activeId)
      .sort((a, b) => a.position - b.position);
  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    saveSetting("theme", next);
  }
  function openSearch() {
    setQuery("");
    setResults([]);
    setDialog("search");
    setSearchIndex(0);
  }
  useEffect(() => {
    if (dialog !== "search" && dialog !== "link") return;
    const seq = ++querySeq.current;
    void api<Page[]>({ type: "search", query })
      .then((r) => {
        if (seq === querySeq.current) {
          setResults(r);
          setSearchIndex(0);
        }
      })
      .catch(fail);
  }, [query, dialog, pages.length]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || composing(e, composition.current)) return;
      if (e.key === "Escape") {
        setDialog(null);
        setMenu(false);
        setFindOpen(false);
        return;
      }
      if (
        dialogRef.current ||
        (e.target as HTMLElement)?.closest?.('[role="dialog"]')
      )
        return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (
        k === "k" &&
        (e.target as HTMLElement)?.closest?.("input,textarea,select")
      )
        return;
      if (k === "k" || k === "p") {
        e.preventDefault();
        if (
          k === "k" &&
          editor.current?.isFocused &&
          !editor.current.state.selection.empty
        ) {
          setQuery("");
          setResults([]);
          setDialog("link");
        } else openSearch();
      } else if (k === "n") {
        e.preventDefault();
        safe(() => create());
      } else if (k === "l" && e.shiftKey) {
        e.preventDefault();
        toggleTheme();
      } else if (k === "\\") {
        e.preventDefault();
        setSidebar((v) => !v);
      } else if (k === "[") {
        e.preventDefault();
        back(-1);
      } else if (k === "]") {
        e.preventDefault();
        back(1);
      } else if (k === "f") {
        e.preventDefault();
        setFindOpen((v) => !v);
      } else if (k === "s") {
        e.preventDefault();
        setNotice("変更は自動保存されます");
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (pendingRef.current > 0 || edits.current.size > 0) {
        e.preventDefault();
        e.returnValue = "保存中です";
      }
    };
    const start = () => {
      composition.current = true;
    };
    const end = () => {
      composition.current = false;
    };
    window.addEventListener("compositionstart", start);
    window.addEventListener("compositionend", end);
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("compositionstart", start);
      window.removeEventListener("compositionend", end);
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", unload);
    };
  }, [theme, expanded]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const duplicate = () =>
    safe(() =>
      mutate(async () => {
        if (!page) return;
        const copy = await api<Page>({ type: "duplicate", id: page.id });
        await refresh();
        select(copy.id);
      }),
    );
  const trash = () =>
    safe(() =>
      mutate(async () => {
        if (!page) return;
        await api({ type: "trash", id: page.id });
        const s = await refresh();
        select(s.pages.find((p) => !p.deletedAt)?.id || "");
        setMenu(false);
      }),
    );
  const move = (
    id: string,
    parentId: string | null,
    beforeId: string | null = null,
  ) =>
    mutate(async () => {
      await api({ type: "move", id, parentId, beforeId });
      await refresh();
      if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
      setDialog(null);
    });
  const openHistory = () =>
    safe(() =>
      mutate(async () => {
        if (!page) return;
        setVersions(await api<Version[]>({ type: "versions", id: page.id }));
        setDialog("history");
      }),
    );
  function currentEditor() {
    return editorId.current === activeRef.current &&
      editor.current &&
      !editor.current.isDestroyed
      ? editor.current
      : null;
  }
  function applyPageLink(p: Page) {
    const e = currentEditor();
    if (!e) {
      fail("編集中のページを確認できません");
      return;
    }
    if (!e.state.selection.empty)
      e.chain()
        .focus()
        .setLink({ href: "folio-page://" + p.id })
        .run();
    else
      e.chain()
        .focus()
        .insertContent({
          type: "text",
          text: p.title,
          marks: [{ type: "link", attrs: { href: "folio-page://" + p.id } }],
        })
        .run();
    setDialog(null);
  }
  const exportPage = (format: "md" | "html" | "json") =>
    safe(async () => {
      if (!page) return;
      const e = currentEditor();
      if (page.kind === "page" && format !== "json" && !e)
        throw new Error("本文を取得できないため書き出しを停止しました");
      const content =
        format === "json"
          ? JSON.stringify(page, null, 2)
          : format === "md"
            ? "# " +
              page.title +
              "\n\n" +
              (e?.getMarkdown() ?? JSON.stringify(page.database, null, 2))
            : '<!doctype html><html lang="ja"><meta charset="utf-8"><title>' +
              page.title.replace(/[<>&"]/g, "") +
              "</title><body>" +
              (e?.getHTML() ??
                "<pre>" +
                  JSON.stringify(page.database, null, 2)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;") +
                  "</pre>") +
              "</body></html>";
      const path = await api<string | null>({
        type: "export",
        name: page.title,
        format,
        content,
      });
      if (path) setNotice("書き出しました：" + path);
      setMenu(false);
    });
  const importPage = () =>
    safe(async () => {
      const file = await api<{
        name: string;
        format: string;
        content: string;
      } | null>({ type: "import" });
      if (!file) return;
      const { Editor: CoreEditor } = await import("@tiptap/core");
      const { extensions } = await import("../editor/Editor");
      const parser = new CoreEditor({
        extensions: extensions(),
        content: file.content,
        contentType: [".md", ".markdown"].includes(file.format)
          ? "markdown"
          : "html",
      });
      const doc = parser.getJSON() as Doc;
      parser.destroy();
      await create(null, "page", file.name, doc);
    });
  const attach = () =>
    safe(async () => {
      const e = currentEditor(),
        id = activeRef.current;
      if (!page || !e) return;
      const file = await api<{
        name: string;
        url: string;
        image: boolean;
      } | null>({ type: "attach" });
      if (!file) return;
      if (currentEditor() !== e || activeRef.current !== id)
        throw new Error(
          "添付の選択中にページが変わりました。元のページでやり直してください。",
        );
      if (file.image)
        e.chain().focus().setImage({ src: file.url, alt: file.name }).run();
      else
        e.chain()
          .focus()
          .insertContent({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "📎 " + file.name,
                marks: [{ type: "link", attrs: { href: file.url } }],
              },
            ],
          })
          .run();
    });
  function tree(parentId: string | null, depth = 0): React.ReactNode {
    return live
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .map((p) => {
        const has = live.some((c) => c.parentId === p.id);
        return (
          <div key={p.id}>
            <div
              className={"page-tree-row " + (p.id === activeId ? "active" : "")}
              style={{ paddingLeft: 12 + depth * 15 }}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData("application/x-folio-page", p.id)
              }
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("application/x-folio-page"))
                  e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = e.dataTransfer.getData("application/x-folio-page");
                if (!id) return;
                const rect = e.currentTarget.getBoundingClientRect(),
                  before = e.clientY < rect.top + rect.height * 0.28;
                safe(() =>
                  move(id, before ? p.parentId : p.id, before ? p.id : null),
                );
              }}
            >
              <button
                className={"tree-toggle " + (!has ? "invisible" : "")}
                aria-label={p.title + " を展開"}
                onClick={() => {
                  const next = new Set(expanded);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  setExpanded(next);
                  saveSetting("expanded", JSON.stringify([...next]));
                }}
              >
                {expanded.has(p.id) ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
              <button className="page-tree-label" onClick={() => select(p.id)}>
                <span className="page-emoji">{p.icon}</span>
                <span>{p.title || "無題"}</span>
              </button>
              <button
                className="tree-add"
                aria-label={p.title + " に子ページを作成"}
                onClick={() => safe(() => create(p.id))}
              >
                <Plus size={13} />
              </button>
            </div>
            {expanded.has(p.id) && tree(p.id, depth + 1)}
          </div>
        );
      });
  }
  const ancestors: Page[] = [];
  let parent = page?.parentId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const p = pages.find((x) => x.id === parent);
    if (!p) break;
    ancestors.unshift(p);
    parent = p.parentId;
  }
  const linked = (doc: Doc, target: string): boolean =>
    !!doc.marks?.some(
      (m) => m.type === "link" && m.attrs?.href === "folio-page://" + target,
    ) || !!doc.content?.some((n) => linked(n, target));
  const backlinks = page
    ? live.filter(
        (p) => !p.documentError && p.id !== page.id && linked(p.doc, page.id),
      )
    : [];
  const headings: Doc[] = page?.documentError
    ? []
    : (page?.doc?.content?.filter((n) => n.type === "heading") ?? []);
  const templates = [
    {
      title: "ミーティングノート",
      icon: "📝",
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "アジェンダ" }],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "今日、話し合うこと" }],
                  },
                ],
              },
            ],
          },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "決まったこと" }],
          },
          { type: "paragraph" },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "次のアクション" }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph" }],
              },
            ],
          },
        ],
      } as Doc,
    },
    {
      title: "デイリーノート",
      icon: "☕",
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "今日のフォーカス" }],
          },
          { type: "paragraph" },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "気づき・ふりかえり" }],
          },
          { type: "paragraph" },
        ],
      } as Doc,
    },
  ];
  if (!ready)
    return (
      <main className="loading">
        <div className="brand-mark">f</div>
        <h2>Folio</h2>
        <p>{error || "ワークスペースを開いています…"}</p>
        {error && (
          <button
            onClick={() =>
              safe(async () => {
                const path = await api<string>({ type: "backup" });
                setError("バックアップ保存先: " + path);
              })
            }
          >
            原本のバックアップを保存
          </button>
        )}
      </main>
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <aside className="sidebar">
          <div className="mac-drag" />
          <div className="workspace">
            <div className="brand-mark">f</div>
            <span>
              My workspace<small>自分だけの、考える場所</small>
            </span>
            <ChevronDown size={14} />
          </div>
          <nav className="sidebar-nav">
            <button onClick={openSearch}>
              <Search size={17} />
              <span>検索</span>
              <kbd>⌘ K</kbd>
            </button>
            <button onClick={() => safe(() => create())}>
              <Plus size={17} />
              <span>新しいページ</span>
              <kbd>⌘ N</kbd>
            </button>
          </nav>
          <div className="sidebar-scroll">
            {live.some((p) => p.favorite) && (
              <>
                <div className="section-label">お気に入り</div>
                {live
                  .filter((p) => p.favorite)
                  .map((p) => (
                    <button
                      key={p.id}
                      className="favorite-row"
                      onClick={() => select(p.id)}
                    >
                      <span>{p.icon}</span>
                      {p.title}
                    </button>
                  ))}
              </>
            )}
            <div className="section-label">
              <span>プライベート</span>
              <button
                aria-label="ページを追加"
                onClick={() => safe(() => create())}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="page-tree">{tree(null)}</div>
            <button
              className="new-root"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("application/x-folio-page"))
                  e.preventDefault();
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData("application/x-folio-page");
                if (id) safe(() => move(id, null));
              }}
              onClick={() => safe(() => create())}
            >
              <Plus size={15} />
              ページを追加
            </button>
          </div>
          <div className="sidebar-footer">
            <button onClick={() => setDialog("templates")}>
              <BookOpen size={16} />
              テンプレート
            </button>
            <button onClick={importPage}>
              <Upload size={16} />
              インポート
            </button>
            <button onClick={() => setDialog("trash")}>
              <Trash2 size={16} />
              ゴミ箱{" "}
              <small>{pages.filter((p) => p.deletedAt).length || ""}</small>
            </button>
            <div className="sidebar-bottom">
              <span>
                <i />
                ローカルワークスペース
              </span>
              <button
                aria-label="テーマを切り替え"
                title="⌘⇧L"
                onClick={toggleTheme}
              >
                {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
              </button>
            </div>
          </div>
        </aside>
      )}
      <main className="main-pane">
        <header className="topbar">
          <button
            aria-label="サイドバーを切り替え"
            onClick={() => setSidebar((v) => !v)}
          >
            <PanelLeft size={17} />
          </button>
          <button
            aria-label="前のページ"
            onClick={() => back(-1)}
            disabled={historyIndex.current <= 0}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            aria-label="次のページ"
            onClick={() => back(1)}
            disabled={historyIndex.current >= history.current.length - 1}
          >
            <ArrowRight size={16} />
          </button>
          <div className="breadcrumbs">
            {ancestors.map((p) => (
              <span key={p.id}>
                <button onClick={() => select(p.id)}>
                  {p.icon} {p.title}
                </button>
                <span>/</span>
              </span>
            ))}
            <span>
              {page?.icon} {page?.title || "ワークスペース"}
            </span>
          </div>
          <div className="spacer" />
          <span
            className={"save-state " + (error ? "error" : "")}
            aria-live="polite"
          >
            {error ? (
              "保存エラー"
            ) : pending ? (
              "保存中…"
            ) : (
              <>
                <Check size={12} />
                保存済み
              </>
            )}
          </span>
          {page && (
            <button
              aria-label="お気に入り"
              className={page.favorite ? "starred" : ""}
              onClick={() => update(page.id, { favorite: !page.favorite })}
            >
              <Star size={17} fill={page.favorite ? "currentColor" : "none"} />
            </button>
          )}
          <button
            aria-label="ページ情報"
            onClick={() => setInspector((v) => !v)}
          >
            <PanelRight size={17} />
          </button>
          <div className="menu-anchor">
            <button
              aria-label="ページメニュー"
              onClick={() => setMenu((v) => !v)}
            >
              <MoreHorizontal size={20} />
            </button>
            {menu && page && (
              <div className="dropdown">
                <button onClick={duplicate}>
                  <Copy size={15} />
                  複製
                </button>
                <button
                  onClick={() => {
                    setDialog("move");
                    setMenu(false);
                  }}
                >
                  <FolderInput size={15} />
                  移動する
                </button>
                <button onClick={() => safe(() => create(page.id))}>
                  <Plus size={15} />
                  子ページを追加
                </button>
                <button onClick={openHistory}>
                  <History size={15} />
                  変更履歴
                </button>
                <hr />
                <button
                  onClick={() =>
                    safe(() =>
                      mutate(async () => {
                        const copies = await api<Page[] | null>({
                          type: "recover",
                        });
                        if (copies?.length) {
                          await refresh();
                          select(copies[0].id);
                          setNotice(
                            "退避内容を新しいページとして復旧しました。元のページも保持しています。",
                          );
                        }
                      }),
                    )
                  }
                >
                  退避JSONから復旧
                </button>
                <button onClick={() => exportPage("md")}>
                  <Download size={15} />
                  Markdownを書き出す
                </button>
                <button onClick={() => exportPage("html")}>
                  <Download size={15} />
                  HTMLを書き出す
                </button>
                <button onClick={() => exportPage("json")}>
                  <Download size={15} />
                  JSONを書き出す
                </button>
                <button
                  onClick={() =>
                    safe(async () => {
                      await ensureSaved();
                      const path = await api<string>({ type: "backup" });
                      setNotice("バックアップを保存しました：" + path);
                      setMenu(false);
                    })
                  }
                >
                  <Copy size={15} />
                  ワークスペースをバックアップ
                </button>
                <hr />
                <button className="danger" onClick={trash}>
                  <Trash2 size={15} />
                  ゴミ箱に移動
                </button>
              </div>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            {edits.current.size ? (
              <div>
                <button
                  onClick={() => {
                    for (const [id, patch] of edits.current.patches())
                      update(id, patch);
                  }}
                >
                  保存を再試行
                </button>
                <button
                  onClick={() =>
                    safe(async () => {
                      await enqueue(async () => {
                        const through = edits.current.sequence;
                        const content = recoveryContent(
                          pageRef.current,
                          edits.current.snapshot(),
                        );
                        const path = await api<string | null>({
                          type: "exportRecovery",
                          content,
                        });
                        if (!path) return;
                        // Do not discard pending edits if the post-write reload fails.
                        const persisted = await api<Snapshot>({ type: "load" });
                        edits.current.discardThrough(through);
                        const state = {
                          ...persisted,
                          pages: edits.current.merge(persisted.pages),
                        };
                        commit(state.pages);
                        const current = state.pages.find(
                          (p) => p.id === activeRef.current,
                        );
                        if (current && !current.documentError)
                          currentEditor()?.commands.setContent(current.doc, {
                            emitUpdate: false,
                          });
                        setError("");
                        setNotice(
                          "未保存の内容をJSONに退避し、保存済みデータを読み直しました",
                        );
                      });
                    })
                  }
                >
                  退避して再読込
                </button>
              </div>
            ) : (
              <button onClick={() => setError("")}>閉じる</button>
            )}
          </div>
        )}
        <div className="document-layout">
          <div
            className="document-scroll"
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest("a");
              if (a) {
                e.preventDefault();
                if (a.href.startsWith("folio-page://")) {
                  const id = a.href
                    .slice("folio-page://".length)
                    .replace(/\/$/, "");
                  if (live.some((p) => p.id === id)) select(id);
                  else setNotice("リンク先のページが見つかりません");
                } else if (a.href.startsWith("folio-asset://"))
                  safe(async () => {
                    const saved = await api<string | null>({
                      type: "downloadAttachment",
                      url: a.href,
                    });
                    if (saved) setNotice("添付を保存しました");
                  });
                else if (/^https?:\/\//.test(a.href))
                  safe(() => api({ type: "openExternal", url: a.href }));
              }
            }}
          >
            {page ? (
              <article
                className={
                  "document " + (page.kind === "database" ? "wide" : "")
                }
                key={page.id}
              >
                {page.cover && (
                  <div
                    className={
                      "cover " +
                      (page.cover.startsWith("folio-asset:")
                        ? "image-cover"
                        : page.cover)
                    }
                    style={
                      page.cover.startsWith("folio-asset:")
                        ? { backgroundImage: `url("${page.cover}")` }
                        : undefined
                    }
                  >
                    <div className="cover-landscape" />
                    <button
                      onClick={() =>
                        update(page.id, {
                          cover:
                            page.cover === "sage"
                              ? "sand"
                              : page.cover === "sand"
                                ? "dusk"
                                : page.cover === "dusk"
                                  ? ""
                                  : "sage",
                        })
                      }
                    >
                      カバーを変更
                    </button>
                  </div>
                )}
                <div className="document-content">
                  <div className="page-decoration">
                    {page.recoveredFrom && (
                      <span title="退避JSONから別ページに復旧しました">
                        復旧ページ
                      </span>
                    )}
                    <div className="menu-anchor">
                      <button
                        className="page-icon"
                        aria-label="ページアイコン"
                        onClick={() => setIconMenu((v) => !v)}
                      >
                        {page.icon}
                      </button>
                      {iconMenu && (
                        <div className="icon-picker">
                          {icons.map((i) => (
                            <button
                              key={i}
                              onClick={() => {
                                update(page.id, { icon: i });
                                setIconMenu(false);
                              }}
                            >
                              {i}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="page-tools">
                      {!page.cover && (
                        <button
                          onClick={() => update(page.id, { cover: "sage" })}
                        >
                          カバーを追加
                        </button>
                      )}
                      <button onClick={attach}>
                        <Paperclip size={12} />
                        添付
                      </button>
                      <button
                        onClick={() =>
                          safe(async () => {
                            const f = await api<{
                              url: string;
                              image: boolean;
                            } | null>({ type: "attach" });
                            if (f?.image) update(page.id, { cover: f.url });
                            else if (f)
                              setNotice("カバーには画像を選択してください");
                          })
                        }
                      >
                        画像カバー
                      </button>
                    </div>
                  </div>
                  <input
                    className="page-title"
                    aria-label="ページタイトル"
                    placeholder="無題"
                    value={page.title}
                    disabled={!!page.documentError}
                    onChange={(e) => update(page.id, { title: e.target.value })}
                  />
                  <div className="page-subtitle">
                    <span>
                      {page.kind === "database"
                        ? "データベース"
                        : "プライベートページ"}
                    </span>
                    <span>·</span>
                    <span>
                      {new Date(page.updatedAt).toLocaleDateString("ja-JP", {
                        month: "long",
                        day: "numeric",
                      })}{" "}
                      更新
                    </span>
                  </div>
                  {findOpen && !page.documentError && (
                    <div className="page-find">
                      <Search size={14} />
                      <input
                        autoFocus
                        aria-label="ページ内検索"
                        placeholder="ページ内を検索"
                        value={pageFind}
                        onChange={(e) => setPageFind(e.target.value)}
                      />
                      <span>
                        {pageFind
                          ? textOf(page.doc)
                              .toLocaleLowerCase()
                              .split(pageFind.toLocaleLowerCase()).length - 1
                          : 0}{" "}
                        件
                      </span>
                      <button
                        onClick={() => {
                          if (
                            pageFind &&
                            document.querySelector(".folio-editor")
                          ) {
                            const e = currentEditor();
                            if (e) {
                              const match = findText(e.state.doc, pageFind)[0];
                              if (match)
                                e.chain()
                                  .focus()
                                  .setTextSelection(match)
                                  .scrollIntoView()
                                  .run();
                            }
                          }
                        }}
                      >
                        表示
                      </button>
                    </div>
                  )}
                  {page.documentError ? (
                    <div role="alert">
                      <p>{page.documentError}</p>
                      <button
                        onClick={() =>
                          safe(async () => {
                            const content = await api<string>({
                              type: "pageSource",
                              id: page.id,
                            });
                            await api({
                              type: "export",
                              name: page.title + "-original",
                              format: "json",
                              content,
                            });
                          })
                        }
                      >
                        原本JSONを保存
                      </button>
                    </div>
                  ) : page.kind === "page" ? (
                    <Editor
                      key={
                        page.id +
                        "-" +
                        (page.revision < 0 ? "restore" : "normal")
                      }
                      doc={page.doc}
                      onChange={(doc) => update(page.id, { doc })}
                      onError={fail}
                      onReady={(e) => {
                        editor.current = e;
                        editorId.current = page.id;
                      }}
                      onLink={() => {
                        setQuery("");
                        setDialog("link");
                      }}
                    />
                  ) : (
                    page.database && (
                      <Database
                        key={page.id + ":" + databaseEpoch}
                        value={page.database}
                        onChange={(database) => update(page.id, { database })}
                      />
                    )
                  )}
                  {children.length > 0 && (
                    <div className="child-pages">
                      {children.map((child) => (
                        <button key={child.id} onClick={() => select(child.id)}>
                          <span>{child.icon}</span>
                          <strong>{child.title}</strong>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="document-end">
                    <span>✧</span>
                    <span>考えを、少しずつ。</span>
                  </div>
                </div>
              </article>
            ) : (
              <div className="empty-workspace">
                <BookOpen size={40} />
                <h1>新しいページから、はじめよう。</h1>
                <button
                  className="primary"
                  onClick={() => safe(() => create())}
                >
                  ページを作成
                </button>
              </div>
            )}
          </div>
          {inspector && page && (
            <aside className="inspector">
              <div className="inspector-heading">
                ページの情報
                <Settings2 size={14} />
              </div>
              <div className="inspector-section">
                <label>このページ</label>
                <p>
                  {page.icon} {page.title}
                </p>
                <dl>
                  <dt>作成日</dt>
                  <dd>
                    {new Date(page.createdAt).toLocaleDateString("ja-JP")}
                  </dd>
                  <dt>文字数</dt>
                  <dd>
                    {page.documentError
                      ? "—"
                      : textOf(page.doc).length.toLocaleString()}
                  </dd>
                  <dt>保存先</dt>
                  <dd>このMac</dd>
                </dl>
              </div>
              <div className="inspector-section">
                <label>アウトライン</label>
                {headings.length ? (
                  headings.map((h, i) => (
                    <button
                      className="outline-item"
                      key={i}
                      style={{
                        paddingLeft: ((h.attrs?.level as number) || 2) * 7 - 7,
                      }}
                      onClick={() =>
                        document
                          .querySelectorAll(
                            ".folio-editor h1,.folio-editor h2,.folio-editor h3",
                          )
                          [i]?.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                          })
                      }
                    >
                      {textOf(h)}
                    </button>
                  ))
                ) : (
                  <p className="subtle">見出しを追加すると表示されます</p>
                )}
              </div>
              <div className="inspector-section">
                <label>
                  バックリンク <small>{backlinks.length}</small>
                </label>
                {backlinks.map((p) => (
                  <button
                    className="outline-item"
                    key={p.id}
                    onClick={() => select(p.id)}
                  >
                    {p.icon} {p.title}
                  </button>
                ))}
                {!backlinks.length && (
                  <p className="subtle">
                    他のページからのリンクが
                    <br />
                    ここに集まります。
                  </p>
                )}
              </div>
              <button className="history-link" onClick={openHistory}>
                <History size={14} />
                変更履歴を見る
              </button>
              <div className="inspector-tip">
                <Command size={17} />
                <p>
                  <kbd>⌘ K</kbd> で、すぐに移動。
                  <br />
                  アイデアの流れを止めずに。
                </p>
              </div>
            </aside>
          )}
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop" onMouseDown={() => setDialog(null)}>
          <div
            className={
              "modal " +
              (["search", "link"].includes(dialog) ? "search-modal" : "")
            }
            role="dialog"
            aria-label={
              dialog === "search"
                ? "ワークスペース検索"
                : dialog === "link"
                  ? "ページリンク"
                  : dialog === "move"
                    ? "ページを移動"
                    : dialog === "history"
                      ? "変更履歴"
                      : dialog === "trash"
                        ? "ゴミ箱"
                        : "テンプレート"
            }
            onMouseDown={(e) => e.stopPropagation()}
          >
            {["search", "link"].includes(dialog) ? (
              <>
                <div className="search-input">
                  <Search size={20} />
                  <input
                    autoFocus
                    aria-label="検索キーワード"
                    placeholder={
                      dialog === "link"
                        ? "リンクするページを検索…"
                        : "ページや本文を検索…"
                    }
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setResults([]);
                      setSearchIndex(0);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.defaultPrevented ||
                        composing(e.nativeEvent, composition.current)
                      )
                        return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSearchIndex((i) =>
                          Math.min(i + 1, results.length - 1),
                        );
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSearchIndex((i) => Math.max(0, i - 1));
                      }
                      if (e.key === "Enter" && results[searchIndex]) {
                        if (dialog === "link") {
                          applyPageLink(results[searchIndex]);
                        } else select(results[searchIndex].id);
                      }
                    }}
                  />
                  <kbd>esc</kbd>
                </div>
                <div className="menu-caption">
                  {query ? "検索結果" : "すべてのページ"}
                </div>
                <div className="search-results">
                  {results.length ? (
                    results.map((p, i) => (
                      <button
                        key={p.id}
                        className={i === searchIndex ? "active" : ""}
                        onClick={() => {
                          if (dialog === "link") {
                            applyPageLink(p);
                          } else select(p.id);
                        }}
                      >
                        <span className="result-icon">{p.icon}</span>
                        <span>
                          <strong>{p.title || "無題"}</strong>
                          <small>
                            {p.documentError
                              ? "未対応の文書（原本を保全）"
                              : textOf(p.doc).slice(0, 85) || "空のページ"}
                          </small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                  ) : (
                    <p className="empty">見つかりませんでした</p>
                  )}
                </div>
                {dialog === "search" && (
                  <div className="palette-actions">
                    <button onClick={() => safe(() => create())}>
                      <Plus size={14} />
                      ページを作成
                    </button>
                    <button
                      onClick={() =>
                        safe(() =>
                          create(null, "database", "新しいデータベース"),
                        )
                      }
                    >
                      <DatabaseIcon size={14} />
                      データベース
                    </button>
                    <button onClick={toggleTheme}>
                      {theme === "light" ? (
                        <Moon size={14} />
                      ) : (
                        <Sun size={14} />
                      )}
                      テーマ
                    </button>
                  </div>
                )}
                <footer className="search-footer">
                  ↑ ↓ 選択 <span>↵ 開く</span>
                  <span>タイトルと本文を検索</span>
                </footer>
              </>
            ) : (
              <>
                <div className="modal-header">
                  <h3>
                    {dialog === "move"
                      ? "ページを移動"
                      : dialog === "history"
                        ? "変更履歴"
                        : dialog === "trash"
                          ? "ゴミ箱"
                          : "新しいページのはじまり"}
                  </h3>
                  <button onClick={() => setDialog(null)}>閉じる</button>
                </div>
                {dialog === "templates" && (
                  <div className="templates">
                    <button onClick={() => safe(() => create())}>
                      <span>📄</span>
                      <strong>空のページ</strong>
                      <small>自由に書きはじめる</small>
                    </button>
                    {templates.map((t) => (
                      <button
                        key={t.title}
                        onClick={() =>
                          safe(async () => {
                            const p = await create(
                              null,
                              "page",
                              t.title,
                              t.doc,
                            );
                            update(p.id, { icon: t.icon });
                          })
                        }
                      >
                        <span>{t.icon}</span>
                        <strong>{t.title}</strong>
                        <small>考えるための、ひとつの型</small>
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        safe(() =>
                          create(null, "database", "新しいデータベース"),
                        )
                      }
                    >
                      <span>▦</span>
                      <strong>データベース</strong>
                      <small>テーブル・ボード・カレンダー</small>
                    </button>
                  </div>
                )}
                {dialog === "move" && (
                  <div className="dialog-list">
                    <button onClick={() => safe(() => move(activeId, null))}>
                      ⌂ ワークスペースの最上位
                    </button>
                    {live
                      .filter((p) => p.id !== activeId)
                      .map((p) => (
                        <button
                          key={p.id}
                          onClick={() => safe(() => move(activeId, p.id))}
                        >
                          {p.icon} {p.title}
                        </button>
                      ))}
                  </div>
                )}
                {dialog === "trash" && (
                  <div className="dialog-list">
                    {pages.filter((p) => p.deletedAt).length ? (
                      pages
                        .filter((p) => p.deletedAt)
                        .map((p) => (
                          <div key={p.id}>
                            <span>
                              {p.icon} {p.title}
                            </span>
                            <button
                              onClick={() =>
                                safe(async () => {
                                  await mutate(async () => {
                                    await api({ type: "restore", id: p.id });
                                    await refresh();
                                  });
                                  setNotice("ページを復元しました");
                                })
                              }
                            >
                              復元
                            </button>
                          </div>
                        ))
                    ) : (
                      <p className="empty">ゴミ箱は空です</p>
                    )}
                  </div>
                )}
                {dialog === "history" && (
                  <div className="dialog-list">
                    {versions.length ? (
                      versions.map((v) => (
                        <div key={v.id}>
                          <span>
                            <strong>
                              {new Date(v.createdAt).toLocaleString("ja-JP")}
                            </strong>
                            <small>
                              {v.title} ·{" "}
                              {v.database
                                ? `${v.database.rows.length} 行: ${v.database.rows.map((r) => r.title).join(", ")} / ${v.database.properties.map((p) => p.name).join(", ")}`
                                : textOf(v.doc).slice(0, 80)}
                            </small>
                          </span>
                          <button
                            onClick={() =>
                              safe(async () => {
                                await mutate(async () => {
                                  const targetId = activeId;
                                  const saved = await api<Page>({
                                    type: "restoreVersion",
                                    id: activeId,
                                    versionId: v.id,
                                  });
                                  await refresh();
                                  setDatabaseEpoch((value) => value + 1);
                                  if (
                                    activeRef.current === targetId &&
                                    !edits.current.patch(targetId).doc
                                  )
                                    currentEditor()?.commands.setContent(
                                      saved.doc,
                                      { emitUpdate: false },
                                    );
                                });
                                setDialog(null);
                                setNotice("履歴を復元しました");
                              })
                            }
                          >
                            復元
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="empty">
                        本文・タイトル・DBを編集すると履歴が保存されます
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
