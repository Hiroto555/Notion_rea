import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECOVERY_INCOMPLETE,
  type ArchiveSnapshot,
} from "../src/shared/conflict-recovery";
import {
  canonicalJson,
  hashCheckpoint,
  type Checkpoint,
} from "../src/sync/protocol";
import { exportRecoveryArchive } from "../src/persistence/conflict-recovery-export";
import { verifyRecoveryBundle } from "../src/persistence/conflict-recovery-verify";

const ASSET_ID = "00000000-0000-4000-8000-000000000001";

const EMPTY_TABLES = {
  pages: [],
  versions: [],
  assets: [],
  record_databases: [],
  record_memberships: [],
  record_value_versions: [],
  record_database_trash_batches: [],
  record_database_trash_members: [],
  legacy_database_archive: [],
  legacy_database_versions: [],
  legacy_record_map: [],
};

function emptyCheckpoint(): Checkpoint {
  return {
    format: "folio-checkpoint/v1",
    name: "folio-workspace",
    version: 1,
    payload: { tables: structuredClone(EMPTY_TABLES) },
    assets: [],
  };
}

function checkpointWithAsset(bytes: Buffer): Checkpoint {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    id: ASSET_ID,
    name: "a.txt",
    extension: "txt",
    mime: "text/plain",
    storageName: ASSET_ID,
    size: bytes.length,
    sha256,
  };
  return {
    format: "folio-checkpoint/v1",
    name: "folio-workspace",
    version: 1,
    payload: {
      tables: {
        ...structuredClone(EMPTY_TABLES),
        assets: [[ASSET_ID, JSON.stringify(metadata)]],
      },
    },
    assets: [{ id: ASSET_ID, sha256, bytes: bytes.length }],
  };
}

function snapshotFor(checkpoint: Checkpoint): ArchiveSnapshot {
  return {
    target: {
      source: "a".repeat(64),
      id: 1,
      operationId: "op-1",
      kind: "conflict",
      createdAt: 1,
      checkpointHash: hashCheckpoint(checkpoint),
    },
    checkpoint,
  };
}

let root: string;
let source: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "folio-d06-")));
  source = join(root, "source");
  mkdirSync(source);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(
  overrides: Partial<Parameters<typeof exportRecoveryArchive>[4]> = {},
) {
  return {
    assertTarget: () => {},
    admitBytes: () => {},
    ...overrides,
  };
}

test("preserves an incomplete export when ENOSPC is injected after output creation", () => {
  const destination = join(root, "enospc-output");
  const checkpoint = emptyCheckpoint();
  const before = canonicalJson(checkpoint);
  const failure = Object.assign(new Error("injected ENOSPC"), {
    code: "ENOSPC",
  });
  expect(() =>
    exportRecoveryArchive(
      snapshotFor(checkpoint),
      source,
      destination,
      "complete-bundle",
      options({
        fault: (stage) => {
          if (stage === "before-file-sync") throw failure;
        },
      }),
    ),
  ).toThrow(failure);
  expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(true);
  expect(() => verifyRecoveryBundle(destination)).toThrow();
  expect(canonicalJson(checkpoint)).toBe(before);
});

