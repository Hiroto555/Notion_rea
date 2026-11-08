import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { SyncConnectionAction, SyncConnectionInput, SyncConnectionView } from "../../shared/sync-management";

type ConnectionMode = SyncConnectionInput["mode"];
export type PendingConnectionKind = "save" | "disable";
export type SyncConnectionPanelProps = {
  view: SyncConnectionView;
  busy: boolean;
  onSave: (input: SyncConnectionInput) => Promise<SyncConnectionAction>;
  onDisable: (requestId: string, expectedRevision: string | null) => Promise<SyncConnectionAction>;
  onRefresh: () => Promise<void>;
  onResolve?: (requestId: string) => Promise<SyncConnectionAction | null>;
};
export type SyncConnectionFeedback = {
  kind: "idle" | "busy" | "saved" | "disabled" | "held" | "outcome-unknown" | "error";
  message: string;
  requestId?: string;
};
export type ResolvedConnectionOutcome = {
  feedback: SyncConnectionFeedback;
  pendingRequestId: string | null;
  permitsRetry: boolean;
};
const INPUT_REQUIRED =
  "URL、ワークスペース ID、クライアント ID、サーバー発行トークン、接続モードを入力してください。";
const FIXED_ERROR_MESSAGE = "操作を完了できませんでした。状態を更新して、もう一度お試しください。";
const PENDING_WRITE_MESSAGE = "前回の操作結果を確認できません。更新して状態を確認してください。";
const NOTICE: Record<string, string> = {
  held: "接続の変更は保留されています。状態を更新してから操作してください。",
  "pending-restart": "変更は保存済みです。次回の再起動時に有効になります。",
  "read-only": "このワークスペースは読み取り専用です。接続情報は変更できません。",
  "secure-store-unavailable": "安全な資格情報ストアを利用できません。接続情報は変更できません。",
  "outcome-unknown": "前回の操作結果を確認できません。更新して状態を確認してください。",
  "identity-changed": "保存済みの接続先と現在の識別情報が一致しません。内容を確認してください。",
  "recovery-copy-held": "復旧用コピーが保留されています。状態を更新してください。",
  busy: "接続の処理中です。",
  "intent-present": "未完了の接続操作があります。更新して状態を確認してください。",
  conflict: "接続設定が競合しています。更新して状態を確認してください。",
  "invalid-input": "保存済みの接続情報を確認できません。入力内容を確認してください。",
  "local-error": "ローカルで接続情報の処理に失敗しました。状態を更新してください。",
  disabled: "接続は無効化されています。",
  configured: "接続は設定済みです。",
  unconfigured: "接続は未設定です。",
};

