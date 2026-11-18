import { useEffect, useRef, useState } from "react";
import { wellFormed } from "../../collaboration/runtime/contract";
import {
  allowsRecovery,
  requiresReceiptRetry,
  sharedRuntimeStateLabel,
  type SharedRuntimeView,
} from "./runtime-state";

export type { SharedRuntimeView } from "./runtime-state";

export type SharedWorkspaceDocument = {
  documentId: string;
  incarnationId: string;
  title: string;
};

export type SharedWorkspaceScope = {
  workspaceId: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  documents: SharedWorkspaceDocument[];
};

export type SharedPanelPort = {
  list(): Promise<SharedWorkspaceScope[]>;
  open(
    workspaceId: string,
    documentId: string,
    incarnationId: string,
  ): Promise<void>;
  retry(): Promise<void>;
  recover(): Promise<string>;
  status(): Promise<SharedRuntimeView>;
};

export function sharedRoleLabel(role: SharedWorkspaceScope["role"]): string {
  switch (role) {
    case "owner":
      return "所有者";
    case "editor":
      return "編集者";
    case "viewer":
      return "閲覧者";
  }
}

function errorText(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    wellFormed(error.message)
  )
    return error.message;
  return fallback;
}

type Selection = {
  workspaceId: string;
  workspaceName: string;
  documentId: string;
  incarnationId: string;
  title: string;
};

function documentKey(
  workspaceId: string,
  document: SharedWorkspaceDocument,
): string {
  return `${workspaceId}:${document.documentId}:${document.incarnationId}`;
}

