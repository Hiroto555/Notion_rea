import { useState } from "react";
import type { StoragePressureSnapshot } from "../shared/storage-pressure";

function bytes(value: number | null): string {
  if (value === null) return "未確認";
  const gib = value / 1024 ** 3;
  return gib >= 1
    ? `${gib.toFixed(1)} GiB`
    : `${Math.floor(value / 1024 ** 2)} MiB`;
}

/** Manual observation only; no polling or filesystem tree scans on render. */
export function StoragePressurePanel() {
  const [snapshot, setSnapshot] = useState<StoragePressureSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSnapshot(undefined);
    try {
      setSnapshot(
        (await window.folio.request({
          type: "storage:pressure",
        })) as StoragePressureSnapshot,
      );
    } catch {
      setError(
        "空き容量を確認できませんでした。時間をおいて再確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="inspector-section" aria-label="保存先の空き容量">
      <h3 className="inspector-label">保存先の空き容量</h3>
      <p className="subtle">保存先ディスク全体の空き容量を表示します。</p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? "確認中…" : snapshot ? "空き容量を再確認" : "空き容量を確認"}
      </button>
      {error && <p role="status">{error}</p>}
      {snapshot && (
        <div role="status">
          <dl>
            <dt>空き容量</dt>
            <dd>{bytes(snapshot.availableBytes)}</dd>
            <dt>保存に残す余裕</dt>
            <dd>{bytes(snapshot.reserveBytes)}</dd>
            <dt>確認日時</dt>
            <dd>{new Date(snapshot.checkedAt).toLocaleString("ja-JP")}</dd>
          </dl>
          <p>
            {snapshot.state === "ready"
              ? "確認時点では、保存用の空き容量があります。"
              : snapshot.state === "blocked"
                ? "空き容量が少ないため、新しい保存を停止しています。"
                : "空き容量を確認できないため、新しい保存を停止しています。"}
          </p>
          {snapshot.state !== "ready" && (
            <p>
              編集中の入力がある場合はアプリを閉じず、空き容量を確保して保存結果を確認してください。未保存の入力は書き出して保全できます。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
