import { validateWorkspaceCheckpoint } from "../sync/workspace-checkpoint";
import { archiveTargetSchema } from "../shared/conflict-recovery";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  RECOVERY_INCOMPLETE,
  type RecoveryExportResult,
  type RecoveryManifest,
  type ArchiveSnapshot,
} from "../shared/conflict-recovery";
import {
  MAX_CHECKPOINT_BYTES,
  canonicalJson,
  hashCheckpoint,
  parseCheckpoint,
  requireCondition,
} from "../sync/protocol";
import { assertOutsideFolioData } from "./output-path";
import { copyRecoveryAsset } from "./conflict-recovery-assets";
import { validateRecoveryManifest, verifyRecoveryBundle } from "./conflict-recovery-verify";
import {
  assertRecoveryDirectory,
  createRecoveryDirectory,
  recoveryPath,
  syncRecoveryDirectory,
  writeRecoveryFile,
  type RecoveryFault,
} from "./recovery-io";

const MANIFEST_FILE = "manifest.json";
const CHECKPOINT_FILE = "checkpoint.json";
const ASSETS_DIRECTORY = "assets";
const DESCRIPTION_FILE = "README.txt";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const CAPACITY_MULTIPLIER = 4;
const CAPACITY_MARGIN = 64 * 1024 * 1024;

const INCOMPLETE_CONTENT = `${RECOVERY_INCOMPLETE}\n`;
const DESCRIPTION_CONTENT = [
  "Folio conflict recovery metadata",
  "",
  "This directory is metadata only and is not a restorable bundle.",
  "checkpoint.json contains the conflict archive checkpoint for inspection.",
  "Attachments are not included; do not restore this directory as a workspace.",
  "",
].join("\n");

export type RecoveryExportOptions = {
  assertTarget: () => void;
  admitBytes: (bytes: number) => void;
  fault?: RecoveryFault;
};

/** Resolve the destination through its existing ancestors without creating it.
 * A destination that exists is resolved as-is so the fresh-directory check can
 * report the conflict instead of silently reusing it. */
function actualPath(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(actualPath(parent), basename(absolute));
  }
  return realpathSync(absolute);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function capacityBytes(known: number): number {
  const reserved = known * CAPACITY_MULTIPLIER + CAPACITY_MARGIN;
  requireCondition(Number.isSafeInteger(reserved) && reserved >= 0, "invalid-recovery-capacity");
  return reserved;
}

function publish(directory: string, marker: string, fault?: RecoveryFault): void {
  fault?.("before-complete");
  unlinkSync(marker);
  fault?.("before-complete-sync");
  syncRecoveryDirectory(directory);
  fault?.("after-complete-sync");
  fault?.("after-complete");
}

export function exportRecoveryArchive(
  snapshot: ArchiveSnapshot,
  sourceDirectory: string,
  destination: string,
  mode: "metadata-only" | "complete-bundle",
  options: RecoveryExportOptions,
): RecoveryExportResult {
  requireCondition(mode === "metadata-only" || mode === "complete-bundle", "invalid-recovery-export-mode");

  // Freeze the snapshot input before touching the filesystem.
  const checkpointBytes = canonicalJson(snapshot.checkpoint, MAX_CHECKPOINT_BYTES);
  const checkpoint = parseCheckpoint(JSON.parse(checkpointBytes));
  const checkpointHash = hashCheckpoint(checkpoint);
  const target = archiveTargetSchema.parse(snapshot.target);
  requireCondition(validateWorkspaceCheckpoint(checkpoint),"invalid-recovery-checkpoint");
  requireCondition(checkpointHash === target.checkpointHash, "recovery-snapshot-target-mismatch");

  const source = assertRecoveryDirectory(sourceDirectory);
  const output = actualPath(destination);
  requireCondition(!inside(source, output), "recovery-destination-inside-source");

  const assets = checkpoint.assets.map((asset) => ({
    id: asset.id,
    sha256: asset.sha256,
    bytes: asset.bytes,
  }));
  const manifest: RecoveryManifest = {
    format: "folio-conflict-recovery",
    version: 1,
    archive: target,
    checkpoint: { file: CHECKPOINT_FILE, bytes: Buffer.byteLength(checkpointBytes), sha256: checkpointHash },
    assets: assets.map((asset) => ({ ...asset, file: `${ASSETS_DIRECTORY}/${asset.id}` })),
  };
  const manifestBytes = mode === "complete-bundle"
    ? canonicalJson(validateRecoveryManifest(manifest), MAX_MANIFEST_BYTES)
    : null;
  const knownBytes = Buffer.byteLength(checkpointBytes) +
    (manifestBytes === null ? Buffer.byteLength(DESCRIPTION_CONTENT) : Buffer.byteLength(manifestBytes)) +
    (mode === "complete-bundle" ? assets.reduce((total, asset) => total + asset.bytes, 0) : 0);

  options.assertTarget();
  options.admitBytes(capacityBytes(knownBytes));

  const parent = assertRecoveryDirectory(dirname(output));
  assertOutsideFolioData(parent);
  const directory = createRecoveryDirectory(output);
  const marker = recoveryPath(directory, RECOVERY_INCOMPLETE);

  writeRecoveryFile(directory, RECOVERY_INCOMPLETE, INCOMPLETE_CONTENT, options.fault);
  writeRecoveryFile(directory, CHECKPOINT_FILE, checkpointBytes, options.fault);
  if (mode === "metadata-only") {
    writeRecoveryFile(directory, DESCRIPTION_FILE, DESCRIPTION_CONTENT, options.fault);
    options.assertTarget();
    publish(directory, marker, options.fault);
    return { kind: "metadata-only", directory, checkpointHash };
  }

  writeRecoveryFile(directory, MANIFEST_FILE, manifestBytes!, options.fault);
  if (assets.length > 0) {
    createRecoveryDirectory(join(directory, ASSETS_DIRECTORY));
    for (const asset of assets) {
      copyRecoveryAsset(source, directory, asset, { fault: options.fault });
    }
  }

  const verified = verifyRecoveryBundle(directory, { allowIncomplete: true });
  options.assertTarget();
  publish(directory, marker, options.fault);
  return {
    kind: "complete-bundle",
    directory,
    checkpointHash,
    fingerprint: verified.fingerprint,
  };
}
