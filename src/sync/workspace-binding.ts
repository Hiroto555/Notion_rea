import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { writeNewFileDurably } from "../persistence/durable-file";
import { identifier, requireCondition } from "./protocol";
import { privatePersistencePort, type PrivatePersistenceOptions } from "../platform/private-persistence";

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
  options?: PrivatePersistenceOptions & { reenroll?: boolean },
): void {
  const native = privatePersistencePort(options);
  if (native) {
    const identity = native.inspectFileIdentity(databasePath);
    const binding = Buffer.from(JSON.stringify({
      version: 2, identityKind: "windows-file-id",
      workspaceId: identifier(device.workspaceId), clientId: identifier(device.clientId),
      bindingId: identifier(device.bindingId), database: identity.path,
      fileId: identity.fileId, volumeId: identity.volumeId,
    }));
    const file = join(dirname(identity.path), ".folio-sync-binding");
    const assertDatabase = () => {
      const now = native.inspectFileIdentity(databasePath);
      requireCondition(now.path === identity.path && now.fileId === identity.fileId &&
        now.volumeId === identity.volumeId, "workspace-binding-database-changed", 409);
    };
    if (existsSync(file)) {
      const old = native.inspectFile(file, 64 * 1024);
      const oldBytes = Buffer.from(native.read(file, old, 64 * 1024));
      if (oldBytes.equals(binding)) { assertDatabase(); return; }
      requireCondition(create && options?.reenroll === true, "workspace-binding-mismatch", 409);
      let prior: Record<string, unknown>;
      try { prior = JSON.parse(oldBytes.toString("utf8")); }
      catch { throw new Error("workspace-binding-foreign"); }
      requireCondition(prior !== null && typeof prior === "object" &&
        prior.version === 2 && prior.identityKind === "windows-file-id" &&
        prior.workspaceId === device.workspaceId &&
        typeof prior.clientId === "string" && typeof prior.bindingId === "string" &&
        typeof prior.database === "string" && typeof prior.fileId === "string" &&
        /^[a-fA-F0-9]{32}$/.test(prior.fileId) && typeof prior.volumeId === "string" &&
        /^[a-fA-F0-9]{16}$/.test(prior.volumeId), "workspace-binding-foreign", 409);
      identifier(prior.clientId); identifier(prior.bindingId);
      assertDatabase();
      // An explicit restored-workspace enrollment retains the exact prior
      // sidecar on a no-replace native rename. UNKNOWN never triggers cleanup.
      native.renameNew(file, `${file}.retained-${randomUUID()}`, old, 64 * 1024);
    } else requireCondition(create, "workspace-binding-missing", 409);
    assertDatabase();
    native.writeNew(file, binding, 64 * 1024);
    assertDatabase();
    return;
  }
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
