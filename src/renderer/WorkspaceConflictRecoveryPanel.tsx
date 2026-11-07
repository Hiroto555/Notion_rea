import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  ArchiveCursor,
  ArchiveItem,
  RecoveryPanelPort,
} from "../shared/conflict-recovery";
import {
  applyActionResult,
  applyList,
  applyStatus,
  beginExport,
  beginList,
  beginRestore,
  beginStatus,
  canQueryStatus,
  canStartOperation,
  createRecoveryPanelModel,
  disposeRecoveryPanelModel,
  failList,
  failOperation,
  failStatus,
  selectTarget,
  targetFromItem,
  type RecoveryExportMode,
  type RecoveryPanelModel,
} from "./conflict-recovery-model";

export type WorkspaceConflictRecoveryPanelProps = {
  port: RecoveryPanelPort;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatSuccessKind(kind: string): string {
  if (kind === "metadata-only") return "JSONのみ（metadata-only）";
  if (kind === "complete-bundle") return "添付付き回収データ";
  if (kind === "restored") return "新規コピーとして復元";
  return kind;
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    fontSize: 13,
  } satisfies CSSProperties,
  section: {
    border: "1px solid #d0d7de",
    borderRadius: 6,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  } satisfies CSSProperties,
  item: {
    border: "1px solid #d8dee4",
    borderRadius: 4,
    padding: 8,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,
  muted: { color: "#57606a" } satisfies CSSProperties,
  noticeInfo: {
    background: "#ddf4ff",
    border: "1px solid #54aeff",
    borderRadius: 4,
    padding: 8,
  } satisfies CSSProperties,
  noticeCaution: {
    background: "#fff8c5",
    border: "1px solid #d4a72c",
    borderRadius: 4,
    padding: 8,
  } satisfies CSSProperties,
  noticeBlocked: {
    background: "#ffebe9",
    border: "1px solid #ff8182",
    borderRadius: 4,
    padding: 8,
  } satisfies CSSProperties,
  noticeUnknown: {
    background: "#fbefff",
    border: "1px solid #c297ff",
    borderRadius: 4,
    padding: 8,
  } satisfies CSSProperties,
  noticeError: {
    background: "#ffebe9",
    border: "1px solid #ff8182",
    borderRadius: 4,
    padding: 8,
  } satisfies CSSProperties,
  button: { padding: "4px 10px" } satisfies CSSProperties,
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    wordBreak: "break-all",
  } satisfies CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse",
  } satisfies CSSProperties,
  th: {
    textAlign: "left",
    borderBottom: "1px solid #d0d7de",
    padding: "4px 6px",
    fontWeight: 600,
  } satisfies CSSProperties,
  td: {
    borderBottom: "1px solid #eaeef2",
    padding: "4px 6px",
    verticalAlign: "top",
  } satisfies CSSProperties,
} as const;

