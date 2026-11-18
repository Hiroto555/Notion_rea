/**
 * Regression: a self echo staged ahead of the next remote revision must not
 * permanently block the staged apply flow.
 *
 * Counterexample against the current split implementation: A's commit reaches
 * the server but the acknowledgement is lost, so A's outbox stays unresolved
 * (status.pending) while A stages its own echo (skip_apply) at applied+1 and a
 * remote revision behind it. After reopening offline, stagedTarget() returns
 * null (the echo hides the remote revision) and applyStaged() silently returns
 * status without applying, because the only echo reconciliation path
 * (WorkspaceSyncStore.nextIncoming) is never invoked outside syncOnce().
 *
 * Expected after fix: applyStaged reconciles the exact own echo (content
 * neutral, inferred receipt) and then applies the remote revision behind it,
 * with no server contact.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";
import { WorkspaceSyncIntentJournal } from "../src/main/normal-apply-intent";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { WorkspaceSyncControl } from "../src/main/workspace-sync-control";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { CheckpointRemote } from "../src/sync/client";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync, WorkspaceSync } from "../src/sync/workspace-sync";
import type { Change } from "../src/sync/protocol";
import { FaultProxy } from "./fixtures/sync-level4-support";

function paragraphDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

it(
  "reconciles a staged own echo and applies the remote revision behind it offline",
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-echo-"));
    const workspaceId = randomUUID(),
      ownerId = randomUUID();
    const server = await startCheckpointServer({
      databasePath: join(root, "server.sqlite"),
      capabilities: [],
      workspaces: [{ workspaceId, ownerId }],
      validateCheckpoint: validateWorkspaceCheckpoint,
      blobs: new WorkspaceBlobStore(join(root, "blobs")),
    });
    const stores: Store[] = [];
    let proxy: FaultProxy | undefined;
    let serverClosed = false;
    try {
      const options = (name: string) => {
        const directory = join(root, name);
        mkdirSync(directory);
        mkdirSync(join(directory, "assets"));
        const store = new Store(join(directory, "workspace.sqlite"));
        stores.push(store);
        const clientId = randomUUID(),
          bindingId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        server.registerDevice({ workspaceId, ownerId, clientId, token });
        return {
          store,
          workspaceId,
          clientId,
          bindingId,
          token,
          baseUrl: server.url,
          canApply: () => true,
        };
      };
      const a = options("a"),
        b = options("b");
      const page = a.store.create(null, "page", "echo base");
      const publisher = await openWorkspaceSync({ ...a, mode: "publish" });
      await publisher.sendPending(); // revision 1

      const joiner = await openWorkspaceSync({ ...b, mode: "join" });
      await joiner.receiveAndStage();
      await joiner.applyStaged(joiner.stagedTarget()!); // revision 1
      expect(joiner.status().appliedRevision).toBe(1);

      // A's next edit commits on the server, but the acknowledgement is lost.
      a.store.update(page.id, 0, {
        title: "ack lost edit",
        doc: paragraphDoc("acked only on the server"),
      });
      proxy = await FaultProxy.start(server.url, "drop-ack-after-commit");
      const sender = await openWorkspaceSync({ ...a, baseUrl: proxy.url });
      const control = new WorkspaceSyncControl(new WorkspaceSyncService(sender), new WorkspaceSyncGate(), false);
      expect(await control.transfer()).toMatchObject({available: true, lastError: "local-or-network-error"});
      expect(proxy.counts.ackDropped).toBe(1);
      expect(sender.status()).toMatchObject({ appliedRevision: 1, pending: true });
      expect(
        (
          await new CheckpointRemote({
            baseUrl: server.url,
            workspaceId,
            token: a.token,
          }).head()
        ).head.revision,
      ).toBe(2);
      const unresolved = a.store.db
        .prepare(
          "SELECT operation_id FROM workspace_sync_outbox WHERE result_json IS NULL",
        )
        .get() as { operation_id: string };

      // A stages its own echo: the applied position must not move and the
      // local content must not be replaced.
      await sender.receiveAndStage();
      await sender.receiveAndStage(); // Changes are paged one revision at a time.
      expect(sender.status()).toMatchObject({ receivedCursor: 2, appliedRevision: 1 });
      expect(a.store.get(page.id).title).toBe("ack lost edit");

      // B applies revision 2 and publishes a remote revision 3 behind it.
      await joiner.receiveAndStage();
      await joiner.applyStaged(joiner.stagedTarget()!);
      b.store.update(page.id, b.store.get(page.id).revision, {
        title: "remote behind echo",
        doc: paragraphDoc("from b"),
      });
      const file = join(root, "attachment.txt");
      writeFileSync(file, "behind echo");
      const asset = attachFile(b.store.db, join(root, "b", "assets"), file);
      await joiner.sendPending(); // revision 3

      // A stages the remote revision behind its own echo, then goes offline.
      await sender.receiveAndStage();
      expect(sender.status()).toMatchObject({ receivedCursor: 3, appliedRevision: 1 });
      expect(readFileSync(join(root, "a", ".folio-sync-assets-staging", asset.id), "utf8")).toBe("behind echo");
      expect(existsSync(join(root, "a", "assets", asset.id))).toBe(false);
      const rev3Row = a.store.db
        .prepare("SELECT change_json FROM workspace_sync_inbox WHERE revision=3")
        .get() as { change_json: string };
      const rev3 = JSON.parse(rev3Row.change_json) as Change;

      await proxy.close();
      proxy = undefined;
      await server.close();
      serverClosed = true;

      a.store.close();
      stores.splice(stores.indexOf(a.store), 1);
      const reopenedStore = new Store(a.store.path);
      stores.push(reopenedStore);
      const offline = WorkspaceSync.openStaged(
        { ...a, store: reopenedStore },
        server.serverEpoch,
      );

      // The next applicable target is the remote change, not the own echo.
      expect(offline.stagedTarget()).toEqual({
        revision: rev3.revision,
        checkpointHash: rev3.checkpointHash,
      });

      // A wrong target must not even reconcile the echo's metadata.
      const next = offline.stagedTarget()!;
      await expect(offline.applyStaged({...next, revision: next.revision + 1})).rejects.toThrow("staged-target-mismatch");
      expect(offline.status()).toMatchObject({appliedRevision: 1, pending: true});
      // The windowless intent path reconciles the echo and applies revision 3.
      const intent = {...next, workspaceId, clientId: a.clientId, bindingId: a.bindingId, serverEpoch: server.serverEpoch};
      const intentFile = new WorkspaceSyncIntentJournal(join(root, "a"), reopenedStore);
      intentFile.create(intent);
      expect(await applyRestartIntent({directory: join(root, "a"), sync: {...a, store: reopenedStore}, readRecovery: () => ({status: "empty", generation: 0})})).toBe("applied");
      expect(intentFile.read().status).toBe("empty");
      const applied = offline.status();
      expect(applied).toMatchObject({
        receivedCursor: 3,
        appliedRevision: 3,
        pending: false,
        conflict: false,
      });
      expect(reopenedStore.get(page.id).title).toBe("remote behind echo");
      expect(readFileSync(join(root, "a", "assets", asset.id), "utf8")).toBe("behind echo");
      expect(reopenedStore.versions(page.id).map((v) => v.title)).toEqual([
        "ack lost edit",
        "echo base",
      ]);

      // The echo reconciliation recorded an inferred receipt for the exact,
      // unchanged operation id and never re-sent it.
      const outbox = reopenedStore.db
        .prepare("SELECT * FROM workspace_sync_outbox WHERE operation_id=?")
        .get(unresolved.operation_id) as { result_json: string | null };
      expect(outbox.result_json).not.toBeNull();
      const receipt = JSON.parse(outbox.result_json!) as {
        status: string;
        revision: number;
      };
      expect(receipt).toMatchObject({ status: "applied", revision: 2 });
      const appliedRow = reopenedStore.db
        .prepare("SELECT revision FROM workspace_sync_applied WHERE singleton=1")
        .get() as { revision: number };
      expect(appliedRow.revision).toBe(3);
    } finally {
      if (proxy) await proxy.close();
      if (!serverClosed) await server.close();
      for (const store of stores)
        try {
          store.close();
        } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
