import { useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  BackupPreview,
  BackupRestored,
  WorkspaceInventory,
} from "../../shared/workspace-backup";
import { DialogFrame } from "../Modal";
import "./workspace-backup-dialog.css";

type PreviewSource = "created" | "chosen";
type PendingAction = "create" | "choose" | "restore" | "open";

const PENDING_MESSAGE: Record<PendingAction, string> = {
  create: "バックアップを作成しています…",
  choose: "バックアップを検証しています…",
  restore: "新しいフォルダーに復元しています…",
  open: "復元先を開いています…",
};

const INVENTORY_FIELDS: ReadonlyArray<[keyof WorkspaceInventory, string]> = [
  ["pages", "ページ"],
  ["recordDatabases", "データベース"],
  ["records", "レコード"],
  ["versions", "履歴"],
  ["settings", "設定"],
  ["saveReceipts", "保存記録"],
  ["registeredAssets", "登録済みの添付ファイル"],
];

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const integerFormatter = new Intl.NumberFormat("ja-JP");
const sizeFormatter = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 1,
});

export function formatBackupDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

export function formatBackupBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "不明";
  if (value < 1024) return `${integerFormatter.format(value)} バイト`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${sizeFormatter.format(size)} ${units[unit]}`;
}

export function workspaceBackupError(error: unknown) {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return detail
    ? `操作を完了できませんでした。${detail}`
    : "操作を完了できませんでした。もう一度お試しください。";
}

function notifyBusy(
  callback: ((busy: boolean) => void) | undefined,
  busy: boolean,
) {
  try {
    callback?.(busy);
  } catch {
    // The parent's busy notification must not leave the dialog stuck busy.
  }
}

type ActionHandlers<T> = {
  onValue: (value: T) => void;
  onError: (message: string) => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
};

/** null means the parent cancelled; it is never treated as a completed value. */
export async function runWorkspaceBackupAction<T>(
  action: () => Promise<T | null>,
  handlers: ActionHandlers<T>,
): Promise<"value" | "cancelled" | "error"> {
  notifyBusy(handlers.onBusyChange, true);
  try {
    const value = await action();
    if (value === null || value === undefined) {
      handlers.onCancel?.();
      return "cancelled";
    }
    handlers.onValue(value);
    return "value";
  } catch (error) {
    handlers.onError(workspaceBackupError(error));
    return "error";
  } finally {
    notifyBusy(handlers.onBusyChange, false);
  }
}

export type WorkspaceBackupDialogProps = {
  onClose: () => void;
  onCreate: () => Promise<BackupPreview | null>;
  onChoose: () => Promise<BackupPreview | null>;
  onRestore: (preview: BackupPreview) => Promise<BackupRestored | null>;
  onOpen: (result: BackupRestored) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
};

export type WorkspaceBackupViewProps = {
  busy: boolean;
  busyMessage?: string;
  error?: string;
  status?: string;
  preview?: BackupPreview;
  previewSource?: PreviewSource;
  restored?: BackupRestored;
  onCreate: () => void;
  onChoose: () => void;
  onRestore: () => void;
  onOpen: () => void;
  onClose: () => void;
};

export function WorkspaceBackupView({
  busy,
  busyMessage,
  error,
  status,
  preview,
  previewSource,
  restored,
  onCreate,
  onChoose,
  onRestore,
  onOpen,
  onClose,
}: WorkspaceBackupViewProps) {
  const sourceLabel =
    previewSource === "chosen"
      ? "検証済みのバックアップ"
      : "作成したバックアップ";
  const statusText = busy
    ? busyMessage || "処理を進めています…"
    : (status ?? "");
  return (
    <div className="workspace-backup-body" aria-busy={busy}>
      <header>
        <h2>バックアップと復元</h2>
        <button
          type="button"
          aria-label="バックアップと復元を閉じる"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <p className="workspace-backup-intro">
        保存済みのワークスペース全体をバックアップし、選択したバックアップを新しいフォルダーへ復元します。
      </p>
      <p className="workspace-backup-caution">
        未保存の入力を復旧する機能ではありません。保存済みの内容だけが対象です。
      </p>
      <p className="workspace-backup-note">
        元のワークスペースと選択したバックアップは変更しません。復元先は新しいフォルダーとして作成され、既存のフォルダーを上書きすることはありません。
      </p>

      <section
        className="workspace-backup-section"
        aria-labelledby="workspace-backup-prepare-heading"
      >
        <h3 id="workspace-backup-prepare-heading">バックアップを用意</h3>
        <p>
          保存済みのワークスペースを今すぐバックアップするか、以前のバックアップを選んで内容を検証します。
        </p>
        <div className="workspace-backup-actions">
          <button type="button" disabled={busy} onClick={onCreate}>
            バックアップを作成
          </button>
          <button type="button" disabled={busy} onClick={onChoose}>
            バックアップを選んで検証
          </button>
        </div>
      </section>

      {preview && !restored && (
        <section
          className="workspace-backup-section workspace-backup-selection"
          aria-labelledby="workspace-backup-selected-heading"
        >
          <h3 id="workspace-backup-selected-heading">復元するバックアップ</h3>
          <p className="workspace-backup-source">{sourceLabel}</p>
          <dl
            className="workspace-backup-summary"
            aria-label="選択したバックアップの情報"
          >
            <div>
              <dt>作成日時</dt>
              <dd>
                <time dateTime={preview.createdAt}>
                  {formatBackupDate(preview.createdAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt>保存場所</dt>
              <dd>
                <code className="workspace-backup-path">
                  {preview.directory}
                </code>
              </dd>
            </div>
            <div>
              <dt>容量</dt>
              <dd>{formatBackupBytes(preview.bytes)}</dd>
            </div>
          </dl>

          <h4>保持される内容</h4>
          <dl
            className="workspace-backup-counts"
            aria-label="バックアップに含まれる件数"
          >
            {INVENTORY_FIELDS.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{integerFormatter.format(preview.inventory[key])} 件</dd>
              </div>
            ))}
          </dl>
          <p>
            ページ、データベース、履歴、設定、保存記録、登録済みの添付ファイルをまとめて保持します。
          </p>
          <p className="workspace-backup-note">
            復元先を選ぶ画面が開きます。選んだ場所に新しいフォルダーを作成し、既存のフォルダーは上書きしません。
          </p>
          <div className="workspace-backup-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={onRestore}
            >
              新しいフォルダーへ復元
            </button>
          </div>
        </section>
      )}

      {restored && (
        <section
          className="workspace-backup-section workspace-backup-complete"
          aria-labelledby="workspace-backup-complete-heading"
        >
          <h3 id="workspace-backup-complete-heading">復元が完了しました</h3>
          <p>復元先（新しいフォルダー）</p>
          <code className="workspace-backup-path workspace-backup-destination">
            {restored.directory}
          </code>
          <p>
            元のワークスペースはそのまま残っています。復元先を開くと、元のアプリを閉じずに別のアプリとして起動します。
          </p>
          <div className="workspace-backup-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={onOpen}
            >
              復元先を開く
            </button>
          </div>
        </section>
      )}

      {(busy || statusText) && (
        <p className="workspace-backup-status" role="status">
          {statusText}
        </p>
      )}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}

      <footer>
        <button type="button" disabled={busy} onClick={onClose}>
          閉じる
        </button>
      </footer>
    </div>
  );
}

export function WorkspaceBackupDialog({
  onClose,
  onCreate,
  onChoose,
  onRestore,
  onOpen,
  onBusyChange,
}: WorkspaceBackupDialogProps) {
  const [busyAction, setBusyAction] = useState<PendingAction | null>(null);
  const [preview, setPreview] = useState<BackupPreview>();
  const [previewSource, setPreviewSource] = useState<PreviewSource>();
  // The restored destination is kept separately from the selected backup so a
  // source path can never be mistaken for, or reused as, the new target.
  const [restored, setRestored] = useState<BackupRestored>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const busyChangeRef = useRef(onBusyChange);
  busyChangeRef.current = onBusyChange;
  const busy = busyAction !== null;

  async function runAction<T>(
    kind: PendingAction,
    action: () => Promise<T | null>,
    handleValue: (value: T) => void,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction(kind);
    setError("");
    setStatus(PENDING_MESSAGE[kind]);
    try {
      await runWorkspaceBackupAction(action, {
        onValue: handleValue,
        onError: (message) => {
          setStatus("");
          setError(message);
        },
        onCancel: () => setStatus(""),
        onBusyChange: (value) => busyChangeRef.current?.(value),
      });
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  const create = () => {
    void runAction("create", onCreate, (value) => {
      setPreview(value);
      setPreviewSource("created");
      setRestored(undefined);
      setStatus(
        "バックアップを作成しました。内容を確認して新しいフォルダーへ復元できます。",
      );
    });
  };

  const choose = () => {
    void runAction("choose", onChoose, (value) => {
      setPreview(value);
      setPreviewSource("chosen");
      setRestored(undefined);
      setStatus(
        "バックアップを検証しました。内容を確認して新しいフォルダーへ復元できます。",
      );
    });
  };

  const restore = () => {
    if (!preview || restored) return;
    void runAction("restore", () => onRestore(preview), (value) => {
      setRestored(value);
      setStatus(
        "復元が完了しました。復元先を開くか、この画面を閉じてください。",
      );
    });
  };

  const open = () => {
    if (!restored) return;
    void runAction(
      "open",
      async () => {
        await onOpen(restored);
        return true;
      },
      () => setStatus("復元先を開きました。"),
    );
  };

  const close = () => {
    if (busyRef.current) return;
    onClose();
  };

  return (
    <DialogFrame
      modal
      name="バックアップと復元"
      className="workspace-backup-dialog"
      onClose={close}
    >
      <WorkspaceBackupView
        busy={busy}
        busyMessage={busyAction ? PENDING_MESSAGE[busyAction] : undefined}
        error={error}
        status={status}
        preview={preview}
        previewSource={previewSource}
        restored={restored}
        onCreate={create}
        onChoose={choose}
        onRestore={restore}
        onOpen={open}
        onClose={close}
      />
    </DialogFrame>
  );
}