describe("exportRecoveryArchive metadata-only", () => {
  test("writes a canonical checkpoint and an explicit non-restorable note without bundle form", () => {
    const checkpoint = emptyCheckpoint();
    const snapshot = snapshotFor(checkpoint);
    const destination = join(root, "metadata");
    let admitted = 0;
    let targetChecks = 0;

    const result = exportRecoveryArchive(
      snapshot,
      source,
      destination,
      "metadata-only",
      options({
        assertTarget: () => {
          targetChecks++;
        },
        admitBytes: (bytes) => {
          admitted = bytes;
        },
      }),
    );

    expect(targetChecks).toBe(2);
    expect(admitted).toBeGreaterThan(64 * 1024 * 1024);
    expect(result).toEqual({
      kind: "metadata-only",
      directory: destination,
      checkpointHash: snapshot.target.checkpointHash,
    });
    expect(readFileSync(join(destination, "checkpoint.json"), "utf8")).toBe(
      canonicalJson(checkpoint),
    );
    expect(readFileSync(join(destination, "README.txt"), "utf8")).toContain(
      "not a restorable bundle",
    );
    expect(existsSync(join(destination, "manifest.json"))).toBe(false);
    expect(existsSync(join(destination, "assets"))).toBe(false);
    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(false);
  });

  test("checks capacity before creating the destination", () => {
    const destination = join(root, "capacity");
    let existedAtAdmission: boolean | null = null;
    let existedAtTargetCheck: boolean | null = null;

    exportRecoveryArchive(
      snapshotFor(emptyCheckpoint()),
      source,
      destination,
      "metadata-only",
      {
        assertTarget: () => {
          if (existedAtTargetCheck === null)
            existedAtTargetCheck = existsSync(destination);
        },
        admitBytes: () => {
          existedAtAdmission = existsSync(destination);
        },
      },
    );

    expect(existedAtTargetCheck).toBe(false);
    expect(existedAtAdmission).toBe(false);
  });

  test("rejects a destination within the source directory", () => {
    const inside = join(source, "nested");
    expect(() =>
      exportRecoveryArchive(
        snapshotFor(emptyCheckpoint()),
        source,
        inside,
        "metadata-only",
        options(),
      ),
    ).toThrow();
    expect(existsSync(inside)).toBe(false);

    expect(() =>
      exportRecoveryArchive(
        snapshotFor(emptyCheckpoint()),
        source,
        source,
        "metadata-only",
        options(),
      ),
    ).toThrow();
  });

  test("rejects a destination under a Folio data or backup marker", () => {
    writeFileSync(join(root, "workspace.sqlite"), "");
    const destination = join(root, "blocked");
    expect(() =>
      exportRecoveryArchive(
        snapshotFor(emptyCheckpoint()),
        source,
        destination,
        "metadata-only",
        options(),
      ),
    ).toThrow();
    expect(existsSync(destination)).toBe(false);
  });
});

