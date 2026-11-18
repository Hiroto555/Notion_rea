import type { AssetManifest, Checkpoint } from "../sync/protocol";
import { z } from "zod";

export const RECOVERY_MAX_ASSETS = 1000;
export const RECOVERY_MAX_ASSET_BYTES = 100 * 1024 * 1024;
export const RECOVERY_INCOMPLETE = "FOLIO-RECOVERY-INCOMPLETE";
export const RECOVERY_ORIGIN_KEY = "folio.recovery.origin.v1";
const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const archiveTargetSchema = z
  .object({
    source: digest,
    id: integer.positive(),
    operationId: z.string().min(1).max(200),
    kind: z.string().min(1).max(200),
    createdAt: integer,
    checkpointHash: digest,
  })
  .strict();
export type ArchiveTarget = z.infer<typeof archiveTargetSchema>;
export const archiveCursorSchema = z
  .object({ anchor: integer, before: integer })
  .strict();
export type ArchiveCursor = z.infer<typeof archiveCursorSchema>;
export type ArchiveItem = {
  id: number;
  operationId: string;
  kind: string;
  createdAt: number;
  valid: boolean;
  bytes: number;
  pages: number | null;
  assets: number | null;
  target: ArchiveTarget | null;
  attachmentStatus: "not-checked";
  reason?: string;
};
export type ArchivePage = {
  items: ArchiveItem[];
  next: ArchiveCursor | null;
  total: number;
};
export type ArchiveSnapshot = { target: ArchiveTarget; checkpoint: Checkpoint };
export type RecoveryManifest = {
  format: "folio-conflict-recovery";
  version: 1;
  archive: ArchiveTarget;
  checkpoint: { file: "checkpoint.json"; bytes: number; sha256: string };
  assets: (AssetManifest & { file: string })[];
};
export type VerifiedRecoveryBundle = {
  directory: string;
  manifest: RecoveryManifest;
  checkpoint: Checkpoint;
  fingerprint: string;
};
export type RecoveryExportResult = {
  kind: "metadata-only" | "complete-bundle";
  directory: string;
  checkpointHash: string;
  fingerprint?: string;
};
export type RecoveredWorkspace = {
  directory: string;
  checkpointHash: string;
  recoveryId: string;
};
export type RecoveryView = { page: ArchivePage; message?: string };
export type RecoveryActionResult =
  | { kind: "cancelled" }
  | {
      kind: "metadata-only" | "complete-bundle" | "restored";
      directory: string;
      checkpointHash: string;
    }
  | {
      kind: "blocked";
      reason: string;
      target?: ArchiveTarget;
      directory?: string;
    }
  | {
      kind: "outcome-unknown";
      reason: string;
      directory: string;
      target: ArchiveTarget;
    };
export type RecoveryRequestContext = {
  operationId: string;
  target: ArchiveTarget;
  mode: "metadata-only" | "complete-bundle" | "restore";
  directory?: string;
};
export type RecoveryPanelPort = {
  list(cursor?: ArchiveCursor): Promise<ArchivePage>;
  currentRequest(): RecoveryRequestContext | null;
  export(
    target: ArchiveTarget,
    mode: "metadata-only" | "complete-bundle",
  ): Promise<RecoveryActionResult>;
  restore(target: ArchiveTarget): Promise<RecoveryActionResult>;
  status(): Promise<RecoveryActionResult | null>;
};
