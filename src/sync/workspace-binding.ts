import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeNewFileDurably } from "../persistence/durable-file";
import { identifier, requireCondition } from "./protocol";

export type WorkspaceDevice = {
  workspaceId: string;
  clientId: string;
  bindingId: string;
};

/** A full backup copies SQLite and assets. The live database file identity
 * and this sidecar must match before a host may use the sync queue. */
export function verifyWorkspaceBinding(
  databasePath: string,
  device: WorkspaceDevice,
  create: boolean,
): void {
  const database = realpathSync(databasePath);
  const stat = lstatSync(database, { bigint: true });
  requireCondition(
    stat.isFile() && stat.nlink === 1n,
    "unsafe-workspace-database",
    409,
  );
  const binding = JSON.stringify({
    workspaceId: identifier(device.workspaceId),
    clientId: identifier(device.clientId),
    bindingId: identifier(device.bindingId),
    database,
    volume: String(stat.dev),
    inode: String(stat.ino),
  });
  const file = join(dirname(database), ".folio-sync-binding");
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    requireCondition(create, "workspace-binding-missing", 409);
    writeNewFileDurably(file, binding, { syncParentDirectory: true });
    return;
  }
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(binding));
    const info = fstatSync(fd);
    requireCondition(
      info.isFile() && info.nlink === 1 && info.size === bytes.length,
      "workspace-binding-mismatch",
      409,
    );
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, null);
      requireCondition(count > 0, "workspace-binding-mismatch", 409);
      read += count;
    }
    requireCondition(
      bytes.equals(Buffer.from(binding)),
      "workspace-binding-mismatch",
      409,
    );
  } finally {
    closeSync(fd);
  }
}
