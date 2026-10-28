import { X } from "lucide-react";
import type {
  LegacyMigrationPreview,
  LegacyMigrationResult,
} from "../shared/legacy-migration-operation";
import { DialogFrame } from "./Modal";
import "./legacy-migration-dialog.css";

export type LegacyMigrationDialogProps = {
  databaseTitle?: string;
  closeBlocked?: boolean;
  state:
    | "loading"
    | "preview"
    | "saving"
    | "unknown"
    | "applied"
    | "rejected"
    | "error";
  preview?: LegacyMigrationPreview;
  result?: LegacyMigrationResult;
  error?: string;
  onPreview: () => void;
  onApply: () => void;
  onResolve: () => void;
  onClose: () => void;
};

/** Parent owns preview identity, locks, operation/journal and receipt lookup. */
export function LegacyMigrationDialog({
  databaseTitle,
  closeBlocked = false,
  state,
  preview,
  result,
  error,
  onPreview,
  onApply,
  onResolve,
  onClose,
}: LegacyMigrationDialogProps) {
  const busy = state === "loading" || state === "saving";
  const cannotClose = busy || closeBlocked;
  const close = () => {
    if (!cannotClose) onClose();
  };
  return (
    <DialogFrame
      modal
      name="旧形式データベースを移行"
      className="legacy-migration-dialog"
      onClose={close}
    >
      <header>
        <h2>旧形式データベースを移行</h2>
        <button
          type="button"
          aria-label="閉じる"
          disabled={cannotClose}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <p>
        「{preview?.title || databaseTitle || "選択したデータベース"}
        」の行を、本文を編集できるページに変換します。
      </p>
      <p>
        選択したデータベースだけが対象です。適用前に SQLite
        と添付ファイルをコピーして検証し、元の行データと履歴を保持します。
      </p>
      {preview && (
        <dl className="legacy-migration-counts">
          <div>
            <dt>ページに変換する行</dt>
            <dd>{preview.currentRecords}</dd>
          </div>
          <div>
            <dt>履歴だけにある行の対応を保持</dt>
            <dd>{preview.historicalRecords}</dd>
          </div>
        </dl>
      )}
      {state === "loading" && (
        <p role="status">移行前のデータを確認しています…</p>
      )}
      {state === "saving" && (
        <p role="status">コピーを検証し、データベースを移行しています…</p>
      )}
      {state === "unknown" && (
        <p role="alert">
          移行結果が不明です。保持した操作の結果を確認してください。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {preview?.issues.length ? (
        <div role="alert">
          <p>原本を変更せず停止しました。</p>
          <ul>
            {preview.issues.map((issue, index) => (
              <li
                key={`${issue.pageId}:${issue.versionId ?? "current"}:${index}`}
              >
                {issue.reason}
                {issue.versionId === undefined
                  ? ""
                  : `（履歴 ${issue.versionId}）`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {state === "applied" && (
        <div role="status">
          <p>
            {result?.records ?? preview?.currentRecords ?? 0} 行を移行しました。
          </p>
          {result?.snapshotPath && (
            <p className="legacy-migration-path">
              移行前コピー: {result.snapshotPath}
            </p>
          )}
        </div>
      )}
      <footer>
        <button type="button" disabled={cannotClose} onClick={close}>
          閉じる
        </button>
        {state === "unknown" ? (
          <button type="button" className="primary" onClick={onResolve}>
            移行結果を確認
          </button>
        ) : (
          state !== "applied" && (
            <>
              <button type="button" disabled={busy} onClick={onPreview}>
                移行プレビューを更新
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  state !== "preview" ||
                  !preview?.canApply ||
                  !!preview.issues.length
                }
                onClick={onApply}
              >
                コピーを作成して移行
              </button>
            </>
          )
        )}
      </footer>
    </DialogFrame>
  );
}
