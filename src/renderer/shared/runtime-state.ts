import { wellFormed } from "../../collaboration/runtime/contract";

export type SharedRuntimeStage =
  | "UNSAVED"
  | "LOCAL_DURABLE"
  | "SERVER_ACCEPTED"
  | "CLIENT_RECEIPT_DURABLE"
  | "PEER_APPLIED"
  | "UNKNOWN"
  | "REJECTED"
  | "OFFLINE"
  | "READ_ONLY";

export type SharedRuntimeView = Readonly<{
  state: SharedRuntimeStage;
  message: string;
  canEdit: boolean;
  pending: number;
  scopeLabel: string;
}>;

export type RuntimeProjectionInput = Readonly<{
  stage: SharedRuntimeStage;
  readonly: boolean;
  online: boolean;
  pending: number;
  rejection: string | null;
  scopeLabel: string;
}>;

const stages: readonly SharedRuntimeStage[] = [
  "UNSAVED",
  "LOCAL_DURABLE",
  "SERVER_ACCEPTED",
  "CLIENT_RECEIPT_DURABLE",
  "PEER_APPLIED",
  "UNKNOWN",
  "REJECTED",
  "OFFLINE",
  "READ_ONLY",
];

function isStage(value: unknown): value is SharedRuntimeStage {
  return (
    typeof value === "string" && (stages as readonly string[]).includes(value)
  );
}

function checkedText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    throw new Error(code);
  return value;
}

function checkedPending(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("INVALID_PENDING");
  return Number(value);
}

function pendingSuffix(pending: number): string {
  return pending === 0 ? "" : ` 未送信の変更が${pending}件あります。`;
}

function stageMessage(
  stage: SharedRuntimeStage,
  rejection: string | null,
): string {
  switch (stage) {
    case "UNSAVED":
      return "未保存の変更があります。この端末にもまだ保存されていません。";
    case "LOCAL_DURABLE":
      return "この端末に保存済みです。サーバー受付はまだ確認できていません。";
    case "SERVER_ACCEPTED":
      return "サーバーが変更を受け付けました。";
    case "CLIENT_RECEIPT_DURABLE":
      return "サーバーの受付記録をこの端末に保存しました。他の端末への反映は未確認です。";
    case "PEER_APPLIED":
      return "他の端末で変更が反映された記録があります。";
    case "UNKNOWN":
      return "サーバーの受付状態を確認できません。再試行して受付記録を確認してください。";
    case "REJECTED":
      return rejection === null
        ? "サーバーが変更を拒否しました。内容を確認して再試行してください。"
        : `サーバーが変更を拒否しました: ${rejection}`;
    case "OFFLINE":
      return "サーバーに接続されていません。未送信の変更がある場合、この端末に保持されています。";
    case "READ_ONLY":
      return "この共有ワークスペースは閲覧のみです。変更は保存されません。";
  }
}

function offlineMessage(stage: SharedRuntimeStage): string {
  switch (stage) {
    case "UNSAVED":
      return "サーバーに接続されていません。未保存の変更はこの端末にもまだ保存されていません。";
    case "LOCAL_DURABLE":
      return "サーバーに接続されていません。変更はこの端末に保存済みで、サーバーへは未送信です。";
    case "CLIENT_RECEIPT_DURABLE":
      return "サーバーに接続されていません。受付記録はこの端末に保存済みです。";
    case "SERVER_ACCEPTED":
    case "PEER_APPLIED":
      return "サーバーに接続されていません。サーバー受付済みの変更があり、接続回復後に状態を再確認します。";
    case "REJECTED":
      return "サーバーに接続されていません。直前の変更は拒否されています。内容を確認してください。";
    case "UNKNOWN":
      return "サーバーに接続されていません。受付状態も確認できないため再試行してください。";
    case "OFFLINE":
      return "サーバーに接続されていません。未送信の変更がある場合、この端末に保持されています。";
    case "READ_ONLY":
      return "サーバーに接続されていません。この共有ワークスペースは閲覧のみです。";
  }
}

export function sharedRuntimeStateLabel(state: SharedRuntimeStage): string {
  switch (state) {
    case "UNSAVED":
      return "未保存";
    case "LOCAL_DURABLE":
      return "端末に保存済み・未送信";
    case "SERVER_ACCEPTED":
      return "サーバー受付済み";
    case "CLIENT_RECEIPT_DURABLE":
      return "受付記録を端末に保存済み";
    case "PEER_APPLIED":
      return "他の端末で反映済み";
    case "UNKNOWN":
      return "受付状態を確認できません";
    case "REJECTED":
      return "変更は拒否されました";
    case "OFFLINE":
      return "オフライン";
    case "READ_ONLY":
      return "閲覧のみ";
  }
}

export function requiresReceiptRetry(view: SharedRuntimeView): boolean {
  return view.state === "UNKNOWN";
}

export function allowsRecovery(view: SharedRuntimeView): boolean {
  return (
    view.state === "UNSAVED" ||
    view.state === "LOCAL_DURABLE" ||
    view.state === "REJECTED" ||
    view.state === "OFFLINE"
  );
}

export function projectRuntimeView(
  input: RuntimeProjectionInput,
): SharedRuntimeView {
  if (!input || typeof input !== "object") throw new Error("INVALID_INPUT");
  if (!isStage(input.stage)) throw new Error("INVALID_STAGE");
  if (typeof input.readonly !== "boolean") throw new Error("INVALID_READ_ONLY");
  if (typeof input.online !== "boolean") throw new Error("INVALID_ONLINE");
  const pending = checkedPending(input.pending);
  const scopeLabel = checkedText(input.scopeLabel, "INVALID_SCOPE_LABEL");
  const rejection =
    input.rejection === null
      ? null
      : checkedText(input.rejection, "INVALID_REJECTION");

  if (input.readonly) {
    return {
      state: "READ_ONLY",
      message: stageMessage("READ_ONLY", null),
      canEdit: false,
      pending,
      scopeLabel,
    };
  }

  if (rejection !== null) {
    return {
      state: "REJECTED",
      message: stageMessage("REJECTED", rejection) + pendingSuffix(pending),
      canEdit: false,
      pending,
      scopeLabel,
    };
  }

  if (input.stage === "UNKNOWN")
    return {
      state: "UNKNOWN",
      message: stageMessage("UNKNOWN", null) + pendingSuffix(pending),
      canEdit: false,
      pending,
      scopeLabel,
    };

  if (input.stage === "READ_ONLY")
    return {
      state: "READ_ONLY",
      message: stageMessage("READ_ONLY", null) + pendingSuffix(pending),
      canEdit: false,
      pending,
      scopeLabel,
    };

  if (input.stage === "REJECTED")
    return {
      state: "REJECTED",
      message: stageMessage("REJECTED", null) + pendingSuffix(pending),
      canEdit: false,
      pending,
      scopeLabel,
    };

  if (!input.online || input.stage === "OFFLINE")
    return {
      state: "OFFLINE",
      message: offlineMessage(input.stage) + pendingSuffix(pending),
      canEdit: false,
      pending,
      scopeLabel,
    };

  return {
    state: input.stage,
    message: stageMessage(input.stage, null) + pendingSuffix(pending),
    canEdit: true,
    pending,
    scopeLabel,
  };
}
