import { useEffect, useState } from "react";
import type { WorkspaceSyncView, WorkspaceSyncRestartView, WorkspaceSyncRestartAction } from "../shared/workspace-sync-view";
import { WorkspaceConflictPanel } from "./WorkspaceConflictPanel";

/** Text only describes durable transfer state; it never claims a remote
 * checkpoint was applied while the editor was open. */
export function syncStatusText(view: Extract<WorkspaceSyncView, {available: true}>): string {
  if (view.running) return view.connection === "connecting" ? "接続中…" : "同期中…";
  if (view.workspace?.conflict) return "同期競合・両側を保持";
  if (view.lastError === "capacity-exceeded" || view.lastError === "workspace-limit-exceeded")
    return "容量不足で同期を保留";
  if (view.lastError === "capacity-unknown" || view.lastError === "workspace-limit-unknown")
    return "容量を確認できず同期を保留";
  if (view.lastError) return "同期を保留";
  if (!view.workspace) return view.connection === "connecting" ? "接続中…" : "未接続";
  const pending = view.workspace.pending ? "送信待ち" : "送信済み";
  return view.workspace.receivedCursor > view.workspace.appliedRevision
    ? `${pending} · 受信 ${view.workspace.receivedCursor} · 適用済み ${view.workspace.appliedRevision}`
    : `${pending} · 適用済み ${view.workspace.appliedRevision}`;
}

export function restartApplyText(view: WorkspaceSyncRestartView): string {
  if (!view.available) return "";
  const target = view.targetRevision === null ? "" : ` R${view.targetRevision}`;
  if (view.state === "uncertain") return "適用予約の記録を確認できません";
  if (view.state === "committed" || view.scheduled) return `次回起動時に${target} を適用予定`;
  if (view.state === "requested") return view.reason
    ? "適用予約を保留中 · 終了時に再確認します"
    : `受信${target} の適用を予約中 · 終了時に確定`;
  switch (view.reason) {
    case "unsaved-changes": return "未保存の入力があるため予約できません";
    case "recovery-blocked": return "復旧記録を確認できないため予約できません";
    case "sync-active": return "同期・保存・保守の完了を待っています";
    case "workspace-changed": return "未送信の変更があるため予約できません";
    case "conflict": return "競合の解消後に予約できます";
    case "target-changed": return "適用対象が変わったため予約できません";
    case "intent-present": return `次回起動時に${target} を適用予定`;
    case "intent-blocked": case "state-unavailable": return "適用予約の状態を確認できません";
    case "no-staged-target": return "";
    case null: return target ? `受信${target} を次回起動時に適用できます` : "";
  }
}

export function WorkspaceSyncIndicator({startupMessage, inputReady = () => false}: {startupMessage?: string; inputReady?: () => boolean}) {
  const [view, setView] = useState<WorkspaceSyncView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restart, setRestart] = useState<WorkspaceSyncRestartView | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartNotice, setRestartNotice] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => window.folio.request<WorkspaceSyncView>({type: "sync:status"})
      .then((next) => {if (active) {setView(next); setFailed(false);}})
      .catch(() => {if (active) setFailed(true);});
    void refresh();
    const timer = window.setInterval(() => {void refresh();}, 10_000);
    return () => {active = false; window.clearInterval(timer);};
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => window.folio.request<WorkspaceSyncRestartView>({type: "sync:restartStatus"})
      .then((next) => {if (active) setRestart(next);})
      .catch(() => {if (active) setRestart(null);});
    void refresh();
    const timer = window.setInterval(() => {void refresh();}, 10_000);
    return () => {active = false; window.clearInterval(timer);};
  }, []);
  const changeRestart = async (type: "sync:restartRequest" | "sync:restartCancel") => {
    setRestartBusy(true); setRestartNotice("");
    try {
      const action = await window.folio.request<WorkspaceSyncRestartAction>(type === "sync:restartCancel" ? {type,reservationId:restart?.available ? restart.reservationId : undefined} : {type});
      setRestart(action.view);
      setRestartNotice(action.result === "prepared" ? "終了時に安全条件を確認して予約を確定します。" :
        action.result === "cancelled" ? "予約を取り消しました。" :
        action.result === "blocked" ? "予約を変更できませんでした。" : "");
    } catch {setRestartNotice("適用予約を操作できませんでした。");}
    finally {setRestartBusy(false);}
  };
  const restartView = restart?.available ? restart : null;
  const restartText = restartView ? restartApplyText(restartView) : "";
  const restartControls = restartView && (restartText || restartView.canRequest || restartView.canCancel) ?
    <span className="save-state" aria-live="polite" title={restartNotice || restartText}>
      {restartNotice || restartText}{" "}
      {restartView.canRequest && <button type="button" disabled={restartBusy} onClick={() => void changeRestart("sync:restartRequest")}>適用を予約</button>}
      {restartView.canCancel && <button type="button" disabled={restartBusy} onClick={() => void changeRestart("sync:restartCancel")}>予約を取り消す</button>}
    </span> : null;
  if (!view?.available) return <>{startupMessage && <span className="save-state" title={startupMessage}>{startupMessage}</span>}
    <WorkspaceConflictPanel showCandidates={false} inputReady={inputReady} />{restartControls}</>;
  const transfer = async () => {
    setBusy(true); setFailed(false);
    try {
      setView(await window.folio.request<WorkspaceSyncView>({type: "sync:run"}));
      void window.folio.request<WorkspaceSyncRestartView>({type: "sync:restartStatus"}).then(setRestart).catch(() => {});
    }
    catch {setFailed(true);}
    finally {setBusy(false);}
  };
  const detail = view.lastError ? `保留理由: ${view.lastError}` :
    view.lastSuccessAt ? `記録された送受信: ${new Date(view.lastSuccessAt).toLocaleString()}（受信・適用待ちが残る場合があります）` :
      startupMessage?.includes("保留") ? startupMessage : "同期の成功記録はまだありません";
  const label = !view.running && !view.lastSuccessAt && !view.lastError && startupMessage?.includes("保留")
    ? "起動時同期を保留" : syncStatusText(view);
  return <><span className="save-state" aria-live="polite" title={detail}>
    {busy ? "同期中…" : failed ? "同期状態を取得できません" : label}{" "}
    <button type="button" onClick={() => void transfer()} disabled={busy || view.running}>
      {busy || view.running ? "同期中…" : view.connection === "disconnected" ? "再接続" : "同期"}
    </button>
  </span><WorkspaceConflictPanel showCandidates={!!view.workspace?.conflict} inputReady={inputReady} />{restartControls}</>;
}
