import { useEffect, useRef, useState } from "react";
import type { SharedRuntimeSession, SharedRuntimeAPI } from "../../shared/shared-runtime-ipc";
import type { Scope, Receipt } from "../../collaboration/runtime/contract";

type PendingStage = {scope: Scope; copyId: string; manifestHash: string; stagedParts: number};
type Review = {
  previewId: string;
  destination: { orgId: string; workspaceId: string };
  documents: { sourceId: string; title: string }[];
  assets: { hash: string; bytes: number }[];
  warnings: { targetId: string }[];
  fingerprint: string;
};
export function SharedCopyPanel({
  api,
  generation,
  pages,
  onChanged,
}: {
  api: SharedRuntimeAPI;
  generation: number;
  pages: { id: string; title: string; kind?: "page" | "record" | "database" }[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [review, setReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const sending = useRef(false);
  const [catalog, setCatalog] = useState(pages);
  const [stages, setStages] = useState<PendingStage[]>([]);
  const [stageMessage, setStageMessage] = useState("");
  const stageGeneration = useRef(generation);
  stageGeneration.current = generation;
  async function refreshStages() {
    try {
      const current = await api.request<SharedRuntimeSession>({type: "list"});
      if (current.generation !== generation || stageGeneration.current !== generation) return;
      const workspace = current.workspaces.find(row => row.documents.length > 0 && row.role !== "viewer");
      const document = workspace?.documents[0];
      const scope = current.scope ?? (current.orgId && workspace && document ? {
        orgId: current.orgId, workspaceId: workspace.workspaceId,
        documentId: document.documentId, incarnationId: document.incarnationId,
      } : null);
      if (!scope) { setStages([]); setStageMessage("共有ページを選ぶと、送信途中のコピーを確認できます。"); return; }
      const rows = await api.request<PendingStage[]>({type: "admin", command: {action: "copyStages", scope}});
      if (stageGeneration.current === generation) {setStages(rows); setStageMessage("");}
    } catch (error) {
      if (stageGeneration.current === generation) setStageMessage(String(error));
    }
  }
  async function abandon(stage: PendingStage) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setMessage("");
    try {
      const receipt = await api.request<Receipt>({type: "copyAbandon", generation,
        scope: stage.scope, copyId: stage.copyId, manifestHash: stage.manifestHash});
      setMessage(receipt.status === "SERVER_ACCEPTED" ? "未公開コピーの中止が確定しました。" : receipt.status + " / " + receipt.code);
      await refreshStages(); onChanged();
    } catch (error) {setMessage(String(error) + "　受付状態を確認してください。");}
    finally {sending.current = false; setBusy(false);}
  }
  useEffect(() => {
    let active = true;
    stageGeneration.current = generation;
    void (async () => {
      try { const rows = await api.request<typeof pages>({type: "copyCatalog", generation}); if (active) setCatalog(rows); }
      catch { if (active) setCatalog(pages); }
      if (active) await refreshStages();
    })();
    return () => {active = false; stageGeneration.current = -1;};
  }, [api, generation]);
  async function preview() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage("");
    try {
      setReview(
        await api.request<Review>({
          type: "copyPreview",
          generation,
          sourceIds: [...selected].sort((a,b) => Number(catalog.find(p => p.id === b)?.kind === "database") - Number(catalog.find(p => p.id === a)?.kind === "database")),
        }),
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function commit() {
    if (!review || sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const receipt = await api.request<Receipt>({
        type: "copyCommit",
        generation,
        previewId: review.previewId,
      });
      setMessage(
        receipt.status === "SERVER_ACCEPTED"
          ? "選択したページを共有領域へコピーしました。"
          : receipt.status + " / " + receipt.code,
      );
      if (receipt.status === "SERVER_ACCEPTED") setReview(null);
      onChanged();
    } catch (e) {
      setMessage(
        String(e) +
          "　個人ページの原本は保持されています。受付状態を確認してください。",
      );
    } finally {
      await refreshStages();
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>個人ページを共有領域へコピー</summary>
      <p>
        選択したページ、データベース、レコードと参照添付をコピーします。レコードは所属データベースも選択してください。プレビューまでは共有サーバーへ送信しません。大きなコピーは分割して送信します。本文は1ページ2MBまでで、合計は添付や保全記録を含めた空き容量により制限されます。
      </p>
      <fieldset disabled={busy}>
        {catalog.map((page) => (
          <label key={page.id}>
            <input
              type="checkbox"
              checked={selected.includes(page.id)}
              onChange={(e) => {
                setReview(null);
                setSelected((old) =>
                  e.target.checked
                    ? [...old, page.id]
                    : old.filter((id) => id !== page.id),
                );
              }}
            />
            {page.kind === "database" ? "DB: " : page.kind === "record" ? "レコード: " : ""}{page.title}
          </label>
        ))}
        <button disabled={!selected.length} onClick={() => void preview()}>
          選択範囲をプレビュー
        </button>
      </fieldset>
      {review && (
        <section>
          <p>
            コピー先：{review.destination.orgId} /{" "}
            {review.destination.workspaceId}
          </p>
          <ul>
            {review.documents.map((d) => (
              <li key={d.sourceId}>{d.title}</li>
            ))}
          </ul>
          <p>添付：{review.assets.length}件</p>
          {review.warnings.length > 0 && (
            <p role="alert">
              選択外の個人ページへのリンクが{review.warnings.length}
              件あります。リンク先の内容はコピーされません。
            </p>
          )}
          <button disabled={busy} onClick={() => void commit()}>
            この範囲を共有領域へコピーする
          </button>
        </section>
      )}
      <section aria-label="送信途中のコピー">
        <p>この接続で送信途中のコピーを確認し、中止できます。受付が未確定の場合は、先に受付状態を確認してください。</p>
        <button disabled={busy} onClick={() => void refreshStages()}>送信途中の一覧を更新</button>
        {stageMessage && <p role="status">{stageMessage}</p>}
        <ul>{stages.map((stage, index) => <li key={stage.copyId + ":" + stage.manifestHash}>
          送信途中 {index + 1}：受信済み {stage.stagedParts}分割
          <button disabled={busy} onClick={() => void abandon(stage)}>この未公開コピーを中止する</button>
        </li>)}</ul>
      </section>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
