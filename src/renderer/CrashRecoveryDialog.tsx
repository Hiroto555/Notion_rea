import type { CrashRecoveryRead } from "../shared/crash-recovery";
import { describePageOperation } from "../shared/page-operation";
import { DialogFrame } from "./Modal";
import "./crash-recovery-dialog.css";

export type CrashRecoveryDialogProps = {
  read: CrashRecoveryRead;
  busy: boolean;
  error?: string;
  onResume: () => void;
  onCopy: () => void;
  /** Explicit retry of retained page create/duplicate operations only. */
  onRetryPageOperations?: () => void;
};

/** The parent owns recovery data, receipt checks, actions and dismissal. */
export function CrashRecoveryDialog({
  read,
  busy,
  error,
  onResume,
  onCopy,
  onRetryPageOperations,
}: CrashRecoveryDialogProps) {
  const snapshot = read.status === "ready" ? read.snapshot : undefined;
  const available = read.status === "ready" && !!snapshot;
  const pageOperations = snapshot?.pageOperations ?? [];
  const blocked =
    read.status === "blocked" || (read.status === "ready" && !snapshot);
  const counts = snapshot
    ? ([
        ["ページの入力", snapshot.pages.length],
        ["レコードの入力", snapshot.records.length],
        ["データベースの変更", snapshot.databases.length],
        ["データベースの作成", snapshot.creations.length],
        ["ページの作成・複製", snapshot.pageOperations?.length ?? 0],
        ["入力途中の値", snapshot.rawDrafts.length],
        ["プロパティ変更・移行", snapshot.externalOperations.length],
        ["入力元が未確認の入力", snapshot.unverifiedInputs?.length ?? 0],
      ] as const)
    : [];

  return (
    <DialogFrame
      modal
      name="前回の入力を復旧"
      className="crash-recovery-dialog"
      onClose={() => {}}
    >
      <div aria-busy={busy} data-recovery-state={read.status}>
        <header>
          <h2>前回の入力を復旧</h2>
        </header>
        {available && (
          <>
            <p>
              前回の終了時に残った入力があります。復旧方法を選んでください。
            </p>
            <dl
              className="crash-recovery-counts"
              aria-label="復旧する入力の件数"
            >
              {counts.map(([label, count]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{count} 件</dd>
                </div>
              ))}
            </dl>
            {!!pageOperations.length && (
              <div className="crash-recovery-options">
                <p>
                  <strong>ページの作成・複製</strong>
                  保存済みの結果を確認できていない、または拒否された操作です。操作内容:
                </p>
                <ul>
                  {pageOperations.slice(0, 5).map((operation) => (
                    <li key={operation.operationId}>
                      {describePageOperation(operation)}
                    </li>
                  ))}
                  {pageOperations.length > 5 && (
                    <li>ほか {pageOperations.length - 5} 件</li>
                  )}
                </ul>
                <p>
                  結果が保存済みなら照合だけを行います。結果が不明な操作だけを、同じID・同じ内容のまま再送します。拒否された操作は再送せず理由を表示します。新しい操作IDで作り直すことはありません。
                </p>
              </div>
            )}
          </>
        )}
        {blocked && (
          <div className="crash-recovery-notice" role="alert">
            <p>復旧用の入力データを読み取れませんでした。</p>
            <p>
              {read.message ||
                "入力データの内容を確認できないため、復旧を開始できません。"}
            </p>
            <p>原本を保持したまま、復旧操作を停止しています。</p>
          </div>
        )}
        {read.status === "empty" && (
          <p role="status">{read.message || "復旧する入力はありません。"}</p>
        )}
        {!!snapshot?.unverifiedInputs?.length && <p role="alert">入力元を確認できないため、「別ページに復旧」で入力を保持できます。</p>}
        {available && read.message && <p role="status">{read.message}</p>}
        <div className="crash-recovery-options">
          <p>
            <strong>入力を復元</strong>
            保存済みの結果を照合してから、保持した入力で編集を再開します。
          </p>
          <p>
            <strong>別ページに復旧</strong>
            元のページを変更せず、保持した入力データを別ページに保存します。
          </p>
        </div>
        {error && (
          <p className="crash-recovery-notice" role="alert">
            {error}
          </p>
        )}
        {busy && <p role="status">復旧処理を進めています…</p>}
        <footer>
          {onRetryPageOperations && !!pageOperations.length && (
            <button
              type="button"
              disabled={busy || !available}
              onClick={onRetryPageOperations}
            >
              同じ操作で再試行
            </button>
          )}
          <button type="button" disabled={busy || !available} onClick={onCopy}>
            別ページに復旧
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !available || !!snapshot?.unverifiedInputs?.length}
            onClick={onResume}
          >
            入力を復元
          </button>
        </footer>
      </div>
    </DialogFrame>
  );
}
