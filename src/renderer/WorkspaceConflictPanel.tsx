import { useState } from "react";
import type { WorkspaceConflictCandidateSnapshot, WorkspaceConflictCandidateSummary, WorkspaceConflictInspection,
  WorkspaceConflictView } from "../shared/workspace-conflict-view";
import { compareConflictPages, type ConflictPageComparison } from "./conflict-page-comparison";
import { compareConflictRecords, type ConflictRecordComparison } from "./conflict-record-comparison";
import { WorkspaceConflictDecisionControls } from "./WorkspaceConflictDecisionControls";

export function conflictCandidateText(candidate: WorkspaceConflictCandidateSummary): string {
  const hash = candidate.checkpointHash ? candidate.checkpointHash.slice(0, 12) : "なし";
  return `${candidate.side === "local" ? "基準" : "相手"} R${candidate.revision} · ページ ${candidate.pages} · 添付 ${candidate.assets} · 識別 ${hash}`;
}

/** Applying a choice is windowless; active-window controls only reserve it. */
export function WorkspaceConflictPanel({showCandidates = true, inputReady = () => false}: {showCandidates?: boolean; inputReady?: () => boolean}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<WorkspaceConflictView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [comparison, setComparison] = useState<ConflictPageComparison | null>(null);
  const [recordComparison, setRecordComparison] = useState<ConflictRecordComparison | null>(null);
  const inspect = async () => {
    if (open) {setOpen(false); return;}
    setOpen(true); setBusy(true); setMessage(""); setComparison(null); setRecordComparison(null);
    try {setView(await window.folio.request<WorkspaceConflictView>({type: "sync:conflict"}));}
    catch {setView(null); setMessage("競合候補を確認できませんでした。");}
    finally {setBusy(false);}
  };
  const compareRecords = async (conflict: WorkspaceConflictInspection) => {
    setBusy(true); setMessage(""); setRecordComparison(null);
    try {
      const read = (candidate: WorkspaceConflictCandidateSummary) =>
        window.folio.request<WorkspaceConflictCandidateSnapshot>({type: "sync:conflictCandidate",
          operationId: conflict.operationId, side: candidate.side, expectedRevision: candidate.revision,
          expectedCheckpointHash: candidate.checkpointHash});
      const [local, remote] = await Promise.all([read(conflict.local), read(conflict.remote)]);
      if (local.checkpointJson === null || remote.checkpointJson === null) throw new Error("candidate-unavailable");
      setRecordComparison(compareConflictRecords(local.checkpointJson, remote.checkpointJson));
    } catch {setMessage("レコードを比較できませんでした。競合の状態を確認し直してください。");}
    finally {setBusy(false);}
  };
  const compare = async (conflict: WorkspaceConflictInspection) => {
    setBusy(true); setMessage(""); setComparison(null);
    try {
      const read = (candidate: WorkspaceConflictCandidateSummary) =>
        window.folio.request<WorkspaceConflictCandidateSnapshot>({type: "sync:conflictCandidate",
          operationId: conflict.operationId, side: candidate.side, expectedRevision: candidate.revision,
          expectedCheckpointHash: candidate.checkpointHash});
      const [local, remote] = await Promise.all([read(conflict.local), read(conflict.remote)]);
      if (local.checkpointJson === null || remote.checkpointJson === null) throw new Error("candidate-unavailable");
      setComparison(compareConflictPages(local.checkpointJson, remote.checkpointJson));
    } catch {setMessage("ページを比較できませんでした。競合の状態を確認し直してください。");}
    finally {setBusy(false);}
  };
  const exportCandidate = async (conflict: WorkspaceConflictInspection, candidate: WorkspaceConflictCandidateSummary) => {
    setBusy(true); setMessage("");
    try {
      const saved = await window.folio.request<string | null>({type: "sync:conflictExport",
        operationId: conflict.operationId, side: candidate.side, expectedRevision: candidate.revision,
        expectedCheckpointHash: candidate.checkpointHash});
      setMessage(saved ? "候補のJSONを書き出しました。添付本体を含まないため完全バックアップではありません。" : "書き出しを取り消しました。");
    } catch {setMessage("候補を書き出せませんでした。競合の状態と保存先を確認してください。");}
    finally {setBusy(false);}
  };
  const conflict = view?.available ? view.conflict : null;
  return <span className={showCandidates ? "save-state conflict-inspector" : "conflict-inspector"}>
    {showCandidates && <button type="button" onClick={() => void inspect()} aria-expanded={open} disabled={busy}>競合候補</button>}
    {open && <span className="conflict-panel" role="region" aria-label="同期競合の候補" aria-live="polite">
      {busy ? "確認中…" : message || (!view?.available ? "候補を確認できません。" : !conflict ? "競合はありません。" : "")}
      {conflict && <>
        <span>競合記録時点の候補です。JSONに添付本体は含まれず、完全バックアップではありません。</span>
        {conflict.status.generation !== conflict.localGeneration && <span>競合後に保存したローカル編集は、この候補には含まれません。</span>}
        {[conflict.local, conflict.remote].map((candidate) => <span key={candidate.side}>
          {candidate.side === "local" ? "ローカル候補: " : "リモート候補: "}{conflictCandidateText(candidate)}{" "}
          <button type="button" disabled={busy || candidate.checkpointHash === null} onClick={() => void exportCandidate(conflict, candidate)}>JSONを書き出す</button>
        </span>)}
        <button type="button" disabled={busy || conflict.remote.checkpointHash === null} onClick={() => void compare(conflict)}>ページを比較</button>
        {comparison && <span className="conflict-comparison">
          <span>変更のあるページ {comparison.totalChanged} 件（最大50件）。本文は各500文字までの抜粋です。書式・添付本体・DBレコード・履歴の比較は含みません。ページの設定だけの変更も含みます。</span>
          {comparison.differences.map((difference) => <span key={difference.id} className="conflict-comparison-page">
            <strong>ページID: {difference.id}</strong>
            {([['ローカル', difference.local], ['リモート', difference.remote]] as const).map(([label, page]) =>
              <span key={label}><strong>{label}: {page ? page.title || '(無題)' : 'この候補にはありません'}</strong>
                {page && <span className="conflict-comparison-body">{page.body}{page.bodyTruncated ? '\n…（省略）' : ''}</span>}</span>)}
          </span>)}
          {comparison.totalChanged > comparison.differences.length && <span>残り {comparison.totalChanged - comparison.differences.length} 件は省略しています。</span>}
        </span>}
        <button type="button" disabled={busy || conflict.remote.checkpointHash === null} onClick={() => void compareRecords(conflict)}>移行済みDBレコードを比較</button>
        {recordComparison && <span className="conflict-comparison">
          <span>変更のある移行済みレコード {recordComparison.totalChanged} 件（最大50件）。題名・ゴミ箱の状態・所属・順序・値を比較します。旧形式のDB行・DB設定・本文・履歴・添付本体は含みません。値は各500文字まで、項目は識別子で表示します。</span>
          {recordComparison.differences.map((difference) => <span key={difference.pageId} className="conflict-comparison-page">
            <strong>レコードID: {difference.pageId}{difference.moved ? " · 所属DB変更" : ""}</strong>
            {([['ローカル', difference.local], ['リモート', difference.remote]] as const).map(([label, row]) =>
              <span key={label}><strong>{label}: {row ? `${row.title || '(無題)'} · ${row.deletedAt === null ? '通常' : 'ゴミ箱'} · DB ${row.databasePageId} · 位置 ${row.position}` : 'この候補にはありません'}</strong>
                {row && <span className="conflict-comparison-body">{row.values}{row.valuesTruncated ? '\n…（省略）' : ''}</span>}</span>)}
          </span>)}
          {recordComparison.totalChanged > recordComparison.differences.length && <span>残り {recordComparison.totalChanged - recordComparison.differences.length} 件は省略しています。</span>}
        </span>}
      </>}
    </span>}
    <WorkspaceConflictDecisionControls conflict={open ? conflict : null} inputReady={inputReady} onReview={() => setOpen(false)} />
  </span>;
}
