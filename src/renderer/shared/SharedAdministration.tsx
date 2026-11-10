import { useCallback, useEffect, useRef, useState } from "react";
import { wellFormed } from "../../collaboration/runtime/contract";
import type { Cut, Role, Scope } from "../../collaboration/runtime/contract";
import type { AdminCommand } from "../../collaboration/runtime/admin";
import type {
  RecoveryRotation,
  RecoveryStatus,
} from "../../collaboration/runtime/admin";
import type { OrganizationOverview } from "../../collaboration/runtime/organization";
import type {
  AuditEvent,
  Overview,
} from "../../collaboration/runtime/operations";
import type {
  SharedRuntimeAPI,
  SharedRuntimeRequest,
} from "../../shared/shared-runtime-ipc";
import "./shared-workbench.css";

export type SharedAdministrationProps = {
  api: SharedRuntimeAPI | undefined;
  orgId: string;
  scope: Scope;
  generation?: number;
  onChanged: () => void;
};

type AuditResponse = { cut: Cut; events: AuditEvent[] };
type InviteResponse = { inviteToken: string };
type GrantRole = Role | "none";

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const permissionMessages: Readonly<Record<string, string | undefined>> = {
  FORBIDDEN: "この操作を行う権限がありません。",
  NOT_ADMINISTRATOR: "組織の管理者ではないため実行できません。",
  NOT_MEMBER: "この組織のメンバーではありません。",
  AUTH_SCOPE_MISMATCH: "この接続の組織と操作対象が一致しません。",
  TARGET_INVALID: "対象ユーザーが不正です。",
  TARGET_MISSING: "対象ユーザーは組織のメンバーではありません。",
  TARGET_INACTIVE:
    "対象ユーザーは選択したワークスペースのメンバーではありません。",
  LAST_OWNER: "最後の所有者は変更できません。",
  WORKSPACE_MISSING: "選択したワークスペースが見つかりません。",
  DUPLICATE_WORKSPACE: "ワークスペースIDが重複しています。",
  ALREADY_BOOTSTRAPPED: "組織はすでに初期化されています。",
  INVALID_ADMIN_COMMAND: "入力内容が管理APIの形式に合いません。",
  INVALID_ID: "IDは英数字・_・-の1〜128文字で入力してください。",
};

function adminRequest(command: AdminCommand): SharedRuntimeRequest {
  return { type: "admin", command };
}

function validId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function validName(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && wellFormed(value);
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length <= 128 &&
    wellFormed(error.message)
    ? error.message
    : "";
}

function describeError(error: unknown): string {
  const code = errorCode(error);
  const mapped = permissionMessages[code];
  if (mapped !== undefined) return mapped;
  if (code.length > 0) return `操作を完了できませんでした（${code}）。`;
  return "操作を完了できませんでした。通信状態を確認してください。";
}

function describeLoadError(label: string, error: unknown): string {
  const code = errorCode(error);
  if (code === "FORBIDDEN" || code === "NOT_ADMINISTRATOR")
    return `${label}は管理者のみ表示できます。`;
  if (code === "NOT_MEMBER" || code === "AUTH_SCOPE_MISMATCH")
    return `${label}を表示する権限がありません。`;
  return code.length > 0
    ? `${label}を取得できませんでした（${code}）。`
    : `${label}を取得できませんでした。`;
}

function roleText(role: unknown): string {
  switch (role) {
    case "owner":
      return "所有者";
    case "editor":
      return "編集者";
    case "viewer":
      return "閲覧者";
    case null:
      return "権限なし";
    default:
      return "不明な権限（操作対象にしません）";
  }
}

function capacityStatusText(status: Overview["status"]): string {
  switch (status) {
    case "READY":
      return "正常";
    case "PRESSURE":
      return "容量注意";
    case "RECOVERY_REQUIRED":
      return "復旧が必要";
  }
}

