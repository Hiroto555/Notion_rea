import { expect, it } from "vitest";
import {
  DEFAULT_LV4_GO_CAPACITY_SCENARIOS,
  LV4_GO_CAPACITY_BOUNDS,
  runLv4GoCapacityMeasurement,
  type CapacityScenario,
} from "../scripts/lv4-go-capacity";
import { MAX_CHECKPOINT_BYTES } from "../src/sync/protocol";

const SCENARIOS: readonly CapacityScenario[] = Object.freeze([
  {
    name: "test-records-3",
    records: { count: 3, valueBytes: 64, edits: 1 },
  },
  {
    name: "test-record-bodies-2x1k",
    records: { count: 2, bodyBytes: 1_024 },
  },
  { name: "test-attachments-1x1k", attachments: { files: 1, bytes: 1_024 } },
  { name: "test-attachments-1x4k", attachments: { files: 1, bytes: 4_096 } },
  {
    name: "test-mixed-2-records-1x2k",
    records: { count: 2, valueBytes: 32 },
    attachments: { files: 1, bytes: 2_048 },
  },
]);

it("keeps the default measurement grid inside fixed bounds", () => {
  const bounds = LV4_GO_CAPACITY_BOUNDS;
  let totalAttachmentBytes = 0;
  for (const scenario of DEFAULT_LV4_GO_CAPACITY_SCENARIOS) {
    const records = scenario.records?.count ?? 0;
    const files = scenario.attachments?.files ?? 0;
    const bytesEach = scenario.attachments?.bytes ?? 0;
    expect(records).toBeLessThanOrEqual(bounds.maxRecordsPerScenario);
    expect(scenario.records?.edits ?? 0).toBeLessThanOrEqual(
      bounds.maxRecordEditsPerScenario,
    );
    expect(scenario.records?.valueBytes ?? 0).toBeLessThanOrEqual(
      bounds.maxRecordValueBytes,
    );
    expect(scenario.records?.bodyBytes ?? 0).toBeLessThanOrEqual(
      bounds.maxRecordBodyBytes,
    );
    expect(files).toBeLessThanOrEqual(bounds.maxAttachmentFilesPerScenario);
    expect(bytesEach).toBeLessThanOrEqual(bounds.maxAttachmentBytesEach);
    const attachmentBytes = files * bytesEach;
    expect(attachmentBytes).toBeLessThanOrEqual(
      bounds.maxAttachmentBytesTotal,
    );
    totalAttachmentBytes += attachmentBytes;
    expect(
      (records > 0 ? 1 : 0) + records + (files > 0 ? 1 : 0),
    ).toBeLessThanOrEqual(bounds.maxPagesPerScenario);
  }
  // A whole script run stays in a few megabytes, never an unbounded fill.
  expect(totalAttachmentBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it("rejects an unbounded scenario before creating a workspace", () => {
  expect(() =>
    runLv4GoCapacityMeasurement({
      scenarios: [
        {
          name: "too-many-records",
          records: { count: LV4_GO_CAPACITY_BOUNDS.maxRecordsPerScenario + 1 },
        },
      ],
    }),
  ).toThrow(/bounded record count/);
});

it(
  "reports bounded record, DB/WAL, attachment and backup sizes without claiming network bytes",
  () => {
    const report = runLv4GoCapacityMeasurement({ scenarios: SCENARIOS });
    expect(report.methodology.networkMeasured).toBe(false);
    expect(report.methodology.userDataAccessed).toBe(false);
    expect(report.methodology.temporaryRootsRemovedInFinally).toBe(true);
    expect(report.checkpointLimitBytes).toBe(MAX_CHECKPOINT_BYTES);
    expect(report.scenarios).toHaveLength(SCENARIOS.length);
    const byName = new Map(report.scenarios.map((row) => [row.name, row]));

    for (const scenario of SCENARIOS) {
      const row = byName.get(scenario.name);
      expect(row, scenario.name).toBeDefined();
      if (!row) continue;

      expect(row.input.recordCount).toBe(scenario.records?.count ?? 0);
      expect(row.input.attachmentFiles).toBe(
        scenario.attachments?.files ?? 0,
      );
      expect(row.counts.recordDatabases).toBe(
        row.input.recordCount > 0 ? 1 : 0,
      );
      expect(row.counts.records).toBe(row.input.recordCount);
      expect(row.counts.snapshotRecords).toBe(row.input.recordCount);
      expect(row.counts.snapshotPages).toBe(row.counts.pages);
      expect(row.counts.assets).toBe(row.input.attachmentFiles);
      expect(row.counts.pages).toBe(
        (row.input.recordCount > 0 ? 1 : 0) +
          row.input.recordCount +
          (row.input.attachmentFiles > 0 ? 1 : 0),
      );

      expect(row.bytes.database).toBeGreaterThan(0);
      expect(row.bytes.wal).toBeGreaterThanOrEqual(0);
      expect(row.bytes.shm).toBeGreaterThanOrEqual(0);
      expect(row.bytes.journal).toBeGreaterThanOrEqual(0);
      expect(row.bytes.assetFileBytes).toBe(row.input.attachmentBytesTotal);
      expect(row.bytes.checkpoint).not.toBeNull();
      expect(row.bytes.checkpoint!).toBeGreaterThan(0);
      expect(row.bytes.checkpoint!).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);

      expect(row.checkpoint.valid).toBe(true);
      expect(row.checkpoint.withinLimit).toBe(true);
      expect(row.checkpoint.limitBytes).toBe(MAX_CHECKPOINT_BYTES);
      expect(row.checkpoint.assetBodiesIncluded).toBe(false);
      expect(row.checkpoint.rejection).toBeNull();
      expect(row.checkpoint.hashPrefix).toMatch(/^[a-f0-9]{8}$/);

      expect(row.backup.scanState).toBe("complete");
      expect(row.backup.databaseBytes).toBeGreaterThan(0);
      expect(row.backup.assetBytes).toBe(row.input.attachmentBytesTotal);
      expect(row.backup.assetFiles).toBe(row.input.attachmentFiles);
      expect(row.backup.manifestBytes).toBeGreaterThan(0);
      expect(row.backup.totalBytes).toBeGreaterThanOrEqual(
        row.backup.databaseBytes + row.backup.assetBytes,
      );
      expect(row.backup.inventory.records).toBe(row.input.recordCount);
      expect(row.backup.inventory.registeredAssets).toBe(
        row.input.attachmentFiles,
      );

      for (const duration of Object.values(row.durationsMs))
        expect(duration).toBeGreaterThanOrEqual(0);
      expect(row.backup.durationMs).toBeGreaterThanOrEqual(0);

      expect(row.network.attempted).toBe(false);
      expect(row.network.bytes).toBeNull();
      expect(row.network.note).toMatch(/No network/);

      if (row.input.recordValueBytes > 0)
        expect(row.bytes.recordMembershipValues).toBeGreaterThanOrEqual(
          row.input.recordCount * row.input.recordValueBytes,
        );
      if (row.input.recordEdits > 0) {
        expect(row.counts.versions).toBeGreaterThan(0);
        expect(row.counts.recordValueVersions).toBeGreaterThan(0);
      }
      if (row.input.attachmentFiles > 0)
        expect(row.bytes.assetMetadata).toBeGreaterThan(0);
    }

    // Attachment payload is measured on disk and in the backup, but the
    // checkpoint carries only a fixed-size manifest entry. Growing the asset
    // by 3 KiB must not grow the serialized checkpoint by 3 KiB.
    const oneK = byName.get("test-attachments-1x1k");
    const fourK = byName.get("test-attachments-1x4k");
    expect(oneK).toBeDefined();
    expect(fourK).toBeDefined();
    if (oneK && fourK) {
      expect(
        fourK.input.attachmentBytesTotal -
          oneK.input.attachmentBytesTotal,
      ).toBe(3_072);
      expect(
        fourK.bytes.assetFileBytes - oneK.bytes.assetFileBytes,
      ).toBe(3_072);
      expect(
        fourK.bytes.checkpoint! - oneK.bytes.checkpoint!,
      ).toBeLessThanOrEqual(64);
      expect(
        fourK.bytes.checkpointAssetManifest! -
          oneK.bytes.checkpointAssetManifest!,
      ).toBeLessThanOrEqual(16);
      expect(fourK.bytes.checkpoint!).toBeLessThan(
        fourK.bytes.assetFileBytes,
      );
    }
  },
  120_000,
);
