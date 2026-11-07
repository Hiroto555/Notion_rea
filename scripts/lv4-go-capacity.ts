/**
 * Lv4 bounded capacity measurement (lane: lv4-go-capacity).
 *
 * Focused on two dimensions that the existing scripts do not cover together:
 * - database/record growth: record databases, record rows, record values,
 *   record Page bodies and record value history;
 * - attachment-size growth: real files attached through `attachFile`, their
 *   backup copies and the checkpoint manifest that references them.
 *
 * Every case uses one `mkdtemp` workspace and is deleted in `finally`. The
 * scenario grid and every field are hard-capped by `LV4_GO_CAPACITY_BOUNDS`;
 * nothing grows until a limit is hit.
 *
 * Measurement boundaries:
 * - `bytes.database`/`bytes.wal`/`bytes.shm`/`bytes.journal` are filesystem
 *   sizes of the live SQLite workspace.
 * - `bytes.checkpoint` is the canonical JSON size of the local checkpoint
 *   payload. It is a serialization size, not a network transfer count.
 * - `bytes.assetFileBytes` is the attachment payload on disk. Attachment
 *   bodies are NOT part of the checkpoint; only the registry manifest is.
 * - `bytes.backup*` are filesystem sizes measured after `createFullBackup`
 *   has copied and verified its snapshot.
 * - `network.attempted` is always false. No socket, HTTP client or peer is
 *   created, so these numbers must never be reported as network throughput.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { attachFile } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { scanDirectoryTree } from "../src/persistence/storage-usage";
import { Store } from "../src/persistence/store";
import {
  buildWorkspaceCheckpoint,
  validateWorkspaceCheckpoint,
} from "../src/sync/workspace-checkpoint";
import {
  canonicalJson,
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
  MAX_WIRE_BYTES,
  SyncError,
} from "../src/sync/protocol";

export const LV4_GO_CAPACITY_BOUNDS = Object.freeze({
  maxRecordsPerScenario: 500,
  maxRecordEditsPerScenario: 100,
  maxRecordValueBytes: 16_384,
  maxRecordBodyBytes: 65_536,
  maxAttachmentFilesPerScenario: 8,
  maxAttachmentBytesEach: 1_048_576,
  maxAttachmentBytesTotal: 4_194_304,
  maxPagesPerScenario: 1_000,
});

export type RecordCapacityInput = {
  count?: number;
  valueBytes?: number;
  bodyBytes?: number;
  edits?: number;
};

export type AttachmentCapacityInput = {
  files?: number;
  bytes?: number;
};

export type CapacityScenario = {
  name: string;
  records?: RecordCapacityInput;
  attachments?: AttachmentCapacityInput;
};

export type CapacityRunOptions = {
  scenarios?: readonly CapacityScenario[];
};

type NormalizedScenario = {
  name: string;
  kind: "records" | "attachments" | "mixed";
  recordCount: number;
  recordValueBytes: number;
  recordBodyBytes: number;
  recordEdits: number;
  attachmentFiles: number;
  attachmentBytesEach: number;
};

type ScenarioInput = {
  recordCount: number;
  recordValueBytes: number;
  recordBodyBytes: number;
  recordEdits: number;
  attachmentFiles: number;
  attachmentBytesEach: number;
  attachmentBytesTotal: number;
};

type ScenarioCounts = {
  pages: number;
  recordDatabases: number;
  records: number;
  versions: number;
  recordValueVersions: number;
  assets: number;
  snapshotPages: number;
  snapshotRecords: number;
};

type ScenarioBytes = {
  database: number;
  wal: number;
  shm: number;
  journal: number;
  pagesData: number;
  pagesBody: number;
  versionsDoc: number;
  versionsDatabase: number;
  recordMembershipValues: number;
  recordValueVersionValues: number;
  assetMetadata: number;
  assetFileBytes: number;
  checkpoint: number | null;
  checkpointAssetManifest: number | null;
};

type ScenarioDurations = {
  recordSchema: number;
  recordSetup: number;
  recordBodies: number;
  recordEdits: number;
  attachmentSetup: number;
  load: number;
  checkpointBuild: number;
  checkpointEncodeHash: number;
  checkpointValidate: number;
};

type ScenarioCheckpoint = {
  valid: boolean;
  hashPrefix: string | null;
  limitBytes: number;
  wireLimitBytes: number;
  withinLimit: boolean;
  assetBodiesIncluded: false;
  rejection: string | null;
};

type ScenarioBackup = {
  durationMs: number;
  databaseBytes: number;
  assetBytes: number;
  manifestBytes: number;
  totalBytes: number;
  files: number;
  assetFiles: number;
  scanState: string;
  fingerprintPrefix: string;
  inventory: {
    pages: number;
    recordDatabases: number;
    records: number;
    versions: number;
    settings: number;
    saveReceipts: number;
    registeredAssets: number;
  };
};

export type CapacityMeasurement = {
  name: string;
  kind: "records" | "attachments" | "mixed";
  input: ScenarioInput;
  counts: ScenarioCounts;
  bytes: ScenarioBytes;
  durationsMs: ScenarioDurations;
  checkpoint: ScenarioCheckpoint;
  backup: ScenarioBackup;
  network: {
    attempted: false;
    bytes: null;
    note: string;
  };
};

export type CapacityReport = {
  node: string;
  platform: string;
  checkpointLimitBytes: number;
  wireLimitBytes: number;
  bounds: typeof LV4_GO_CAPACITY_BOUNDS;
  methodology: {
    data: "synthetic mkdtemp workspaces only";
    userDataAccessed: false;
    temporaryRootsRemovedInFinally: true;
    persistence: "production Store, RecordRepository, attachFile and createFullBackup";
    bounded: true;
    checkpointAmount: "canonical local JSON checkpoint size";
    assetAmount: "attachment file bytes on disk; not part of the checkpoint payload";
    backupAmount: "filesystem size of the verified full backup";
    networkMeasured: false;
    networkNote: string;
  };
  scenarios: CapacityMeasurement[];
};

const NETWORK_NOTE =
  "No network is attempted. checkpointBytes is a local serialization size, assetFileBytes is on-disk attachment payload, and neither is a transferred-byte count.";

export const DEFAULT_LV4_GO_CAPACITY_SCENARIOS: readonly CapacityScenario[] =
  Object.freeze([
    { name: "records-10", records: { count: 10, valueBytes: 128 } },
    { name: "records-100", records: { count: 100, valueBytes: 64 } },
    { name: "records-250", records: { count: 250, valueBytes: 32 } },
    {
      name: "record-values-50x2k",
      records: { count: 50, valueBytes: 2_048 },
    },
    {
      name: "record-bodies-20x4k",
      records: { count: 20, bodyBytes: 4_096 },
    },
    {
      name: "record-history-60",
      records: { count: 1, valueBytes: 128, edits: 60 },
    },
    { name: "attachments-3x64k", attachments: { files: 3, bytes: 65_536 } },
    {
      name: "attachments-5x256k",
      attachments: { files: 5, bytes: 262_144 },
    },
    {
      name: "mixed-100-records-2x256k",
      records: { count: 100, valueBytes: 64 },
      attachments: { files: 2, bytes: 262_144 },
    },
    {
      name: "mixed-20-bodies-1x1m",
      records: { count: 20, bodyBytes: 2_048 },
      attachments: { files: 1, bytes: 1_048_576 },
    },
  ]);

const fileBytes = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const elapsed = (start: number): number =>
  Math.round((performance.now() - start) * 1_000) / 1_000;

const safeNonNegative = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`Invalid ${label}: ${String(value)}`);
  return value;
};

function normalizeScenario(scenario: CapacityScenario): NormalizedScenario {
  if (!scenario || typeof scenario.name !== "string" || !scenario.name)
    throw new TypeError("Capacity scenario requires a name");
  const records = scenario.records ?? {};
  const attachments = scenario.attachments ?? {};
  const recordCount = safeNonNegative(
    records.count ?? 0,
    `${scenario.name}.records.count`,
  );
  const recordValueBytes = safeNonNegative(
    records.valueBytes ?? 0,
    `${scenario.name}.records.valueBytes`,
  );
  const recordBodyBytes = safeNonNegative(
    records.bodyBytes ?? 0,
    `${scenario.name}.records.bodyBytes`,
  );
  const recordEdits = safeNonNegative(
    records.edits ?? 0,
    `${scenario.name}.records.edits`,
  );
  const attachmentFiles = safeNonNegative(
    attachments.files ?? 0,
    `${scenario.name}.attachments.files`,
  );
  const attachmentBytesEach = safeNonNegative(
    attachments.bytes ?? 0,
    `${scenario.name}.attachments.bytes`,
  );
  const bounds = LV4_GO_CAPACITY_BOUNDS;
  if (recordCount > bounds.maxRecordsPerScenario)
    throw new RangeError(
      `${scenario.name} exceeds the bounded record count (${bounds.maxRecordsPerScenario})`,
    );
  if (recordValueBytes > bounds.maxRecordValueBytes)
    throw new RangeError(
      `${scenario.name} exceeds the bounded record value size (${bounds.maxRecordValueBytes})`,
    );
  if (recordBodyBytes > bounds.maxRecordBodyBytes)
    throw new RangeError(
      `${scenario.name} exceeds the bounded record body size (${bounds.maxRecordBodyBytes})`,
    );
  if (recordEdits > bounds.maxRecordEditsPerScenario)
    throw new RangeError(
      `${scenario.name} exceeds the bounded record edit count (${bounds.maxRecordEditsPerScenario})`,
    );
  if (attachmentFiles > bounds.maxAttachmentFilesPerScenario)
    throw new RangeError(
      `${scenario.name} exceeds the bounded attachment count (${bounds.maxAttachmentFilesPerScenario})`,
    );
  if (attachmentBytesEach > bounds.maxAttachmentBytesEach)
    throw new RangeError(
      `${scenario.name} exceeds the bounded per-attachment size (${bounds.maxAttachmentBytesEach})`,
    );
  const attachmentBytesTotal = attachmentFiles * attachmentBytesEach;
  if (
    !Number.isSafeInteger(attachmentBytesTotal) ||
    attachmentBytesTotal > bounds.maxAttachmentBytesTotal
  )
    throw new RangeError(
      `${scenario.name} exceeds the bounded total attachment size (${bounds.maxAttachmentBytesTotal})`,
    );
  if ((recordBodyBytes > 0 || recordEdits > 0) && recordCount === 0)
    throw new RangeError(
      `${scenario.name} requests record body/history work without records`,
    );
  const pages =
    (recordCount > 0 ? 1 : 0) +
    recordCount +
    (attachmentFiles > 0 ? 1 : 0);
  if (pages > bounds.maxPagesPerScenario)
    throw new RangeError(
      `${scenario.name} exceeds the bounded page count (${bounds.maxPagesPerScenario})`,
    );
  if (recordCount === 0 && attachmentFiles === 0)
    throw new RangeError(`${scenario.name} has no measured data`);
  return {
    name: scenario.name,
    kind:
      recordCount > 0 && attachmentFiles > 0
        ? "mixed"
        : attachmentFiles > 0
          ? "attachments"
          : "records",
    recordCount,
    recordValueBytes,
    recordBodyBytes,
    recordEdits,
    attachmentFiles,
    attachmentBytesEach,
  };
}

const textDoc = (bytes: number) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: bytes > 0 ? [{ type: "text", text: "x".repeat(bytes) }] : [],
    },
  ],
});

const attachmentDoc = (sources: readonly string[]) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "attachments" }] },
    ...sources.map((src) => ({ type: "image", attrs: { src } })),
  ],
});

/** Logical byte size of one TEXT column across its rows. All table/column
 * names are fixed literals in this file. */
