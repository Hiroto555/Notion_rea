/**
 * Product regression for post-COMMIT staging reclaim in WorkspaceSync.apply.
 *
 * c5a08dc added reclaimAppliedStaging after local.applyNext() commits. Two
 * remote revisions may share one attachment: the first offline apply publishes
 * it to the active asset directory and reclaims the shared staging copy, so the
 * second offline apply must reuse the fully verified active bytes instead of
 * requiring the staging file to still exist.
 *
 * The second case injects a cleanup exception after the SQLite apply has
 * committed and proves the apply result is still returned unchanged.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { Store } from "../src/persistence/store";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

const { reclaimFault } = vi.hoisted(() => ({
  reclaimFault: { throwAfterCommit: false },
}));

vi.mock("../src/sync/workspace-blobs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/sync/workspace-blobs")>();
  return {
    ...actual,
    reclaimAppliedStaging: (
      ...args: Parameters<typeof actual.reclaimAppliedStaging>
    ) => {
      if (reclaimFault.throwAfterCommit)
        throw new Error("injected-reclaim-failure");
      return actual.reclaimAppliedStaging(...args);
    },
  };
});

function paragraphDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

async function makeRig() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-m2-staging-"));
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
    blobs: new WorkspaceBlobStore(join(root, "blobs")),
  });
  const stores: Store[] = [];
  let serverClosed = false;
  const device = (name: string) => {
    const directory = join(root, name);
    mkdirSync(directory);
    mkdirSync(join(directory, "assets"));
    const store = new Store(join(directory, "workspace.sqlite"));
    stores.push(store);
    const clientId = randomUUID();
    const bindingId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    server.registerDevice({ workspaceId, ownerId, clientId, token });
    return {
      directory,
      store,
      options: {
        store,
        workspaceId,
        clientId,
        bindingId,
        token,
        baseUrl: server.url,
        canApply: () => true,
      },
    };
  };
  return {
    root,
    stores,
    device,
    stopServer: async () => {
      if (serverClosed) return;
      serverClosed = true;
      await server.close();
    },
    close: async () => {
      if (!serverClosed) {
        serverClosed = true;
        await server.close();
      }
      for (const store of stores)
        try {
          store.close();
        } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it(
  "reuses verified active bytes when a shared staged asset was reclaimed by an earlier apply",
  async () => {
    const rig = await makeRig();
    try {
      const a = rig.device("a");
      const b = rig.device("b");
      const page = a.store.create(null, "page", "shared base");
      const file = join(rig.root, "shared.txt");
      writeFileSync(file, "shared attachment");
      const asset = attachFile(a.store.db, join(a.directory, "assets"), file);
      const publisher = await openWorkspaceSync({
        ...a.options,
        mode: "publish",
      });
      await publisher.sendPending(); // revision 1 references the attachment
      a.store.update(page.id, a.store.get(page.id).revision, {
        title: "second revision",
        doc: paragraphDoc("second"),
      });
      await publisher.sendPending(); // revision 2 references it too

      const joiner = await openWorkspaceSync({ ...b.options, mode: "join" });
      await joiner.receiveAndStage();
      await joiner.receiveAndStage();
      expect(joiner.status()).toMatchObject({
        receivedCursor: 2,
        appliedRevision: 0,
      });
      const stagingAsset = join(
        b.directory,
        ".folio-sync-assets-staging",
        asset.id,
      );
      const activeAsset = join(b.directory, "assets", asset.id);
      expect(readFileSync(stagingAsset, "utf8")).toBe("shared attachment");
      expect(existsSync(activeAsset)).toBe(false);
      const first = joiner.stagedTarget()!;
      expect(first.revision).toBe(1);

      await rig.stopServer();
      await joiner.applyStaged(first);
      expect(joiner.status()).toMatchObject({ appliedRevision: 1 });
      expect(existsSync(stagingAsset)).toBe(false);
      expect(readFileSync(activeAsset, "utf8")).toBe("shared attachment");

      const second = joiner.stagedTarget()!;
      expect(second.revision).toBe(2);
      await joiner.applyStaged(second);
      expect(joiner.status()).toMatchObject({
        appliedRevision: 2,
        receivedCursor: 2,
      });
      expect(b.store.get(page.id).title).toBe("second revision");
      expect(joiner.appliedMatches(second)).toBe(true);
      expect(readFileSync(activeAsset, "utf8")).toBe("shared attachment");
    } finally {
      await rig.close();
    }
  },
  30_000,
);

it(
  "keeps the committed apply when post-commit staging cleanup throws",
  async () => {
    const rig = await makeRig();
    try {
      const a = rig.device("a");
      const b = rig.device("b");
      const page = a.store.create(null, "page", "cleanup base");
      const file = join(rig.root, "cleanup.txt");
      writeFileSync(file, "cleanup bytes");
      const asset = attachFile(a.store.db, join(a.directory, "assets"), file);
      const publisher = await openWorkspaceSync({
        ...a.options,
        mode: "publish",
      });
      await publisher.sendPending();

      const joiner = await openWorkspaceSync({ ...b.options, mode: "join" });
      await joiner.receiveAndStage();
      const target = joiner.stagedTarget()!;
      expect(target.revision).toBe(1);
      const stagingAsset = join(
        b.directory,
        ".folio-sync-assets-staging",
        asset.id,
      );
      const activeAsset = join(b.directory, "assets", asset.id);
      expect(readFileSync(stagingAsset, "utf8")).toBe("cleanup bytes");

      await rig.stopServer();
      reclaimFault.throwAfterCommit = true;
      const pending = joiner.applyStaged(target);
      await expect(pending).resolves.toBeDefined();
      const status = await pending;
      expect(status).toMatchObject({
        appliedRevision: 1,
        receivedCursor: 1,
        pending: false,
        conflict: false,
      });
      expect(b.store.get(page.id).title).toBe("cleanup base");
      expect(joiner.appliedMatches(target)).toBe(true);
      expect(readFileSync(activeAsset, "utf8")).toBe("cleanup bytes");
      // The failed cleanup preserved the uncertain staging evidence.
      expect(existsSync(stagingAsset)).toBe(true);
    } finally {
      reclaimFault.throwAfterCommit = false;
      await rig.close();
    }
  },
  30_000,
);
