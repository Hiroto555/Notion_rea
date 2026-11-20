import { Component, useState, type ReactNode } from "react";

type RecoveryActions = {
  backup: () => Promise<string | null>;
  salvage?: () => Promise<string | null>;
  onClose?: () => void;
};

export function RenderingRecovery({
  backup,
  salvage,
  onClose,
}: RecoveryActions) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function save(action: () => Promise<string | null>) {
    if (busy) return;
    setBusy(true);
    try {
      const path = await action();
      setNotice(path ? "保存先 " + path : "キャンセルしました。");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "コピーを保存できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="表示の復旧">
      <h2>画面を表示できませんでした</h2>
      <p>保存済みのワークスペースをコピーできます。</p>
      <button disabled={busy} onClick={() => void save(backup)}>
        診断用の原本コピーを保存
      </button>
      {salvage && (
        <button disabled={busy} onClick={() => void save(salvage)}>
          DB・添付・復旧記録を救出
        </button>
      )}
      {onClose && <button onClick={onClose}>レコードを閉じる</button>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

/** Parents key an editor boundary by document/session identity. A failed
 * render must not unmount the owner's draft lanes or repeatedly retry it. */
export class ErrorBoundary extends Component<
  RecoveryActions & { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    const { children, ...actions } = this.props;
    return this.state.failed ? <RenderingRecovery {...actions} /> : children;
  }
}
