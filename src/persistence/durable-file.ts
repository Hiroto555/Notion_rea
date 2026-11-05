import {
  closeSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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
  durableFs.syncPath(path);
}

/**
 * Create a new file exclusively, flush its bytes, and close it safely. When
 * requested, the containing directory is flushed too, so the new name is
 * durable before the caller records a reference to it.
 *
 * Any failure after the exclusive create removes the file this call created.
 * Cleanup never replaces the original error, and an existing file is never
 * removed because a failed exclusive create reports that nothing was created.
 */
export function writeNewFileDurably(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  options: { mode?: number; syncParentDirectory?: boolean } = {},
): void {
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
