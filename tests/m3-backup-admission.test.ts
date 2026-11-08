import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";
import { Store } from "../src/persistence/store";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { SyncError } from "../src/sync/protocol";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

const roots: string[] = [];
const stores: Store[] = [];

function workspace(): { source: string; store: Store } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-backup-admission-"));
  roots.push(root);
  const source = join(root, "workspace");
  const store = new Store(join(source, "workspace.sqlite"));
  stores.push(store);
  return { source, store };
}

function backupEntries(source: string): string[] {
  const root = join(source, "backups");
  return existsSync(root) ? readdirSync(root).sort() : [];
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceBackupService backup admission", () => {
  it("creates an ordinary backup and never widens an existing root", () => {
    const { source, store } = workspace();
    const root = join(source, "backups");
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    const service = new WorkspaceBackupService(store.db, source);
    const first = service.create("first");
    expect(existsSync(first.directory)).toBe(true);
    expect(lstatSync(root).mode & 0o777).toBe(0o755);
    const second = service.create("second");
    expect(existsSync(second.directory)).toBe(true);
    expect(backupEntries(source)).toHaveLength(2);
  });

  it("marks only a fresh backups root private", () => {
    const { source, store } = workspace();
    expect(existsSync(join(source, "backups"))).toBe(false);
    new WorkspaceBackupService(store.db, source).create("manual");
    expect(lstatSync(join(source, "backups")).mode & 0o777).toBe(0o700);
  });

  it("refuses the ninth real generation before creating its directory", () => {
    const { source, store } = workspace();
    const service = new WorkspaceBackupService(store.db, source);
    for (let index = 0; index < 8; index += 1)
      expect(existsSync(service.create(`generation-${index}`).directory)).toBe(true);
    const before = backupEntries(source);
    expect(before).toHaveLength(8);
    expect(() => service.create("ninth")).toThrow(
      expect.objectContaining({ code: "sync-backup-retention-held", status: 409 }),
    );
    expect(() => service.createAutomatic("ninth-automatic")).toThrow(
      expect.objectContaining({ code: "sync-backup-retention-held" }),
    );
    expect(backupEntries(source)).toEqual(before);
  }, 30_000);

  it("counts unknown and incomplete entries as generations", () => {
    const { source, store } = workspace();
    const root = join(source, "backups");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 7; index += 1)
      mkdirSync(join(root, `unknown-${index}`));
    const incomplete = join(root, "incomplete");
    mkdirSync(incomplete);
    writeFileSync(join(incomplete, "FOLIO-RECOVERY-INCOMPLETE"), "incomplete\n");
    const before = backupEntries(source);
    expect(before).toHaveLength(8);
    const service = new WorkspaceBackupService(store.db, source);
    expect(() => service.create("new")).toThrow(
      expect.objectContaining({ code: "sync-backup-retention-held" }),
    );
    expect(backupEntries(source)).toEqual(before);
  });

  it("refuses before creating anything when retention cannot be inspected", () => {
    const { source, store } = workspace();
    const root = join(source, "backups");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    symlinkSync(join(root, "missing"), join(root, "alias"));
    const before = backupEntries(source);
    const service = new WorkspaceBackupService(store.db, source);
    expect(() => service.create("new")).toThrow(
      expect.objectContaining({ code: "sync-backup-retention-unknown", status: 409 }),
    );
    expect(backupEntries(source)).toEqual(before);
  });

  it("refuses before-rebind at the cap without changing the old queue or binding", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-backup-admission-rebind-"));
    roots.push(root);
    const workspaceId = randomUUID(),
      ownerId = randomUUID();
    const server = await startCheckpointServer({
      databasePath: join(root, "server.sqlite"),
      capabilities: [],
      workspaces: [{ workspaceId, ownerId }],
      validateCheckpoint: validateWorkspaceCheckpoint,
    });
    try {
      const source = join(root, "source");
      const store = new Store(join(source, "workspace.sqlite"));
      stores.push(store);
      const clientId = randomUUID(),
        bindingId = randomUUID(),
        token = randomBytes(32).toString("base64url");
      server.registerDevice({ workspaceId, ownerId, clientId, token });
      const options = {
        store,
        workspaceId,
        clientId,
        bindingId,
        token,
        baseUrl: server.url,
        canApply: () => true,
      };
      await openWorkspaceSync({ ...options, mode: "publish" });
      store.create(null, "page", "queued content");
      const queue = new WorkspaceSyncStore(store, {
        ...options,
        serverEpoch: server.serverEpoch,
      });
      const queued = queue.prepare();
      if (!queued) throw new Error("fixture did not queue an operation");
      const bindingPath = join(source, ".folio-sync-binding");
      const bindingBefore = readFileSync(bindingPath, "utf8");

      const backupsRoot = join(source, "backups");
      rmSync(backupsRoot, { recursive: true, force: true });
      mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
      for (let index = 0; index < 8; index += 1)
        mkdirSync(join(backupsRoot, `held-${index}`));
      const before = backupEntries(source);
      expect(before).toHaveLength(8);

      const nextClientId = randomUUID(),
        nextBindingId = randomUUID(),
        nextToken = randomBytes(32).toString("base64url");
      server.registerDevice({
        workspaceId,
        ownerId,
        clientId: nextClientId,
        token: nextToken,
      });
      let failure: unknown;
      try {
        await openWorkspaceSync({
          ...options,
          clientId: nextClientId,
          bindingId: nextBindingId,
          token: nextToken,
          mode: "recover",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SyncError);
      expect((failure as SyncError).code).toBe("sync-backup-retention-held");
      expect(backupEntries(source)).toEqual(before);
      expect(readFileSync(bindingPath, "utf8")).toBe(bindingBefore);

      const unchanged = new WorkspaceSyncStore(store, {
        ...options,
        serverEpoch: server.serverEpoch,
      });
      expect(unchanged.status()).toMatchObject({ pending: true, conflict: false });
      expect(unchanged.prepare()?.operationId).toBe(queued.operationId);

      const reopened = await openWorkspaceSync(options);
      expect(reopened.status().pending).toBe(true);
    } finally {
      await server.close();
    }
  }, 30_000);
});
