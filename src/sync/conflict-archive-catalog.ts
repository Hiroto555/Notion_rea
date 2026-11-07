import type { DatabaseSync } from "node:sqlite";
import {
  archiveCursorSchema,
  archiveTargetSchema,
  type ArchiveCursor,
  type ArchiveItem,
  type ArchivePage,
  type ArchiveSnapshot,
  type ArchiveTarget,
} from "../shared/conflict-recovery";
import {
  canonicalJson,
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
  parseCheckpoint,
  sha256,
  type Checkpoint,
} from "./protocol";
import { validateWorkspaceCheckpoint } from "./workspace-checkpoint";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type StateScopeRow = {
  workspace_id: string;
  client_id: string;
  binding_id: string;
  server_epoch: string;
};

type ArchiveRow = {
  id: number;
  operation_id: string;
  kind: string;
  created_at: number;
  checkpoint_json: string | null;
  checkpoint_bytes: number;
};

type ParsedArchive = {
  checkpoint: Checkpoint;
  checkpointHash: string;
  bytes: number;
  pages: number;
  assets: number;
};

function hasTable(db: DatabaseSync, name: string): boolean {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) !== undefined;
}

function readSnapshot<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw error;
  }
}

function readSourceScope(db: DatabaseSync): string | null {
  if (!hasTable(db, "workspace_sync_state")) return null;
  let row: StateScopeRow | undefined;
  try {
    row = db
      .prepare(
        "SELECT workspace_id,client_id,binding_id,server_epoch FROM workspace_sync_state WHERE singleton=1",
      )
      .get() as StateScopeRow | undefined;
  } catch {
    throw new Error("invalid-sync-state");
  }
  if (
    row === undefined ||
    typeof row.workspace_id !== "string" ||
    typeof row.client_id !== "string" ||
    typeof row.binding_id !== "string" ||
    typeof row.server_epoch !== "string" ||
    row.workspace_id.length === 0 ||
    row.client_id.length === 0 ||
    row.binding_id.length === 0 ||
    row.server_epoch.length === 0
  ) {
    throw new Error("invalid-sync-state");
  }
  return sha256(
    canonicalJson([
      row.workspace_id,
      row.client_id,
      row.binding_id,
      row.server_epoch,
    ]),
  );
}

function parseArchiveJson(value: string): ParsedArchive | null {
  try {
    const checkpoint = parseCheckpoint(JSON.parse(value));
    if (!validateWorkspaceCheckpoint(checkpoint)) return null;
    const canonical = canonicalJson(checkpoint, MAX_CHECKPOINT_BYTES);
    const tables =
      (checkpoint.payload as { tables?: Record<string, unknown> }).tables ?? {};
    return {
      checkpoint,
      checkpointHash: hashCheckpoint(checkpoint),
      bytes: Buffer.byteLength(canonical),
      pages: Array.isArray(tables.pages) ? tables.pages.length : 0,
      assets: checkpoint.assets.length,
    };
  } catch {
    return null;
  }
}

function invalidSummary(
  row: ArchiveRow,
  reason: string,
): ArchiveItem {
  return {
    id: row.id,
    operationId: typeof row.operation_id === "string" ? row.operation_id.slice(0,200) : "",
    kind: typeof row.kind === "string" ? row.kind.slice(0,200) : "",
    createdAt: Number.isSafeInteger(row.created_at) ? row.created_at : 0,
    valid: false,
    bytes: row.checkpoint_bytes,
    pages: null,
    assets: null,
    target: null,
    attachmentStatus: "not-checked",
    reason,
  };
}

function summarize(source: string, row: ArchiveRow): ArchiveItem {
  if (
    typeof row.operation_id !== "string" ||
    typeof row.kind !== "string" ||
    !Number.isSafeInteger(row.created_at)
  ) {
    return invalidSummary(row, "invalid-archive-row");
  }
  if (row.checkpoint_json === null || row.checkpoint_bytes > MAX_CHECKPOINT_BYTES) {
    return invalidSummary(row, "checkpoint-too-large");
  }
  const parsed = parseArchiveJson(row.checkpoint_json);
  if (parsed === null) return invalidSummary(row, "invalid-archive-checkpoint");
  const target: ArchiveTarget = {
    source,
    id: row.id,
    operationId: row.operation_id,
    kind: row.kind,
    createdAt: row.created_at,
    checkpointHash: parsed.checkpointHash,
  };
  if (!archiveTargetSchema.safeParse(target).success) return invalidSummary(row,"invalid-archive-row");
  return {
    id: row.id,
    operationId: row.operation_id,
    kind: row.kind,
    createdAt: row.created_at,
    valid: true,
    bytes: parsed.bytes,
    pages: parsed.pages,
    assets: parsed.assets,
    target,
    attachmentStatus: "not-checked",
  };
}

