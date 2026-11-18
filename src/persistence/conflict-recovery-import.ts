import { assertOutsideFolioData } from "./output-path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { hashCheckpoint, requireCondition } from "../sync/protocol";
import type { RecoveredWorkspace, VerifiedRecoveryBundle } from "../shared/conflict-recovery";
import { RECOVERY_INCOMPLETE } from "../shared/conflict-recovery";
import { copyRecoveryAsset } from "./conflict-recovery-assets";
import { verifyRecoveryBundle } from "./conflict-recovery-verify";
import { initializeRecoveredContent, inspectRecoveredContent } from "./recovered-content";
import {
  createRecoveryDirectory,
  readRecoveryFile,
  syncRecoveryDirectory,
  writeRecoveryFile,
  type RecoveryFault,
} from "./recovery-io";
import { Store } from "./store";
import { privatePersistencePort, type NativePrivateSqliteLease, type NativePrivateFile } from "../platform/private-persistence";

// Deliberately retained cleanup owners on UNKNOWN; no retry/release API.
// The durable incomplete marker/checkpoint remain the recovery authority.
const retainedConflictOwners: { store?: Store; lease: NativePrivateSqliteLease; failure?: unknown }[] = [];
function assertConflictDatabase(expected: NativePrivateFile, actual: NativePrivateFile): void {
  requireCondition(expected.path === actual.path &&
    expected.fileId.toLowerCase() === actual.fileId.toLowerCase() &&
    expected.volumeId.toLowerCase() === actual.volumeId.toLowerCase(), "recovery-database-identity-changed");
}

const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const BUDGET_SLACK_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_FILE = "checkpoint.json";
const ASSETS_DIRECTORY = "assets";

function contains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep);
}

function assertFreshDestination(source: string, destination: string): string {
  requireCondition(isAbsolute(destination), "invalid-recovery-destination");
  const target = resolve(destination);
  requireCondition(target === destination, "invalid-recovery-destination");
  const parent = dirname(target);
  const canonicalParent = realpathSync(parent);
  requireCondition(canonicalParent === parent, "unsafe-recovery-destination");
  const canonicalTarget = join(canonicalParent, basename(target));
  requireCondition(!contains(source, canonicalTarget), "recovery-destination-inside-source");
  requireCondition(!existsSync(canonicalTarget), "recovery-destination-exists");
  return canonicalTarget;
}

function recoveryBudget(verified: VerifiedRecoveryBundle): number {
  let payload = verified.manifest.checkpoint.bytes;
  for (const asset of verified.manifest.assets) payload += asset.bytes;
  requireCondition(Number.isSafeInteger(payload) && payload >= 0, "invalid-recovery-budget");
  const multiplied = payload * 4;
  requireCondition(Number.isSafeInteger(multiplied), "invalid-recovery-budget");
  const required = multiplied + BUDGET_SLACK_BYTES;
  requireCondition(Number.isSafeInteger(required), "invalid-recovery-budget");
  return required;
}