export function connectionWriteBlockReason(
  view: SyncConnectionView,
  busy: boolean,
  pendingRequestId: string | null = null,
): string | null {
  if (busy) return "処理中です。完了するまでお待ちください。";
  if (pendingRequestId) return PENDING_WRITE_MESSAGE;
  if (view.state === "held") return "接続は保留中です。保存や無効化はできません。状態を更新してください。";
  if (view.reason === "read-only") return "読み取り専用のため、接続情報は変更できません。";
  if (view.reason === "secure-store-unavailable")
    return "安全な資格情報ストアを利用できないため、接続情報は変更できません。";
  return null;
}
export function connectionDisableBlockReason(
  view: SyncConnectionView,
  busy: boolean,
  pendingRequestId: string | null = null,
): string | null {
  if (busy) return "処理中です。完了するまでお待ちください。";
  if (pendingRequestId) return PENDING_WRITE_MESSAGE;
  if (view.reason === "read-only") return "読み取り専用のため、接続情報は変更できません。";
  if (view.reason === "recovery-copy-held")
    return "復旧用コピーが保留されているため、無効化できません。状態を更新してください。";
  if (view.reason === "identity-changed")
    return "保存済みの接続先と現在の識別情報が一致しないため、無効化できません。内容を確認してください。";
  if (view.reason === "intent-present")
    return "未完了の接続操作があるため、無効化できません。更新して状態を確認してください。";
  if (view.state === "held" && view.reason !== "secure-store-unavailable")
    return "接続は保留中です。状態を更新してから無効化してください。";
  return null;
}
export function canWriteConnection(
  view: SyncConnectionView,
  busy: boolean,
  pendingRequestId: string | null = null,
): boolean {
  return connectionWriteBlockReason(view, busy, pendingRequestId) === null;
}
export function canDisableConnection(
  view: SyncConnectionView,
  busy: boolean,
  pendingRequestId: string | null = null,
): boolean {
  return connectionDisableBlockReason(view, busy, pendingRequestId) === null;
}
export function connectionStateNotice(view: SyncConnectionView): string {
  if (view.state === "held") return NOTICE.held;
  if (view.state === "pending-restart") return NOTICE["pending-restart"];
  if (view.reason && NOTICE[view.reason]) return NOTICE[view.reason];
  return NOTICE[view.state] ?? NOTICE.unconfigured;
}
function feedbackTone(feedback: SyncConnectionFeedback): "status" | "alert" {
  return feedback.kind === "error" || feedback.kind === "held" || feedback.kind === "outcome-unknown"
    ? "alert"
    : "status";
}
export function unknownOutcomeFeedback(
  kind: PendingConnectionKind,
  requestId: string,
): SyncConnectionFeedback {
  return {
    kind: "outcome-unknown",
    message:
      kind === "disable"
        ? "無効化の結果を確認できませんでした。更新して状態を確認してください。"
        : "保存結果を確認できませんでした。更新して状態を確認してください。",
    requestId,
  };
}
export function saveFeedback(action: SyncConnectionAction, requestId: string): SyncConnectionFeedback {
  if (action.outcome === "saved")
    return { kind: "saved", message: "接続情報を保存しました。次回の再起動時に有効になります。" };
  if (action.outcome === "disabled") return { kind: "disabled", message: NOTICE.disabled };
  if (action.outcome === "held")
    return { kind: "held", message: "保存は保留されました。まだ有効になっていません。" };
  return unknownOutcomeFeedback("save", requestId);
}
export function disableFeedback(action: SyncConnectionAction, requestId: string): SyncConnectionFeedback {
  if (action.outcome === "disabled")
    return {
      kind: "disabled",
      message:
        "接続を無効化しました。この端末のローカル資格情報を削除しました。サーバー側の取り消しは管理者の CLI で別途行ってください。",
    };
  if (action.outcome === "held")
    return { kind: "held", message: "無効化は保留されました。まだ完了していません。" };
  return unknownOutcomeFeedback("disable", requestId);
}
export function resolvedOutcomeFeedback(
  action: SyncConnectionAction | null,
  requestId: string,
  kind: PendingConnectionKind,
): ResolvedConnectionOutcome {
  if (action === null)
    return {
      feedback: {
        kind: "idle",
        message: "前回の操作は確定していません。もう一度実行できます。",
      },
      pendingRequestId: null,
      permitsRetry: true,
    };
  const feedback = kind === "disable" ? disableFeedback(action, requestId) : saveFeedback(action, requestId);
  return {
    feedback,
    pendingRequestId: feedback.requestId ?? null,
    permitsRetry: false,
  };
}
export function connectionErrorMessage(_error: unknown = undefined, _secret = ""): string {
  return FIXED_ERROR_MESSAGE;
}

type Field = {
  id: string;
  name: string;
  label: string;
  type: "text" | "url" | "password";
  value: string;
  set: (value: string) => void;
  help?: string;
};

