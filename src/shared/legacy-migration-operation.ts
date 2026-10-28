import { z } from "zod";
import type { DatabaseProjection, Page } from "./types";

const pageId = z.string().min(1).max(500);
export const legacyMigrationOperationSchema = z
  .object({
    operationId: z.string().min(1).max(100),
    sessionId: z.string().min(1).max(100),
    seq: z.number().int().positive().safe(),
    databasePageId: pageId,
    revision: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .max(Number.MAX_SAFE_INTEGER - 1),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const migrationPreviewRequestSchema = z
  .object({
    type: z.literal("migration:preview"),
    databasePageId: pageId,
  })
  .strict();
export const migrationCommitRequestSchema = z
  .object({
    type: z.literal("migration:commit"),
    operation: legacyMigrationOperationSchema,
  })
  .strict();
export const migrationResolveRequestSchema = z
  .object({
    type: z.literal("migration:resolve"),
    operation: legacyMigrationOperationSchema,
  })
  .strict();
export type LegacyMigrationOperation = z.infer<
  typeof legacyMigrationOperationSchema
>;
export type LegacyMigrationIssue = {
  pageId: string;
  versionId?: number;
  reason: string;
};
export type LegacyMigrationPreview = {
  databasePageId: string;
  title: string;
  revision: number;
  sourceFingerprint: string;
  canApply: boolean;
  currentRecords: number;
  /** Historical identities absent from the current row set, reserved for later restoration. */
  historicalRecords: number;
  issues: LegacyMigrationIssue[];
};
export type LegacyMigrationResult = {
  status: "applied" | "rejected" | "unknown";
  operationId: string;
  sessionId: string;
  seq: number;
  databasePageId: string;
  fingerprint: string;
  page?: Page;
  database?: DatabaseProjection;
  snapshotPath?: string;
  records?: number;
  message?: string;
};

/** Prepare once after the user accepts this exact preview. Retain unchanged
 * until a receipt resolves; never create a replacement ID for unknown work. */
export function prepareLegacyMigration(
  preview: LegacyMigrationPreview,
): LegacyMigrationOperation {
  if (!preview.canApply || preview.issues.length)
    throw new Error("移行できるプレビューがありません。");
  return legacyMigrationOperationSchema.parse({
    operationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    seq: 1,
    databasePageId: preview.databasePageId,
    revision: preview.revision,
    sourceFingerprint: preview.sourceFingerprint,
  });
}
