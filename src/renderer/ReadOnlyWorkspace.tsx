import { useEffect, useState } from "react";
import type { StartupStatus } from "../shared/startup-status";
import type { Page, Snapshot } from "../shared/types";
import { textOf } from "../shared/types";

export function ReadOnlyWorkspace({ status }: { status: StartupStatus }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [selected, setSelected] = useState<Page>();
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    window.folio
      .request<Snapshot>({ type: "load" })
      .then((result) => {
        if (active) {
          setPages(result.pages);
          setSelected(result.pages[0]);
        }
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      });
    return () => {
      active = false;
    };
  }, []);
  const filtered = pages.filter(
    (page) =>
      !page.deletedAt &&
      (page.title + "\n" + textOf(page.doc))
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  async function exportPage() {
    if (!selected || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const source = await window.folio.request<string>({
        type: "pageSource",
        id: selected.id,
      });
      if (typeof source !== "string") throw new Error("原本を取得できません。");
      const path = await window.folio.request<string | null>({
        type: "export",
        name: selected.title || "page-source",
        format: "json",
        content: source,
      });
      if (path) setMessage("書き出し先 " + path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function salvage() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.folio.request<{ directory: string } | null>({
        type: "storage:rawSalvage",
      });
      if (result) setMessage("救出先 " + result.directory);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="readonly-workspace">
      <header>
        <h1>Folio · 読み取り専用</h1>
        <p>{status.message}</p>
        <button disabled={busy} onClick={() => void salvage()}>
          DB・添付・復旧記録を救出
        </button>
      </header>
      <label>
        ページを検索
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <nav aria-label="保存済みページ">
        {filtered.map((page) => (
          <button
            key={page.id}
            onClick={() => setSelected(page)}
            aria-pressed={page.id === selected?.id}
          >
            {page.title || "無題"}
          </button>
        ))}
      </nav>
      {selected && (
        <article>
          <h2>{selected.title || "無題"}</h2>
          {selected.documentError ? (
            <p>{selected.documentError}</p>
          ) : (
            <pre>{textOf(selected.doc)}</pre>
          )}
          <button disabled={busy} onClick={() => void exportPage()}>
            ページの原本JSONを書き出し
          </button>
        </article>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
