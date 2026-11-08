import type { BlobTransferRecord } from "./blob-transfer-types";
export type ReleaseFilePin = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string }>;
export type CacheReleaseOperation = {
  id: string; kind: "partial" | "empty-journal";
  scopeHash: string; journalName: string; rootDev: number; rootIno: number;
  dbDev: number; dbIno: number; record: BlobTransferRecord | null;
  file: ReleaseFilePin | null; expiresAt: number;
  phase: "planned" | "releasing" | "trashed" | "unlinked" | "completed";
  releasedBytes: number;
  metadata?: {name: string; pin: ReleaseFilePin}[];
};
