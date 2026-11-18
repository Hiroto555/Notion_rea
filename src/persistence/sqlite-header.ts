import { openSync, readSync, closeSync } from "node:fs";
/** A coarse rejection check before SQLite can create WAL/shm sidecars even on a
 * read-only open. Never authorizes a writable open: WAL-aware SQL validation
 * must still follow. Empty legacy private files have no header. */
export function sqliteHeader(
  path: string,
): { version: number; applicationId: number } | undefined {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100),
      bytes = readSync(fd, header, 0, 100, 0);
    if (bytes === 0) return undefined;
    if (
      bytes !== 100 ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    )
      throw new Error("Invalid workspace SQLite header");
    return {
      version: header.readUInt32BE(60),
      applicationId: header.readUInt32BE(68),
    };
  } finally {
    closeSync(fd);
  }
}