export function WorkspaceConflictRecoveryPanel(
  props: WorkspaceConflictRecoveryPanelProps,
) {
  const [model, setModel] = useState<RecoveryPanelModel>(createRecoveryPanelModel);
  const modelRef = useRef(model);
  const tokenRef = useRef(0);
  const aliveRef = useRef(true);

  function applyNow(updater: (current: RecoveryPanelModel) => RecoveryPanelModel): void {
    const next = updater(modelRef.current);
    modelRef.current = next;
    setModel(next);
  }

  function nextToken(): number {
    tokenRef.current += 1;
    return tokenRef.current;
  }

  async function loadPage(cursor?: ArchiveCursor): Promise<void> {
    const token = nextToken();
    applyNow((current) => beginList(current, token, cursor));
    try {
      const page = await props.port.list(cursor);
      if (!aliveRef.current) return;
      applyNow((current) =>
        applyList(current, token, page, { append: cursor !== undefined }),
      );
    } catch (error) {
      if (!aliveRef.current) return;
      applyNow((current) => failList(current, token, errorMessage(error)));
    }
  }

  async function queryStatus(): Promise<void> {
    const token = nextToken();
    applyNow((current) => beginStatus(current, token));
    try {
      const result = await props.port.status();
      if (!aliveRef.current) return;
      applyNow((current) => applyStatus(current, token, result));
    } catch (error) {
      if (!aliveRef.current) return;
      applyNow((current) => failStatus(current, token, errorMessage(error)));
    }
  }

  async function runExport(mode: RecoveryExportMode): Promise<void> {
    const target = modelRef.current.target;
    if (target === null || !canStartOperation(modelRef.current, target)) return;
    const token = nextToken();
    applyNow((current) => beginExport(current, token, target, mode));
    try {
      const result = await props.port.export(target, mode);
      if (!aliveRef.current) return;
      applyNow((current) => applyActionResult(current, token, result));
    } catch (error) {
      if (!aliveRef.current) return;
      applyNow((current) =>
        failOperation(current, token, { target, message: errorMessage(error) }),
      );
    }
  }

  async function runRestore(): Promise<void> {
    const target = modelRef.current.target;
    if (target === null || !canStartOperation(modelRef.current, target)) return;
    const token = nextToken();
    applyNow((current) => beginRestore(current, token, target));
    try {
      const result = await props.port.restore(target);
      if (!aliveRef.current) return;
      applyNow((current) => applyActionResult(current, token, result));
    } catch (error) {
      if (!aliveRef.current) return;
      applyNow((current) =>
        failOperation(current, token, { target, message: errorMessage(error) }),
      );
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    applyNow((current) =>
      current.disposed ? createRecoveryPanelModel() : current,
    );

    void (async () => {
      await queryStatus();
      await loadPage();
    })();

    return () => {
      aliveRef.current = false;
      tokenRef.current += 1;
      modelRef.current = disposeRecoveryPanelModel(modelRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.port]);

  const selectedTarget = model.target;
  const pending = model.pendingUnknown;
  const busy = model.busy !== null;
  const canOperate = canStartOperation(model, selectedTarget);

  function renderNotice() {
    const notice = model.notice;
    if (notice === null) return null;
    if (notice.kind === "outcome-unknown") {
      const locked = pending ?? {
        target: notice.target,
        directory: notice.directory,
        reason: notice.message,
      };
      return (
        <div role="alert" style={styles.noticeUnknown}>
          <strong>結果不明（成功ではありません）</strong>
          <div>{notice.message}</div>
          <div style={styles.muted}>
            保全先の候補（未確認）: <span style={styles.code}>{notice.directory}</span>
          </div>
          <div style={styles.muted}>
            対象: <span style={styles.code}>{locked.target.operationId}</span>（
            {locked.target.kind}）
          </div>
          <div style={styles.muted}>
            成功として扱うには、同じ生成先の完成検査に通る再照会が必要です。新規IDでの再適用や削除は行いません。
          </div>
        </div>
      );
    }
    if (notice.kind === "blocked") {
      return (
        <div role="alert" style={styles.noticeBlocked}>
          <strong>処理を保留しました</strong>
          <div>{notice.message}</div>
          {notice.directory ? <div>未完了の保全先: {notice.directory}</div> : null}
          {notice.target ? (
            <div style={styles.muted}>
              対象: <span style={styles.code}>{notice.target.operationId}</span>
            </div>
          ) : null}
        </div>
      );
    }
    if (notice.kind === "caution") {
      return (
        <div role="alert" style={styles.noticeCaution}>
          <strong>注意</strong>
          <div>{notice.message}</div>
        </div>
      );
    }
    if (notice.kind === "error") {
      return (
        <div role="alert" style={{ ...styles.noticeBlocked, ...styles.noticeError }}>
          <strong>エラー</strong>
          <div>{notice.message}</div>
        </div>
      );
    }
    return (
      <div role="status" style={styles.noticeInfo}>
        {notice.message}
      </div>
    );
  }

  function renderItem(item: ArchiveItem) {
    const target = targetFromItem(item);
    const isSelected =
      selectedTarget !== null &&
      target !== null &&
      target.source === selectedTarget.source &&
      target.id === selectedTarget.id;
    const locked =
      target !== null &&
      pending !== null &&
      target.source === pending.target.source &&
      target.id === pending.target.id;
    return (
      <div key={item.id} style={styles.item}>
        <div style={styles.row}>
          <strong>#{item.id}</strong>
          <span>{item.operationId}</span>
          <span style={styles.muted}>{item.kind}</span>
          <span style={styles.muted}>{formatTimestamp(item.createdAt)}</span>
        </div>
        <div style={styles.muted}>
          {item.valid ? "読取可能" : "破損のため復元対象外"} / {formatBytes(item.bytes)}
          {item.pages === null ? "" : ` / ${item.pages}ページ`}
          {item.assets === null ? "" : ` / 添付${item.assets}件`}
          {` / 添付検査: ${item.attachmentStatus}`}
        </div>
        {item.reason ? <div style={styles.muted}>理由: {item.reason}</div> : null}
        <div style={styles.row}>
          <button
            type="button"
            style={styles.button}
            disabled={target === null}
            onClick={() => {
              if (target !== null) applyNow((current) => selectTarget(current, target));
            }}
          >
            {isSelected ? "選択中" : "この対象を選択"}
          </button>
          {locked ? <span style={styles.muted}>結果不明のため操作を保留中</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root} aria-label="競合アーカイブの復元">
      <div style={styles.section}>
        <div style={styles.row}>
          <strong>競合アーカイブ</strong>
          <span style={styles.muted}>
            {model.page === null
              ? "未読込"
              : `${model.page.items.length} / ${model.page.total} 件表示`}
          </span>
          <button
            type="button"
            style={styles.button}
            disabled={busy}
            onClick={() => void loadPage()}
          >
            最新を読み込む
          </button>
          <button
            type="button"
            style={styles.button}
            disabled={!canQueryStatus(model)}
            onClick={() => void queryStatus()}
          >
            直近の結果を再照会
          </button>
          {busy ? <span style={styles.muted}>処理中…</span> : null}
        </div>
        {renderNotice()}
        {model.lastSuccess ? (
          <div style={styles.noticeInfo}>
            <strong>
              結果（成功）: {formatSuccessKind(model.lastSuccess.kind)}
            </strong>
            <div>
              保全先:{" "}
              <span style={styles.code}>{model.lastSuccess.directory}</span>
            </div>
            <div style={styles.muted}>
              checkpoint hash:{" "}
              <span style={styles.code}>{model.lastSuccess.checkpointHash}</span>
            </div>
          </div>
        ) : null}
        {model.page === null ? (
          <div style={styles.muted}>一覧を読み込んでください。</div>
        ) : model.page.items.length === 0 ? (
          <div style={styles.muted}>競合アーカイブはありません。</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>対象</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={styles.td}>
                  <div style={{ ...styles.root, gap: 8 }}>
                    {model.page.items.map(renderItem)}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {model.page?.next ? (
          <div style={styles.row}>
            <button
              type="button"
              style={styles.button}
              disabled={busy}
              onClick={() => void loadPage(model.page?.next ?? undefined)}
            >
              次のページを読み込む
            </button>
          </div>
        ) : null}
      </div>

      <div style={styles.section}>
        <strong>選択中の対象</strong>
        {selectedTarget === null ? (
          <div style={styles.muted}>一覧から読取可能な対象を選択してください。</div>
        ) : (
          <>
            <div>
              operationId:{" "}
              <span style={styles.code}>{selectedTarget.operationId}</span>
            </div>
            <div style={styles.muted}>
              kind: {selectedTarget.kind} / createdAt:{" "}
              {formatTimestamp(selectedTarget.createdAt)}
            </div>
            <div style={styles.muted}>
              source: <span style={styles.code}>{selectedTarget.source}</span>
            </div>
            <div style={styles.muted}>
              checkpoint hash:{" "}
              <span style={styles.code}>{selectedTarget.checkpointHash}</span>
            </div>
            {pending !== null && pending.target.id === selectedTarget.id ? (
              <div style={styles.noticeUnknown}>
                保全先の確認が終わるまで、この対象への新規操作は行いません。
              </div>
            ) : null}
            <div style={styles.row}>
              <button
                type="button"
                style={styles.button}
                disabled={!canOperate}
                onClick={() => void runExport("metadata-only")}
              >
                JSONのみ保存（metadata-only）
              </button>
              <button
                type="button"
                style={styles.button}
                disabled={!canOperate}
                onClick={() => void runExport("complete-bundle")}
              >
                添付付き回収データ保存
              </button>
              <button
                type="button"
                style={styles.button}
                disabled={!canOperate}
                onClick={() => void runRestore()}
              >
                新規コピーとして復元
              </button>
            </div>
            <div style={styles.muted}>
              JSONのみ保存は復元用バンドルではありません。添付付き回収データのみ復元に使用できます。
              復元は新しいコピーを作成し、既存データを上書きしません。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default WorkspaceConflictRecoveryPanel;
