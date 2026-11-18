import { useRef, useState } from "react";
import type { Page } from "../shared/types";
import type { PageOrderRepairPreview } from "../shared/page-order-repair";
import type { PageOrderRepairAttempt } from "./reliable-page-order-repair";
import { DialogFrame } from "./Modal";

type Props = {
  pages: readonly Page[];
  onPreview: () => Promise<PageOrderRepairPreview>;
  onApply: (fingerprint: string) => Promise<PageOrderRepairAttempt>;
  onPendingChange: (pending: boolean) => void;
  onReload: () => Promise<void>;
  onClose: () => void;
};

export function PageOrderRepairDialog({
  pages,
  onPreview,
  onApply,
  onPendingChange,
  onReload,
  onClose,
}: Props) {
  const [preview, setPreview] = useState<PageOrderRepairPreview>();
  const [attempt, setAttempt] = useState<PageOrderRepairAttempt>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const needsReload =
    attempt?.status === "applied" || attempt?.status === "unknown";
  const titles = new Map(pages.map((page) => [page.id, page.title || "無題"]));
  const parentName = (id: string | null) =>
    id === null ? "ワークスペースの最上位" : (titles.get(id) ?? id);
  const close = () => {
    if (!lock.current && !needsReload) onClose();
  };

  async function inspect() {
    if (lock.current || needsReload) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    setAttempt(undefined);
    setPreview(undefined);
    try {
      setPreview(await onPreview());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function apply() {
    if (lock.current || !preview?.canApply || needsReload) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    onPendingChange(true);
    try {
      const result = await onApply(preview.sourceFingerprint);
      setAttempt(result);
      if (result.status === "not-sent" || result.status === "rejected")
        onPendingChange(false);
      setPreview(undefined);
    } catch {
      setAttempt({
        status: "unknown",
        message:
          "修復結果を確認できません。表示を読み直して並び順を確認してください。",
      });
      setPreview(undefined);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await onReload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <DialogFrame
      modal={false}
      name="ページの並び順を修復"
      className="modal page-order-repair"
      onClose={close}
    >
      <div className="modal-header">
        <h3>ページの並び順を修復</h3>
        <button disabled={busy || needsReload} onClick={close}>
          閉じる
        </button>
      </div>
      <div className="page-order-repair-content" aria-busy={busy}>
        <p>
          同じ順位になったページを確認します。適用前に復元用の完全バックアップを作成します。
        </p>
        {!needsReload && (
          <button disabled={busy} onClick={() => void inspect()}>
            並び順を確認
          </button>
        )}
        {preview && (
          <>
            <p role="status">
              {preview.scannedPages} 件を確認しました。変更対象は{" "}
              {preview.targetIds.length} 件です。
            </p>
            {preview.groups.map((group) => (
              <section key={JSON.stringify([group.parentId, group.position])}>
                <h4>{parentName(group.parentId)}</h4>
                <table>
                  <thead>
                    <tr>
                      <th>ページ</th>
                      <th>現在の順位</th>
                      <th>修復後の順位</th>
                      <th>更新番号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.targets.map((target) => (
                      <tr key={target.pageId}>
                        <td>
                          {target.title || "無題"}
                          {target.deleted ? "（ゴミ箱）" : ""}
                          {target.changed ? "" : "（順位を維持）"}
                        </td>
                        <td>{target.fromPosition}</td>
                        <td>{target.toPosition}</td>
                        <td>
                          {target.fromRevision} → {target.toRevision}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
            {preview.issues.length > 0 && (
              <ul>
                {preview.issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            )}
            {preview.rejections.map((group, index) => (
              <section key={index}>
                <h4>{parentName(group.parentId)}</h4>
                <ul>
                  {group.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </section>
            ))}
            {!preview.canApply &&
              preview.groups.length === 0 &&
              preview.rejections.length === 0 &&
              preview.issues.length === 0 && (
                <p>修復が必要な同順位はありません。</p>
              )}
            <button
              className="primary"
              disabled={busy || !preview.canApply}
              onClick={() => void apply()}
            >
              バックアップを作成して修復
            </button>
          </>
        )}
        {attempt?.status === "applied" && (
          <div role="status">
            <p>{attempt.appliedPages} 件の並び順を修復しました。</p>
            {attempt.backup && (
              <p>
                変更前のバックアップ
                <br />
                {attempt.backup.directory}
              </p>
            )}
          </div>
        )}
        {attempt?.status === "rejected" && (
          <div role="alert">
            {attempt.issues.map((issue, index) => (
              <p key={index}>{issue}</p>
            ))}
          </div>
        )}
        {(attempt?.status === "unknown" || attempt?.status === "not-sent") && (
          <p role="alert">{attempt.message}</p>
        )}
        {message && <p role="alert">{message}</p>}
        {needsReload && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void reload()}
          >
            保存済みの状態を読み直す
          </button>
        )}
      </div>
    </DialogFrame>
  );
}
