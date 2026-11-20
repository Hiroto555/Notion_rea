import { ErrorBoundary, RenderingRecovery } from "./ErrorBoundary";
import { useEffect, useState } from "react";
import { App } from "./App";
import { ReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import type { StartupStatus } from "../shared/startup-status";
import type { DesktopRootBindings } from "./desktop-api";

export function StartupApp({ desktop }: { desktop: DesktopRootBindings }) {
  const backup = () => desktop.compatibility.request<string | null>({type: "backup"});
  const salvage = async () => (await desktop.readOnly.recovery.salvageRaw())?.directory ?? null;
  return <ErrorBoundary backup={backup} salvage={salvage}><StartupContent desktop={desktop} backup={backup} salvage={salvage} /></ErrorBoundary>;
}

function StartupContent({desktop, backup, salvage}: {
  desktop: DesktopRootBindings; backup: () => Promise<string | null>; salvage: () => Promise<string | null>;
}) {
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
        <RenderingRecovery backup={backup} salvage={salvage} />
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
      experimentalSharedUi={status.experimentalSharedUi}
    />
  );
}