describe("exportRecoveryArchive complete bundle", () => {
  test("writes manifest, checkpoint and assets, verifies, then publishes", () => {
    const data = Buffer.from("hello recovery asset");
    const checkpoint = checkpointWithAsset(data);
    const snapshot = snapshotFor(checkpoint);
    mkdirSync(join(source, "assets"));
    writeFileSync(join(source, "assets", ASSET_ID), data);
    const destination = join(root, "bundle");
    let targetChecks = 0;

    const result = exportRecoveryArchive(
      snapshot,
      source,
      destination,
      "complete-bundle",
      options({
        assertTarget: () => {
          targetChecks++;
        },
      }),
    );

    expect(targetChecks).toBe(2);
    expect(result.kind).toBe("complete-bundle");
    expect(result.directory).toBe(destination);
    expect(result.checkpointHash).toBe(snapshot.target.checkpointHash);
    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(false);
    expect(readFileSync(join(destination, "assets", ASSET_ID))).toEqual(data);
    const verified = verifyRecoveryBundle(destination);
    expect(verified.fingerprint).toBe(result.fingerprint);
    expect(verified.manifest.archive).toEqual(snapshot.target);
    expect(verified.checkpoint).toEqual(checkpoint);
  });

  test("keeps the incomplete output when the final target check fails", () => {
    const data = Buffer.from("retain on target failure");
    const checkpoint = checkpointWithAsset(data);
    mkdirSync(join(source, "assets"));
    writeFileSync(join(source, "assets", ASSET_ID), data);
    const destination = join(root, "target-failure");
    let checks = 0;

    expect(() =>
      exportRecoveryArchive(
        snapshotFor(checkpoint),
        source,
        destination,
        "complete-bundle",
        options({
          assertTarget: () => {
            if (++checks === 2) throw new Error("target changed");
          },
        }),
      ),
    ).toThrow("target changed");

    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(true);
    expect(() => verifyRecoveryBundle(destination)).toThrow();
    expect(
      verifyRecoveryBundle(destination, { allowIncomplete: true }).checkpoint,
    ).toEqual(checkpoint);
  });

  test("retains a failed copy without cleanup", () => {
    const checkpoint = checkpointWithAsset(Buffer.from("missing"));
    const destination = join(root, "missing-asset");

    expect(() =>
      exportRecoveryArchive(
        snapshotFor(checkpoint),
        source,
        destination,
        "complete-bundle",
        options(),
      ),
    ).toThrow();

    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(true);
    expect(existsSync(join(destination, "manifest.json"))).toBe(true);
    expect(() => verifyRecoveryBundle(destination)).toThrow();
  });

  test("a before-complete fault leaves the incomplete marker in place", () => {
    const data = Buffer.from("fault before complete");
    const checkpoint = checkpointWithAsset(data);
    mkdirSync(join(source, "assets"));
    writeFileSync(join(source, "assets", ASSET_ID), data);
    const destination = join(root, "before-complete");

    expect(() =>
      exportRecoveryArchive(
        snapshotFor(checkpoint),
        source,
        destination,
        "complete-bundle",
        options({
          fault: (stage) => {
            if (stage === "before-complete") throw new Error(stage);
          },
        }),
      ),
    ).toThrow("before-complete");

    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(true);
    expect(() => verifyRecoveryBundle(destination)).toThrow();
  });

  test("an after-complete fault reports unknown but leaves a verifiable bundle", () => {
    const data = Buffer.from("fault after complete");
    const checkpoint = checkpointWithAsset(data);
    mkdirSync(join(source, "assets"));
    writeFileSync(join(source, "assets", ASSET_ID), data);
    const destination = join(root, "after-complete");

    expect(() =>
      exportRecoveryArchive(
        snapshotFor(checkpoint),
        source,
        destination,
        "complete-bundle",
        options({
          fault: (stage) => {
            if (stage === "after-complete") throw new Error(stage);
          },
        }),
      ),
    ).toThrow("after-complete");

    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(false);
    expect(verifyRecoveryBundle(destination).checkpoint).toEqual(checkpoint);
  });
});

test("measures Japanese checkpoint text in UTF-8 bytes", () => {
  const bytes = Buffer.from("添付の内容");
  const checkpoint = checkpointWithAsset(bytes);
  const tables = checkpoint.payload.tables as unknown as { assets: string[][] };
  const metadata = JSON.parse(tables.assets[0][1]);
  metadata.name = "日本語の添付.txt";
  tables.assets[0][1] = JSON.stringify(metadata);
  mkdirSync(join(source, "assets"));
  writeFileSync(join(source, "assets", ASSET_ID), bytes);
  const destination = join(root, "日本語 回収");
  exportRecoveryArchive(
    snapshotFor(checkpoint),
    source,
    destination,
    "complete-bundle",
    options(),
  );
  expect(verifyRecoveryBundle(destination).manifest.checkpoint.bytes).toBe(
    Buffer.byteLength(canonicalJson(checkpoint)),
  );
});
test("does not acknowledge an uncertain completion-directory fsync", () => {
  const destination = join(root, "uncertain-completion");
  expect(() =>
    exportRecoveryArchive(
      snapshotFor(emptyCheckpoint()),
      source,
      destination,
      "complete-bundle",
      options({
        fault: (stage) => {
          if (stage === "before-complete-sync")
            throw new Error("completion sync response unknown");
        },
      }),
    ),
  ).toThrow("completion sync response unknown");
  expect(existsSync(join(destination, "checkpoint.json"))).toBe(true);
  expect(verifyRecoveryBundle(destination).checkpoint).toEqual(
    emptyCheckpoint(),
  );
});
