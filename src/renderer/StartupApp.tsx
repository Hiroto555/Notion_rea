import { useEffect, useState } from "react";
import { App } from "./App";
import { ReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import type { StartupStatus } from "../shared/startup-status";
import type { DesktopRootBindings } from "./desktop-api";

export function StartupApp({ desktop }: { desktop: DesktopRootBindings }) {
  const [status, setStatus] = useState<StartupStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    desktop.readOnly.workspace
      .startupStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setError("起動状態を確認できません。Folioを再起動してください。");
      });
    return () => {
      active = false;
    };
  }, [desktop]);
  if (error)
    return (
      <main className="loading" role="alert">
        {error}
      </main>
    );
  if (!status)
    return <main className="loading">ワークスペースを確認しています…</main>;
  return status.mode === "readOnly" ? (
    <ReadOnlyWorkspace status={status} api={desktop.readOnly} />
  ) : (
    <App
      api={desktop.writable}
      desktopCompatibility={desktop.compatibility}
      syncMessage={status.syncMessage}
    />
  );
}
