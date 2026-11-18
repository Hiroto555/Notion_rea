import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readSyncSuccess, writeSyncSuccess } from "../src/main/workspace-sync-history";
import { Store } from "../src/persistence/store";
import { hashCheckpoint } from "../src/sync/protocol";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";

it("persists a local transfer time without changing synced content and isolates bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "folio-sync-history-"));
  const store = new Store(join(root, "workspace.sqlite"));
  try {
    const id = {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch"};
    const sync = new WorkspaceSyncStore(store, id); sync.enable("publish", () => {});
    const beforeStatus = sync.status(), beforeHash = hashCheckpoint(buildWorkspaceCheckpoint(store.db));
    const time = "2026-11-07T10:00:00.000Z";
    expect(readSyncSuccess(store.db, id)).toBeNull();
    writeSyncSuccess(store.db, id, time);
    expect(readSyncSuccess(store.db, id)).toBe(time);
    const reopened = new DatabaseSync(store.path, {readOnly: true});
    try {expect(readSyncSuccess(reopened, id)).toBe(time);} finally {reopened.close();}
    expect(readSyncSuccess(store.db, {...id, bindingId: "other"})).toBeNull();
    expect(readSyncSuccess(store.db, {...id, serverEpoch: "other"})).toBeNull();
    expect(sync.status()).toEqual(beforeStatus);
    expect(hashCheckpoint(buildWorkspaceCheckpoint(store.db))).toBe(beforeHash);
    expect(() => writeSyncSuccess(store.db, id, "invalid")).toThrow("invalid-sync-success-time");
    store.db.prepare("UPDATE settings SET value=? WHERE key LIKE ?").run("unexpected", "folio.sync.last-success.v1.%");
    expect(readSyncSuccess(store.db, id)).toBeNull();
    expect(() => writeSyncSuccess(store.db, id, time)).toThrow("invalid-sync-success-history");
    expect(store.db.prepare("SELECT value FROM settings WHERE key LIKE ?").get("folio.sync.last-success.v1.%")?.value).toBe("unexpected");
  } finally {store.close(); rmSync(root, {recursive: true, force: true});}
});
