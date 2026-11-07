import { assertOutsideFolioData } from "./output-path";
import { randomUUID } from "node:crypto";
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

  const recoveryId = randomUUID();
  createRecoveryDirectory(target);
  const assetsDirectory = join(target, ASSETS_DIRECTORY);
  createRecoveryDirectory(assetsDirectory);
  writeRecoveryFile(target, RECOVERY_INCOMPLETE, Buffer.alloc(0), options.fault);
  const checkpointBytes = readRecoveryFile(
    candidate.directory,
    CHECKPOINT_FILE,
    MAX_CHECKPOINT_BYTES,
  );
  writeRecoveryFile(target, CHECKPOINT_FILE, checkpointBytes, options.fault);
  for (const asset of candidate.manifest.assets) {
    copyRecoveryAsset(candidate.directory, target, asset, { fault: options.fault });
  }

  const store = new Store(join(target, "workspace.sqlite"), { allowIncompleteRecovery: true });
  try {
    initializeRecoveredContent(store, candidate.checkpoint, recoveryId);
  } finally {
    store.close();
  }

  const inspectedId = inspectRecoveredContent(target, checkpointHash, true);
  requireCondition(inspectedId === recoveryId, "recovery-id-mismatch");

  const sourceAgain = verifyRecoveryBundle(candidate.directory);
  requireCondition(sourceAgain.fingerprint === expectedFingerprint, "recovery-source-changed");
  requireCondition(
    hashCheckpoint(sourceAgain.checkpoint) === checkpointHash,
    "recovery-checkpoint-mismatch",
  );

  options.fault?.("before-complete");
  unlinkSync(join(target, RECOVERY_INCOMPLETE));
  options.fault?.("before-complete-sync");
  syncRecoveryDirectory(target);
  options.fault?.("after-complete");

  return { directory: target, checkpointHash, recoveryId };
}
