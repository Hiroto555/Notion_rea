import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { LoadedSyncConnection, SyncConnectionVault } from "./sync-connection-vault";

/** A persisted disable always overrides legacy environment configuration.
 * A vault read/decrypt failure cannot silently fall back to another device. */
export function savedConnectionEnvironment(vault: SyncConnectionVault, directory: string,
  databasePath: string, env: NodeJS.ProcessEnv): {env: NodeJS.ProcessEnv; saved?: LoadedSyncConnection; held?: boolean} {
  if (!existsSync(directory)) return {env};
  try {
    const view = vault.view(databasePath);
    if (view.state === "unconfigured") return {env};
    if (view.state === "disabled") return {env: {...env, FOLIO_SYNC_ENABLED: "0"}};
    if (view.state === "held") return {env: {...env, FOLIO_SYNC_ENABLED: "0"}, held: true};
    const saved = vault.load(databasePath);
    if (!saved) return {env: {...env, FOLIO_SYNC_ENABLED: "0"}, held: true};
    return {saved, env: {...env, FOLIO_SYNC_ENABLED: "1", FOLIO_DATA_DIR: dirname(databasePath),
      FOLIO_SYNC_URL: saved.baseUrl, FOLIO_SYNC_WORKSPACE: saved.workspaceId, FOLIO_SYNC_CLIENT: saved.clientId,
      FOLIO_SYNC_BINDING: saved.bindingId, FOLIO_SYNC_TOKEN: saved.token, FOLIO_SYNC_MODE: saved.mode}};
  } catch {return {env: {...env, FOLIO_SYNC_ENABLED: "0"}, held: true};}
}
