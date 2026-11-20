import { useEffect, useState } from "react";
import type { StartupStatus } from "../shared/startup-status";
import type { ReadOnlyAppApi } from "../shared/app-api";
import type { Page } from "../shared/types";
import { textOf } from "../shared/types";
import { fileExportNotice, rawSalvageNotice } from "./capability-notice";

export function ReadOnlyWorkspace({
  status,
  api,
}: {
  status: StartupStatus;
  api: ReadOnlyAppApi;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const [selected, setSelected] = useState<Page>();
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [capabilityNotice, setCapabilityNotice] = useState("");
  useEffect(() => {
    let active = true;
    api.workspace
      .load()
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
  }, [api]);
  // Independent mount-time capability read behind the same active fence.
  // The notice is display-only: it is never awaited before an action and
  // never gates one, and an unreadable table leaves the original text and
  // the existing error surface untouched.
  useEffect(() => {
    let active = true;
    api.capabilities
      .read()
      .then((value) => {
        if (active) setCapabilityNotice(fileExportNotice(value));
      })
      .catch(() => {
        if (active) setCapabilityNotice(fileExportNotice(null));
      });
    return () => {
      active = false;
    };
  }, [api]);
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
      const source = await api.original.readOriginal(selected.id);
      const path = await api.original.exportOriginal({
        name: selected.title || "page-source",
        content: source,
      });
      if (path) setMessage("書き出し先 " + path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function exportWorkspace() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const path = await api.original.exportWorkspaceMarkdown();
      if (path) setMessage("書き出し先 " + path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }
  async function salvage() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api.recovery.salvageRaw();
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
        <button disabled={busy} onClick={() => void exportWorkspace()}>Markdown一括書き出し</button>
        <p className="subtle">{rawSalvageNotice()}</p>
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
          {capabilityNotice !== "" && (
            <p className="subtle">{capabilityNotice}</p>
          )}
        </article>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
