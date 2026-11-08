import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECOVERY_INCOMPLETE,
  RECOVERY_ORIGIN_KEY,
  type ArchiveSnapshot,
} from "../../src/shared/conflict-recovery";
import { attachFile } from "../../src/persistence/assets";
import { exportRecoveryArchive } from "../../src/persistence/conflict-recovery-export";
import { verifyRecoveryBundle } from "../../src/persistence/conflict-recovery-verify";
import { restoreRecoveryBundle } from "../../src/persistence/conflict-recovery-import";
import { inspectRecoveredContent } from "../../src/persistence/recovered-content";
import {
  assertRecoverySyncAllowed,
  readRecoveryOrigin,
} from "../../src/persistence/recovery-origin";
import { Store } from "../../src/persistence/store";
import {
  MAX_CHECKPOINT_BYTES,
  canonicalJson,
  hashCheckpoint,
} from "../../src/sync/protocol";
import {
  buildWorkspaceCheckpoint,
  validateWorkspaceCheckpoint,
} from "../../src/sync/workspace-checkpoint";

const FILE_COUNT = 1000;
const EXACT_TOTAL_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 20_000_000;
const CHECKPOINT_LIMIT_BYTES = 1024 * 1024;
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;
const SAFETY_FREE_BYTES = 512 * 1024 * 1024;
const MAX_RSS_BYTES = 1024 * 1024 * 1024;
const EXPORT_BUDGET_MS = 60_000;
const VERIFY_BUDGET_MS = 30_000;
const RESTORE_BUDGET_MS = 60_000;

type Identity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type ExpectedAsset = {
  id: string;
  bytes: number;
  sha256: string;
  sourcePath: string;
  sourceIdentity: Identity;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true });
  check(stat.isFile() && !stat.isSymbolicLink(), "expected a regular file");
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function availableBytes(path: string): number {
  const stat = statfsSync(path);
  const free = Number(stat.bavail) * Number(stat.bsize);
  check(Number.isSafeInteger(free) && free >= 0, "invalid statfs result");
  return free;
}

function hashStreaming(path: string): { bytes: number; sha256: string } {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let offset = 0;
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, offset);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
    return { bytes: offset, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const length = writeSync(fd, data, offset, data.length - offset);
    check(length > 0, "source write made no progress");
    offset += length;
  }
}

function createSizedFile(path: string, size: number, index: number): void {
  const prefix = Buffer.from(`asset-index-${index}:`, "ascii");
  check(size > prefix.length, "source file is too small for its prefix");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeAll(fd, prefix);
    const chunk = Buffer.alloc(CHUNK_BYTES);
    for (let offset = 0; offset < chunk.length; offset++) {
      chunk[offset] = (index * 31 + offset * 17) & 0xff;
    }
    let written = prefix.length;
    while (written < size) {
      const length = Math.min(chunk.length, size - written);
      writeAll(fd, chunk.subarray(0, length));
      written += length;
    }
  } finally {
    closeSync(fd);
  }
}

function sortedEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function main(): void {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-recovery-bench-")),
  );
  const sourceDirectory = join(root, "source");
  const sourceAssets = join(sourceDirectory, "assets");
  const inputDirectory = join(root, "inputs");
  const bundleDirectory = join(root, "bundle");
  const restoredDirectory = join(root, "restored");
  let sourceStore: Store | undefined;
  let originStore: Store | undefined;

  try {
    const freeBytesBefore = availableBytes(root);
    check(
      freeBytesBefore >= MIN_FREE_BYTES,
      "insufficient free space for the recovery benchmark",
    );

    mkdirSync(sourceDirectory, { mode: 0o700 });
    mkdirSync(sourceAssets, { mode: 0o700 });
    mkdirSync(inputDirectory, { mode: 0o700 });

    const baseBytes = Math.floor(EXACT_TOTAL_BYTES / FILE_COUNT);
    const sizes: number[] = [];
    for (let index = 0; index < FILE_COUNT; index++) {
      sizes.push(
        index === FILE_COUNT - 1
          ? EXACT_TOTAL_BYTES - baseBytes * (FILE_COUNT - 1)
          : baseBytes,
      );
    }
    check(
      sizes.reduce((total, size) => total + size, 0) === EXACT_TOTAL_BYTES,
      "source sizes do not total the exact byte target",
    );
    for (const size of sizes) {
      check(
        size > 0 && size < MAX_FILE_BYTES,
        "source file size is outside the attachment limit",
      );
    }

    sourceStore = new Store(join(sourceDirectory, "workspace.sqlite"));
    const page = sourceStore.create(null, "page", "M3 recovery benchmark");
    check(typeof page.id === "string" && page.id.length > 0, "failed to create source page");

    const expected: ExpectedAsset[] = [];
    const expectedIds = new Set<string>();
    for (let index = 0; index < FILE_COUNT; index++) {
      const size = sizes[index];
      const inputPath = join(
        inputDirectory,
        `source-${String(index).padStart(4, "0")}.txt`,
      );
      createSizedFile(inputPath, size, index);
      const attached = attachFile(sourceStore.db, sourceAssets, inputPath);
      check(
        typeof attached.id === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(attached.id),
        "attachFile returned an invalid asset id",
      );
      check(
        attached.storageName === attached.id && attached.size === size,
        "attachFile returned invalid asset metadata",
      );
      check(!expectedIds.has(attached.id), "attachFile returned a duplicate asset id");
      expectedIds.add(attached.id);
      const sourcePath = join(sourceAssets, attached.id);
      const sourceHash = hashStreaming(sourcePath);
      check(
        sourceHash.bytes === size && sourceHash.sha256 === attached.sha256,
        "source attachment bytes do not match attachFile metadata",
      );
      expected.push({
        id: attached.id,
        bytes: size,
        sha256: attached.sha256,
        sourcePath,
        sourceIdentity: identity(sourcePath),
      });
    }
    check(expected.length === FILE_COUNT, "not all source files were attached");
    check(
      expected.reduce((total, asset) => total + asset.bytes, 0) === EXACT_TOTAL_BYTES,
      "attached source bytes do not total the exact byte target",
    );

    const checkpoint = buildWorkspaceCheckpoint(sourceStore.db);
    const frozenJson = canonicalJson(checkpoint, MAX_CHECKPOINT_BYTES);
    const checkpointBytes = Buffer.byteLength(frozenJson);
    check(
      checkpointBytes > 0 && checkpointBytes <= CHECKPOINT_LIMIT_BYTES,
      "checkpoint exceeds one MiB",
    );
    check(
      validateWorkspaceCheckpoint(checkpoint),
      "source checkpoint is not valid",
    );
    const frozenHash = hashCheckpoint(checkpoint);
    check(
      checkpoint.assets.length === FILE_COUNT,
      "checkpoint asset count is wrong",
    );
    const checkpointAssets = new Map(
      checkpoint.assets.map((asset) => [asset.id, asset]),
    );
    for (const asset of expected) {
      const present = checkpointAssets.get(asset.id);
      check(
        present !== undefined &&
          present.bytes === asset.bytes &&
          present.sha256 === asset.sha256,
        "checkpoint asset metadata does not match the source",
      );
    }

    sourceStore.close();
    sourceStore = undefined;

    const sourceDbPath = join(sourceDirectory, "workspace.sqlite");
    const sourceDbIdentity = identity(sourceDbPath);
    const sourceDbHash = hashStreaming(sourceDbPath);
    const frozenSourceNames = readdirSync(sourceAssets).sort();
    check(
      sortedEqual(frozenSourceNames, [...expectedIds].sort()),
      "source asset directory does not match attached ids",
    );

    const target = {
      source: "a".repeat(64),
      id: 1,
      operationId: "benchmark",
      kind: "conflict",
      createdAt: 1,
      checkpointHash: frozenHash,
    };
    const snapshot: ArchiveSnapshot = { target, checkpoint };

    let targetChecks = 0;
    const assertTarget = (): void => {
      targetChecks++;
      check(
        canonicalJson(checkpoint, MAX_CHECKPOINT_BYTES) === frozenJson &&
          hashCheckpoint(checkpoint) === frozenHash,
        "frozen checkpoint changed during recovery",
      );
    };
    const admitBytes = (bytes: number): void => {
      check(Number.isSafeInteger(bytes) && bytes > 0, "invalid admission request");
      const free = availableBytes(root);
      check(
        free - bytes >= SAFETY_FREE_BYTES,
        "recovery admission would fill the disk",
      );
    };

    const exportStart = nowMs();
    const exported = exportRecoveryArchive(
      snapshot,
      sourceDirectory,
      bundleDirectory,
      "complete-bundle",
      { assertTarget, admitBytes },
    );
    const exportMs = nowMs() - exportStart;
    check(targetChecks === 2, "export did not check the frozen target twice");
    check(exported.kind === "complete-bundle", "export did not create a complete bundle");
    check(exported.checkpointHash === frozenHash, "export changed the checkpoint hash");
    check(typeof exported.fingerprint === "string", "export did not report a fingerprint");
    check(
      !existsSync(join(bundleDirectory, RECOVERY_INCOMPLETE)),
      "export left the incomplete marker",
    );

    const verifyStart = nowMs();
    const verified = verifyRecoveryBundle(bundleDirectory);
    const verifyMs = nowMs() - verifyStart;
    check(
      verified.fingerprint === exported.fingerprint,
      "verified fingerprint differs from export",
    );
    check(
      canonicalJson(verified.manifest.archive) === canonicalJson(target),
      "verified archive target differs from the snapshot",
    );
    check(
      canonicalJson(verified.checkpoint, MAX_CHECKPOINT_BYTES) === frozenJson &&
        hashCheckpoint(verified.checkpoint) === frozenHash,
      "verified checkpoint differs from the frozen checkpoint",
    );
    check(
      verified.manifest.assets.length === FILE_COUNT,
      "verified manifest asset count is wrong",
    );
    const verifiedAssets = new Map(
      verified.manifest.assets.map((asset) => [asset.id, asset]),
    );
    let exportedBytes = 0;
    for (const asset of expected) {
      const present = verifiedAssets.get(asset.id);
      check(
        present !== undefined &&
          present.bytes === asset.bytes &&
          present.sha256 === asset.sha256,
        "verified manifest asset does not match the source",
      );
      exportedBytes += present.bytes;
    }
    check(exportedBytes === EXACT_TOTAL_BYTES, "exported bytes do not total the exact target");

    const restoreStart = nowMs();
    const restored = restoreRecoveryBundle(verified, restoredDirectory, {
      admitBytes,
    });
    const restoreMs = nowMs() - restoreStart;
    check(restored.directory === restoredDirectory, "restore used a different directory");
    check(restored.checkpointHash === frozenHash, "restore changed the checkpoint hash");
    check(typeof restored.recoveryId === "string", "restore did not report a recovery id");
    check(
      !existsSync(join(restoredDirectory, RECOVERY_INCOMPLETE)),
      "restore left the incomplete marker",
    );

    const inspectedId = inspectRecoveredContent(restoredDirectory, frozenHash);
    check(inspectedId === restored.recoveryId, "restored content inspection id mismatch");

    const restoredDbPath = join(restoredDirectory, "workspace.sqlite");
    const restoredDbIdentity = identity(restoredDbPath);
    check(
      restoredDbIdentity.dev !== sourceDbIdentity.dev ||
        restoredDbIdentity.ino !== sourceDbIdentity.ino,
      "restored database reused the source inode",
    );

    originStore = new Store(restoredDbPath, { readOnly: true });
    check(
      readRecoveryOrigin(originStore.db) === "recovered",
      "recovery origin was not readable as recovered",
    );
    let syncHeld = false;
    try {
      assertRecoverySyncAllowed(originStore.db);
    } catch (error) {
      if ((error as { code?: string }).code === "recovered-workspace-sync-held") {
        syncHeld = true;
      } else {
        throw error;
      }
    }
    check(syncHeld, "recovered workspace did not hold sync");
    const originRow = originStore.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(RECOVERY_ORIGIN_KEY) as { value: string } | undefined;
    check(originRow !== undefined, "recovery origin row is missing");
    const originRecord = JSON.parse(String(originRow.value)) as {
      sync?: string;
      recoveryId?: string;
      checkpointHash?: string;
    };
    check(
      originRecord.sync === "held" &&
        originRecord.recoveryId === restored.recoveryId &&
        originRecord.checkpointHash === frozenHash,
      "recovery origin is not permanently held",
    );
    originStore.close();
    originStore = undefined;

    originStore = new Store(restoredDbPath, { readOnly: true });
    check(
      readRecoveryOrigin(originStore.db) === "recovered",
      "recovery origin did not survive a reopen",
    );
    check(
      !existsSync(join(restoredDirectory, RECOVERY_INCOMPLETE)),
      "restored incomplete marker reappeared after reopen",
    );
    originStore.close();
    originStore = undefined;

    const restoredAssetsDirectory = join(restoredDirectory, "assets");
    const restoredNames = readdirSync(restoredAssetsDirectory).sort();
    check(
      sortedEqual(restoredNames, [...expectedIds].sort()),
      "restored asset set does not match the source set",
    );
    let sourceBytes = 0;
    let restoredBytes = 0;
    for (const asset of expected) {
      const sourceNow = identity(asset.sourcePath);
      check(sameIdentity(sourceNow, asset.sourceIdentity), "source attachment changed");
      const sourceNowHash = hashStreaming(asset.sourcePath);
      check(
        sourceNowHash.bytes === asset.bytes &&
          sourceNowHash.sha256 === asset.sha256,
        "source attachment bytes changed",
      );
      sourceBytes += sourceNowHash.bytes;

      const restoredPath = join(restoredAssetsDirectory, asset.id);
      const restoredNow = identity(restoredPath);
      check(
        restoredNow.size === BigInt(asset.bytes),
        "restored attachment size is wrong",
      );
      check(
        restoredNow.dev !== asset.sourceIdentity.dev ||
          restoredNow.ino !== asset.sourceIdentity.ino,
        "restored attachment reused the source inode",
      );
      const restoredNowHash = hashStreaming(restoredPath);
      check(
        restoredNowHash.bytes === asset.bytes &&
          restoredNowHash.sha256 === asset.sha256,
        "restored attachment bytes or hash are wrong",
      );
      restoredBytes += restoredNowHash.bytes;
    }
    check(sourceBytes === EXACT_TOTAL_BYTES, "source bytes do not total the exact target");
    check(restoredBytes === EXACT_TOTAL_BYTES, "restored bytes do not total the exact target");

    check(
      sameIdentity(identity(sourceDbPath), sourceDbIdentity),
      "source database metadata changed",
    );
    const sourceDbNow = hashStreaming(sourceDbPath);
    check(
      sourceDbNow.bytes === sourceDbHash.bytes &&
        sourceDbNow.sha256 === sourceDbHash.sha256,
      "source database bytes changed",
    );
    check(
      sortedEqual(readdirSync(sourceAssets).sort(), frozenSourceNames),
      "source asset directory changed",
    );

    const freeBytesAfter = availableBytes(root);
    // Node reports process.resourceUsage().maxRSS in KiB on both platforms.
    const maxRssBytes = process.resourceUsage().maxRSS * 1024;

    const budgetFailures: string[] = [];
    if (exportMs > EXPORT_BUDGET_MS) budgetFailures.push("export");
    if (verifyMs > VERIFY_BUDGET_MS) budgetFailures.push("verify");
    if (restoreMs > RESTORE_BUDGET_MS) budgetFailures.push("restore");
    if (maxRssBytes > MAX_RSS_BYTES) budgetFailures.push("maxRss");
    if (freeBytesAfter < SAFETY_FREE_BYTES) budgetFailures.push("freeSpace");

    const metrics = {
      counts: {
        sourceFiles: FILE_COUNT,
        attachedAssets: expected.length,
        expectedAssets: checkpoint.assets.length,
        exportedAssets: verified.manifest.assets.length,
        restoredAssets: restoredNames.length,
        sourceFilesVerified: expected.length,
        restoredFilesVerified: expected.length,
      },
      exactBytes: EXACT_TOTAL_BYTES,
      sourceBytes,
      exportedBytes,
      restoredBytes,
      checkpointBytes,
      durations: {
        exportMs: roundMs(exportMs),
        verifyMs: roundMs(verifyMs),
        restoreMs: roundMs(restoreMs),
        totalMs: roundMs(exportMs + verifyMs + restoreMs),
      },
      budgets: {
        exportMs: EXPORT_BUDGET_MS,
        verifyMs: VERIFY_BUDGET_MS,
        restoreMs: RESTORE_BUDGET_MS,
        maxRssBytes: MAX_RSS_BYTES,
      },
      maxRssBytes,
      freeBytesBefore,
      freeBytesAfter,
      booleans: {
        diskPrecheck: true,
        checkpointWithinOneMiB: true,
        checkpointFrozen: true,
        checkpointValid: true,
        exportedManifestMatches: true,
        allSourceBytesVerified: true,
        allRestoredBytesVerified: true,
        allHashesVerified: true,
        newInodes: true,
        sourceDatabaseUnchanged: true,
        sourceAssetsUnchanged: true,
        restoredMarkerAbsent: true,
        recoveryOriginHeld: true,
        syncHeld: true,
        restoreInspectionMatched: true,
        budgetsMet: budgetFailures.length === 0,
      },
    };
    console.log("M3_RECOVERY_METRICS " + JSON.stringify(metrics));
    if (budgetFailures.length > 0) {
      throw new Error(
        "M3 recovery budget exceeded: " + budgetFailures.join(","),
      );
    }
  } finally {
    if (originStore !== undefined) {
      try {
        originStore.close();
      } catch {}
    }
    if (sourceStore !== undefined) {
      try {
        sourceStore.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}

main();
