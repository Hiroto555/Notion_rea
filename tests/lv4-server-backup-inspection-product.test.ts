import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { inspectCheckpointServerBackup } from "../src/sync/server-backup-inspection";

function files(directory: string) {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name), s = lstatSync(path);
    return {name, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, nlink: s.nlink,
      hash: createHash("sha256").update(readFileSync(path)).digest("hex")};
  });
}

it("inspects a genuine catalog with special path characters without modifying its files", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-backup-inspect-"));
  let server: Awaited<ReturnType<typeof startCheckpointServer>> | undefined;
  try {
    const parent = join(root, "確認 #?% space"); mkdirSync(parent);
    server = await startCheckpointServer({databasePath: join(root, "server.sqlite"),
      capabilities: [{workspaceId: "workspace_1", ownerId: "owner-1", token: "A".repeat(43)}],
      validateCheckpoint: () => true});
    const destination = join(parent, "snapshot");
    const backup = server.backup(destination);
    const before = files(destination);
    const inspected = inspectCheckpointServerBackup(destination);
    expect(inspected.serverEpoch).toBe(backup.manifest.serverEpoch);
    expect(inspected.attachments.included).toBe(false);
    expect(inspected.coverage).toEqual({scope: "manifest-and-catalog-summary",
      historyAndReceipts: "not-validated", restore: "not-validated", concurrentWriters: "not-excluded"});
    expect(inspected.workspaces[0].workspaceId).toBe("workspace_1");
    expect(files(destination)).toEqual(before);
    expect(() => inspectCheckpointServerBackup(destination, {maxDatabaseBytes: 1}))
      .toThrow("server-backup-inspection-too-large");
    expect(() => inspectCheckpointServerBackup(destination, {maxDatabaseBytes: 0}))
      .toThrow("invalid-backup-options");
    expect(files(destination)).toEqual(before);
  } finally {if (server) await server.close(); rmSync(root, {recursive: true, force: true});}
});

it("does not claim restore readiness when summary checks cannot detect a missing catalog table", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-backup-inspect-limits-"));
  let server: Awaited<ReturnType<typeof startCheckpointServer>> | undefined;
  try {
    server = await startCheckpointServer({databasePath: join(root, "server.sqlite"),
      capabilities: [{workspaceId: "workspace", ownerId: "owner", token: "A".repeat(43)}],
      validateCheckpoint: () => true});
    const destination = join(root, "snapshot"); server.backup(destination);
    const databasePath = join(destination, "server.sqlite"), manifestPath = join(destination, "manifest.json");
    const db = new DatabaseSync(databasePath);
    try {db.exec("DROP TABLE checkpoint_device_workspaces");} finally {db.close();}
    const database = readFileSync(databasePath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.database.bytes = database.length;
    manifest.database.sha256 = createHash("sha256").update(database).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = files(destination);
    const inspected = inspectCheckpointServerBackup(destination);
    expect(inspected.coverage.restore).toBe("not-validated");
    expect(inspected.coverage.historyAndReceipts).toBe("not-validated");
    expect(files(destination)).toEqual(before);
  } finally {if (server) await server.close(); rmSync(root, {recursive: true, force: true});}
});

it("rejects a WAL-mode header without creating sidecars or changing the input", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-backup-inspect-wal-"));
  let server: Awaited<ReturnType<typeof startCheckpointServer>> | undefined;
  try {
    server = await startCheckpointServer({databasePath: join(root, "server.sqlite"),
      capabilities: [{workspaceId: "workspace", ownerId: "owner", token: "A".repeat(43)}],
      validateCheckpoint: () => true});
    const destination = join(root, "snapshot"); server.backup(destination);
    const databasePath = join(destination, "server.sqlite"), manifestPath = join(destination, "manifest.json");
    const database = readFileSync(databasePath); database[18] = 2; database[19] = 2;
    writeFileSync(databasePath, database);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.database.sha256 = createHash("sha256").update(database).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = files(destination);
    expect(() => inspectCheckpointServerBackup(destination)).toThrow();
    expect(files(destination)).toEqual(before);
  } finally {if (server) await server.close(); rmSync(root, {recursive: true, force: true});}
});
