import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceConflictInspection } from "../shared/workspace-conflict-view";
import {
  ConflictDecisionModel,
  emptyConflictDecisionUi,
} from "./conflict-decision-model";
import { compareConflictPages } from "./conflict-page-comparison";
import { compareConflictRecords } from "./conflict-record-comparison";

export function WorkspaceConflictDecisionControls({
  conflict,
  inputReady,
  onReview,
}: {
  conflict: WorkspaceConflictInspection | null;
  inputReady: () => boolean;
  onReview: () => void;
}) {
  const readiness = useRef(inputReady);
  readiness.current = inputReady;
  const [state, setState] = useState(emptyConflictDecisionUi);
  const reviewRegion = useRef<HTMLSpanElement>(null);
  const [model] = useState(
    () =>
      new ConflictDecisionModel(
        (request) => window.folio.request(request),
        () => readiness.current(),
        setState,
      ),
  );
  useEffect(() => {
    void model.refresh();
    const timer = window.setInterval(() => void model.refresh(), 10_000);
    return () => {
      window.clearInterval(timer);
      model.invalidate();
    };
  }, [model]);
  useEffect(() => {
    if (state.preview) reviewRegion.current?.focus();
  }, [state.preview?.id]);
  const comparison = useMemo(() => {
    const preview = state.preview;
    if (!preview?.remoteCheckpointJson) return null;
    try {
      return {
        pages: compareConflictPages(
          preview.latestCheckpointJson,
          preview.remoteCheckpointJson,
        ),
        records: compareConflictRecords(
          preview.latestCheckpointJson,
          preview.remoteCheckpointJson,
        ),
      };
    } catch {
      return null;
    }
  }, [state.preview]);
  const review = (choice: "local" | "remote") => {
    if (!conflict) return;
    void model.review({
      choice,
      operationId: conflict.operationId,
      expectedLocalHash: conflict.local.checkpointHash,
      expectedRemoteRevision: conflict.remote.revision,
      expectedRemoteHash: conflict.remote.checkpointHash,
    });
    onReview();
  };
  const view = state.view,
    preview = state.preview;
  const status = state.unknown
    ? "選択要求の結果を確認できません"
    : view?.state === "requested"
      ? "競合の選択を準備中 · 終了時に再確認"
      : view?.state === "pending"
        ? "次回起動の競合選択を保留中"
        : view?.state === "consumed"
          ? "前回の競合選択を記録済み"
          : view?.state === "blocked"
            ? "競合の選択記録を確認できません"
            : "";
  return (
    <span className="conflict-decision-controls" aria-live="polite">
      {status && <span>{status} </span>}
      {view?.state === "requested" && view.reason && (
        <span>
          入力・対象・同期状態が変わっています。終了時の確定は保留されます。{" "}
        </span>
      )}
      {conflict && (
        <>
          <button
            type="button"
            disabled={
              state.busy || state.unknown || !view?.canPreview || !inputReady()
            }
            onClick={() => review("local")}
          >
            この端末の保存済み内容を確認
          </button>{" "}
          <button
            type="button"
            disabled={
              state.busy ||
              state.unknown ||
              !view?.canPreview ||
              !inputReady() ||
              conflict.remote.checkpointHash === null
            }
            onClick={() => review("remote")}
          >
            リモート版を使う内容を確認
          </button>
        </>
      )}
      {view?.canCancel && (
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void model.cancel()}
        >
          競合の選択予約を取消
        </button>
      )}
      {(state.unknown ||
        (!view && conflict !== null) ||
        view?.state === "blocked") && (
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void model.refresh()}
        >
          選択状態を確認
        </button>
      )}
      {state.notice && <span>{state.notice}</span>}
      {preview && (
        <span
          className="conflict-panel conflict-decision-review"
          ref={reviewRegion}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !state.busy) {
              event.stopPropagation();
              model.discardPreview();
            }
          }}
          role="region"
          aria-label="競合の選択内容を確認"
        >
          <strong>
            {preview.target.choice === "local"
              ? "この端末の最新保存内容を使います"
              : "選択したリモート版を使います"}
          </strong>
          <span>
            まだ本文は変更していません。終了時に予約を確定し、次回起動時に接続と対象を再確認します。接続できない場合は保留します。
          </span>
          <span>
            この端末の最新保存: 世代 {preview.target.generation} · ページ{" "}
            {preview.latestPages} · 添付 {preview.latestAssets} · 識別{" "}
            {preview.target.latestCheckpointHash.slice(0, 12)}
          </span>
          <span>
            競合時点のローカル候補: 世代 {preview.target.conflictGeneration} ·
            識別 {preview.target.localCheckpointHash.slice(0, 12)}
          </span>
          <span>
            相手の候補: R{preview.target.remoteRevision} · 識別{" "}
            {preview.target.remoteCheckpointHash?.slice(0, 12) ?? "なし"}
          </span>
          {preview.target.latestCheckpointHash !==
            preview.target.localCheckpointHash && (
            <strong>
              競合時点より後の保存内容があります。この確認は最新保存内容を対象にしています。
            </strong>
          )}
          {comparison && (
            <span className="conflict-comparison">
              <span>
                最新保存内容と相手の差: ページ {comparison.pages.totalChanged}{" "}
                件、移行済みDBレコード {comparison.records.totalChanged}{" "}
                件。各最大50件の抜粋です。
              </span>
              {comparison.pages.differences.map((difference) => (
                <span className="conflict-comparison-page" key={difference.id}>
                  <strong>ページ: {difference.id}</strong>
                  {(
                    [
                      ["この端末の最新保存", difference.local],
                      ["相手", difference.remote],
                    ] as const
                  ).map(([label, page]) => (
                    <span key={label}>
                      <strong>
                        {label}: {page?.title || (page ? "(無題)" : "なし")}
                      </strong>
                      {page && (
                        <span className="conflict-comparison-body">
                          {page.body}
                          {page.bodyTruncated ? "\n…（省略）" : ""}
                        </span>
                      )}
                    </span>
                  ))}
                </span>
              ))}
              {comparison.records.differences.map((difference) => (
                <span
                  className="conflict-comparison-page"
                  key={difference.pageId}
                >
                  <strong>レコード: {difference.pageId}</strong>
                  {(
                    [
                      ["この端末の最新保存", difference.local],
                      ["相手", difference.remote],
                    ] as const
                  ).map(([label, row]) => (
                    <span key={label}>
                      {label}:{" "}
                      {row
                        ? `${row.title} · ${row.deletedAt === null ? "通常" : "ゴミ箱"} · DB ${row.databasePageId}`
                        : "なし"}
                      {row && (
                        <span className="conflict-comparison-body">
                          {row.values}
                          {row.valuesTruncated ? "\n…（省略）" : ""}
                        </span>
                      )}
                    </span>
                  ))}
                </span>
              ))}
            </span>
          )}
          {!comparison && preview.remoteCheckpointJson !== null && (
            <span>比較を表示できないため、選択を確定できません。</span>
          )}
          <span>
            比較は本文・値の各500文字までの抜粋です。旧形式DB行・DB設定・履歴・書式・添付本体の完全比較ではありません。保全するcheckpoint
            JSONは完全バックアップではありません。取り出し・復元は「保全した競合データ」から新しい保存先へ行えます。
          </span>
          <label>
            <input
              type="checkbox"
              checked={state.acknowledged}
              onChange={(event) => model.acknowledge(event.target.checked)}
            />
            保存済みの対象と比較範囲を確認しました。未保存・変換中の入力は含まれないことを理解しました。
          </label>
          <button
            type="button"
            disabled={
              state.busy ||
              !state.acknowledged ||
              !inputReady() ||
              (!comparison && preview.remoteCheckpointJson !== null)
            }
            onClick={() => void model.confirm()}
          >
            この選択を終了時に確定する準備
          </button>
          <button
            type="button"
            disabled={state.busy}
            onClick={() => model.discardPreview()}
          >
            確認を閉じる
          </button>
        </span>
      )}
    </span>
  );
}