const columnBytes = (
  db: DatabaseSync,
  table: string,
  column: string,
): number =>
  Number(
    (
      db
        .prepare(
          `SELECT coalesce(sum(length(CAST(${column} AS BLOB))),0) AS bytes FROM ${table}`,
        )
        .get() as { bytes: number }
    ).bytes,
  );

const countRows = (db: DatabaseSync, table: string): number =>
  Number(
    (
      db.prepare(`SELECT count(*) AS value FROM ${table}`).get() as {
        value: number;
      }
    ).value,
  );

function measureScenario(scenario: CapacityScenario): CapacityMeasurement {
  const spec = normalizeScenario(scenario);
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-lv4-go-capacity-"),
  );
  const workspace = join(root, "workspace");
  const assetsDirectory = join(workspace, "assets");
  const backupDirectory = join(root, "backup");
  let opened: Store | null = null;
  try {
    mkdirSync(workspace);
    mkdirSync(assetsDirectory);
    const store = new Store(join(workspace, "workspace.sqlite"));
    opened = store;
    const repository = new RecordRepository(store);

    const schemaStart = performance.now();
    store.transaction(() => {
      repository.createSchema();
      markRecordStoreVersion(store.db);
    });
    const recordSchema = elapsed(schemaStart);

    const recordSetupStart = performance.now();
    let ownerId: string | null = null;
    const recordIds: string[] = [];
    if (spec.recordCount > 0) {
      const owner = store.create(null, "database", "capacity database");
      ownerId = owner.id;
      for (let index = 0; index < spec.recordCount; index++) {
        const values: Record<string, string | boolean> =
          spec.recordValueBytes > 0
            ? { note: "v".repeat(spec.recordValueBytes) }
            : { flag: index % 2 === 0 };
        const record = repository.create(owner.id, `record ${index}`, values);
        recordIds.push(record.pageId);
      }
    }
    const recordSetup = elapsed(recordSetupStart);

    const recordBodiesStart = performance.now();
    if (spec.recordBodyBytes > 0) {
      for (const pageId of recordIds) {
        const page = store.get(pageId);
        store.updateRecordPage(pageId, ownerId!, page.revision, {
          doc: textDoc(spec.recordBodyBytes),
        });
      }
    }
    const recordBodies = elapsed(recordBodiesStart);

    const recordEditsStart = performance.now();
    if (spec.recordEdits > 0) {
      let current = repository.projection(recordIds[0]);
      for (let index = 0; index < spec.recordEdits; index++) {
        current = repository.patch(
          current.pageId,
          ownerId!,
          current.revision,
          {
            title: `edit ${index}`,
            values:
              spec.recordValueBytes > 0
                ? { note: "e".repeat(spec.recordValueBytes) }
                : { edited: index },
          },
        );
      }
    }
    const recordEdits = elapsed(recordEditsStart);

    const attachmentSetupStart = performance.now();
    const assetUrls: string[] = [];
    let attachedBytes = 0;
    for (let index = 0; index < spec.attachmentFiles; index++) {
      const file = join(root, `asset-${index}.bin`);
      writeFileSync(file, Buffer.alloc(spec.attachmentBytesEach, 97 + (index % 26)), {
        flag: "wx",
      });
      const asset = attachFile(store.db, assetsDirectory, file);
      if (asset.size !== spec.attachmentBytesEach)
        throw new Error(
          `${spec.name} attachment size mismatch: ${asset.size} !== ${spec.attachmentBytesEach}`,
        );
      attachedBytes += asset.size;
      assetUrls.push(asset.url);
    }
    if (attachedBytes !== spec.attachmentFiles * spec.attachmentBytesEach)
      throw new Error(`${spec.name} attachment byte total mismatch`);
    if (assetUrls.length > 0)
      store.create(
        null,
        "page",
        "capacity attachments",
        attachmentDoc(assetUrls),
      );
    const attachmentSetup = elapsed(attachmentSetupStart);

    const loadStart = performance.now();
    const snapshot = store.load();
    const load = elapsed(loadStart);

    const db = store.db;
    const counts: ScenarioCounts = {
      pages: countRows(db, "pages"),
      recordDatabases: countRows(db, "record_databases"),
      records: countRows(db, "record_memberships"),
      versions: countRows(db, "versions"),
      recordValueVersions: countRows(db, "record_value_versions"),
      assets: countRows(db, "assets"),
      snapshotPages: snapshot.pages.length,
      snapshotRecords: snapshot.records?.length ?? 0,
    };
    if (counts.records !== spec.recordCount)
      throw new Error(
        `${spec.name} record count mismatch: ${counts.records} !== ${spec.recordCount}`,
      );
    if (counts.assets !== spec.attachmentFiles)
      throw new Error(
        `${spec.name} asset count mismatch: ${counts.assets} !== ${spec.attachmentFiles}`,
      );
    if (counts.snapshotRecords !== counts.records)
      throw new Error(`${spec.name} load() record projection mismatch`);

    const bytes: ScenarioBytes = {
      database: fileBytes(store.path),
      wal: fileBytes(store.path + "-wal"),
      shm: fileBytes(store.path + "-shm"),
      journal: fileBytes(store.path + "-journal"),
      pagesData: columnBytes(db, "pages", "data"),
      pagesBody: columnBytes(db, "pages", "body"),
      versionsDoc: columnBytes(db, "versions", "doc"),
      versionsDatabase: columnBytes(db, "versions", "database"),
      recordMembershipValues: columnBytes(
        db,
        "record_memberships",
        "values_json",
      ),
      recordValueVersionValues: columnBytes(
        db,
        "record_value_versions",
        "values_json",
      ),
      assetMetadata: columnBytes(db, "assets", "metadata"),
      assetFileBytes: 0,
      checkpoint: null,
      checkpointAssetManifest: null,
    };

    const checkpointBuildStart = performance.now();
    const checkpoint = buildWorkspaceCheckpoint(db);
    const checkpointBuild = elapsed(checkpointBuildStart);

    let checkpointBytes: number | null = null;
    let checkpointAssetManifestBytes: number | null = null;
    let checkpointHashPrefix: string | null = null;
    let checkpointRejection: string | null = null;
    const encodeStart = performance.now();
    try {
      checkpointBytes = Buffer.byteLength(canonicalJson(checkpoint));
      checkpointAssetManifestBytes = Buffer.byteLength(
        canonicalJson(checkpoint.assets),
      );
      checkpointHashPrefix = hashCheckpoint(checkpoint).slice(0, 8);
    } catch (error) {
      checkpointRejection =
        error instanceof SyncError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    }
    const checkpointEncodeHash = elapsed(encodeStart);

    const validateStart = performance.now();
    const checkpointValid = validateWorkspaceCheckpoint(checkpoint);
    const checkpointValidate = elapsed(validateStart);

    // Measure the live DB/WAL after all writes and before the backup reads.
    bytes.database = fileBytes(store.path);
    bytes.wal = fileBytes(store.path + "-wal");
    bytes.shm = fileBytes(store.path + "-shm");
    bytes.journal = fileBytes(store.path + "-journal");

    const assetScan = scanDirectoryTree(assetsDirectory);
    if (assetScan.usage.state !== "complete")
      throw new Error(
        `${spec.name} asset scan was not complete: ${assetScan.usage.state}`,
      );
    bytes.assetFileBytes = assetScan.usage.measuredBytes;

    const backupStart = performance.now();
    const backup = createFullBackup(db, workspace, backupDirectory);
    const backupDuration = elapsed(backupStart);

    const backupAssetsScan = scanDirectoryTree(
      join(backupDirectory, "assets"),
    );
    const backupScan = scanDirectoryTree(backupDirectory);
    if (
      backupScan.usage.state !== "complete" ||
      backupAssetsScan.usage.state !== "complete"
    )
      throw new Error(`${spec.name} backup scan was not complete`);
    const backupDatabaseBytes = fileBytes(
      join(backupDirectory, "workspace.sqlite"),
    );
    const backupAssetBytes = backupAssetsScan.usage.measuredBytes;
    const backupManifestBytes = fileBytes(
      join(backupDirectory, "manifest.json"),
    );
    if (backup.manifest.assets.length !== spec.attachmentFiles)
      throw new Error(`${spec.name} backup asset manifest mismatch`);

    bytes.checkpoint = checkpointBytes;
    bytes.checkpointAssetManifest = checkpointAssetManifestBytes;

    return {
      name: spec.name,
      kind: spec.kind,
      input: {
        recordCount: spec.recordCount,
        recordValueBytes: spec.recordValueBytes,
        recordBodyBytes: spec.recordBodyBytes,
        recordEdits: spec.recordEdits,
        attachmentFiles: spec.attachmentFiles,
        attachmentBytesEach: spec.attachmentBytesEach,
        attachmentBytesTotal:
          spec.attachmentFiles * spec.attachmentBytesEach,
      },
      counts,
      bytes,
      durationsMs: {
        recordSchema,
        recordSetup,
        recordBodies,
        recordEdits,
        attachmentSetup,
        load,
        checkpointBuild,
        checkpointEncodeHash,
        checkpointValidate,
      },
      checkpoint: {
        valid: checkpointValid,
        hashPrefix: checkpointHashPrefix,
        limitBytes: MAX_CHECKPOINT_BYTES,
        wireLimitBytes: MAX_WIRE_BYTES,
        withinLimit:
          checkpointBytes !== null &&
          checkpointBytes <= MAX_CHECKPOINT_BYTES,
        assetBodiesIncluded: false,
        rejection: checkpointRejection,
      },
      backup: {
        durationMs: backupDuration,
        databaseBytes: backupDatabaseBytes,
        assetBytes: backupAssetBytes,
        manifestBytes: backupManifestBytes,
        totalBytes: backupScan.usage.measuredBytes,
        files: backupScan.usage.measuredFiles,
        assetFiles: backup.manifest.assets.length,
        scanState: backupScan.usage.state,
        fingerprintPrefix: backup.fingerprint.slice(0, 8),
        inventory: { ...backup.manifest.inventory },
      },
      network: {
        attempted: false,
        bytes: null,
        note: NETWORK_NOTE,
      },
    };
  } finally {
    try {
      opened?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export function runLv4GoCapacityMeasurement(
  options: CapacityRunOptions = {},
): CapacityReport {
  const scenarios =
    options.scenarios ?? DEFAULT_LV4_GO_CAPACITY_SCENARIOS;
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    checkpointLimitBytes: MAX_CHECKPOINT_BYTES,
    wireLimitBytes: MAX_WIRE_BYTES,
    bounds: LV4_GO_CAPACITY_BOUNDS,
    methodology: {
      data: "synthetic mkdtemp workspaces only",
      userDataAccessed: false,
      temporaryRootsRemovedInFinally: true,
      persistence:
        "production Store, RecordRepository, attachFile and createFullBackup",
      bounded: true,
      checkpointAmount: "canonical local JSON checkpoint size",
      assetAmount:
        "attachment file bytes on disk; not part of the checkpoint payload",
      backupAmount: "filesystem size of the verified full backup",
      networkMeasured: false,
      networkNote: NETWORK_NOTE,
    },
    scenarios: scenarios.map(measureScenario),
  };
}
