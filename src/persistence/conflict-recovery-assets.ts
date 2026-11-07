import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { AssetManifest } from "../sync/protocol";
import { requireCondition } from "../sync/protocol";
import { recoveryPath, syncRecoveryDirectory, withRecoveryRead, type RecoveryFault } from "./recovery-io";

const MAX_RECOVERY_ASSET_BYTES = 20_000_000;
const CHUNK_BYTES = 65_536;

function assertAsset(asset: AssetManifest): void {
  requireCondition(asset !== null && typeof asset === "object" && !Array.isArray(asset), "invalid-recovery-asset");
  requireCondition(typeof asset.id === "string" && asset.id.length > 0 && asset.id.length <= 200 &&
    asset.id !== "." && asset.id !== ".." && !asset.id.includes("/") && !asset.id.includes("\\") &&
    !asset.id.includes("\0"), "unsafe-recovery-asset-id");
  requireCondition(typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/.test(asset.sha256), "invalid-recovery-asset-hash");
  requireCondition(Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.bytes <= MAX_RECOVERY_ASSET_BYTES,
    "invalid-recovery-asset-bytes");
}

function sameIdentity(before: ReturnType<typeof fstatSync>, after: ReturnType<typeof fstatSync>): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.isFile() && after.nlink === 1;
}

function verifyNewOutput(path: string, asset: AssetManifest): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    requireCondition(before.isFile() && before.nlink === 1 && before.size === asset.bytes, "invalid-recovery-output");
    const hash = createHash("sha256"), buffer = Buffer.alloc(CHUNK_BYTES);
    let offset = 0;
    while (offset < asset.bytes) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, asset.bytes - offset), offset);
      requireCondition(n > 0, "recovery-output-truncated");
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    requireCondition(offset === asset.bytes && hash.digest("hex") === asset.sha256, "recovery-output-hash-mismatch");
    const after = fstatSync(fd);
    requireCondition(sameIdentity(before, after), "recovery-output-changed");
    const link = lstatSync(path);
    requireCondition(link.dev === after.dev && link.ino === after.ino && link.isFile() && link.nlink === 1,
      "recovery-output-changed");
  } finally { closeSync(fd); }
}

export function copyRecoveryAsset(
  sourceRoot: string,
  destinationRoot: string,
  asset: AssetManifest,
  options: { sourcePrefix?: string; destinationPrefix?: string; fault?: RecoveryFault } = {},
): void {
  assertAsset(asset);
  const sourceRelative = `${options.sourcePrefix ?? "assets"}/${asset.id}`;
  const destinationRelative = `${options.destinationPrefix ?? "assets"}/${asset.id}`;
  withRecoveryRead(sourceRoot, sourceRelative, MAX_RECOVERY_ASSET_BYTES, (fd, stat) => {
    requireCondition(stat.size === asset.bytes, "recovery-asset-size-mismatch");
    const outputPath = recoveryPath(destinationRoot, destinationRelative);
    const output = openSync(outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash("sha256"), buffer = Buffer.alloc(CHUNK_BYTES);
    let offset = 0;
    try {
      while (offset < stat.size) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        requireCondition(n > 0, "recovery-asset-truncated");
        hash.update(buffer.subarray(0, n));
        let written = 0;
        while (written < n) {
          const m = writeSync(output, buffer, written, n - written);
          requireCondition(m > 0, "recovery-asset-write-incomplete");
          written += m;
        }
        offset += n;
      }
      options.fault?.("before-file-sync");
      fsyncSync(output);
      options.fault?.("after-file-sync");
    } finally { closeSync(output); }
    requireCondition(offset === asset.bytes, "recovery-asset-size-mismatch");
    requireCondition(hash.digest("hex") === asset.sha256, "recovery-asset-hash-mismatch");
  });
  verifyNewOutput(recoveryPath(destinationRoot, destinationRelative), asset);
  options.fault?.("before-directory-sync");
  syncRecoveryDirectory(dirname(recoveryPath(destinationRoot, destinationRelative)));
  options.fault?.("after-directory-sync");
}
