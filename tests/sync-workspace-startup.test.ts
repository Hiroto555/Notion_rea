import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runStartupWorkspaceSync } from "../src/main/workspace-sync-startup";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { readUserVersion } from "../src/persistence/schema-startup";
import { Store } from "../src/persistence/store";
import { emptyCrashRecoverySnapshot, type CrashRecoveryRead } from "../src/shared/crash-recovery";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

const clean: CrashRecoveryRead = { status: "empty", generation: 0 };

it("applies startup changes only after saved recovery input is cleared, and never uses a restored binding", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-sync-startup-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
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
      const clientId = randomUUID(), bindingId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      server.registerDevice({ workspaceId, ownerId, clientId, token });
      const options = {
        store, workspaceId, clientId, bindingId, token, baseUrl: server.url,
        canApply: () => true,
      };
      return { store, options, env: {
        FOLIO_DATA_DIR: join(root, name),
        FOLIO_SYNC_ENABLED: "1",
        FOLIO_SYNC_URL: server.url,
        FOLIO_SYNC_TOKEN: token,
        FOLIO_SYNC_WORKSPACE: workspaceId,
        FOLIO_SYNC_CLIENT: clientId,
        FOLIO_SYNC_BINDING: bindingId,
      } };
    };
    const a = device("a"), b = device("b");
    const page = a.store.create(null, "page", "送信元");
    expect(await runStartupWorkspaceSync(a.store, () => clean, {
      ...a.env, FOLIO_SYNC_ENABLED: "0", FOLIO_SYNC_MODE: "publish",
    })).toBeUndefined();
    expect(readUserVersion(a.store.db)).toBe(3);
    expect(await runStartupWorkspaceSync(a.store, () => clean, {
      ...a.env, FOLIO_SYNC_MODE: "publish",
    })).toContain("適用済み 1");
    expect(readUserVersion(a.store.db)).toBe(5);

    b.store.handle({ type: "setting", key: "theme", value: "dark" });
    const snapshot = emptyCrashRecoverySnapshot();
    snapshot.rawDrafts.push({ scope: "record", pageId: page.id, key: "draft", value: "-" });
    expect(await runStartupWorkspaceSync(b.store, () => ({
      status: "ready", generation: 1, snapshot,
    }), { ...b.env, FOLIO_SYNC_MODE: "join" })).toContain("受信済み 1 · 適用済み 0");
    expect(b.store.pages()).toEqual([]);
    expect(await runStartupWorkspaceSync(b.store, () => clean, b.env)).toContain("適用済み 1");
    expect(b.store.get(page.id).title).toBe(page.title);
    expect(b.store.load().settings.theme).toBe("dark");

    const backup = createFullBackup(b.store.db, b.env.FOLIO_DATA_DIR, join(root, "backup"));
    expect(backup.manifest.storeVersion).toBe(5);
    const restored = join(root, "restored");
    restoreFullBackup(backup.directory, restored, backup.fingerprint);
    expect(existsSync(join(restored, ".folio-sync-binding"))).toBe(false);
    const restoredStore = new Store(join(restored, "workspace.sqlite"));
    stores.push(restoredStore);
    await expect(openWorkspaceSync({ ...b.options, store: restoredStore }))
      .rejects.toThrow("workspace-binding-missing");
    const edited = restoredStore.update(page.id, page.revision, { title: "復元した端末の編集" });
    expect(edited.title).toBe("復元した端末の編集");
    expect(a.store.get(page.id).title).toBe(page.title);
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