function readArchiveRow(db: DatabaseSync, id: number): ArchiveRow | undefined {
  if (!hasTable(db, "workspace_sync_archives")) return undefined;
  return db
    .prepare(
      `SELECT id,substr(operation_id,1,201) AS operation_id,substr(kind,1,201) AS kind,created_at,
        length(CAST(checkpoint_json AS BLOB)) AS checkpoint_bytes,
        CASE WHEN length(CAST(checkpoint_json AS BLOB)) <= ?
          THEN checkpoint_json ELSE NULL END AS checkpoint_json
       FROM workspace_sync_archives WHERE id=?`,
    )
    .get(MAX_CHECKPOINT_BYTES, id) as ArchiveRow | undefined;
}

function targetFromRow(
  source: string,
  row: ArchiveRow,
  checkpointHash: string,
): ArchiveTarget {
  return {
    source,
    id: row.id,
    operationId: row.operation_id,
    kind: row.kind,
    createdAt: row.created_at,
    checkpointHash,
  };
}

function sameTarget(left: ArchiveTarget, right: ArchiveTarget): boolean {
  return (
    left.source === right.source &&
    left.id === right.id &&
    left.operationId === right.operationId &&
    left.kind === right.kind &&
    left.createdAt === right.createdAt &&
    left.checkpointHash === right.checkpointHash
  );
}

export function listConflictArchives(
  db: DatabaseSync,
  options: { limit?: number; cursor?: ArchiveCursor } = {},
): ArchivePage {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error("invalid-archive-limit");
  }
  const cursor =
    options.cursor === undefined
      ? undefined
      : archiveCursorSchema.parse(options.cursor);

  return readSnapshot(db, () => {
    const source = readSourceScope(db);
    if (source === null) return { items: [], next: null, total: 0 };
    if (!hasTable(db, "workspace_sync_archives")) {
      return { items: [], next: null, total: 0 };
    }

    const newest = db
      .prepare("SELECT max(id) AS id FROM workspace_sync_archives")
      .get() as { id: number | null };
    const anchor = cursor?.anchor ?? newest.id;
    if (anchor === null) return { items: [], next: null, total: 0 };
    const before = cursor?.before ?? anchor + 1;

    const total = Number(
      (
        db.prepare("SELECT count(*) AS count FROM workspace_sync_archives").get() as {
          count: number;
        }
      ).count,
    );
    const rows = db
      .prepare(
        `SELECT id,substr(operation_id,1,201) AS operation_id,substr(kind,1,201) AS kind,created_at,
          length(CAST(checkpoint_json AS BLOB)) AS checkpoint_bytes,
          CASE WHEN length(CAST(checkpoint_json AS BLOB)) <= ?
            THEN checkpoint_json ELSE NULL END AS checkpoint_json
         FROM workspace_sync_archives
         WHERE id <= ? AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(MAX_CHECKPOINT_BYTES, anchor, before, limit + 1) as ArchiveRow[];

    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => summarize(source, row));
    const next =
      rows.length > limit && items.length > 0
        ? { anchor, before: items[items.length - 1].id }
        : null;
    return { items, next, total };
  });
}

export function readConflictArchive(
  db: DatabaseSync,
  target: ArchiveTarget,
): ArchiveSnapshot {
  const expected = archiveTargetSchema.parse(target);
  return readSnapshot(db, () => {
    const source = readSourceScope(db);
    if (source === null) throw new Error("invalid-sync-state");
    if (expected.source !== source) throw new Error("archive-source-mismatch");

    const row = readArchiveRow(db, expected.id);
    if (row === undefined) throw new Error("archive-not-found");
    if (
      row.operation_id !== expected.operationId ||
      row.kind !== expected.kind ||
      row.created_at !== expected.createdAt
    ) {
      throw new Error("archive-target-mismatch");
    }
    if (row.checkpoint_json === null || row.checkpoint_bytes > MAX_CHECKPOINT_BYTES) {
      throw new Error("archive-checkpoint-too-large");
    }
    const parsed = parseArchiveJson(row.checkpoint_json);
    if (parsed === null) throw new Error("invalid-archive-checkpoint");
    const actual = targetFromRow(source, row, parsed.checkpointHash);
    if (!sameTarget(expected, actual)) throw new Error("archive-target-mismatch");
    return { target: actual, checkpoint: parsed.checkpoint };
  });
}
