import { SyncError } from "../sync/protocol";

// A peer controls its error code. Only known, non-secret values cross into UI
// state; raw exceptions and arbitrary peer text may contain credentials.
const EXPOSED_ERRORS = new Set([
  "server-head-regressed", "server-epoch-mismatch", "workspace-binding-mismatch",
  "workspace-binding-missing", "sync-conflict-open", "insufficient-storage",
  "payload-too-large", "invalid-local-workspace-checkpoint", "sync-already-running",
  "unauthorized", "forbidden", "blob-transfer-failed", "asset-id-hash-conflict",
  "invalid-sync-mode", "explicit-conflict-flow-required", "loopback-only",
  "reconnect-held", "sync-not-connected", "recovered-workspace-sync-held", "normal-apply-present", "legacy-apply-intent-held",
  "blob-transfer-limit", "blob-transfer-cache-held", "blob-transfer-budget-held", "blob-transfer-budget-unsafe",
  "blob-transfer-locked", "blob-transfer-blocked", "blob-transfer-prefix-mismatch", "blob-transfer-partial-missing",
]);
export function safeSyncErrorCode(error: unknown): string {
  if (error instanceof SyncError && EXPOSED_ERRORS.has(error.code)) return error.code;
  if (error instanceof Error) {
    for (const code of ["capacity-exceeded", "capacity-unknown", "workspace-limit-exceeded", "workspace-limit-unknown"])
      if (error.message.includes(`(${code})`)) return code;
  }
  return "local-or-network-error";
}
