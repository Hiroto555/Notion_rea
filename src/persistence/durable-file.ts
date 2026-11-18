import {
  closeSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, posix, win32 } from "node:path";
import {
  assertPrivateFilePort,
  PrivateFilePortUnsupportedError,
  publishPrivateFile,
  selectPrivateFilePlatform,
  type PrivateFilePort,
} from "../platform/private-file-port";
import { publishPrivateFileV2, type PrivateFileV2Port } from "../platform/private-file-v2";
import {
  publishPrivateFileV3,
  WINDOWS_RECOVERY_MAX_BYTES,
  type PrivateFileV3Port,
  type WindowsRecoveryPublishReceipt,
} from "../platform/windows/private-recovery-io";
import type { WindowsPrivatePublishV2Receipt } from "../platform/windows/private-publication-v2";

/**
 * The small filesystem seam used by the durability-sensitive writers. Tests can
 * replace individual operations to exercise an fsync or close failure without
 * installing a global node:fs mock. This object is not a general filesystem
 * abstraction: the files and directories being made durable are still chosen by
 * the callers.
 */
export const durableFs = {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  syncPath(path: string): void {
    if (process.platform === "win32")
      throw new PrivateFilePortUnsupportedError("POSIX path fsync is not Windows durability proof");
    const descriptor = durableFs.openSync(path, "r");
    try {
      durableFs.fsyncSync(descriptor);
    } catch (error) {
      try { durableFs.closeSync(descriptor); } catch {}
      throw error;
    }
    durableFs.closeSync(descriptor);
  },
};

export function syncPath(path: string): void {
  if (process.platform === "win32")
    throw new PrivateFilePortUnsupportedError("POSIX path fsync is not Windows durability proof");
  durableFs.syncPath(path);
}

export type WriteNewFileDurablyOptions = {
  mode?: number;
  syncParentDirectory?: boolean;
  privateFilePort?: PrivateFilePort;
  privateFileV2Port?: PrivateFileV2Port;
  privateFileV3Port?: PrivateFileV3Port;
  /** Test seam; production must omit this override. */
  platform?: NodeJS.Platform;
};

/**
 * Create a new file exclusively, flush its bytes, and close it safely. When
 * requested, the containing directory is flushed too, so the new name is
 * durable before the caller records a reference to it.
 *
 * In the legacy POSIX branch, any failure after exclusive create removes the file.
 * Cleanup never replaces the original error, and an existing file is never
 * removed because a failed exclusive create reports that nothing was created.
 * Explicit private ports instead retain staging and all uncertain artifacts;
 * they always require both file and name durability.
 */
export function writeNewFileDurably(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  options: WriteNewFileDurablyOptions = {},
): void | WindowsPrivatePublishV2Receipt | WindowsRecoveryPublishReceipt {
  const platform = selectPrivateFilePlatform(options.platform);
  const explicitPorts =
    (options.privateFilePort !== undefined ? 1 : 0) +
    (options.privateFileV2Port !== undefined ? 1 : 0) +
    (options.privateFileV3Port !== undefined ? 1 : 0);
  if (explicitPorts > 1)
    throw new PrivateFilePortUnsupportedError("Exactly one private file port may be supplied");
  if (options.privateFileV2Port !== undefined || options.privateFileV3Port !== undefined) {
    if (platform !== "win32")
      throw new PrivateFilePortUnsupportedError("Explicit private ports require the Windows publication path");
    if (options.mode !== undefined && options.mode !== 0o600)
      throw new PrivateFilePortUnsupportedError("Private publication requires mode 0600");
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw new PrivateFilePortUnsupportedError("Invalid private file destination");
    const destination = win32.resolve(path);
    const name = win32.basename(destination);
    if (!name || name === "." || name === "..")
      throw new PrivateFilePortUnsupportedError("Invalid private file destination");
    let bytes: Uint8Array;
    if (typeof data === "string") {
      const encoded = Buffer.from(data, "utf8");
      if (encoded.toString("utf8") !== data)
        throw new PrivateFilePortUnsupportedError("Private file is not reversible UTF-8");
      bytes = encoded;
    } else {
      if (!ArrayBuffer.isView(data))
        throw new PrivateFilePortUnsupportedError("Invalid private file bytes");
      bytes = Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    const attemptId = randomUUID().replace(/-/g, "");
    const stagingPath = win32.join(win32.dirname(destination), `.${name}.folio-private-${attemptId}.tmp`);
    if (options.privateFileV3Port !== undefined) {
      if (bytes.byteLength > WINDOWS_RECOVERY_MAX_BYTES)
        throw new PrivateFilePortUnsupportedError("Private v3 file exceeds the recovery payload bound");
      return publishPrivateFileV3(options.privateFileV3Port, {
        path: destination, stagingPath, attemptId, bytes, beforePublish() {},
      });
    }
    return publishPrivateFileV2(options.privateFileV2Port!, {
      path: destination, stagingPath, attemptId, bytes, beforePublish() {},
    });
  }
  if (options.privateFilePort !== undefined || platform === "win32") {
    assertPrivateFilePort(options.privateFilePort, options.platform);
    if (options.mode !== undefined && options.mode !== 0o600)
      throw new PrivateFilePortUnsupportedError("Private publication requires mode 0600");
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw new PrivateFilePortUnsupportedError("Invalid private file destination");
    const paths = platform === "win32" ? win32 : posix;
    const destination = paths.resolve(path);
    const name = paths.basename(destination);
    if (!name || name === "." || name === "..")
      throw new PrivateFilePortUnsupportedError("Invalid private file destination");
    let bytes: Uint8Array;
    if (typeof data === "string") {
      const encoded = Buffer.from(data, "utf8");
      if (encoded.toString("utf8") !== data)
        throw new PrivateFilePortUnsupportedError("Private file is not reversible UTF-8");
      bytes = encoded;
    } else {
      if (!ArrayBuffer.isView(data))
        throw new PrivateFilePortUnsupportedError("Invalid private file bytes");
      bytes = Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    publishPrivateFile(options.privateFilePort, {
      path: destination,
      stagingPath: paths.join(paths.dirname(destination), `.${name}.folio-private-${randomUUID()}.tmp`),
      bytes,
      beforePublish() {},
    }, options.platform);
    return;
  }
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = durableFs.openSync(path, "wx", options.mode ?? 0o600);
    created = true;
    durableFs.writeFileSync(descriptor, data);
    durableFs.fsyncSync(descriptor);
    const openDescriptor = descriptor;
    descriptor = undefined;
    durableFs.closeSync(openDescriptor);
    if (options.syncParentDirectory) durableFs.syncPath(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        durableFs.closeSync(descriptor);
      } catch {
        // A close failure must not hide the write/fsync failure.
      }
    }
    if (created) {
      try {
        durableFs.unlinkSync(path);
      } catch {
        // Leave the original error intact even if cleanup itself fails.
      }
    }
    throw error;
  }
}
