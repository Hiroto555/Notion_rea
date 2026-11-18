import { useState } from "react";
import type { JSX } from "react";
import type {
  TransferMaintenanceEntry,
  TransferMaintenanceView,
  TransferReleasePlanView,
  TransferReleaseResult,
} from "../../shared/sync-management";

export const TRANSFER_GENERIC_ERROR =
  "転送操作を完了できませんでした。もう一度お試しください。";

const TRANSFER_REFRESH_ERROR =
  "解放は完了しましたが、一覧を更新できませんでした。更新して状態を確認してください。";

const TRANSFER_STATE_LABELS: Record<TransferMaintenanceEntry["state"], string> = {
  active: "転送中",
  blocked: "ブロック中",
  completed: "完了",
  releasing: "解放処理中",
  "empty-scope": "空のスコープ",
  unknown: "不明",
};

const TRANSFER_PURPOSE_LABELS: Record<TransferMaintenanceEntry["state"], string> = {
  active: "転送中のキャッシュ",
  blocked: "同期に保持されているキャッシュ",
  completed: "転送済みのキャッシュ",
  releasing: "解放処理中のキャッシュ",
  "empty-scope": "空のスコープの記録",
  unknown: "状態不明のキャッシュ",
};

export function transferErrorMessage(_error: unknown): string {
  return TRANSFER_GENERIC_ERROR;
}

export function formatTransferBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

