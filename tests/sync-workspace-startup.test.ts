import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runStartupWorkspaceSync } from "../src/main/workspace-sync-startup";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { readUserVersion } from "../src/persistence/schema-startup";
import { Store } from "../src/persistence/store";
import {
  emptyCrashRecoverySnapshot,
  type CrashRecoveryRead,
} from "../src/shared/crash-recovery";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";
import { CheckpointRemote } from "../src/sync/client";

const clean: CrashRecoveryRead = { status: "empty", generation: 0 };

it("applies startup changes only after saved recovery input is cleared, and never uses a restored binding", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-sync-startup-"));
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  try {
    const device = (name: string) => {
      const store = new Store(join(root, name, "workspace.sqlite"));
      stores.push(store);
      const clientId = randomUUID(),
        bindingId = randomUUID();
      const token = randomBytes(32).toString("base64url");
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
      return {
        store,
        options,
        env: {
          FOLIO_DATA_DIR: join(root, name),
          FOLIO_SYNC_ENABLED: "1",
          FOLIO_SYNC_URL: server.url,
          FOLIO_SYNC_TOKEN: token,
          FOLIO_SYNC_WORKSPACE: workspaceId,
          FOLIO_SYNC_CLIENT: clientId,
          FOLIO_SYNC_BINDING: bindingId,
        },
      };
    };
    const a = device("a"),
      b = device("b");
    const page = a.store.create(null, "page", "送信元");
    expect(
      await runStartupWorkspaceSync(a.store, () => clean, {
        ...a.env,
        FOLIO_SYNC_ENABLED: "0",
        FOLIO_SYNC_MODE: "publish",
      }),
    ).toBeUndefined();
    expect(readUserVersion(a.store.db)).toBe(3);
    await expect(
      openWorkspaceSync({
        ...a.options,
        mode: "publish",
        admitBytes() {
          throw new Error("capacity refused");
        },
      }),
    ).rejects.toThrow("capacity refused");
    expect(readUserVersion(a.store.db)).toBe(3);
    expect(existsSync(join(a.env.FOLIO_DATA_DIR, ".folio-sync-binding"))).toBe(
      false,
    );

    // Open a connection before migration, as an already-running older
    // process could. Its content and settings statements must stop at v5.
    const stale = new DatabaseSync(a.store.path);
    try {
      expect(
        await runStartupWorkspaceSync(a.store, () => clean, {
          ...a.env,
          FOLIO_SYNC_MODE: "publish",
        }),
      ).toContain("適用済み 1");
      expect(readUserVersion(a.store.db)).toBe(5);
      expect(() => stale.exec("UPDATE pages SET body='old writer'")).toThrow(
        "no such function: folio_sync_v5_write",
      );
      expect(() =>
        stale.exec("INSERT INTO settings VALUES('theme','dark')"),
      ).toThrow("no such function: folio_sync_v5_write");
    } finally {
      stale.close();
    }

    b.store.handle({ type: "setting", key: "theme", value: "dark" });
    const snapshot = emptyCrashRecoverySnapshot();
    snapshot.rawDrafts.push({
      scope: "record",
      pageId: page.id,
      key: "draft",
      value: "-",
    });
    expect(
      await runStartupWorkspaceSync(
        b.store,
        () => ({
          status: "ready",
          generation: 1,
          snapshot,
        }),
        { ...b.env, FOLIO_SYNC_MODE: "join" },
      ),
    ).toContain("受信済み 1 · 適用済み 0");
    expect(b.store.pages()).toEqual([]);
    expect(
      await runStartupWorkspaceSync(b.store, () => clean, b.env),
    ).toContain("受信済み 1 · 適用済み 0");
    expect(b.store.pages()).toEqual([]);
    expect(await runStartupWorkspaceSync(b.store, () => clean, {
      ...b.env, FOLIO_SYNC_CONFLICT_CHOICE: "remote", FOLIO_SYNC_CONFLICT_REVISION: "1",
    })).toContain("explicit-conflict-flow-required");
    expect(b.store.pages()).toEqual([]);
    const staged = await openWorkspaceSync(b.options);
    const target = staged.stagedTarget()!;
    new WorkspaceSyncIntentFile(realpathSync(b.env.FOLIO_DATA_DIR)).create({
      workspaceId, clientId: b.options.clientId, bindingId: b.options.bindingId,
      serverEpoch: server.serverEpoch, ...target,
    });
    expect(
      await runStartupWorkspaceSync(b.store, () => clean, b.env),
    ).toContain("適用済み 1");
    expect(b.store.get(page.id).title).toBe(page.title);
    expect(b.store.load().settings.theme).toBe("dark");

    b.store.update(page.id, page.revision, { title: "Bの未送信変更" });
    const queue = new WorkspaceSyncStore(b.store, {
      ...b.options,
      serverEpoch: server.serverEpoch,
    });
    const originalOperation = queue.prepare()!;
    const backup = createFullBackup(
      b.store.db,
      b.env.FOLIO_DATA_DIR,
      join(root, "backup"),
    );
    expect(backup.manifest.storeVersion).toBe(5);
    const restored = join(root, "restored");
    restoreFullBackup(backup.directory, restored, backup.fingerprint);
    expect(existsSync(join(restored, ".folio-sync-binding"))).toBe(false);
    const restoredStore = new Store(join(restored, "workspace.sqlite"));
    stores.push(restoredStore);
    await expect(
      openWorkspaceSync({ ...b.options, store: restoredStore }),
    ).rejects.toThrow("workspace-binding-missing");
    await expect(
      openWorkspaceSync({
        ...b.options,
        store: restoredStore,
        mode: "recover",
      }),
    ).rejects.toThrow("workspace-binding-missing");
    await expect(
      openWorkspaceSync({
        ...b.options,
        store: restoredStore,
        bindingId: randomUUID(),
        mode: "recover",
      }),
    ).rejects.toThrow("new-sync-device-required");
    const edited = restoredStore.update(
      page.id,
      restoredStore.get(page.id).revision,
      {
        title: "復元した端末の編集",
      },
    );
    expect(edited.title).toBe("復元した端末の編集");

    const clientId = randomUUID(),
      bindingId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    server.registerDevice({ workspaceId, ownerId, clientId, token });
    const recovered = await openWorkspaceSync({
      ...b.options,
      clientId,
      bindingId,
      token,
      store: restoredStore,
      mode: "recover",
    });
    const reopened = await openWorkspaceSync({
      ...b.options,
      clientId,
      bindingId,
      token,
      store: restoredStore,
      mode: "recover",
    });
    expect(reopened.status()).toEqual(recovered.status());
    expect(recovered.status()).toMatchObject({
      appliedRevision: 0,
      pending: true,
    });
    expect(
      readdirSync(join(restored, "backups")).some((name) =>
        name.startsWith("sync-before-rebind-"),
      ),
    ).toBe(true);
    expect(await recovered.syncOnce()).toMatchObject({
      appliedRevision: 0,
      conflict: true,
    });
    const conflict = recovered.conflict()!;
    expect(conflict.operation.clientId).toBe(clientId);
    expect(conflict.operation.operationId).not.toBe(
      originalOperation.operationId,
    );
    expect(
      await new CheckpointRemote(b.options).lookup(
        b.options.clientId,
        originalOperation.operationId,
      ),
    ).toBeNull();
    expect(a.store.get(page.id).title).toBe(page.title);
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