function receiptStatusText(status: string): string {
  switch (status) {
    case "SERVER_ACCEPTED":
      return "サーバー受付";
    case "REJECTED":
      return "拒否";
    case "INVALIDATED":
      return "無効";
    default:
      return status;
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "不明";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(1)} ${unit}`;
}

async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

function checkedRecoveryStatus(value: unknown): RecoveryStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_RECOVERY_RESPONSE");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "configured")
    throw new Error("INVALID_RECOVERY_RESPONSE");
  const configured = (value as { configured?: unknown }).configured;
  if (typeof configured !== "boolean")
    throw new Error("INVALID_RECOVERY_RESPONSE");
  return { configured };
}

function checkedRecoveryRotation(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_RECOVERY_RESPONSE");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "recoveryKey")
    throw new Error("INVALID_RECOVERY_RESPONSE");
  const recoveryKey = (value as { recoveryKey?: unknown }).recoveryKey;
  if (
    typeof recoveryKey !== "string" ||
    recoveryKey.length === 0 ||
    recoveryKey.length > 256 ||
    !wellFormed(recoveryKey)
  )
    throw new Error("INVALID_RECOVERY_RESPONSE");
  return recoveryKey;
}

export function SharedAdministration({
  api,
  orgId,
  scope,
  generation,
  onChanged,
}: SharedAdministrationProps) {
  const [overview, setOverview] = useState<OrganizationOverview | null>(null);
  const [operations, setOperations] = useState<Overview | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [operationsError, setOperationsError] = useState("");
  const [auditError, setAuditError] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const [workspaceIdInput, setWorkspaceIdInput] = useState("");
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [revealRecovery, setRevealRecovery] = useState(false);
  const [revokeUserId, setRevokeUserId] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [handoffUserId, setHandoffUserId] = useState("");
  const [handoffWorkspaces, setHandoffWorkspaces] = useState<string[]>([]);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantRole, setGrantRole] = useState<GrantRole>("viewer");

  const mounted = useRef(true);
  const loadFence = useRef(0);
  const mutationFence = useRef(0);
  const busyRef = useRef(false);

  const refreshAll = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    const ticket = ++loadFence.current;
    setLoading(true);
    const [organizationResult, operationsResult, auditResult, recoveryResult] =
      await Promise.all([
        attempt(() =>
          api.request<OrganizationOverview>(
            adminRequest({ action: "organization", orgId }),
          ),
        ),
        attempt(() =>
          api.request<Overview>(adminRequest({ action: "overview", orgId })),
        ),
        attempt(() =>
          api.request<AuditResponse>(
            adminRequest({ action: "audit", orgId, limit: 50 }),
          ),
        ),
        attempt(async () =>
          checkedRecoveryStatus(
            await api.request<unknown>(
              adminRequest({ action: "recoveryStatus", orgId }),
            ),
          ),
        ),
      ]);
    if (!mounted.current || ticket !== loadFence.current) return;
    if (organizationResult.ok) {
      setOverview(organizationResult.value);
      setOverviewError("");
    } else {
      setOverviewError(
        describeLoadError("組織の概要", organizationResult.error),
      );
    }
    if (operationsResult.ok) {
      setOperations(operationsResult.value);
      setOperationsError("");
    } else {
      setOperationsError(describeLoadError("運用状況", operationsResult.error));
    }
    if (auditResult.ok) {
      setAudit(auditResult.value);
      setAuditError("");
    } else {
      setAuditError(describeLoadError("監査ログ", auditResult.error));
    }
    if (recoveryResult.ok) {
      setRecovery(recoveryResult.value);
      setRecoveryError("");
    } else {
      setRecovery(null);
      setRecoveryError(
        describeLoadError("復旧キーの状態", recoveryResult.error),
      );
    }
    setLoading(false);
  }, [api, orgId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadFence.current += 1;
      mutationFence.current += 1;
    };
  }, []);

  useEffect(() => {
    setRecoveryKey("");
    setRevealRecovery(false);
    return () => {
      setRecoveryKey("");
      setRevealRecovery(false);
    };
  }, [
    orgId,
    scope.orgId,
    scope.workspaceId,
    scope.documentId,
    scope.incarnationId,
    generation,
  ]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  async function perform<T>(
    command: AdminCommand,
    successMessage: string,
    apply: (value: T) => void,
  ): Promise<void> {
    if (!api) {
      setActionError("管理機能を利用できるアプリで開いてください。");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    const ticket = ++mutationFence.current;
    try {
      const value = await api.request<T>(adminRequest(command));
      if (!mounted.current || ticket !== mutationFence.current) return;
      apply(value);
      setNotice(successMessage);
      try {
        onChanged();
      } catch {
        setNotice(`${successMessage} 親画面の更新に失敗しました。`);
      }
      void refreshAll();
    } catch (error) {
      if (mounted.current && ticket === mutationFence.current) {
        setActionError(describeError(error));
      }
    } finally {
      busyRef.current = false;
      if (mounted.current && ticket === mutationFence.current) setBusy(false);
    }
  }

  function createWorkspace() {
    if (!validId(workspaceIdInput)) {
      setActionError(
        "ワークスペースIDは英数字・_・-の1〜128文字で入力してください。",
      );
      return;
    }
    if (!validName(workspaceNameInput)) {
      setActionError("ワークスペース名は1〜200文字で入力してください。");
      return;
    }
    void perform<{ ok: boolean }>(
      {
        action: "workspaceCreate",
        orgId,
        workspaceId: workspaceIdInput,
        name: workspaceNameInput,
      },
      "ワークスペースを作成しました。",
      () => {
        setWorkspaceIdInput("");
        setWorkspaceNameInput("");
      },
    );
  }

  function inviteUser() {
    if (!validId(inviteUserId)) {
      setActionError("招待するユーザーIDを入力してください。");
      return;
    }
    void perform<InviteResponse>(
      { action: "invite", orgId, userId: inviteUserId },
      "招待トークンを発行しました。",
      (value) => {
        if (
          typeof value.inviteToken !== "string" ||
          value.inviteToken.length === 0 ||
          !wellFormed(value.inviteToken)
        ) {
          throw new Error("INVALID_INVITE_RESPONSE");
        }
        setInviteToken(value.inviteToken);
        setRevealToken(false);
        setInviteUserId("");
      },
    );
  }

  function rotateRecovery() {
    void perform<RecoveryRotation>(
      { action: "rotateRecovery", orgId },
      "復旧キーを再発行しました。",
      (value) => {
        setRecoveryKey(checkedRecoveryRotation(value));
        setRevealRecovery(false);
      },
    );
  }

  function revokeMember() {
    if (!validId(revokeUserId)) {
      setActionError("削除するメンバーを選択してください。");
      return;
    }
    void perform<{ ok: boolean }>(
      { action: "revokeMember", orgId, userId: revokeUserId },
      "メンバーを削除しました。",
      () => {
        setConfirmRevoke(false);
        setRevokeUserId("");
      },
    );
  }

  function handoff() {
    if (!validId(handoffUserId)) {
      setActionError("引き継ぎ先のメンバーを選択してください。");
      return;
    }
    void perform<{ ok: boolean }>(
      {
        action: "handoff",
        orgId,
        userId: handoffUserId,
        workspaces: handoffWorkspaces,
      },
      "組織の所有権を引き継ぎました。",
      () => {
        setHandoffUserId("");
        setHandoffWorkspaces([]);
      },
    );
  }

  function grant() {
    if (!validId(grantUserId)) {
      setActionError("権限を変更するメンバーを選択してください。");
      return;
    }
    const role: Role | null = grantRole === "none" ? null : grantRole;
    void perform<{ ok: boolean }>(
      {
        action: "grant",
        scope: {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          documentId: scope.documentId,
          incarnationId: scope.incarnationId,
        },
        userId: grantUserId,
        role,
      },
      "ワークスペース権限を更新しました。",
      () => undefined,
    );
  }

  function toggleHandoffWorkspace(workspaceId: string) {
    setHandoffWorkspaces((current) =>
      current.includes(workspaceId)
        ? current.filter((item) => item !== workspaceId)
        : [...current, workspaceId],
    );
  }

  const unavailable = !api;

  return (
    <section className="shared-workbench" aria-label="共有組織の管理">
      <header>
        <h1>共有組織の管理</h1>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={loading || busy}
        >
          {loading ? "更新しています…" : "情報を更新"}
        </button>
      </header>

      {unavailable && (
        <p role="alert">管理機能を利用できるアプリで開いてください。</p>
      )}
      <p>
        組織ID: <code>{orgId}</code>
      </p>
      <p>
        対象スコープ: <code>{scope.workspaceId}</code> /{" "}
        <code>{scope.documentId}</code> / <code>{scope.incarnationId}</code>
      </p>
      <p>
        組織の管理者権限と、各ワークスペースの内容の所有権は別の権限です。
        画面上のボタンに関係なく、実行可否はサーバーが判定します。
      </p>

      {actionError && (
        <p role="alert">{actionError} 入力内容はこの画面に保持しています。</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">処理中です。</p>}

      <section aria-label="組織の概要">
        <h2>組織の概要</h2>
        {overviewError && (
          <p role="alert">
            {overviewError}{" "}
            <button
              type="button"
              onClick={() => void refreshAll()}
              disabled={loading}
            >
              再読み込み
            </button>
          </p>
        )}
        {overview === null && loading && <p>読み込んでいます…</p>}
        {overview && (
          <>
            <p>
              組織管理者: {overview.isAdministrator ? "はい" : "いいえ"}
              　（組織の所有権。ワークスペースの内容所有権とは別です）
            </p>
            <p>メンバー: {overview.members.length}人</p>
            <ul>
              {overview.members.map((memberId) => (
                <li key={memberId}>
                  <code>{memberId}</code>
                </li>
              ))}
            </ul>
            <h3>参加中のワークスペース</h3>
            {overview.workspaces.length === 0 && (
              <p>参加しているワークスペースはありません。</p>
            )}
            <ul>
              {overview.workspaces.map((workspace) => (
                <li key={workspace.workspaceId}>
                  {workspace.name}（<code>{workspace.workspaceId}</code>）／
                  あなたの権限: {roleText(workspace.role)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-label="復旧キー">
        <h2>復旧キー</h2>
        {recoveryError && <p role="alert">{recoveryError}</p>}
        {recovery === null && loading && <p>読み込んでいます…</p>}
        {recovery && (
          <p>復旧キー: {recovery.configured ? "設定済み" : "未設定"}</p>
        )}
        <p>
          復旧キーの状態確認と再発行は組織の管理者のみ実行できます。
          再発行すると以前の復旧キーは無効になります。所有権を引き継いだ場合も、
          以前の所有者の復旧キーは無効となり、新しい所有者だけが再発行できます。
        </p>
        <button
          type="button"
          onClick={rotateRecovery}
          disabled={busy || unavailable}
        >
          復旧キーを再発行
        </button>
        {recoveryKey && (
          <div aria-label="発行された復旧キー">
            <label>
              新しい復旧キー（読み取り専用）
              <input
                type={revealRecovery ? "text" : "password"}
                value={recoveryKey}
                readOnly
                autoComplete="off"
                aria-label="新しい復旧キー"
              />
            </label>
            <button
              type="button"
              aria-pressed={revealRecovery}
              onClick={() => setRevealRecovery((current) => !current)}
            >
              {revealRecovery ? "非表示" : "表示"}
            </button>
            <p role="status">
              この画面を離れると再表示できません。メールやクリップボードへの連携は行いません。
              現在の所有者が安全な方法で保管してください。
            </p>
          </div>
        )}
      </section>

      <section aria-label="運用状況">
        <h2>運用状況</h2>
        {operationsError && <p role="alert">{operationsError}</p>}
        {operations === null && loading && <p>読み込んでいます…</p>}
        {operations && (
          <>
            <p>
              状態: {capacityStatusText(operations.status)}
              　文書数: {operations.documents}
              　未処理: {operations.pending}
            </p>
            <p>
              レコード: {formatBytes(operations.recordBytes)}
              　添付: {formatBytes(operations.blobBytes)}
            </p>
            <p>
              現在位置: seq {operations.cut.seq} / epoch{" "}
              <code>{operations.cut.epoch}</code>
            </p>
            <p>
              保持: イベント {operations.retention.events}、意図{" "}
              {operations.retention.intents}、試行{" "}
              {operations.retention.attempts}、検証{" "}
              {operations.retention.verifications}
            </p>
          </>
        )}
      </section>

      <section aria-label="バックアップ">
        <h2>バックアップ</h2>
        {operations && operations.backups.length === 0 && (
          <p>バックアップはありません。</p>
        )}
        {operations && operations.backups.length > 0 && (
          <ul>
            {operations.backups.map((backup) => (
              <li key={backup.hash}>
                <code>{backup.hash}</code>（seq {backup.cut.seq}、
                {backup.verified ? "検証済み" : "未検証"}）
              </li>
            ))}
          </ul>
        )}
        {operations === null && !loading && (
          <p>バックアップ情報を取得できませんでした。</p>
        )}
      </section>

      <section aria-label="監査ログ">
        <h2>監査ログ</h2>
        {auditError && <p role="alert">{auditError}</p>}
        {audit === null && loading && <p>読み込んでいます…</p>}
        {audit && audit.events.length === 0 && (
          <p>記録された変更はありません。</p>
        )}
        {audit && audit.events.length > 0 && (
          <>
            <p>
              直近 {audit.events.length} 件（最新 seq{" "}
              {audit.events[audit.events.length - 1].seq}）
            </p>
            <table>
              <caption>直近の変更履歴</caption>
              <thead>
                <tr>
                  <th scope="col">seq</th>
                  <th scope="col">状態</th>
                  <th scope="col">実行ユーザーID</th>
                  <th scope="col">ワークスペースID</th>
                  <th scope="col">コード</th>
                </tr>
              </thead>
              <tbody>
                {audit.events.map((event) => (
                  <tr key={`${event.seq}:${event.intentId}`}>
                    <td>{event.seq}</td>
                    <td>{receiptStatusText(event.status)}</td>
                    <td>
                      <code>{event.writerId}</code>
                    </td>
                    <td>
                      <code>{event.scope.workspaceId}</code>
                    </td>
                    <td>{event.code === null ? "—" : event.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-label="ワークスペースの作成">
        <h2>ワークスペースの作成</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createWorkspace();
          }}
        >
          <label>
            ワークスペースID（技術ID）
            <input
              value={workspaceIdInput}
              onChange={(event) => setWorkspaceIdInput(event.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <label>
            ワークスペース名
            <input
              value={workspaceNameInput}
              onChange={(event) => setWorkspaceNameInput(event.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy || unavailable}>
            作成
          </button>
        </form>
      </section>

      <section aria-label="ユーザーの招待">
        <h2>ユーザーの招待</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            inviteUser();
          }}
        >
          <label>
            招待するユーザーID（技術ID）
            <input
              value={inviteUserId}
              onChange={(event) => setInviteUserId(event.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy || unavailable}>
            招待トークンを発行
          </button>
        </form>
        <p>
          招待トークンは自動送信しません。メール・Slack・クリップボードへの連携は行いません。
        </p>
        {inviteToken && (
          <div aria-label="発行された招待トークン">
            <label>
              招待トークン（読み取り専用）
              <input
                type={revealToken ? "text" : "password"}
                value={inviteToken}
                readOnly
                aria-label="発行された招待トークン"
              />
            </label>
            <button
              type="button"
              aria-pressed={revealToken}
              onClick={() => setRevealToken((current) => !current)}
            >
              {revealToken ? "非表示" : "表示"}
            </button>
            <p role="status">
              この画面を離れると再表示できません。安全な方法で本人へ渡してください。
            </p>
          </div>
        )}
      </section>

      <section aria-label="メンバーの削除">
        <h2>メンバーの削除</h2>
        <label>
          削除するメンバー（技術ID）
          <select
            value={revokeUserId}
            onChange={(event) => {
              setRevokeUserId(event.target.value);
              setConfirmRevoke(false);
            }}
            disabled={busy || overview === null}
          >
            <option value="">選択してください</option>
            {overview?.members.map((memberId) => (
              <option key={memberId} value={memberId}>
                {memberId}
              </option>
            ))}
          </select>
        </label>
        {!confirmRevoke && (
          <button
            type="button"
            onClick={() => {
              if (!validId(revokeUserId)) {
                setActionError("削除するメンバーを選択してください。");
                return;
              }
              setActionError("");
              setConfirmRevoke(true);
            }}
            disabled={busy || unavailable || !validId(revokeUserId)}
          >
            削除の確認へ
          </button>
        )}
        {confirmRevoke && (
          <div role="group" aria-label="メンバー削除の確認">
            <p>
              <code>{revokeUserId}</code> を組織から削除します。
            </p>
            <button
              type="button"
              onClick={revokeMember}
              disabled={busy || unavailable}
            >
              削除する
            </button>
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              disabled={busy}
            >
              取り消す
            </button>
          </div>
        )}
      </section>

      <section aria-label="所有権の引き継ぎ">
        <h2>所有権の引き継ぎ</h2>
        <label>
          引き継ぎ先のメンバー（技術ID）
          <select
            value={handoffUserId}
            onChange={(event) => setHandoffUserId(event.target.value)}
            disabled={busy || overview === null}
          >
            <option value="">選択してください</option>
            {overview?.members.map((memberId) => (
              <option key={memberId} value={memberId}>
                {memberId}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={busy || overview === null}>
          <legend>同時に所有者権限を渡すワークスペース</legend>
          {overview === null || overview.workspaces.length === 0 ? (
            <p>選択できるワークスペースはありません。</p>
          ) : (
            overview.workspaces.map((workspace) => (
              <label key={workspace.workspaceId}>
                <input
                  type="checkbox"
                  checked={handoffWorkspaces.includes(workspace.workspaceId)}
                  onChange={() => toggleHandoffWorkspace(workspace.workspaceId)}
                />
                {workspace.name}（<code>{workspace.workspaceId}</code>）
              </label>
            ))
          )}
        </fieldset>
        <button
          type="button"
          onClick={handoff}
          disabled={busy || unavailable || !validId(handoffUserId)}
        >
          所有権を引き継ぐ
        </button>
      </section>

      <section aria-label="ワークスペース権限の付与">
        <h2>ワークスペース権限の付与</h2>
        <p>
          対象スコープ: <code>{scope.workspaceId}</code> /{" "}
          <code>{scope.documentId}</code> / <code>{scope.incarnationId}</code>
        </p>
        <label>
          権限を変更するメンバー（技術ID）
          <select
            value={grantUserId}
            onChange={(event) => setGrantUserId(event.target.value)}
            disabled={busy || overview === null}
          >
            <option value="">選択してください</option>
            {overview?.members.map((memberId) => (
              <option key={memberId} value={memberId}>
                {memberId}
              </option>
            ))}
          </select>
        </label>
        <label>
          付与する権限
          <select
            value={grantRole}
            onChange={(event) => setGrantRole(event.target.value as GrantRole)}
            disabled={busy}
          >
            <option value="owner">所有者</option>
            <option value="editor">編集者</option>
            <option value="viewer">閲覧者</option>
            <option value="none">権限なし</option>
          </select>
        </label>
        <button
          type="button"
          onClick={grant}
          disabled={busy || unavailable || !validId(grantUserId)}
        >
          権限を更新
        </button>
      </section>

      <p>
        この画面はバックアップの復元、ファイルのアップロード、請求情報の変更には対応していません。
      </p>
    </section>
  );
}