export function shortScopeHash(scopeHash: string, length = 8): string {
  const value = typeof scopeHash === "string" ? scopeHash : "";
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

export function transferEntryPurpose(entry: TransferMaintenanceEntry): string {
  return TRANSFER_PURPOSE_LABELS[entry.state] ?? "状態不明のキャッシュ";
}

export function formatTransferState(state: TransferMaintenanceEntry["state"]): string {
  return TRANSFER_STATE_LABELS[state] ?? state;
}

export function transferOutcomeNotice(result: TransferReleaseResult): {
  kind: "released" | "held" | "unknown";
  text: string;
} {
  if (result.outcome === "outcome-unknown") {
    return {
      kind: "unknown",
      text: `操作 ${result.operationId} の解放結果を確認できません。この操作 ID を保持し、結果を確認するまで新しい解放を開始しないでください。`,
    };
  }
  if (result.outcome === "held") {
    return {
      kind: "held",
      text: `操作 ${result.operationId} は保留されました（理由: ${
        result.reason ?? "理由の提示なし"
      }）。エントリは保持され、バイト数は解放されていません。`,
    };
  }
  return {
    kind: "released",
    text: `操作 ${result.operationId} で ${result.releasedBytes} バイト（${formatTransferBytes(
      result.releasedBytes,
    )}）を解放しました。`,
  };
}

export function transferUnknownNotice(operationId: string): string {
  return `操作 ${operationId} の解放結果を確認できません。この操作 ID を保持し、結果を確認するまで新しい解放を開始しないでください。`;
}

export function transferReleaseConfirmation(entry: TransferMaintenanceEntry) {
  return {
    entryId: entry.entryId,
    assetId: entry.assetId ?? "なし",
    scopeHash: entry.scopeHash,
    shortScopeHash: shortScopeHash(entry.scopeHash),
    purpose: transferEntryPurpose(entry),
    currentScope: entry.currentScope,
    scopeLabel: entry.currentScope ? "現在のスコープ" : "古いスコープ",
    bytes: entry.bytes,
    bytesLabel: `${entry.bytes} バイト（${formatTransferBytes(entry.bytes)}）`,
    cacheNotice: "不完全なキャッシュは再ダウンロードされます。",
  };
}

export function transferResumeConfirmation(
  entry: TransferMaintenanceEntry,
  operationId: string,
) {
  return {
    operationId,
    entryId: entry.entryId,
    purpose: transferEntryPurpose(entry),
    shortScopeHash: shortScopeHash(entry.scopeHash),
    bytesLabel: `${entry.bytes} バイト（${formatTransferBytes(entry.bytes)}）`,
    usesNewTicket: false,
    message:
      "新しい解放チケットは作成しません。次の操作 ID をそのまま使って解放を再開します。",
  };
}

export function pendingTransferEntries(
  entries: TransferMaintenanceEntry[],
  resolvedOperationIds: readonly string[] = [],
  hiddenOperationId?: string | null,
): TransferMaintenanceEntry[] {
  return entries.filter(
    (entry) =>
      typeof entry.operationId === "string" &&
      entry.operationId.length > 0 &&
      !resolvedOperationIds.includes(entry.operationId) &&
      entry.operationId !== hiddenOperationId,
  );
}

export type TransferMaintenancePanelProps = {
  view: TransferMaintenanceView;
  busy: boolean;
  onRefresh?: (cursor?: string) => Promise<void>;
  onPlan: (entryId: string) => Promise<TransferReleasePlanView>;
  onRelease: (operationId: string) => Promise<TransferReleaseResult>;
  onResolve: (operationId: string) => Promise<TransferReleaseResult>;
};

type Pending = "refresh" | "plan" | "release" | "resume" | "resolve" | null;
type Notice = { kind: "released" | "held" | "unknown" | "error"; text: string } | null;
type UnknownRelease = { operationId: string; entry: TransferMaintenanceEntry };
type ResumeTarget = { operationId: string; entry: TransferMaintenanceEntry };

export function TransferMaintenancePanel({
  view,
  busy,
  onRefresh,
  onPlan,
  onRelease,
  onResolve,
}: TransferMaintenancePanelProps): JSX.Element {
  const [pending, setPending] = useState<Pending>(null);
  const [confirmation, setConfirmation] = useState<TransferReleasePlanView | null>(null);
  const [unknown, setUnknown] = useState<UnknownRelease | null>(null);
  const [resumeTarget, setResumeTarget] = useState<ResumeTarget | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [resolvedOperationIds, setResolvedOperationIds] = useState<string[]>([]);
  const isBusy = busy || pending !== null;
  const pendingEntries = pendingTransferEntries(
    view.entries,
    resolvedOperationIds,
    unknown?.operationId ?? null,
  );
  const releaseLocked = unknown !== null || pendingEntries.length > 0;
  const nextCursor = view.nextCursor;
  const confirm = confirmation ? transferReleaseConfirmation(confirmation.entry) : null;
  const resume = resumeTarget
    ? transferResumeConfirmation(resumeTarget.entry, resumeTarget.operationId)
    : null;

  const markResolved = (operationId: string) => {
    setResolvedOperationIds((current) =>
      current.includes(operationId) ? current : [...current, operationId],
    );
  };

  const refreshAfterRelease = async () => {
    if (!onRefresh) return;
    try {
      await onRefresh();
    } catch {
      setNotice({ kind: "error", text: TRANSFER_REFRESH_ERROR });
    }
  };

  const applyResult = async (
    operationId: string,
    entry: TransferMaintenanceEntry,
    result: TransferReleaseResult,
    createUnknown: boolean,
  ) => {
    const nextNotice = transferOutcomeNotice(result);
    if (result.outcome === "outcome-unknown") {
      if (createUnknown) setUnknown({ operationId, entry });
      setNotice(nextNotice);
      return;
    }
    markResolved(operationId);
    setUnknown((current) => (current?.operationId === operationId ? null : current));
    setNotice(nextNotice);
    if (result.outcome === "released") await refreshAfterRelease();
  };

  const refresh = async (cursor?: string) => {
    if (!onRefresh) return;
    setPending("refresh");
    setNotice(null);
    try {
      await onRefresh(cursor);
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const plan = async (entryId: string) => {
    if (releaseLocked) return;
    setPending("plan");
    setNotice(null);
    try {
      const result = await onPlan(entryId);
      setConfirmation(result);
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const release = async () => {
    if (!confirmation || releaseLocked) return;
    const operationId = confirmation.operationId;
    const entry = confirmation.entry;
    setPending("release");
    setNotice(null);
    try {
      const result = await onRelease(operationId);
      setConfirmation(null);
      await applyResult(operationId, entry, result, true);
    } catch (error) {
      setUnknown({ operationId, entry });
      setNotice({ kind: "unknown", text: transferUnknownNotice(operationId) });
      setConfirmation(null);
    } finally {
      setPending(null);
    }
  };

  const resumeRelease = async () => {
    if (!resumeTarget) return;
    const { operationId, entry } = resumeTarget;
    setPending("resume");
    setNotice(null);
    try {
      const result = await onRelease(operationId);
      setResumeTarget(null);
      await applyResult(operationId, entry, result, true);
    } catch (error) {
      setUnknown({ operationId, entry });
      setNotice({ kind: "unknown", text: transferUnknownNotice(operationId) });
      setResumeTarget(null);
    } finally {
      setPending(null);
    }
  };

  const resolve = async (operationId: string) => {
    const entry =
      (unknown?.operationId === operationId ? unknown.entry : undefined) ??
      view.entries.find((candidate) => candidate.operationId === operationId);
    setPending("resolve");
    setNotice(null);
    try {
      const result = await onResolve(operationId);
      if (!entry) {
        setNotice(transferOutcomeNotice(result));
        if (result.outcome !== "outcome-unknown") {
          markResolved(operationId);
          if (result.outcome === "released") await refreshAfterRelease();
        }
        return;
      }
      await applyResult(operationId, entry, result, false);
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const noticeRole =
    notice && (notice.kind === "error" || notice.kind === "held" || notice.kind === "unknown")
      ? "alert"
      : "status";

  return (
    <section aria-labelledby="transfer-maintenance-title" aria-busy={isBusy}>
      <h2 id="transfer-maintenance-title">転送メンテナンス</h2>
      <p>
        この端末に残っている転送キャッシュを確認し、不要なエントリだけを解放します。パス指定や一括削除は行いません。
      </p>

      <dl>
        <div>
          <dt>保持バイト数</dt>
          <dd>
            {view.usedBytes} バイト（{formatTransferBytes(view.usedBytes)}）
          </dd>
        </div>
        <div>
          <dt>上限超過</dt>
          <dd>{view.overLimit ? "はい" : "いいえ"}</dd>
        </div>
        <div>
          <dt>保留</dt>
          <dd>{view.held ?? "なし"}</dd>
        </div>
      </dl>

      <div>
        <button type="button" onClick={() => refresh()} disabled={isBusy || !onRefresh}>
          更新
        </button>
        {nextCursor ? (
          <button
            type="button"
            onClick={() => refresh(nextCursor)}
            disabled={isBusy || !onRefresh}
            data-cursor={nextCursor}
          >
            さらに読み込む
          </button>
        ) : null}
        {view.held ? <p>保留中でも更新できます: {view.held}</p> : null}
      </div>

      {isBusy ? <p role="status">処理中…</p> : null}

      {unknown ? (
        <section aria-labelledby="transfer-unknown-title">
          <h3 id="transfer-unknown-title">解放結果を確認できません</h3>
          <p>
            この操作 ID を保持してください: <code>{unknown.operationId}</code>。結果を確認するまで新しい解放は開始できません。
          </p>
          <p>
            {transferEntryPurpose(unknown.entry)}。スコープ{" "}
            <code>{shortScopeHash(unknown.entry.scopeHash)}</code>、
            {unknown.entry.bytes} バイト（{formatTransferBytes(unknown.entry.bytes)}）。
          </p>
          <button
            type="button"
            onClick={() => void resolve(unknown.operationId)}
            disabled={isBusy}
          >
            結果を照会
          </button>
          <button
            type="button"
            onClick={() => setResumeTarget(unknown)}
            disabled={isBusy}
          >
            解放を再開
          </button>
        </section>
      ) : null}

      {pendingEntries.length > 0 ? (
        <section aria-labelledby="transfer-pending-title">
          <h3 id="transfer-pending-title">保留中の解放操作</h3>
          <p>
            再起動後も残っている解放操作です。同じ操作 ID のまま結果を照会するか、解放を再開してください。新しい解放チケットは作成しません。
          </p>
          <ul>
            {pendingEntries.map((entry) => {
              const operationId = entry.operationId as string;
              return (
                <li key={operationId} data-operation-id={operationId}>
                  <p>
                    {transferEntryPurpose(entry)}。スコープ{" "}
                    <code>{shortScopeHash(entry.scopeHash)}</code>、
                    {entry.bytes} バイト（{formatTransferBytes(entry.bytes)}）。
                  </p>
                  <p>
                    操作 ID: <code>{operationId}</code>
                  </p>
                  <button
                    type="button"
                    onClick={() => void resolve(operationId)}
                    disabled={isBusy}
                  >
                    結果を照会
                  </button>
                  <button
                    type="button"
                    onClick={() => setResumeTarget({ operationId, entry })}
                    disabled={isBusy}
                  >
                    解放を再開
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {resume && resumeTarget ? (
        <section aria-labelledby="transfer-resume-title">
          <h3 id="transfer-resume-title">解放の再開確認</h3>
          <p>{resume.message}</p>
          <dl>
            <div>
              <dt>操作 ID</dt>
              <dd>
                <code>{resume.operationId}</code>
              </dd>
            </div>
            <div>
              <dt>目的</dt>
              <dd>{resume.purpose}</dd>
            </div>
            <div>
              <dt>スコープ</dt>
              <dd>
                <code>{resume.shortScopeHash}</code>
              </dd>
            </div>
            <div>
              <dt>保持バイト数</dt>
              <dd>{resume.bytesLabel}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => void resumeRelease()}
            disabled={isBusy}
          >
            同じ操作 ID で解放を再開
          </button>
          <button
            type="button"
            onClick={() => setResumeTarget(null)}
            disabled={isBusy}
          >
            キャンセル
          </button>
        </section>
      ) : null}

      {notice ? (
        <p role={noticeRole} aria-live={noticeRole === "alert" ? "assertive" : "polite"}>
          {notice.text}
        </p>
      ) : null}

      {confirm && confirmation ? (
        <section aria-labelledby="transfer-confirm-title">
          <h3 id="transfer-confirm-title">解放の確認（ドライラン）</h3>
          <p>
            このエントリだけを解放します。パス指定や一括削除は受け付けません。
          </p>
          <p>{confirm.cacheNotice}</p>
          <dl>
            <div>
              <dt>目的</dt>
              <dd>{confirm.purpose}</dd>
            </div>
            <div>
              <dt>スコープ</dt>
              <dd>
                <code>{confirm.shortScopeHash}</code>
              </dd>
            </div>
            <div>
              <dt>スコープの状態</dt>
              <dd>{confirm.scopeLabel}</dd>
            </div>
            <div>
              <dt>保持バイト数</dt>
              <dd>{confirm.bytesLabel}</dd>
            </div>
            <div>
              <dt>エントリ ID（詳細）</dt>
              <dd>
                <code>{confirm.entryId}</code>
              </dd>
            </div>
            <div>
              <dt>アセット ID</dt>
              <dd>{confirm.assetId}</dd>
            </div>
          </dl>
          <p>
            不透明な操作 ID: <code>{confirmation.operationId}</code>
          </p>
          <button type="button" onClick={() => void release()} disabled={isBusy || releaseLocked}>
            解放を実行
          </button>
          <button type="button" onClick={() => setConfirmation(null)} disabled={isBusy}>
            キャンセル
          </button>
        </section>
      ) : null}

      {releaseLocked ? (
        <p role="status">
          未解決または保留中の解放操作があるため、新しい解放の確認はできません。同じ操作 ID の結果を確認してください。
        </p>
      ) : null}

      <table>
        <caption>転送メンテナンスのエントリ</caption>
        <thead>
          <tr>
            <th scope="col">目的とスコープ</th>
            <th scope="col">状態</th>
            <th scope="col">保持バイト数</th>
            <th scope="col">理由</th>
            <th scope="col">操作</th>
            <th scope="col">詳細</th>
          </tr>
        </thead>
        <tbody>
          {view.entries.map((entry) => (
            <tr
              key={entry.entryId}
              data-entry-id={entry.entryId}
              data-state={entry.state}
              data-scope={entry.currentScope ? "current" : "old"}
            >
              <th scope="row">
                <span>{transferEntryPurpose(entry)}</span>
                <span> · {entry.currentScope ? "現在のスコープ" : "古いスコープ"}</span>
                <br />
                <code title={entry.scopeHash}>{shortScopeHash(entry.scopeHash)}</code>
              </th>
              <td>{formatTransferState(entry.state)}</td>
              <td>
                {entry.bytes} バイト（{formatTransferBytes(entry.bytes)}）
              </td>
              <td>{entry.reason ?? "理由なし"}</td>
              <td>
                {entry.canRelease ? (
                  <button
                    type="button"
                    onClick={() => void plan(entry.entryId)}
                    disabled={isBusy || releaseLocked}
                    aria-label={`${shortScopeHash(entry.scopeHash)} の解放内容を確認`}
                  >
                    解放内容を確認
                  </button>
                ) : (
                  <span>このエントリは保持されます。解放できません。</span>
                )}
              </td>
              <td>
                <details>
                  <summary>詳細</summary>
                  <dl>
                    <div>
                      <dt>エントリ ID</dt>
                      <dd>
                        <code>{entry.entryId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>完全なスコープハッシュ</dt>
                      <dd>
                        <code>{entry.scopeHash}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>アセット ID</dt>
                      <dd>{entry.assetId ?? "なし"}</dd>
                    </div>
                    <div>
                      <dt>オフセット</dt>
                      <dd>{entry.offset}</dd>
                    </div>
                    <div>
                      <dt>状態コード</dt>
                      <dd>{entry.state}</dd>
                    </div>
                  </dl>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.entries.length === 0 ? <p>転送エントリはありません。</p> : null}
    </section>
  );
}

export default TransferMaintenancePanel;
