import { useState } from "react";
import type {
  SharedRuntimeAPI,
  SharedRuntimeSession,
} from "../../shared/shared-runtime-ipc";
import type { Command } from "../../collaboration/runtime/contract";
import type { Doc } from "../../shared/types";

/** Explicit semantic controls. Unsupported rich edits remain a retained draft. */
export function SharedDocumentActions({
  api,
  session,
  onChanged,
}: {
  api: SharedRuntimeAPI;
  session: SharedRuntimeSession;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [block, setBlock] = useState(""),
    [table, setTable] = useState(""),
    [parentId, setParentId] = useState(""),
    [query, setQuery] = useState(""),
    [result, setResult] = useState(""),
    [exportPayload, setExportPayload] = useState("");
  const snapshot = session.snapshot;
  if (!snapshot || !session.scope) return null;
  const nodes: { id: string; type: string }[] = [];
  function visit(node: Doc) {
    if (
      node.attrs?.id &&
      typeof node.attrs.id === "string" &&
      ![
        "tableRow",
        "tableCell",
        "tableHeader",
      ].includes(node.type)
    )
      nodes.push({ id: node.attrs.id, type: node.type });
    if (node.type !== "table") node.content?.forEach(visit);
  }
  snapshot.state.document.content?.forEach(visit);
  async function command(command: Command) {
    setBusy(true);
    setError("");
    try {
      await api.request({
        type: "command",
        generation: session.generation,
        command,
      });
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function movePage() {
    setBusy(true);
    setError("");
    try {
      const receipt = await api.request<{
        status: string;
        code: string | null;
      }>({
        type: "resource",
        generation: session.generation,
        scope: session.scope!,
        command: {
          kind: "resource",
          action: "page.move",
          payload: { parentId: parentId || null, beforeId: null },
        },
      });
      if (receipt.status !== "SERVER_ACCEPTED")
        throw new Error(receipt.code ?? receipt.status);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function read(action: "search" | "history" | "documentExport") {
    setBusy(true);
    setError("");
    try {
      const value = await api.request<unknown>({
        type: "admin",
        command:
          action === "search"
            ? { action, scope: session.scope!, query }
            : { action, scope: session.scope! },
      });
      setResult(JSON.stringify(value, null, 2));
      setExportPayload(
        action === "documentExport" ? JSON.stringify(value, null, 2) : "",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>共有文書の操作・検索・履歴</summary>
      <fieldset disabled={busy || !session.view.canEdit}>
        <button
          onClick={() =>
            void command({
              kind: "block.insert",
              parentId: null,
              beforeId: null,
              node: { type: "paragraph", attrs: { id: crypto.randomUUID() } },
            })
          }
        >
          段落を追加
        </button>
        <label>
          対象ブロック
          <select value={block} onChange={(e) => setBlock(e.target.value)}>
            <option value="">選択</option>
            {nodes.map((n) => (
              <option value={n.id} key={n.id}>
                {n.type} / {n.id}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!block}
          onClick={() =>
            void command({
              kind: "block.move",
              blockId: block,
              parentId: null,
              beforeId: null,
            })
          }
        >
          末尾へ移動
        </button>
        <button
          disabled={!block}
          onClick={() => void command({ kind: "block.delete", blockId: block })}
        >
          ブロックを削除
        </button>
        <label>
          表
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">選択</option>
            {snapshot.state.tables.map((t) => (
              <option key={t.tableId} value={t.tableId}>
                {t.tableId}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!table}
          onClick={() =>
            void command({
              kind: "table.row.insert",
              tableId: table,
              rowId: crypto.randomUUID(),
              beforeId: null,
            })
          }
        >
          行を追加
        </button>
        <button
          disabled={!table}
          onClick={() =>
            void command({
              kind: "table.column.insert",
              tableId: table,
              columnId: crypto.randomUUID(),
              beforeId: null,
            })
          }
        >
          列を追加
        </button>
        <label>
          ページの移動先
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">ワークスペース直下</option>
            {session.workspaces
              .find((w) => w.workspaceId === session.scope!.workspaceId)
              ?.documents.filter(
                (d) => d.documentId !== session.scope!.documentId,
              )
              .map((d) => (
                <option key={d.documentId} value={d.documentId}>
                  {d.title}
                </option>
              ))}
          </select>
        </label>
        <button onClick={() => void movePage()}>このページを移動</button>
      </fieldset>
      <label>
        検索
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={500}
        />
      </label>
      <button disabled={busy} onClick={() => void read("search")}>
        検索
      </button>
      <button disabled={busy} onClick={() => void read("history")}>
        文書履歴を読む
      </button>
      <button disabled={busy} onClick={() => void read("documentExport")}>
        文書を書き出し用に取得
      </button>
      {!!exportPayload && (
        <a
          download="folio-shared-document.json"
          href={
            "data:application/json;charset=utf-8," +
            encodeURIComponent(exportPayload)
          }
        >
          取得した文書JSONを保存
        </a>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <pre>{result}</pre>}
    </details>
  );
}
