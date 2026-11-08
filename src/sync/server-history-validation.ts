import type { DatabaseSync } from "node:sqlite";
import {
  fingerprintCommit,
  hashCheckpoint,
  identifier,
  MAX_WIRE_BYTES,
  parseChangePage,
  parseCheckpoint,
  parseCommit,
  parseResult,
  SyncError,
  type Change,
  type Checkpoint,
} from "./protocol";
import type {
  ServerAssetRequirement,
  ServerHistoryInventory,
} from "./server-full-types";

const DEFAULT_MAX_ROWS = 4096;
const DEFAULT_MAX_JSON_BYTES = 128 * 1024 * 1024;
const INVALID = "server-history-invalid";
const LIMIT = "server-history-limit";
const KNOWN_TABLES = new Set([
  "checkpoint_server_identity",
  "checkpoint_heads",
  "checkpoint_operations",
  "checkpoint_changes",
  "checkpoint_device_workspaces",
  "checkpoint_devices",
]);

type HistoryLimits = { maxRows?: number; maxJsonBytes?: number };
type SqlRow = Record<string, unknown>;
type HeadState = {
  workspaceId: string;
  ownerId: string;
  revision: number;
  checkpointHash: string | null;
  checkpoint: Checkpoint | null;
};

function fail(code: string, status: number): never {
  throw new SyncError(code, status);
}

function invalid(): never {
  return fail(INVALID, 422);
}

function limit(): never {
  return fail(LIMIT, 409);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hashValue(value: unknown): string {
  if (!isHash(value)) invalid();
  return value;
}

function counter(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid();
  return value as number;
}

function jsonLength(value: unknown): number {
  if (value === null) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return value as number;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_WIRE_BYTES)
    invalid();
  try {
    return JSON.parse(value);
  } catch {
    return invalid();
  }
}

function normalizedLimits(limits: HistoryLimits | undefined): {
  maxRows: number;
  maxJsonBytes: number;
} {
  if (limits === undefined) {
    return { maxRows: DEFAULT_MAX_ROWS, maxJsonBytes: DEFAULT_MAX_JSON_BYTES };
  }
  if (limits === null || typeof limits !== "object" || Array.isArray(limits))
    limit();
  const pick = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > fallback
    )
      limit();
    return value;
  };
  return {
    maxRows: pick(limits.maxRows, DEFAULT_MAX_ROWS),
    maxJsonBytes: pick(limits.maxJsonBytes, DEFAULT_MAX_JSON_BYTES),
  };
}

function selectRows(
  db: DatabaseSync,
  sql: string,
  remaining: number,
): SqlRow[] {
  const fetch = Math.floor(remaining) + 1;
  if (!(fetch >= 1)) limit();
  let rows: SqlRow[];
  try {
    rows = db.prepare(sql).all(fetch) as SqlRow[];
  } catch {
    return invalid();
  }
  if (rows.length > remaining) limit();
  return rows;
}

function compareAssets(
  left: ServerAssetRequirement,
  right: ServerAssetRequirement,
): number {
  if (left.workspaceId !== right.workspaceId)
    return left.workspaceId < right.workspaceId ? -1 : 1;
  if (left.sha256 !== right.sha256) return left.sha256 < right.sha256 ? -1 : 1;
  return left.bytes - right.bytes;
}

