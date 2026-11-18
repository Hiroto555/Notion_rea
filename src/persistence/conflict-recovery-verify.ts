import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  RECOVERY_INCOMPLETE,
  RECOVERY_MAX_ASSET_BYTES,
  RECOVERY_MAX_ASSETS,
  archiveTargetSchema,
  type RecoveryManifest,
  type VerifiedRecoveryBundle,
} from "../shared/conflict-recovery";
import { MAX_CHECKPOINT_BYTES, MAX_SYNC_ASSET_BYTES, canonicalJson, hashCheckpoint,
  parseCheckpoint, requireCondition, sha256 } from "../sync/protocol";
import { validateWorkspaceCheckpoint } from "../sync/workspace-checkpoint";
import { assertRecoveryDirectory, hashRecoveryFile, readRecoveryFile } from "./recovery-io";

const MANIFEST_FILE = "manifest.json";
const CHECKPOINT_FILE = "checkpoint.json";
const ASSETS_DIRECTORY = "assets";
const MAX_MANIFEST_BYTES = 1024 * 1024;

const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

const assetSchema = z.object({
  id: z.string().min(1).max(200),
  sha256: digest,
  bytes: integer.max(MAX_SYNC_ASSET_BYTES),
  file: z.string().min(1).max(1000),
}).strict();

const manifestSchema = z.object({
  format: z.literal("folio-conflict-recovery"),
  version: z.literal(1),
  archive: archiveTargetSchema,
  checkpoint: z.object({
    file: z.literal(CHECKPOINT_FILE),
    bytes: integer.max(MAX_CHECKPOINT_BYTES),
    sha256: digest,
  }).strict(),
  assets: z.array(assetSchema).max(RECOVERY_MAX_ASSETS),
}).strict();

function parseJson(bytes: Buffer, code: string): unknown {
  let value: unknown;
  let parsed = true;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    parsed = false;
    value = undefined;
  }
  requireCondition(parsed, code, 422);
  return value;
}

function pathExists(path: string, code: string): boolean {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  requireCondition(!info.isSymbolicLink() && info.isFile() && info.nlink === 1, code, 422);
  return true;
}

export function validateRecoveryManifest(value: unknown): RecoveryManifest {
  const result = manifestSchema.safeParse(value);
  requireCondition(result.success, "invalid-recovery-manifest", 422);
  const manifest = result.data as RecoveryManifest;

  requireCondition(manifest.archive.checkpointHash === manifest.checkpoint.sha256,"recovery-archive-hash-mismatch",422);
  const ids = new Set<string>();
  let total = 0;
  for (const asset of manifest.assets) {
    requireCondition(asset.id !== "." && asset.id !== ".." && !asset.id.includes("/") &&
      !asset.id.includes("\\") && !asset.id.includes("\0"), "invalid-recovery-asset-id", 422);
    requireCondition(asset.file === `${ASSETS_DIRECTORY}/${asset.id}`, "invalid-recovery-asset-file", 422);
    requireCondition(!ids.has(asset.id), "duplicate-recovery-asset-id", 422);
    ids.add(asset.id);
    total += asset.bytes;
    requireCondition(Number.isSafeInteger(total) && total <= RECOVERY_MAX_ASSET_BYTES,
      "recovery-asset-total-too-large", 422);
  }

  canonicalJson(manifest, MAX_MANIFEST_BYTES);
  return manifest;
}

function verifyAssets(directory: string, manifest: RecoveryManifest): void {
  const expected = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const assetsPath = join(directory, ASSETS_DIRECTORY);
  let info;
  try {
    info = lstatSync(assetsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      requireCondition(expected.size === 0, "recovery-assets-missing", 422);
      return;
    }
    throw error;
  }
  requireCondition(!info.isSymbolicLink() && info.isDirectory() &&
    realpathSync(assetsPath) === assetsPath, "unsafe-recovery-assets", 422);

  const names = readdirSync(assetsPath).sort();
  requireCondition(names.length === expected.size, "recovery-assets-mismatch", 422);
  for (const name of names) requireCondition(expected.has(name), "unexpected-recovery-asset", 422);
  for (const asset of manifest.assets) {
    const actual = hashRecoveryFile(directory, asset.file, MAX_SYNC_ASSET_BYTES);
    requireCondition(actual.bytes === asset.bytes && actual.sha256 === asset.sha256,
      "recovery-asset-mismatch", 422);
  }
}

function verifyCheckpoint(directory: string, manifest: RecoveryManifest) {
  const bytes = readRecoveryFile(directory, CHECKPOINT_FILE, MAX_CHECKPOINT_BYTES);
  requireCondition(bytes.length === manifest.checkpoint.bytes, "recovery-checkpoint-bytes", 422);
  const checkpoint = parseCheckpoint(parseJson(bytes, "invalid-recovery-checkpoint-json"));
  requireCondition(validateWorkspaceCheckpoint(checkpoint), "invalid-recovery-checkpoint", 422);
  requireCondition(canonicalJson(checkpoint,MAX_CHECKPOINT_BYTES) === bytes.toString("utf8"),"noncanonical-recovery-checkpoint",422);
  requireCondition(hashCheckpoint(checkpoint) === manifest.checkpoint.sha256,
    "recovery-checkpoint-hash", 422);
  return checkpoint;
}

function verifyCheckpointAssets(checkpoint: ReturnType<typeof parseCheckpoint>,
  manifest: RecoveryManifest): void {
  requireCondition(checkpoint.assets.length === manifest.assets.length,
    "recovery-asset-manifest-mismatch", 422);
  const expected = new Map(checkpoint.assets.map((asset) => [asset.id, asset]));
  for (const asset of manifest.assets) {
    const actual = expected.get(asset.id);
    requireCondition(actual !== undefined && actual.sha256 === asset.sha256 &&
      actual.bytes === asset.bytes, "recovery-asset-manifest-mismatch", 422);
  }
}

export function verifyRecoveryBundle(directory: string,
  options?: { allowIncomplete?: boolean }): VerifiedRecoveryBundle {
  const canonical = assertRecoveryDirectory(directory);
  const marker = pathExists(join(canonical, RECOVERY_INCOMPLETE), "unsafe-recovery-entry");
  requireCondition(options?.allowIncomplete === true || !marker, "recovery-incomplete", 422);

  const allowed = new Set([MANIFEST_FILE, CHECKPOINT_FILE, ASSETS_DIRECTORY]);
  if (marker) allowed.add(RECOVERY_INCOMPLETE);
  for (const name of readdirSync(canonical).sort()) {
    requireCondition(allowed.has(name), "unexpected-recovery-entry", 422);
  }

  const manifestBytes = readRecoveryFile(canonical, MANIFEST_FILE, MAX_MANIFEST_BYTES);
  const manifest = validateRecoveryManifest(parseJson(manifestBytes, "invalid-recovery-manifest-json"));
  const checkpoint = verifyCheckpoint(canonical, manifest);
  verifyCheckpointAssets(checkpoint, manifest);
  verifyAssets(canonical, manifest);

  return {
    directory: canonical,
    manifest,
    checkpoint,
    fingerprint: sha256(canonicalJson(manifest, MAX_MANIFEST_BYTES)),
  };
}
