import { useEffect, useRef, useState } from "react";
import type { SyncConnectionAction, SyncConnectionView, SyncRetentionView, TransferMaintenanceView, TransferReleasePlanView, TransferReleaseResult } from "../../shared/sync-management";
import { formatTransferBytes } from "./TransferMaintenancePanel";
import { SyncConnectionPanel } from "./SyncConnectionPanel";
import { TransferMaintenancePanel } from "./TransferMaintenancePanel";
import "./sync-management.css";

/** Input and confirmations only. Main owns every path, credential and ticket. */
export function SyncManagementDialog({onClose}: {onClose(): void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [connection, setConnection] = useState<SyncConnectionView | null>(null);
  const [transfers, setTransfers] = useState<TransferMaintenanceView | null>(null);
  const [retention, setRetention] = useState<SyncRetentionView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const alive = useRef(true);
  const refreshConnection = async () => {
    const view = await window.folio.request<SyncConnectionView>({type: "sync:connectionStatus"});
    if (alive.current) setConnection(view);
  };
  const refreshTransfers = async (cursor?: string) => {
    const view = await window.folio.request<TransferMaintenanceView>({type: "sync:transferInventory", cursor});
    if (alive.current) setTransfers(view);
  };
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void Promise.allSettled([refreshConnection(), refreshTransfers(), window.folio.request<SyncRetentionView>({type: "sync:retentionStatus"})
      .then(view => {if (alive.current) setRetention(view);})]).then(results => {
      if (!alive.current) return;
      if (results.some(result => result.status === "rejected")) setError("一部の同期設定を確認できませんでした。更新して再確認してください。");
      setBusy(false);
    });
    return () => {alive.current = false;};
  }, []);
  const remember = (action: SyncConnectionAction) => {if (alive.current) setConnection(action.view); return action;};
  return <dialog ref={dialog} className="sync-management-dialog" aria-labelledby="sync-management-title" onCancel={onClose}>
    <header className="sync-management-heading"><h2 id="sync-management-title">同期設定と転送キャッシュ</h2>
      <button type="button" onClick={onClose} aria-label="同期設定を閉じる">閉じる</button></header>
    <p>設定の保存後はFolioを終了して開き直してください。未保存の入力や適用予約がある場合は、先にその状態を確認してください。</p>
    {error && <p role="alert">{error}</p>}
    {connection ? <SyncConnectionPanel view={connection} busy={busy}
      onRefresh={refreshConnection}
      onResolve={async requestId => {
        const action = await window.folio.request<SyncConnectionAction | null>({type: "sync:connectionResolve", requestId});
        if (action) remember(action); return action;
      }}
      onSave={async input => remember(await window.folio.request<SyncConnectionAction>({type: "sync:connectionConfigure", input}))}
      onDisable={async (requestId, expectedRevision) => remember(await window.folio.request<SyncConnectionAction>({type: "sync:connectionDisable", requestId, expectedRevision}))} /> :
      <button type="button" disabled={busy} onClick={() => void refreshConnection().catch(() => setError("接続設定を確認できませんでした。"))}>接続設定を再確認</button>}
    <hr />
    <section aria-label="同期の保持上限"><h2>保持量と上限</h2>
      {retention?.queue && <p>同期の保全記録: {retention.queue.rows} / {retention.queue.maxRows} 件、
        {formatTransferBytes(retention.queue.bytes)} / {formatTransferBytes(retention.queue.maxBytes)}。
        {retention.queue.held && "上限のため、新しい同期データの保存を保留しています。"}</p>}
      {retention?.backups && <p>完全バックアップ: {retention.backups.generations} / 8 世代、
        {formatTransferBytes(retention.backups.bytes)} / 512 MiB。</p>}
      {retention?.held && <p role="alert">保持量を確認できない項目があります。保全データは削除していません。</p>}
      <p>バックアップの上限に達した場合は「ストレージ管理」から検証済みバックアップを外部へ移動してください。
        同期記録の上限に達した場合は、完全バックアップを保全してから管理手順で新しい同期先へ移行します。未解決の記録は自動削除しません。</p>
    </section>
    {transfers ? <TransferMaintenancePanel view={transfers} busy={busy} onRefresh={refreshTransfers}
      onPlan={entryId => window.folio.request<TransferReleasePlanView>({type: "sync:transferPlan", entryId})}
      onRelease={async operationId => {
        const result = await window.folio.request<TransferReleaseResult>({type: "sync:transferRelease", operationId});
        if (result.outcome === "released") await refreshTransfers(); return result;
      }}
      onResolve={operationId => window.folio.request<TransferReleaseResult>({type: "sync:transferResolve", operationId})} /> :
      <button type="button" disabled={busy} onClick={() => void refreshTransfers().catch(() => setError("転送キャッシュを確認できませんでした。"))}>転送キャッシュを再確認</button>}
  </dialog>;
}

export function SyncManagementButton() {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="sync-management-open" onClick={() => setOpen(true)}>同期設定</button>
    {open && <SyncManagementDialog onClose={() => setOpen(false)} />}</>;
}