export function SyncConnectionPanel({
  view,
  busy: parentBusy,
  onSave,
  onDisable,
  onRefresh,
  onResolve,
}: SyncConnectionPanelProps): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(view.target?.baseUrl ?? "");
  const [workspaceId, setWorkspaceId] = useState(view.target?.workspaceId ?? "");
  const [clientId, setClientId] = useState(view.target?.clientId ?? "");
  const [mode, setMode] = useState<ConnectionMode | "">(view.target?.mode ?? "");
  const [token, setToken] = useState("");
  const [feedback, setFeedback] = useState<SyncConnectionFeedback>({ kind: "idle", message: "" });
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<PendingConnectionKind | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const inFlightRef = useRef(false);
  const busy = parentBusy || localBusy;
  const writeBlockReason = connectionWriteBlockReason(view, busy, pendingRequestId);
  const disableBlockReason = connectionDisableBlockReason(view, busy, pendingRequestId);
  const writeDisabled = writeBlockReason !== null;
  const disableDisabled = disableBlockReason !== null;

  useEffect(() => {
    setBaseUrl(view.target?.baseUrl ?? "");
    setWorkspaceId(view.target?.workspaceId ?? "");
    setClientId(view.target?.clientId ?? "");
    setMode(view.target?.mode ?? "");
  }, [view.target?.baseUrl, view.target?.workspaceId, view.target?.clientId, view.target?.mode]);
  useEffect(
    () => () => {
      setToken("");
    },
    [],
  );
  function clearSecret() {
    setToken("");
  }
  function remember(next: SyncConnectionFeedback, kind: PendingConnectionKind = "save") {
    setFeedback(next);
    const nextPending = next.requestId ?? null;
    setPendingRequestId(nextPending);
    setPendingKind(nextPending ? kind : null);
  }
  function newRequestId(): string | null {
    if (pendingRequestId) return pendingRequestId;
    try {
      return crypto.randomUUID();
    } catch {
      setFeedback({ kind: "error", message: "要求 ID を作成できませんでした。" });
      return null;
    }
  }
  function beginOperation(): boolean {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setLocalBusy(true);
    return true;
  }
  function endOperation() {
    inFlightRef.current = false;
    setLocalBusy(false);
  }
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeDisabled) return;
    const secret = token;
    if (!baseUrl.trim() || !workspaceId.trim() || !clientId.trim() || !secret || !mode) {
      setFeedback({ kind: "error", message: INPUT_REQUIRED });
      return;
    }
    const requestId = newRequestId();
    if (!requestId) return;
    if (!beginOperation()) return;
    setFeedback({ kind: "busy", message: "接続情報を保存しています…" });
    try {
      const action = await onSave({
        requestId,
        expectedRevision: view.revision,
        baseUrl: baseUrl.trim(),
        workspaceId: workspaceId.trim(),
        clientId: clientId.trim(),
        mode,
        token: secret,
      });
      remember(saveFeedback(action, requestId), "save");
    } catch {
      remember(unknownOutcomeFeedback("save", requestId), "save");
    } finally {
      endOperation();
      clearSecret();
    }
  }
  async function handleDisable() {
    if (disableDisabled) return;
    const requestId = newRequestId();
    if (!requestId) return;
    if (!beginOperation()) return;
    setFeedback({ kind: "busy", message: "接続を無効化しています…" });
    try {
      const action = await onDisable(requestId, view.revision);
      remember(disableFeedback(action, requestId), "disable");
    } catch {
      remember(unknownOutcomeFeedback("disable", requestId), "disable");
    } finally {
      endOperation();
      clearSecret();
    }
  }
  async function handleRefresh() {
    if (busy) return;
    if (!beginOperation()) return;
    setFeedback({ kind: "busy", message: "接続状態を更新しています…" });
    let resolvedFeedback: SyncConnectionFeedback | null = null;
    let resolvedKind: PendingConnectionKind | null = null;
    try {
      if (pendingRequestId) {
        const kind = pendingKind ?? "save";
        if (onResolve) {
          try {
            const resolved = resolvedOutcomeFeedback(
              await onResolve(pendingRequestId),
              pendingRequestId,
              kind,
            );
            resolvedFeedback = resolved.feedback;
            resolvedKind = resolved.pendingRequestId ? kind : null;
          } catch {
            resolvedFeedback = unknownOutcomeFeedback(kind, pendingRequestId);
            resolvedKind = kind;
          }
        } else {
          resolvedFeedback = unknownOutcomeFeedback(kind, pendingRequestId);
          resolvedKind = kind;
        }
      }
      await onRefresh();
      if (resolvedFeedback) {
        setFeedback(resolvedFeedback);
        setPendingRequestId(resolvedFeedback.requestId ?? null);
        setPendingKind(resolvedKind);
      } else {
        setFeedback({ kind: "idle", message: "" });
        setPendingRequestId(null);
        setPendingKind(null);
      }
    } catch {
      if (resolvedFeedback) {
        setFeedback(resolvedFeedback);
        setPendingRequestId(resolvedFeedback.requestId ?? null);
        setPendingKind(resolvedKind);
      } else {
        setFeedback({ kind: "error", message: connectionErrorMessage() });
      }
    } finally {
      endOperation();
    }
  }

  const fields: Field[] = [
    {
      id: "sync-base-url",
      name: "baseUrl",
      label: "URL",
      type: "url",
      value: baseUrl,
      set: setBaseUrl,
      help: "127.0.0.1 の同期サーバー URL。",
    },
    { id: "sync-workspace-id", name: "workspaceId", label: "ワークスペース ID", type: "text", value: workspaceId, set: setWorkspaceId },
    { id: "sync-client-id", name: "clientId", label: "クライアント ID", type: "text", value: clientId, set: setClientId },
    {
      id: "sync-token",
      name: "token",
      label: "サーバー発行トークン",
      type: "password",
      value: token,
      set: setToken,
      help: "トークンは画面や状態表示には表示されません。保存後は入力欄から消去されます。",
    },
  ];

  return (
    <section className="sync-connection-panel" aria-labelledby="sync-connection-heading" aria-busy={busy}>
      <header>
        <h2 id="sync-connection-heading">同期接続</h2>
        <p>接続情報を保存すると、次回の再起動時に有効になります。保存だけでは今すぐの接続は始まりません。</p>
      </header>
      <p className="sync-connection-state">{connectionStateNotice(view)}</p>
      {(writeBlockReason ?? disableBlockReason) && (
        <p className="sync-connection-blocked" role="alert">
          {writeBlockReason ?? disableBlockReason}
        </p>
      )}
      {view.state === "pending-restart" && (
        <p className="sync-connection-restart" role="status">
          次回の再起動時に有効になります。
        </p>
      )}
      <form onSubmit={(event) => void handleSubmit(event)}>
        <fieldset>
          <legend>接続情報</legend>
          {fields.map((field) => (
            <div key={field.id}>
              <label htmlFor={field.id}>{field.label}</label>
              <input
                id={field.id}
                name={field.name}
                type={field.type}
                value={field.value}
                onChange={(event) => field.set(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={writeDisabled}
                aria-describedby={field.help ? `${field.id}-help` : undefined}
                required
              />
              {field.help && <p id={`${field.id}-help`}>{field.help}</p>}
            </div>
          ))}
          <label htmlFor="sync-mode">接続モード</label>
          <select
            id="sync-mode"
            name="mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as ConnectionMode | "")}
            disabled={writeDisabled}
            required
          >
            <option value="" disabled>モードを選択してください</option>
            <option value="publish">新しく公開して同期を開始</option>
            <option value="join">既存のワークスペースに参加（空の保存先専用）</option>
            <option value="recover">以前の接続を復旧</option>
          </select>
          <p id="sync-mode-help">
            publish は現在の内容を新しい同期先へ公開します。join は空の新規保存先から参加します。
            recover は通常のバックアップ復元後などに、新しく発行された端末 ID で接続を復旧します。
            既存の内容を自動で結合する操作ではありません。復旧用コピーからの同期は保留されます。
          </p>
        </fieldset>
        <p className="sync-connection-note">
          {view.hasCredential
            ? "サーバー発行トークンは安全なストアに保存済みです。"
            : "サーバー発行トークンはまだ保存されていません。"}
        </p>
        <div className="sync-connection-actions">
          <button type="submit" disabled={writeDisabled} aria-label="接続情報を保存">
            保存
          </button>
          <button type="button" disabled={disableDisabled} aria-label="接続を無効化" onClick={() => void handleDisable()}>
            無効化
          </button>
          <button type="button" disabled={busy} aria-label="接続状態を更新" onClick={() => void handleRefresh()}>
            更新
          </button>
        </div>
      </form>
      <p className="sync-connection-disable-note">
        無効化はこの端末に保存されたローカル資格情報を削除します。サーバー側の取り消しは管理者の CLI で別途行ってください。
      </p>
      {feedback.message && (
        <p
          className={`sync-connection-feedback sync-connection-${feedback.kind}`}
          role={feedbackTone(feedback)}
          aria-live={feedbackTone(feedback) === "status" ? "polite" : "assertive"}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}
