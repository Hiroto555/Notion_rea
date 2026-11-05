import { useEffect, useState } from "react";
import { App } from "./App";
import { ReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import type { StartupStatus } from "../shared/startup-status";

export function StartupApp() {
  const [status, setStatus] = useState<StartupStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    window.folio
      .request<StartupStatus>({ type: "startup:status" })
      .then((value) => {
        if (value?.mode !== "writable" && value?.mode !== "readOnly")
          throw new Error("Invalid startup state");
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setError("起動状態を確認できません。Folioを再起動してください。");
      });
    return () => {
      active = false;
    };
  }, []);
  if (error)
    return (
      <main className="loading" role="alert">
        {error}
      </main>
    );
  if (!status)
    return <main className="loading">ワークスペースを確認しています…</main>;
  return status.mode === "readOnly" ? (
    <ReadOnlyWorkspace status={status} />
  ) : (
    <App />
  );
}
