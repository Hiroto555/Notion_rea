import type { WorkspaceInventory } from "./workspace-backup";

/**
 * Explicit repair of sibling positions that the previous duplicate
 * implementation left equal. Nothing here runs automatically: a caller must
 * request a read-only preview, show every entry below to the user, and then
 * apply that exact preview. No IPC/GUI wiring is provided by this contract.
 *
 * Preview guarantees:
 * - only raw values are read; the workspace is not written;
 * - equal positions are ordered deterministically by (createdAt, page id);
 * - every value that changes is listed with its old/new position and the
 *   revision before/after;
 * - pages that do not need a new position keep both their bytes and revision.
 */
export type PageOrderRepairTarget = {
  pageId: string;
  title: string;
  parentId: string | null;
  deleted: boolean;
  fromPosition: number;
  toPosition: number;
  fromRevision: number;
  toRevision: number;
  /** False only for the deterministic first page of a tie, which keeps its slot. */
  changed: boolean;
};

/**
 * One sibling group that shares a position. `targets` is the exact intended
 * order after repair; the first entry keeps `position`, the following entries
 * receive strictly increasing positions in the gap before the next sibling.
 */
export type PageOrderRepairGroup = {
  parentId: string | null;
  position: number;
  targets: readonly PageOrderRepairTarget[];
};

/** A tie that is deliberately left alone, with the reason shown to the user. */
export type PageOrderRepairRejection = {
  parentId: string | null;
  position: number;
  pageIds: readonly string[];
  reasons: readonly string[];
};

export type PageOrderRepairPreview = {
  /** SHA-256 of the raw workspace state this preview was computed from. */
  sourceFingerprint: string;
  groups: readonly PageOrderRepairGroup[];
  rejections: readonly PageOrderRepairRejection[];
  /** Workspace-wide blockers (unknown schema, malformed JSON, broken records…). */
  issues: readonly string[];
  /** Pages that apply() would rewrite (the changed entries of every group). */
  targetIds: readonly string[];
  canApply: boolean;
  scannedPages: number;
};

/** The only capability a caller keeps from a preview. Positions are re-derived. */
export type PageOrderRepairPlan = {
  sourceFingerprint: string;
};

export type PageOrderRepairBackup = {
  directory: string;
  /** SHA-256 of the verified backup manifest bytes. */
  fingerprint: string;
  inventory: WorkspaceInventory;
};

export type PageOrderRepairResult = {
  status: "applied" | "rejected";
  sourceFingerprint: string;
  currentFingerprint: string;
  appliedGroups: number;
  appliedPages: number;
  /** Changed entries only; entries that kept their position are not listed. */
  targets: readonly PageOrderRepairTarget[];
  backup?: PageOrderRepairBackup;
  issues: readonly string[];
};

export type PageOrderRepairOptions = {
  /**
   * Parent directory for the verified full backup. Defaults to
   * `<workspace>/backups`, matching WorkspaceBackupService. The final backup
   * directory is always created new; an existing path is never reused.
   */
  backupDirectory?: string;
};
