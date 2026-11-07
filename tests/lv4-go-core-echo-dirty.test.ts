/**
 * Regression: a lost ACK leaves the client's own echo staged ahead of a later
 * remote revision. A newer local edit is then made while offline. Applying the
 * remote revision must be refused so the newer local content and pending state
 * survive; only the verified own echo may be reconciled.
 *
 * The server commits A's edit but the FaultProxy drops the acknowledgement.
 * A stages its own echo (revision 2, skip_apply) and B's later revision 3.
 * After reopening offline, A edits again without sending. applyStaged() must
 * reconcile the echo but leave revision 3 staged and the newer edit untouched.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { CheckpointRemote } from "../src/sync/client";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync, WorkspaceSync } from "../src/sync/workspace-sync";
import { FaultProxy } from "./fixtures/sync-level4-support";

function paragraphDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

it(
  "refuses an offline apply when a newer unsent local edit follows a lost-ACK echo",
  async () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "folio-lv4-echo-dirty-"),
    );
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
      await expect(sender.sendPending()).rejects.toThrow();
      expect(proxy.counts.ackDropped).toBe(1);
      expect(sender.status()).toMatchObject({
        appliedRevision: 1,
        pending: true,
      });
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

      // A stages its own echo without moving the applied position or replacing
      // the local content.
      await sender.receiveAndStage();
      await sender.receiveAndStage(); // Changes are paged one revision at a time.
      expect(sender.status()).toMatchObject({
        receivedCursor: 2,
        appliedRevision: 1,
      });
      expect(a.store.get(page.id).title).toBe("ack lost edit");

      // B applies revision 2 and publishes a later remote revision 3.
      await joiner.receiveAndStage();
      await joiner.applyStaged(joiner.stagedTarget()!);
      b.store.update(page.id, b.store.get(page.id).revision, {
        title: "remote behind echo",
        doc: paragraphDoc("from b"),
      });
      await joiner.sendPending(); // revision 3

      // A stages the remote revision behind its own echo, then goes offline.
      await sender.receiveAndStage();
      expect(sender.status()).toMatchObject({
        receivedCursor: 3,
        appliedRevision: 1,
      });

      await proxy.close();
      proxy = undefined;
      await server.close();
      serverClosed = true;

      a.store.close();
      stores.splice(stores.indexOf(a.store), 1);
      const reopenedStore = new Store(a.store.path);
      stores.push(reopenedStore);

      // A newer local edit has never been prepared or sent.
      const current = reopenedStore.get(page.id);
      reopenedStore.update(page.id, current.revision, {
        title: "newer local unsent",
        doc: paragraphDoc("local body kept offline"),
      });

      const offline = WorkspaceSync.openStaged(
        { ...a, store: reopenedStore },
        server.serverEpoch,
      );
      const target = offline.stagedTarget()!;
      expect(target.revision).toBe(3);
      const before = offline.status();
      expect(before).toMatchObject({
        receivedCursor: 3,
        appliedRevision: 1,
        pending: true,
        conflict: false,
      });
      expect(before.generation).toBeGreaterThan(before.cleanGeneration);

      const refused = await offline.applyStaged(target);
      // The verified own echo is reconciled, but revision 3 is not applied over
      // the newer local edit.
      expect(refused).toMatchObject({
        receivedCursor: 3,
        appliedRevision: 2,
        pending: true,
        conflict: false,
      });
      expect(refused.generation).toBe(before.generation);
      expect(refused.generation).toBeGreaterThan(refused.cleanGeneration);

      expect(reopenedStore.get(page.id).title).toBe("newer local unsent");
      expect(JSON.stringify(reopenedStore.get(page.id).doc)).toContain(
        "local body kept offline",
      );
      expect(offline.stagedTarget()).toEqual(target);

      // The lost ACK was settled by the echo receipt; the still-pending state
      // belongs to the newer local edit that was never put in the outbox.
      const outbox = reopenedStore.db
        .prepare(
          "SELECT result_json FROM workspace_sync_outbox WHERE operation_id=?",
        )
        .get(unresolved.operation_id) as { result_json: string | null };
      expect(outbox.result_json).not.toBeNull();
      expect(JSON.parse(outbox.result_json!)).toMatchObject({
        status: "applied",
        revision: 2,
      });
      const pendingOutbox = reopenedStore.db
        .prepare(
          "SELECT count(*) AS count FROM workspace_sync_outbox WHERE result_json IS NULL",
        )
        .get() as { count: number };
      expect(pendingOutbox.count).toBe(0);
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