export function inspectServerHistory(
  db: DatabaseSync,
  limits?: HistoryLimits,
): ServerHistoryInventory {
  try {
    const ceiling = normalizedLimits(limits);
    let remainingRows = ceiling.maxRows;
    let jsonBytes = 0;
    const account = (bytes: number): void => {
      remainingRows -= 1;
      if (remainingRows < 0) limit();
      jsonBytes += bytes;
      if (jsonBytes > ceiling.maxJsonBytes) limit();
    };

    const schema = db
      .prepare(
        "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 257",
      )
      .all() as SqlRow[];
    if (schema.length > 256) invalid();
    const tables = new Set<string>();
    for (const object of schema) {
      const name = object.name;
      if (typeof name !== "string") invalid();
      if (object.type === "trigger" || object.type === "view") invalid();
      if (object.type === "table") {
        if (!KNOWN_TABLES.has(name)) invalid();
        tables.add(name);
      } else if (object.type !== "index") {
        invalid();
      }
    }
    if (
      tables.size !== KNOWN_TABLES.size ||
      [...KNOWN_TABLES].some((name) => !tables.has(name))
    )
      invalid();

    // Inspect aggregate lengths before materializing any JSON column. LIMIT
    // alone would still allow one corrupt multi-megabyte value into JS memory.
    let preflightRows = 0, preflightBytes = 0;
    for (const [table, columns] of [
      ["checkpoint_heads", ["checkpoint_json"]], ["checkpoint_changes", ["change_json"]],
      ["checkpoint_operations", ["commit_json", "result_json"]], ["checkpoint_devices", []],
      ["checkpoint_device_workspaces", []],
    ] as const) {
      const terms = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`);
      const row = db.prepare(`SELECT COUNT(*) AS rows,COALESCE(SUM(${terms.length ? terms.join("+") : "0"}),0) AS bytes${
        terms.map((term, index) => `,COALESCE(MAX(${term}),0) AS largest${index}`).join("")} FROM ${table}`).get()!;
      preflightRows += counter(row.rows); preflightBytes += counter(row.bytes);
      for (let index = 0; index < terms.length; index++) if (counter(row["largest" + index]) > MAX_WIRE_BYTES) invalid();
    }
    if (preflightRows > ceiling.maxRows || preflightBytes > ceiling.maxJsonBytes) limit();

    const identity = db
      .prepare(
        "SELECT singleton,version,epoch FROM checkpoint_server_identity LIMIT 2",
      )
      .all() as SqlRow[];
    if (identity.length !== 1) invalid();
    if (Number(identity[0].singleton) !== 1) invalid();
    if (Number(identity[0].version) !== 1) invalid();
    const serverEpoch = identifier(identity[0].epoch);

    const assets = new Map<string, ServerAssetRequirement>();
    const addAssets = (
      workspaceId: string,
      checkpoint: Checkpoint | null,
    ): void => {
      if (checkpoint === null) return;
      for (const asset of checkpoint.assets) {
        const key = `${workspaceId}\0${asset.sha256}`;
        if (assets.has(key) && assets.get(key)!.bytes !== asset.bytes) invalid();
        if (!assets.has(key) && assets.size >= 4096) limit();
        if (!assets.has(key))
          assets.set(key, {
            workspaceId,
            sha256: asset.sha256,
            bytes: asset.bytes,
          });
      }
    };

    const headRows = selectRows(
      db,
      "SELECT workspace_id,owner_id,revision,checkpoint_hash,checkpoint_json,length(CAST(checkpoint_json AS BLOB)) AS checkpoint_bytes FROM checkpoint_heads ORDER BY workspace_id LIMIT ?",
      remainingRows,
    );
    const heads = new Map<string, HeadState>();
    for (const row of headRows) {
      const checkpointBytes = jsonLength(row.checkpoint_bytes);
      account(checkpointBytes);
      if (checkpointBytes > MAX_WIRE_BYTES) invalid();
      const workspaceId = identifier(row.workspace_id);
      const ownerId = identifier(row.owner_id);
      const revision = counter(row.revision);
      let checkpointHash: string | null = null;
      let checkpoint: Checkpoint | null = null;
      if (revision === 0) {
        if (
          row.checkpoint_hash !== null ||
          row.checkpoint_json !== null ||
          checkpointBytes !== 0
        )
          invalid();
      } else {
        checkpointHash = hashValue(row.checkpoint_hash);
        if (row.checkpoint_json === null) invalid();
        checkpoint = parseCheckpoint(parseJson(row.checkpoint_json));
        if (hashCheckpoint(checkpoint) !== checkpointHash) invalid();
      }
      if (heads.has(workspaceId)) invalid();
      heads.set(workspaceId, {
        workspaceId,
        ownerId,
        revision,
        checkpointHash,
        checkpoint,
      });
      addAssets(workspaceId, checkpoint);
    }

    const changeRows = selectRows(
      db,
      "SELECT workspace_id,revision,change_json,length(CAST(change_json AS BLOB)) AS change_bytes FROM checkpoint_changes ORDER BY workspace_id,revision LIMIT ?",
      remainingRows,
    );
    const rawChanges = new Map<
      string,
      { revision: number; json: unknown }[]
    >();
    for (const row of changeRows) {
      const changeBytes = jsonLength(row.change_bytes);
      account(changeBytes);
      if (changeBytes > MAX_WIRE_BYTES) invalid();
      const workspaceId = identifier(row.workspace_id);
      if (!heads.has(workspaceId)) invalid();
      const revision = counter(row.revision, 1);
      const entries = rawChanges.get(workspaceId) ?? [];
      entries.push({ revision, json: row.change_json });
      rawChanges.set(workspaceId, entries);
    }
    const changes = new Map<string, Change>();
    for (const [workspaceId, entries] of rawChanges) {
      const head = heads.get(workspaceId)!;
      if (entries.length !== head.revision) invalid();
      entries.sort((left, right) => left.revision - right.revision);
      entries.forEach((entry, index) => {
        const expected = index + 1;
        if (entry.revision !== expected) invalid();
        const page = parseChangePage({
          protocol: 1,
          workspaceId,
          serverEpoch,
          after: expected - 1,
          headRevision: head.revision,
          changes: [parseJson(entry.json)],
        });
        const change = page.changes[0];
        changes.set(`${workspaceId}\0${expected}`, change);
        addAssets(workspaceId, change.checkpoint);
      });
    }
    for (const head of heads.values()) {
      if (head.revision === 0) {
        if (rawChanges.get(head.workspaceId) !== undefined) invalid();
        continue;
      }
      const last = changes.get(`${head.workspaceId}\0${head.revision}`);
      if (last === undefined || last.checkpointHash !== head.checkpointHash)
        invalid();
    }

    const operationRows = selectRows(
      db,
      "SELECT workspace_id,client_id,operation_id,fingerprint,commit_json,result_json,length(CAST(commit_json AS BLOB)) AS commit_bytes,length(CAST(result_json AS BLOB)) AS result_bytes FROM checkpoint_operations ORDER BY workspace_id,client_id,operation_id LIMIT ?",
      remainingRows,
    );
    const operationKeys = new Set<string>();
    const appliedChanges = new Map<string, number>();
    for (const row of operationRows) {
      const commitBytes = jsonLength(row.commit_bytes);
      const resultBytes = jsonLength(row.result_bytes);
      account(commitBytes + resultBytes);
      if (commitBytes > MAX_WIRE_BYTES || resultBytes > MAX_WIRE_BYTES)
        invalid();
      const sqlWorkspace = identifier(row.workspace_id);
      const sqlClient = identifier(row.client_id);
      const sqlOperation = identifier(row.operation_id);
      const sqlFingerprint = hashValue(row.fingerprint);
      const commit = parseCommit(parseJson(row.commit_json));
      const result = parseResult(parseJson(row.result_json));
      if (
        commit.workspaceId !== sqlWorkspace ||
        commit.clientId !== sqlClient ||
        commit.operationId !== sqlOperation
      )
        invalid();
      if (!heads.has(commit.workspaceId)) invalid();
      const fingerprint = fingerprintCommit(commit);
      if (fingerprint !== sqlFingerprint) invalid();
      if (
        result.workspaceId !== commit.workspaceId ||
        result.clientId !== commit.clientId ||
        result.operationId !== commit.operationId ||
        result.serverEpoch !== commit.serverEpoch ||
        result.fingerprint !== fingerprint
      )
        invalid();
      const operationKey = `${sqlWorkspace}\0${sqlClient}\0${sqlOperation}`;
      if (operationKeys.has(operationKey)) invalid();
      operationKeys.add(operationKey);
      addAssets(commit.workspaceId, commit.checkpoint);
      if (result.status === "applied") {
        if (result.revision !== commit.baseRevision + 1) invalid();
        if (result.checkpointHash !== commit.checkpointHash) invalid();
        const changeKey = `${commit.workspaceId}\0${result.revision}`;
        const change = changes.get(changeKey);
        if (
          change === undefined ||
          change.clientId !== commit.clientId ||
          change.operationId !== commit.operationId ||
          change.fingerprint !== fingerprint ||
          change.checkpointHash !== commit.checkpointHash
        )
          invalid();
        const count = (appliedChanges.get(changeKey) ?? 0) + 1;
        if (count !== 1) invalid();
        appliedChanges.set(changeKey, count);
      } else {
        if (result.head.revision === commit.baseRevision) invalid();
        if (result.head.revision === 0) {
          if (
            result.head.checkpointHash !== null ||
            result.head.checkpoint !== null
          )
            invalid();
        } else {
          const historical = changes.get(
            `${commit.workspaceId}\0${result.head.revision}`,
          );
          if (
            historical === undefined ||
            historical.checkpointHash !== result.head.checkpointHash
          )
            invalid();
        }
        addAssets(commit.workspaceId, result.head.checkpoint);
      }
    }
    for (const key of changes.keys()) {
      if (appliedChanges.get(key) !== 1) invalid();
    }

    const deviceWorkspaceRows = selectRows(
      db,
      "SELECT workspace_id FROM checkpoint_device_workspaces ORDER BY workspace_id LIMIT ?",
      ceiling.maxRows,
    );
    const deviceWorkspaces = new Set<string>();
    for (const row of deviceWorkspaceRows) {
      account(0);
      const workspaceId = identifier(row.workspace_id);
      if (!heads.has(workspaceId) || deviceWorkspaces.has(workspaceId))
        invalid();
      deviceWorkspaces.add(workspaceId);
    }

    const deviceRows = selectRows(
      db,
      "SELECT workspace_id,client_id,owner_id,token_hash,revoked FROM checkpoint_devices ORDER BY workspace_id,client_id LIMIT ?",
      remainingRows,
    );
    const tokenHashes = new Set<string>();
    const deviceKeys = new Set<string>();
    let activeDevices = 0;
    let revokedDevices = 0;
    for (const row of deviceRows) {
      account(0);
      const workspaceId = identifier(row.workspace_id);
      identifier(row.client_id);
      const deviceKey = workspaceId + "\0" + String(row.client_id);
      if (deviceKeys.has(deviceKey)) invalid();
      deviceKeys.add(deviceKey);
      const ownerId = identifier(row.owner_id);
      if (!isHash(row.token_hash) || tokenHashes.has(row.token_hash)) invalid();
      tokenHashes.add(row.token_hash);
      if (row.revoked !== 0 && row.revoked !== 1) invalid();
      const head = heads.get(workspaceId);
      if (
        head === undefined ||
        head.ownerId !== ownerId ||
        !deviceWorkspaces.has(workspaceId)
      )
        invalid();
      if (row.revoked === 1) revokedDevices++;
      else activeDevices++;
    }

    return {
      serverEpoch,
      workspaces: [...heads.values()]
        .sort((left, right) =>
          left.workspaceId < right.workspaceId ? -1 : 1,
        )
        .map((head) => ({
          workspaceId: head.workspaceId,
          ownerId: head.ownerId,
          revision: head.revision,
          checkpointHash: head.checkpointHash,
        })),
      changes: changeRows.length,
      operations: operationRows.length,
      devices: deviceRows.length,
      activeDevices,
      revokedDevices,
      assets: [...assets.values()].sort(compareAssets),
    };
  } catch (error) {
    if (
      error instanceof SyncError &&
      (error.code === INVALID || error.code === LIMIT)
    )
      throw error;
    throw new SyncError(INVALID, 422);
  }
}