export function SharedWorkspacePanel({
  port,
  onClose,
}: {
  port: SharedPanelPort;
  onClose: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<SharedWorkspaceScope[] | null>(
    null,
  );
  const [view, setView] = useState<SharedRuntimeView | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [listError, setListError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [actionError, setActionError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(true);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryText, setRecoveryText] = useState("");
  const [recoveryError, setRecoveryError] = useState("");

  const mounted = useRef(true);
  const listFence = useRef(0);
  const statusFence = useRef(0);
  const openFence = useRef(0);
  const retryFence = useRef(0);
  const recoverFence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listFence.current += 1;
      statusFence.current += 1;
      openFence.current += 1;
      retryFence.current += 1;
      recoverFence.current += 1;
    };
  }, []);

  useEffect(() => {
    const token = ++listFence.current;
    setListLoading(true);
    setListError("");
    void port
      .list()
      .then((items) => {
        if (!mounted.current || token !== listFence.current) return;
        setWorkspaces(items);
      })
      .catch((error: unknown) => {
        if (!mounted.current || token !== listFence.current) return;
        setListError(
          errorText(
            error,
            "共有ワークスペース一覧を取得できませんでした。再読み込みしてください。",
          ),
        );
      })
      .finally(() => {
        if (mounted.current && token === listFence.current)
          setListLoading(false);
      });
  }, [port]);

  useEffect(() => {
    const token = ++statusFence.current;
    setStatusLoading(true);
    setStatusError("");
    void port
      .status()
      .then((next) => {
        if (!mounted.current || token !== statusFence.current) return;
        setView(next);
      })
      .catch((error: unknown) => {
        if (!mounted.current || token !== statusFence.current) return;
        setStatusError(
          errorText(
            error,
            "保存状態を取得できませんでした。状態を再取得してください。",
          ),
        );
      })
      .finally(() => {
        if (mounted.current && token === statusFence.current)
          setStatusLoading(false);
      });
  }, [port]);

  async function reloadList() {
    const token = ++listFence.current;
    setListLoading(true);
    setListError("");
    try {
      const items = await port.list();
      if (!mounted.current || token !== listFence.current) return;
      setWorkspaces(items);
    } catch (error) {
      if (!mounted.current || token !== listFence.current) return;
      setListError(
        errorText(
          error,
          "共有ワークスペース一覧を取得できませんでした。再読み込みしてください。",
        ),
      );
    } finally {
      if (mounted.current && token === listFence.current) setListLoading(false);
    }
  }

  async function refreshStatus() {
    const token = ++statusFence.current;
    setStatusLoading(true);
    setStatusError("");
    try {
      const next = await port.status();
      if (!mounted.current || token !== statusFence.current) return;
      setView(next);
    } catch (error) {
      if (!mounted.current || token !== statusFence.current) return;
      setStatusError(
        errorText(
          error,
          "保存状態を取得できませんでした。状態を再取得してください。",
        ),
      );
    } finally {
      if (mounted.current && token === statusFence.current)
        setStatusLoading(false);
    }
  }

  async function openDocument(
    workspace: SharedWorkspaceScope,
    document: SharedWorkspaceDocument,
  ) {
    const token = ++openFence.current;
    const key = documentKey(workspace.workspaceId, document);
    setOpeningKey(key);
    setActionError("");
    setRecoveryError("");
    try {
      await port.open(
        workspace.workspaceId,
        document.documentId,
        document.incarnationId,
      );
      if (!mounted.current || token !== openFence.current) return;
      setSelection({
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        documentId: document.documentId,
        incarnationId: document.incarnationId,
        title: document.title,
      });
      await refreshStatus();
    } catch (error) {
      if (!mounted.current || token !== openFence.current) return;
      setActionError(
        errorText(error, "文書を開けませんでした。選択は変更していません。"),
      );
    } finally {
      if (mounted.current && token === openFence.current) setOpeningKey(null);
    }
  }

  async function retryReceipt() {
    const token = ++retryFence.current;
    setRetrying(true);
    setActionError("");
    setStatusError("");
    try {
      await port.retry();
      if (!mounted.current || token !== retryFence.current) return;
      const statusToken = ++statusFence.current;
      const next = await port.status();
      if (!mounted.current || statusToken !== statusFence.current) return;
      setView(next);
    } catch (error) {
      if (!mounted.current || token !== retryFence.current) return;
      setActionError(
        errorText(
          error,
          "受付状態を再確認できませんでした。時間をおいて再試行してください。",
        ),
      );
    } finally {
      if (mounted.current && token === retryFence.current) setRetrying(false);
    }
  }

  async function recoverOriginal() {
    const token = ++recoverFence.current;
    setRecovering(true);
    setRecoveryError("");
    try {
      const text = await port.recover();
      if (!mounted.current || token !== recoverFence.current) return;
      setRecoveryText(text);
    } catch (error) {
      if (!mounted.current || token !== recoverFence.current) return;
      setRecoveryError(
        errorText(
          error,
          "原本の復元用テキストを取得できませんでした。表示中の内容は保持しています。",
        ),
      );
    } finally {
      if (mounted.current && token === recoverFence.current)
        setRecovering(false);
    }
  }

  const unknown = view !== null && requiresReceiptRetry(view);

  return (
    <section className="shared-workspace-panel" aria-label="共有ワークスペース">
      <header>
        <h2>共有ワークスペース</h2>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </header>

      <section aria-label="共有ワークスペース一覧">
        <h3>ワークスペースと文書</h3>
        {listError && (
          <div role="alert">
            <p>{listError}</p>
            <button
              type="button"
              onClick={() => void reloadList()}
              disabled={listLoading}
            >
              再読み込み
            </button>
          </div>
        )}
        {listLoading && workspaces === null && <p>一覧を読み込んでいます…</p>}
        {workspaces !== null && workspaces.length === 0 && (
          <p>共有ワークスペースはありません。</p>
        )}
        {workspaces?.map((workspace) => (
          <section key={workspace.workspaceId} aria-label={workspace.name}>
            <h4>{workspace.name}</h4>
            <p>権限: {sharedRoleLabel(workspace.role)}</p>
            {workspace.documents.length === 0 ? (
              <p>文書はありません。</p>
            ) : (
              <ul>
                {workspace.documents.map((document) => {
                  const key = documentKey(workspace.workspaceId, document);
                  const selected =
                    selection !== null &&
                    selection.workspaceId === workspace.workspaceId &&
                    selection.documentId === document.documentId &&
                    selection.incarnationId === document.incarnationId;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={openingKey !== null}
                        onClick={() => void openDocument(workspace, document)}
                      >
                        {document.title || "無題"}
                        {selected
                          ? "（選択中）"
                          : openingKey === key
                            ? "（開いています…）"
                            : ""}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </section>

      <section aria-label="保存状態">
        <h3>保存状態</h3>
        {selection && (
          <p>
            選択中の文書: {selection.workspaceName} /{" "}
            {selection.title || "無題"}
          </p>
        )}
        {statusError && (
          <div role="alert">
            <p>{statusError}</p>
            <button
              type="button"
              onClick={() => void refreshStatus()}
              disabled={statusLoading}
            >
              状態を再取得
            </button>
          </div>
        )}
        {statusLoading && view === null && <p>保存状態を確認しています…</p>}
        {view && (
          <>
            <p role="status" aria-live="polite">
              <strong>{sharedRuntimeStateLabel(view.state)}</strong>
            </p>
            <p>{view.message}</p>
            <p>対象: {view.scopeLabel}</p>
            <p>未送信の変更: {view.pending}件</p>
            <p>{view.canEdit ? "編集できます。" : "編集できません。"}</p>
          </>
        )}
        {unknown && (
          <button
            type="button"
            onClick={() => void retryReceipt()}
            disabled={retrying}
          >
            {retrying ? "受付状態を確認しています…" : "受付状態を再確認"}
          </button>
        )}
        {view && !unknown && (
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={statusLoading}
          >
            {statusLoading ? "状態を確認しています…" : "状態を更新"}
          </button>
        )}
        {view && allowsRecovery(view) && (
          <button
            type="button"
            onClick={() => void recoverOriginal()}
            disabled={recovering}
          >
            {recovering
              ? "原本を準備しています…"
              : "原本の復元用テキストを表示"}
          </button>
        )}
        {actionError && <p role="alert">{actionError}</p>}
        {recoveryError && <p role="alert">{recoveryError}</p>}
        {recoveryText && (
          <section aria-label="原本の復元用テキスト">
            <h4>原本の復元用テキスト</h4>
            <pre>{recoveryText}</pre>
          </section>
        )}
      </section>
    </section>
  );
}
