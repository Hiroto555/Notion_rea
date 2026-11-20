export function showSharedUi(env: Readonly<Record<string, string | undefined>>,
  connection: {held?: boolean; saved?: unknown}): boolean {
  return env.FOLIO_EXPERIMENTAL_SHARED_UI === "1" || env.FOLIO_SYNC_ENABLED === "1" ||
    connection.held === true || Boolean(connection.saved);
}

export type StartupStatus = {
  mode: "writable" | "readOnly";
  message?: string;
  syncMessage?: string;
  experimentalSharedUi?: boolean;
};