export function restoreRecoveryBundle(
  verified: VerifiedRecoveryBundle,
  destination: string,
  options: { admitBytes: (bytes: number) => void; fault?: RecoveryFault },
): RecoveredWorkspace {
  const native = privatePersistencePort();
  requireCondition(!native || !!native.acquireSqliteLease, "native-sqlite-lease-required", 503);
  const expectedFingerprint=verified.fingerprint;
  const candidate = verifyRecoveryBundle(verified.directory);
  requireCondition(candidate.fingerprint === expectedFingerprint, "recovery-source-changed");
  const checkpointHash = hashCheckpoint(candidate.checkpoint);
  requireCondition(
    checkpointHash === candidate.manifest.archive.checkpointHash,
    "recovery-checkpoint-mismatch",
  );

  const target = assertFreshDestination(candidate.directory, destination);
  assertOutsideFolioData(dirname(target));
  options.admitBytes(recoveryBudget(candidate));
  requireCondition(verifyRecoveryBundle(candidate.directory).fingerprint === expectedFingerprint,
    "recovery-source-changed");
  assertFreshDestination(candidate.directory, destination);

  const recoveryId = randomUUID();
  createRecoveryDirectory(target);
  const assetsDirectory = join(target, ASSETS_DIRECTORY);
  createRecoveryDirectory(assetsDirectory);
  const incomplete = writeRecoveryFile(target, RECOVERY_INCOMPLETE, Buffer.alloc(0), options.fault);
  const checkpointBytes = readRecoveryFile(
    candidate.directory,
    CHECKPOINT_FILE,
    MAX_CHECKPOINT_BYTES,
  );
  requireCondition(checkpointBytes.length === candidate.manifest.checkpoint.bytes &&
    createHash("sha256").update(checkpointBytes).digest("hex") === candidate.manifest.checkpoint.sha256,
  "recovery-checkpoint-mismatch");
  writeRecoveryFile(target, CHECKPOINT_FILE, checkpointBytes, options.fault);
  for (const asset of candidate.manifest.assets) {
    copyRecoveryAsset(candidate.directory, target, asset, { fault: options.fault });
  }

  const databasePath = join(target, "workspace.sqlite");
  let lease: NativePrivateSqliteLease | undefined;
  let store: Store | undefined;
  let originalDatabase: NativePrivateFile | undefined;
  let constructorAttempted = false, closeAttempted = false;
  const errors: unknown[] = [];
  try {
    if (native) {
      originalDatabase = native.writeNew(databasePath, new Uint8Array(), 0).identity;
      lease = native.acquireSqliteLease!(databasePath, originalDatabase);
      lease.assertHeld();
    }
    constructorAttempted = true;
    store = new Store(databasePath, { allowIncompleteRecovery: true,
      ...(native ? { nativePrivateFilesystem: native, nativeLease: lease } : {}) });
    lease?.assertHeld();
    initializeRecoveredContent(store, candidate.checkpoint, recoveryId);
    lease?.assertHeld();
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    requireCondition(store.db.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok",
      "recovery-content-mismatch");
    closeAttempted = true;
    store.close();
    store = undefined; lease = undefined;
  } catch (error) { errors.push(error);
  } finally {
    if (store && !closeAttempted) {
      closeAttempted = true;
      try { store.close(); store = undefined; lease = undefined; } catch (error) { errors.push(error); }
    }
    if (lease && !constructorAttempted) {
      try { lease.close(); lease = undefined; } catch (error) { errors.push(error); }
    }
    if (native && lease) retainedConflictOwners.push({ store, lease, failure: errors[0] });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "recovery SQLite lifetime UNKNOWN");
  if (native) {
    // inspectRecoveredContent owns an internal Store. Only a successful return
    // proves its finally-close returned; any thrown outcome retains this lease.
    const inspectionLease = native.acquireSqliteLease!(databasePath, originalDatabase!);
    try {
      inspectionLease.assertHeld();
      requireCondition(inspectRecoveredContent(target, checkpointHash, true) === recoveryId, "recovery-id-mismatch");
      inspectionLease.assertHeld();
      options.fault?.("before-complete");
      inspectionLease.assertHeld();
      requireCondition(verifyRecoveryBundle(candidate.directory).fingerprint === expectedFingerprint,
        "recovery-source-changed");
      requireCondition(inspectRecoveredContent(target, checkpointHash, true) === recoveryId, "recovery-id-mismatch");
      inspectionLease.assertHeld();
      inspectionLease.close();
    } catch (error) {
      retainedConflictOwners.push({ lease: inspectionLease, failure: error });
      throw error;
    }
    const file = native.inspectFile(databasePath, 256 * 1024 * 1024);
    assertConflictDatabase(originalDatabase!, file);
    native.proveSync(databasePath, file);
  } else {
    requireCondition(inspectRecoveredContent(target, checkpointHash, true) === recoveryId, "recovery-id-mismatch");
  }

  const sourceAgain = verifyRecoveryBundle(candidate.directory);
  requireCondition(sourceAgain.fingerprint === expectedFingerprint, "recovery-source-changed");
  requireCondition(
    hashCheckpoint(sourceAgain.checkpoint) === checkpointHash,
    "recovery-checkpoint-mismatch",
  );

  if (!native) options.fault?.("before-complete");
  requireCondition(verifyRecoveryBundle(candidate.directory).fingerprint === expectedFingerprint,
    "recovery-source-changed");
  if (native) {
    requireCondition(!!incomplete, "recovery-marker-identity-required");
    native.unlinkExact(join(target, RECOVERY_INCOMPLETE), incomplete, 0);
    options.fault?.("after-complete");
    return { directory: target, checkpointHash, recoveryId };
  }
  unlinkSync(join(target, RECOVERY_INCOMPLETE));
  options.fault?.("before-complete-sync");
  syncRecoveryDirectory(target);
  options.fault?.("after-complete");

  return { directory: target, checkpointHash, recoveryId };
}
