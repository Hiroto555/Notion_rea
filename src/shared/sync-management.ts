import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const syncConnectionInputSchema = z.object({
  requestId: z.string().uuid(), expectedRevision: z.string().uuid().nullable(),
  baseUrl: z.string().max(2048).refine(value => {
    try { const u = new URL(value); return u.protocol === "http:" && u.hostname === "127.0.0.1" &&
      !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash; } catch { return false; }
  }), workspaceId: id, clientId: id, mode: z.enum(["publish", "join", "recover"]),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),
}).strict();
export type SyncConnectionInput = z.infer<typeof syncConnectionInputSchema>;
export type SyncConnectionTargetView = Pick<SyncConnectionInput, "baseUrl" | "workspaceId" | "clientId" | "mode">;
export type SyncConnectionReason = "read-only" | "recovery-copy-held" | "secure-store-unavailable" |
  "identity-changed" | "busy" | "intent-present" | "conflict" | "invalid-input" | "outcome-unknown" | "local-error";
/** No credential or ciphertext is returned to the renderer. */
export type SyncConnectionView = {
  state: "unconfigured" | "configured" | "pending-restart" | "disabled" | "held";
  revision: string | null; target: SyncConnectionTargetView | null;
  hasCredential: boolean; reason: SyncConnectionReason | null;
};
export type SyncConnectionAction = { outcome: "saved" | "disabled" | "held" | "outcome-unknown"; view: SyncConnectionView };

export type TransferMaintenanceEntry = {
  entryId: string; scopeHash: string; assetId: string | null; bytes: number; offset: number;
  state: "active" | "blocked" | "completed" | "releasing" | "empty-scope" | "unknown";
  currentScope: boolean; canRelease: boolean; reason: string | null;
  operationId?: string;
};
export type TransferMaintenanceView = {
  entries: TransferMaintenanceEntry[]; nextCursor: string | null;
  usedBytes: number; overLimit: boolean; held: string | null;
};
export type TransferReleasePlanView = {
  operationId: string; entry: TransferMaintenanceEntry; expiresAt: number;
};
export type TransferReleaseResult = { operationId: string; outcome: "released" | "held" | "outcome-unknown";
  releasedBytes: number; reason: string | null };
