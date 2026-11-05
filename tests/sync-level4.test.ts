/**
 * Lane D product verification for Folio Level 4 workspace sync.
 *
 * Every mutating client is a separate Node OS process with its own temporary
 * Store, assets directory, client id and binding id.  The checkpoint server is
 * a persistent loopback fixture owned by this test process.  The Codex
 * integration modules are loaded through an esbuild bridge only when all of
 * them exist, so this file is skipped on the base commit and runs in the
 * integrated branch without a production stub.
 *
 * Faults are injected only through a child-local loopback proxy or by
 * SIGKILLing the exact child this file spawned.  No host network setting, real
 * Folio data, Electron, browser, clipboard or GUI surface is touched.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inspectWritableStartup } from "../src/persistence/schema-startup";
import type {
  Level4Api,
  Level4Conflict,
  Level4ServerFixture,
  Level4Status,
  Level4Store,
} from "./fixtures/sync-level4-support";
import {
  FaultProxy,
  checkpointPage,
  disposeBundles,
  docText,
  drive,
  expectOk,
  findPage,
  findPageByTitle,
  imageDoc,
  INTEGRATION_FILES,
  integrationFilesPresent,
  integrationFilesStarted,
  loadLevel4Api,
  paragraphDoc,
  rawHead,
  registerDevice,
  restartLevel4Server,
  runProductClient,
  sha256,
  sha256File,
  spawnProductClient,
  startLevel4Server,
  tempRoot,
  waitForFile,
  workspace,
  writeProductConfig,
} from "./fixtures/sync-level4-support";

const PRESENT = integrationFilesPresent();
const describeLevel4 = PRESENT ? describe : describe.skip;
const TIMEOUT = 60_000;

const roots: string[] = [];
const fixtures = new Set<Level4ServerFixture>();
const proxies = new Set<FaultProxy>();
let api!: Level4Api;

beforeAll(async () => {
  if (PRESENT) api = await loadLevel4Api();
}, 120_000);

afterEach(async () => {
  for (const proxy of proxies) await proxy.close();
  proxies.clear();
  for (const fixture of fixtures) {
    try {
      await fixture.server.close();
    } catch {
      // A test that already stopped the server must still clean the temp root.
    }
  }
  fixtures.clear();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort; the directory is under the OS temporary directory.
    }
  }
});

afterAll(() => {
  disposeBundles();
});

type Identity = {
  token: string;
  clientId: string;
  workspaceId?: string;
  bindingId?: string;
};

async function fixture(
  options: {
    extraWorkspaces?: { workspaceId: string; ownerId: string }[];
  } = {},
): Promise<{ root: string; server: Level4ServerFixture }> {
  const root = tempRoot();
  roots.push(root);
  const server = await startLevel4Server({ api, root, ...options });
  fixtures.add(server);
  return { root, server };
}

function identity(
  server: Level4ServerFixture,
  label: string,
  workspaceId?: string,
): Identity {
  const device = server.devices.get(label);
  if (!device) throw new Error(`device ${label} is not registered`);
  return {
    ...device,
    workspaceId: workspaceId ?? server.workspaceId,
    bindingId: `binding-${device.clientId}`,
  };
}

function config(
  server: Level4ServerFixture,
  store: ReturnType<typeof workspace>,
  who: Identity,
  steps: any[],
  options: { canApply?: boolean; timeoutMs?: number } = {},
) {
  return {
    databasePath: store.database,
    assetsPath: store.assets,
    baseUrl: server.server.url,
    token: who.token,
    workspaceId: who.workspaceId ?? server.workspaceId,
    clientId: who.clientId,
    bindingId: who.bindingId ?? `binding-${who.clientId}`,
    ...options,
    steps,
  };
}

async function run(
  server: Level4ServerFixture,
  who: Identity,
  store: ReturnType<typeof workspace>,
  label: string,
  steps: any[],
  options: { canApply?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  return runProductClient(
    server.root,
    label,
    config(server, store, who, steps, options),
  );
}

function value(output: any, name: string): any {
  return output?.vars?.[name];
}

function status(output: any, name: string): Level4Status {
  return value(output, name);
}

function page(output: any, name: string): any {
  return value(output, name);
}

/** Build an identity for a second workspace on the same fixture server. */
async function registerFor(
  server: Level4ServerFixture,
  workspaceId: string,
  ownerId: string,
  label: string,
): Promise<Identity> {
  const device = {
    clientId: `client-${label}-${randomUUID().slice(0, 12)}`,
    token: sha256(randomUUID()),
  };
  await server.server.registerDevice({
    workspaceId,
    ownerId,
    clientId: device.clientId,
    token: device.token,
  });
  return {
    ...device,
    workspaceId,
    bindingId: `binding-${device.clientId}`,
  };
}

// This probe is never skipped.  It prevents a partially integrated branch from
// silently hiding all 14 product checks: no files at all is the base commit,
// but one or two files is an incomplete integration and fails loudly.
it("does not partially integrate the frozen workspace-sync files", () => {
  if (!integrationFilesStarted()) return;
  const missing = INTEGRATION_FILES.filter(
    (file) => !existsSync(join(process.cwd(), file)),
  );
  expect(missing).toEqual([]);
});

describeLevel4("Level 4 workspace sync product verification", () => {
  it(
    "saves one page, publishes, pulls into a fresh join, and reopens both stores",
    async () => {
      const { root, server } = await fixture();
      const a = await registerDevice(server, "a");
      const b = await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const published = expectOk(
        await run(server, whoA, aStore, "a-publish", [
          { kind: "open", mode: "publish", saveAs: "opened" },
          {
            kind: "createPage",
            title: "Alpha",
            doc: paragraphDoc("first body"),
            saveAs: "alpha",
          },
          {
            kind: "save",
            pageId: "${alpha.id}",
            title: "Alpha v1",
            doc: paragraphDoc("first body saved"),
            saveAs: "saved",
          },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "versions", pageId: "${alpha.id}", saveAs: "versions" },
          { kind: "schemaVersion", saveAs: "schema" },
          { kind: "close" },
        ]),
      );
      const alpha = page(published, "alpha");
      const sync1 = status(published, "sync");
      const status1 = status(published, "status");
      expect(sync1.pending).toBe(false);
      expect(status1.pending).toBe(false);
      expect(value(published, "schema")).toBeGreaterThanOrEqual(5);
      // The production preflight used by an old v4 Store must refuse the
      // promoted workspace.  This is the old-version pin, not a reimplemented
      // version check: the same function the Store constructor uses is called
      // with the old supported version.
      expect(() => inspectWritableStartup(aStore.database, 4)).toThrow(
        /newer Folio version/,
      );
      expect(
        inspectWritableStartup(aStore.database, 5).version,
      ).toBeGreaterThanOrEqual(5);
      const serverHead = (
        await rawHead(server.server.url, server.workspaceId, a.token)
      ).head.revision;
      expect(status1.appliedRevision).toBe(serverHead);

      const joined = expectOk(
        await run(server, whoB, bStore, "b-join", [
          { kind: "open", mode: "join", saveAs: "opened" },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "pages", saveAs: "pages" },
          { kind: "page", pageId: alpha.id, saveAs: "alpha" },
          { kind: "versions", pageId: alpha.id, saveAs: "versions" },
          { kind: "close" },
        ]),
      );
      const joinedPage = page(joined, "alpha");
      expect(joinedPage.id).toBe(alpha.id);
      expect(joinedPage.title).toBe("Alpha v1");
      expect(docText(joinedPage.doc)).toBe("first body saved");
      expect(status(joined, "status").pending).toBe(false);
      expect(status(joined, "status").appliedRevision).toBe(serverHead);
      expect(
        page(joined, "versions").map((version: any) => version.title),
      ).toEqual(
        page(published, "versions").map((version: any) => version.title),
      );

      // Two independent processes reopen the same stores without a mode. The
      // pending outbox/inbox must not be recreated and no duplicate page may
      // appear.
      const reopenedA = expectOk(
        await run(server, whoA, aStore, "a-reopen", [
          { kind: "open", saveAs: "opened" },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "pages", saveAs: "pages" },
          { kind: "schemaVersion", saveAs: "schema" },
          { kind: "close" },
        ]),
      );
      expect(status(reopenedA, "status")).toMatchObject({
        pending: false,
        appliedRevision: serverHead,
      });
      expect(value(reopenedA, "pages")).toHaveLength(1);
      expect(value(reopenedA, "schema")).toBeGreaterThanOrEqual(5);

      const reopenedB = expectOk(
        await run(server, whoB, bStore, "b-reopen", [
          { kind: "open", saveAs: "opened" },
          { kind: "status", saveAs: "status" },
          { kind: "pages", saveAs: "pages" },
          { kind: "close" },
        ]),
      );
      expect(status(reopenedB, "status")).toMatchObject({
        pending: false,
        appliedRevision: serverHead,
      });
      expect(value(reopenedB, "pages")).toHaveLength(1);
      expect(findPage(value(reopenedB, "pages"), alpha.id).title).toBe(
        "Alpha v1",
      );
    },
    TIMEOUT,
  );

  it(
    "propagates edits and new pages in both directions without duplicating ids",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const published = expectOk(
        await run(server, whoA, aStore, "a-seed", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Shared page",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(published, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          {
            kind: "save",
            pageId,
            title: "Edited on B",
            doc: paragraphDoc("from B"),
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );

      const aAfterB = expectOk(
        await run(server, whoA, aStore, "a-after-b", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId, saveAs: "page" },
          {
            kind: "createPage",
            title: "Second page",
            doc: paragraphDoc("second"),
            saveAs: "second",
          },
          { kind: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(page(aAfterB, "page").title).toBe("Edited on B");
      expect(docText(page(aAfterB, "page").doc)).toBe("from B");
      const secondId = page(aAfterB, "second").id;

      const bAfterA = expectOk(
        await run(server, whoB, bStore, "b-after-a", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "pages", saveAs: "pages" },
          {
            kind: "createPage",
            title: "Third page",
            doc: paragraphDoc("third"),
            saveAs: "third",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const bTitles = value(bAfterA, "pages")
        .map((entry: any) => entry.title)
        .sort();
      expect(bTitles).toEqual(["Edited on B", "Second page"]);
      expect(findPage(value(bAfterA, "pages"), secondId).title).toBe(
        "Second page",
      );
      const thirdId = page(bAfterA, "third").id;

      const finalA = expectOk(
        await run(server, whoA, aStore, "a-final", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "pages", saveAs: "pages" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      const finalPages = value(finalA, "pages");
      expect(finalPages.map((entry: any) => entry.title).sort()).toEqual([
        "Edited on B",
        "Second page",
        "Third page",
      ]);
      expect(new Set(finalPages.map((entry: any) => entry.id)).size).toBe(
        finalPages.length,
      );
      expect(findPage(finalPages, thirdId).title).toBe("Third page");
      expect(status(finalA, "status").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "transfers database schema, records and values, then a database tombstone batch",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const created = expectOk(
        await run(server, whoA, aStore, "a-db", [
          { kind: "open", mode: "publish" },
          { kind: "createDatabase", title: "Tasks", saveAs: "database" },
          {
            kind: "createRecord",
            databasePageId: "${database.page.id}",
            title: "Row one",
            values: { status: "進行中", date: "2026-11-05" },
            saveAs: "record",
          },
          {
            kind: "saveRecord",
            pageId: "${record.pageId}",
            databasePageId: "${database.page.id}",
            title: "Row one edited",
            values: { status: "完了" },
            saveAs: "recordEdited",
          },
          { kind: "sync", saveAs: "sync" },
          { kind: "close" },
        ]),
      );
      const databaseId = page(created, "database").page.id;
      const recordId = page(created, "record").pageId;
      expect(status(created, "sync").pending).toBe(false);

      const joined = expectOk(
        await run(server, whoB, bStore, "b-db", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          {
            kind: "readDatabase",
            databasePageId: databaseId,
            saveAs: "snapshot",
          },
          {
            kind: "saveRecord",
            pageId: recordId,
            databasePageId: databaseId,
            values: { status: "進行中" },
            saveAs: "fromB",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const snapshot = page(joined, "snapshot");
      expect(snapshot.page.id).toBe(databaseId);
      expect(snapshot.page.kind).toBe("database");
      expect(
        snapshot.database.settings.properties.map(
          (property: any) => property.id,
        ),
      ).toEqual(["status", "date"]);
      expect(snapshot.database.records).toHaveLength(1);
      expect(snapshot.database.records[0]).toMatchObject({
        pageId: recordId,
        databasePageId: databaseId,
        title: "Row one edited",
        values: { status: "完了" },
      });

      const aAfterB = expectOk(
        await run(server, whoA, aStore, "a-db-after-b", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "readDatabase",
            databasePageId: databaseId,
            saveAs: "snapshot",
          },
          {
            kind: "trashDatabase",
            databasePageId: databaseId,
            saveAs: "trashed",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      expect(page(aAfterB, "snapshot").database.records[0].values).toEqual({
        status: "進行中",
      });
      expect(page(aAfterB, "trashed").deletedAt).not.toBeNull();

      const bTombstone = expectOk(
        await run(server, whoB, bStore, "b-db-tombstone", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId: databaseId, saveAs: "database" },
          { kind: "readRecord", pageId: recordId, saveAs: "record" },
          {
            kind: "restoreDatabase",
            databasePageId: databaseId,
            saveAs: "restored",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      expect(page(bTombstone, "database").deletedAt).not.toBeNull();
      expect(page(bTombstone, "record").deletedAt).not.toBeNull();
      expect(page(bTombstone, "restored").deletedAt).toBeNull();

      const finalA = expectOk(
        await run(server, whoA, aStore, "a-db-restored", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "readDatabase",
            databasePageId: databaseId,
            saveAs: "snapshot",
          },
          { kind: "page", pageId: databaseId, saveAs: "database" },
          { kind: "sync", saveAs: "sync" },
          { kind: "close" },
        ]),
      );
      expect(page(finalA, "database").deletedAt).toBeNull();
      expect(page(finalA, "snapshot").database.records[0]).toMatchObject({
        pageId: recordId,
        title: "Row one edited",
        values: { status: "進行中" },
        deletedAt: null,
      });
      expect(status(finalA, "sync").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "transfers the asset file/id/hash and preserves it across page trash and restore",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");
      const source = Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        Buffer.from(`lane-d-asset-${randomUUID()}`),
      ]);
      const sourcePath = join(root, "source.png");
      writeFileSync(sourcePath, source, { mode: 0o600 });
      const sourceHash = sha256(source);

      const created = expectOk(
        await run(server, whoA, aStore, "a-asset", [
          { kind: "open", mode: "publish" },
          { kind: "attach", file: sourcePath, saveAs: "asset" },
          {
            kind: "createPage",
            title: "Asset page",
            doc: imageDoc("${asset.url}"),
            saveAs: "page",
          },
          { kind: "sync", saveAs: "sync" },
          { kind: "close" },
        ]),
      );
      const asset = page(created, "asset");
      const assetPage = page(created, "page");
      expect(asset.sha256).toBe(sourceHash);
      expect(asset.bytes).toBe(source.length);
      expect(status(created, "sync").pending).toBe(false);

      const received = expectOk(
        await run(server, whoB, bStore, "b-asset", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "page", pageId: assetPage.id, saveAs: "page" },
          { kind: "resolveAsset", url: asset.url, saveAs: "resolved" },
          { kind: "close" },
        ]),
      );
      const resolved = page(received, "resolved");
      expect(resolved.path).toBe(join(bStore.assets, asset.id));
      expect(resolved.bytes).toBe(source.length);
      expect(resolved.sha256).toBe(sourceHash);
      expect(
        page(received, "page").doc.content.some(
          (node: any) => node?.attrs?.src === asset.url,
        ),
      ).toBe(true);
      expect(sha256File(join(bStore.assets, asset.id))).toBe(sourceHash);

      expectOk(
        await run(server, whoA, aStore, "a-asset-trash", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "trash", pageId: assetPage.id, saveAs: "trashed" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const tombstoned = expectOk(
        await run(server, whoB, bStore, "b-asset-tombstone", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId: assetPage.id, saveAs: "page" },
          { kind: "resolveAsset", url: asset.url, saveAs: "resolved" },
          { kind: "close" },
        ]),
      );
      expect(page(tombstoned, "page").deletedAt).not.toBeNull();
      expect(sha256File(page(tombstoned, "resolved").path)).toBe(sourceHash);
      expect(existsSync(join(bStore.assets, asset.id))).toBe(true);

      expectOk(
        await run(server, whoA, aStore, "a-asset-restore", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "restore", pageId: assetPage.id, saveAs: "restored" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const restored = expectOk(
        await run(server, whoB, bStore, "b-asset-restored", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId: assetPage.id, saveAs: "page" },
          { kind: "resolveAsset", url: asset.url, saveAs: "resolved" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(page(restored, "page").deletedAt).toBeNull();
      expect(page(restored, "page").id).toBe(assetPage.id);
      expect(page(restored, "resolved").sha256).toBe(sourceHash);
      expect(status(restored, "status").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "defers remote apply while canApply is false and rejects the stale write epoch",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-barrier-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Barrier base",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-barrier-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      expectOk(
        await run(server, whoA, aStore, "a-barrier-edit", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "save",
            pageId,
            title: "Barrier remote",
            doc: paragraphDoc("remote"),
          },
          { kind: "sync", saveAs: "sync" },
          { kind: "close" },
        ]),
      );

      const deferred = expectOk(
        await run(
          server,
          whoB,
          bStore,
          "b-barrier-defer",
          [
            { kind: "open", saveAs: "opened" },
            { kind: "sync", saveAs: "sync" },
            { kind: "status", saveAs: "status" },
            { kind: "writeEpoch", saveAs: "epoch" },
            { kind: "page", pageId, saveAs: "page" },
            { kind: "close" },
          ],
          { canApply: false },
        ),
      );
      const deferredStatus = status(deferred, "status");
      const deferredPage = page(deferred, "page");
      expect(deferredPage.title).toBe("Barrier base");
      expect(docText(deferredPage.doc)).toBe("base");
      expect(deferredStatus.pending).toBe(true);
      expect(deferredStatus.receivedCursor).toBeGreaterThan(
        deferredStatus.appliedRevision,
      );

      const applied = expectOk(
        await run(server, whoB, bStore, "b-barrier-apply", [
          { kind: "open" },
          { kind: "sync", saveAs: "sync" },
          {
            kind: "assertWritable",
            epoch: page(deferred, "epoch"),
            saveAs: "staleWrite",
          },
          { kind: "writeEpoch", saveAs: "epoch" },
          { kind: "assertWritable", epoch: "${epoch}", saveAs: "currentWrite" },
          { kind: "status", saveAs: "status" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "close" },
        ]),
      );
      expect(page(applied, "staleWrite")).toMatchObject({ accepted: false });
      expect(page(applied, "currentWrite")).toMatchObject({ accepted: true });
      expect(page(applied, "epoch")).not.toBe(page(deferred, "epoch"));
      expect(page(applied, "page").title).toBe("Barrier remote");
      expect(status(applied, "sync")).toMatchObject({
        conflict: false,
        pending: false,
      });
      expect(status(applied, "status")).toMatchObject({ pending: false });
    },
    TIMEOUT,
  );

  it(
    "recovers a locally committed page after SIGKILL and reopens without duplicates",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      expectOk(
        await run(server, whoA, aStore, "a-crash-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Crash base",
            doc: paragraphDoc("base"),
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      expectOk(
        await run(server, whoB, bStore, "b-crash-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const headBefore = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;

      const readyPath = join(root, "crash.ready");
      const configPath = writeProductConfig(server.root, "a-crash-hold", {
        ...config(server, aStore, whoA, [
          { kind: "open" },
          {
            kind: "createPage",
            title: "Crash page",
            doc: paragraphDoc("written before SIGKILL"),
            saveAs: "page",
          },
          {
            kind: "save",
            pageId: "${page.id}",
            title: "Crash page saved",
            doc: paragraphDoc("durable local body"),
          },
          { kind: "hold", readyPath },
        ]),
      });
      const holder = spawnProductClient(configPath, { root });
      await waitForFile(readyPath);
      const killed = await holder.kill();
      expect(killed.signal).toBe("SIGKILL");
      await holder.result;

      const recovered = expectOk(
        await run(server, whoA, aStore, "a-crash-resume", [
          { kind: "open" },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "pages", saveAs: "pages" },
          { kind: "close" },
        ]),
      );
      const recoveredPages = value(recovered, "pages");
      expect(recoveredPages).toHaveLength(2);
      expect(
        findPageByTitle(recoveredPages, "Crash page saved").doc,
      ).toBeTruthy();
      expect(
        docText(findPageByTitle(recoveredPages, "Crash page saved").doc),
      ).toBe("durable local body");
      expect(status(recovered, "status").pending).toBe(false);
      const headAfter = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;
      // Local create+save may be coalesced into one frozen outbox envelope or
      // sent as two; both are valid. The page must arrive once either way.
      expect(headAfter).toBeGreaterThan(headBefore);
      expect(headAfter).toBeLessThanOrEqual(headBefore + 2);

      const receiver = expectOk(
        await run(server, whoB, bStore, "b-crash-receive", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "pages", saveAs: "pages" },
          { kind: "close" },
        ]),
      );
      expect(value(receiver, "pages")).toHaveLength(2);
      expect(
        findPageByTitle(value(receiver, "pages"), "Crash page saved").doc,
      ).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    "keeps offline work through process exit, server restart and a new connection",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-offline-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Offline base",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-offline-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const baseHead = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;

      const readyPath = join(root, "offline.ready");
      const goPath = join(root, "offline.go");
      const childConfig = writeProductConfig(server.root, "a-offline-child", {
        ...config(server, aStore, whoA, [
          { kind: "open" },
          { kind: "writeFile", path: readyPath, content: "ready" },
          { kind: "waitFile", path: goPath },
          {
            kind: "save",
            pageId,
            title: "Offline edit",
            doc: paragraphDoc("offline body"),
          },
          { kind: "syncExpectError", saveAs: "offlineSync" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      });
      const offlineChild = spawnProductClient(childConfig, { root });
      await waitForFile(readyPath);
      await server.server.close();
      writeFileSync(goPath, "go", { mode: 0o600 });
      const offline = expectOk(await offlineChild.result);
      const offlineAttempt = value(offline, "offlineSync");
      expect(
        offlineAttempt.error ??
          offlineAttempt.status?.pending ??
          status(offline, "status").pending,
      ).toBeTruthy();
      expect(status(offline, "status").pending).toBe(true);

      await restartLevel4Server(server, api);
      const resumed = expectOk(
        await run(server, whoA, aStore, "a-offline-resume", [
          { kind: "open" },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "close" },
        ]),
      );
      expect(status(resumed, "status").pending).toBe(false);
      expect(page(resumed, "page").title).toBe("Offline edit");
      expect(docText(page(resumed, "page").doc)).toBe("offline body");
      expect(
        (await rawHead(server.server.url, server.workspaceId, whoA.token)).head
          .revision,
      ).toBe(baseHead + 1);

      const receiver = expectOk(
        await run(server, whoB, bStore, "b-offline-receive", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(page(receiver, "page").title).toBe("Offline edit");
      expect(status(receiver, "status").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "recovers from an ACK lost strictly after the server committed",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-ack-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "ACK base",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "versions", pageId: "${page.id}", saveAs: "versions" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-ack-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const headBefore = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;

      const proxy = await FaultProxy.start(
        server.server.url,
        "drop-ack-after-commit",
      );
      proxies.add(proxy);
      const proxied = expectOk(
        await runProductClient(server.root, "a-ack-proxied", {
          ...config(server, aStore, whoA, [
            { kind: "open" },
            {
              kind: "save",
              pageId,
              title: "ACK lost",
              doc: paragraphDoc("acked only here"),
            },
            { kind: "syncExpectError", saveAs: "sync" },
            { kind: "status", saveAs: "status" },
            { kind: "close" },
          ]),
          baseUrl: proxy.url,
        }),
      );
      const lostAttempt = value(proxied, "sync");
      expect(
        lostAttempt.error ??
          lostAttempt.status?.pending ??
          status(proxied, "status").pending,
      ).toBeTruthy();
      expect(status(proxied, "status").pending).toBe(true);
      expect(proxy.counts.ackDropped).toBe(1);
      const committedHead = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;
      expect(committedHead).toBe(headBefore + 1);

      const retried = expectOk(
        await run(server, whoA, aStore, "a-ack-retry", [
          { kind: "open" },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "versions", pageId, saveAs: "versions" },
          { kind: "close" },
        ]),
      );
      expect(page(retried, "page").title).toBe("ACK lost");
      expect(status(retried, "status").pending).toBe(false);
      expect(
        (await rawHead(server.server.url, server.workspaceId, whoA.token)).head
          .revision,
      ).toBe(committedHead);

      const receiver = expectOk(
        await run(server, whoB, bStore, "b-ack-receive", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "versions", pageId, saveAs: "versions" },
          { kind: "close" },
        ]),
      );
      expect(page(receiver, "page").title).toBe("ACK lost");
      expect(page(receiver, "versions").length).toBe(
        page(retried, "versions").length,
      );
    },
    TIMEOUT,
  );

  it(
    "rejects a replayed stale change page and resumes from the durable cursor",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-dup-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Duplicate base",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-dup-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      for (const [title, body] of [
        ["Duplicate one", "one"],
        ["Duplicate two", "two"],
      ]) {
        expectOk(
          await run(server, whoA, aStore, `a-dup-${body}`, [
            { kind: "open" },
            { kind: "sync" },
            { kind: "save", pageId, title, doc: paragraphDoc(body) },
            { kind: "sync", saveAs: "sync" },
            { kind: "close" },
          ]),
        );
      }

      const proxy = await FaultProxy.start(
        server.server.url,
        "stale-changes-replay",
      );
      proxies.add(proxy);
      const interrupted = expectOk(
        await runProductClient(server.root, "b-dup-interrupted", {
          ...config(server, bStore, whoB, [
            { kind: "open" },
            { kind: "syncExpectError", saveAs: "sync" },
            { kind: "status", saveAs: "status" },
            { kind: "page", pageId, saveAs: "page" },
            { kind: "close" },
          ]),
          baseUrl: proxy.url,
        }),
      );
      expect(page(interrupted, "page").title).toBe("Duplicate one");
      expect(status(interrupted, "status").appliedRevision).toBeLessThan(
        (await rawHead(server.server.url, server.workspaceId, whoA.token)).head
          .revision,
      );
      expect(proxy.counts.changesReplayed).toBeGreaterThanOrEqual(1);

      const resumed = expectOk(
        await run(server, whoB, bStore, "b-dup-resumed", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "pages", saveAs: "pages" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(page(resumed, "page").title).toBe("Duplicate two");
      expect(value(resumed, "pages")).toHaveLength(1);
      expect(status(resumed, "status").pending).toBe(false);
      expect(status(resumed, "status").appliedRevision).toBe(
        (await rawHead(server.server.url, server.workspaceId, whoA.token)).head
          .revision,
      );
    },
    TIMEOUT,
  );

  it(
    "rejects an out-of-order change page without applying or advancing the cursor",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-reorder-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Reorder base",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-reorder-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const joinedHead = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;
      for (const [title, body] of [
        ["Reorder one", "one"],
        ["Reorder two", "two"],
      ]) {
        expectOk(
          await run(server, whoA, aStore, `a-reorder-${body}`, [
            { kind: "open" },
            { kind: "sync" },
            { kind: "save", pageId, title, doc: paragraphDoc(body) },
            { kind: "sync" },
            { kind: "close" },
          ]),
        );
      }

      const proxy = await FaultProxy.start(
        server.server.url,
        "reorder-changes-once",
      );
      proxies.add(proxy);
      const rejected = expectOk(
        await runProductClient(server.root, "b-reorder-rejected", {
          ...config(server, bStore, whoB, [
            { kind: "open" },
            { kind: "syncExpectError", saveAs: "sync" },
            { kind: "status", saveAs: "status" },
            { kind: "page", pageId, saveAs: "page" },
            { kind: "close" },
          ]),
          baseUrl: proxy.url,
        }),
      );
      expect(value(rejected, "sync").error).toBeTruthy();
      expect(page(rejected, "page").title).toBe("Reorder base");
      expect(status(rejected, "status").appliedRevision).toBe(joinedHead);
      expect(proxy.counts.changesReordered).toBe(1);

      const resumed = expectOk(
        await run(server, whoB, bStore, "b-reorder-resumed", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(page(resumed, "page").title).toBe("Reorder two");
      expect(status(resumed, "status").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "preserves both conflict snapshots across reopen and resolves explicitly to remote",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-conflict-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Conflict shared",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-conflict-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      expectOk(
        await run(server, whoA, aStore, "a-conflict-remote", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "save",
            pageId,
            title: "A remote",
            doc: paragraphDoc("remote"),
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );

      const conflicted = expectOk(
        await run(server, whoB, bStore, "b-conflict-local", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "save",
            pageId,
            title: "B local",
            doc: paragraphDoc("local"),
          },
          { kind: "syncExpectError", saveAs: "push", maxCalls: 6 },
          { kind: "status", saveAs: "status" },
          { kind: "conflict", saveAs: "conflict" },
          { kind: "close" },
        ]),
      );
      const conflict = page(conflicted, "conflict") as Level4Conflict;
      expect(conflict).toBeTruthy();
      expect(status(conflicted, "status").conflict).toBe(true);
      const localCheckpointPage = checkpointPage(
        conflict.operation.checkpoint,
        pageId,
      );
      const remoteCheckpointPage = checkpointPage(
        conflict.result.head.checkpoint,
        pageId,
      );
      expect(localCheckpointPage.title).toBe("B local");
      expect(remoteCheckpointPage.title).toBe("A remote");
      const observedRevision = conflict.result.head.revision;

      // The conflict must survive a fresh process and an unrelated open.
      const reopened = expectOk(
        await run(server, whoB, bStore, "b-conflict-reopen", [
          { kind: "open" },
          { kind: "status", saveAs: "status" },
          { kind: "conflict", saveAs: "conflict" },
          {
            kind: "resolveExpectError",
            choice: "remote",
            expectedRevision: observedRevision - 1,
            saveAs: "wrongRevision",
          },
          { kind: "conflict", saveAs: "afterWrong" },
          { kind: "close" },
        ]),
      );
      expect(status(reopened, "status").conflict).toBe(true);
      expect(value(reopened, "conflict")).toBeTruthy();
      expect(value(reopened, "wrongRevision").error).toBeTruthy();
      expect(value(reopened, "afterWrong")).toBeTruthy();

      const resolved = expectOk(
        await run(server, whoB, bStore, "b-conflict-resolve-remote", [
          { kind: "open" },
          {
            kind: "resolve",
            choice: "remote",
            expectedRevision: observedRevision,
            saveAs: "resolved",
          },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "close" },
        ]),
      );
      expect(page(resolved, "page").title).toBe("A remote");
      expect(docText(page(resolved, "page").doc)).toBe("remote");
      expect(status(resolved, "status").conflict).toBe(false);
      expect(status(resolved, "status").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "resolves a later conflict to the local candidate against the observed head",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-local-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Local shared",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-local-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      expectOk(
        await run(server, whoA, aStore, "a-local-remote", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "save",
            pageId,
            title: "A later",
            doc: paragraphDoc("a later"),
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const conflicted = expectOk(
        await run(server, whoB, bStore, "b-local-conflict", [
          { kind: "open" },
          { kind: "sync" },
          {
            kind: "save",
            pageId,
            title: "B candidate",
            doc: paragraphDoc("b candidate"),
          },
          { kind: "syncExpectError", saveAs: "push", maxCalls: 6 },
          { kind: "conflict", saveAs: "conflict" },
          { kind: "close" },
        ]),
      );
      const conflict = page(conflicted, "conflict") as Level4Conflict;
      const observedRevision = conflict.result.head.revision;
      const resolved = expectOk(
        await run(server, whoB, bStore, "b-local-resolve", [
          { kind: "open" },
          {
            kind: "resolve",
            choice: "local",
            expectedRevision: observedRevision,
            saveAs: "resolved",
          },
          { kind: "sync", saveAs: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "close" },
        ]),
      );
      expect(page(resolved, "page").title).toBe("B candidate");
      expect(status(resolved, "status").conflict).toBe(false);
      expect(status(resolved, "status").pending).toBe(false);
      expect(
        (await rawHead(server.server.url, server.workspaceId, whoA.token)).head
          .revision,
      ).toBe(observedRevision + 1);

      const remote = expectOk(
        await run(server, whoA, aStore, "a-local-receive", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "page", pageId, saveAs: "page" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(page(remote, "page").title).toBe("B candidate");
      expect(docText(page(remote, "page").doc)).toBe("b candidate");
      expect(status(remote, "status").pending).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "denies a token from another workspace on every sync entry",
    async () => {
      const otherWorkspaceId = `ws-other-${randomUUID().slice(0, 12)}`;
      const otherOwnerId = `owner-other-${randomUUID().slice(0, 12)}`;
      const { root, server } = await fixture({
        extraWorkspaces: [
          { workspaceId: otherWorkspaceId, ownerId: otherOwnerId },
        ],
      });
      await registerDevice(server, "a");
      const other = await registerFor(
        server,
        otherWorkspaceId,
        otherOwnerId,
        "other",
      );
      const whoA = identity(server, "a");
      const aStore = workspace(root, "a");
      expectOk(
        await run(server, whoA, aStore, "a-isolation", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Private",
            doc: paragraphDoc("only ws one"),
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );

      const wrongToken = await runProductClient(server.root, "wrong-token", {
        ...config(server, workspace(root, "wrong-token"), other, [
          { kind: "open", mode: "join" },
        ]),
        workspaceId: server.workspaceId,
      });
      expect(wrongToken.ok).toBe(false);
      expect(String(wrongToken.error)).toMatch(
        /401|403|unauthorized|forbidden|workspace/i,
      );

      const wrongWorkspace = await runProductClient(
        server.root,
        "wrong-workspace",
        {
          ...config(server, workspace(root, "wrong-workspace"), whoA, [
            { kind: "open", mode: "join" },
          ]),
          workspaceId: otherWorkspaceId,
        },
      );
      expect(wrongWorkspace.ok).toBe(false);
      expect(String(wrongWorkspace.error)).toMatch(
        /401|403|unauthorized|forbidden|workspace/i,
      );

      await expect(
        rawHead(server.server.url, server.workspaceId, other.token),
      ).rejects.toThrow(/401|unauthorized/i);
      await expect(
        rawHead(server.server.url, otherWorkspaceId, whoA.token),
      ).rejects.toThrow(/401|unauthorized/i);
    },
    TIMEOUT,
  );

  it(
    "stops a revoked device, keeps its local pending work, and persists revocation",
    async () => {
      const { root, server } = await fixture();
      await registerDevice(server, "a");
      await registerDevice(server, "b");
      const aStore = workspace(root, "a");
      const bStore = workspace(root, "b");
      const whoA = identity(server, "a");
      const whoB = identity(server, "b");

      const base = expectOk(
        await run(server, whoA, aStore, "a-revoke-base", [
          { kind: "open", mode: "publish" },
          {
            kind: "createPage",
            title: "Revoke base",
            doc: paragraphDoc("base"),
            saveAs: "page",
          },
          { kind: "sync" },
          {
            kind: "createPage",
            title: "Before revoke",
            doc: paragraphDoc("before"),
          },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const pageId = page(base, "page").id;
      expectOk(
        await run(server, whoB, bStore, "b-revoke-join", [
          { kind: "open", mode: "join" },
          { kind: "sync" },
          { kind: "close" },
        ]),
      );
      const headBefore = (
        await rawHead(server.server.url, server.workspaceId, whoA.token)
      ).head.revision;

      const readyPath = join(root, "revoke.ready");
      const goPath = join(root, "revoke.go");
      const holder = spawnProductClient(
        writeProductConfig(server.root, "a-revoke-holder", {
          ...config(server, aStore, whoA, [
            { kind: "open" },
            { kind: "writeFile", path: readyPath, content: "ready" },
            { kind: "waitFile", path: goPath },
            {
              kind: "save",
              pageId,
              title: "After revoke",
              doc: paragraphDoc("must remain local"),
            },
            { kind: "syncExpectError", saveAs: "sync" },
            { kind: "status", saveAs: "status" },
            { kind: "close" },
          ]),
        }),
        { root },
      );
      await waitForFile(readyPath);
      await server.server.revokeDevice(server.workspaceId, whoA.clientId);
      writeFileSync(goPath, "go", { mode: 0o600 });
      const revoked = expectOk(await holder.result);
      const revokedAttempt = value(revoked, "sync");
      expect(
        revokedAttempt.error ??
          revokedAttempt.status?.pending ??
          status(revoked, "status").pending,
      ).toBeTruthy();
      expect(status(revoked, "status").pending).toBe(true);

      await expect(
        rawHead(server.server.url, server.workspaceId, whoA.token),
      ).rejects.toThrow(/401|unauthorized|forbidden/i);
      await restartLevel4Server(server, api);
      await expect(
        rawHead(server.server.url, server.workspaceId, whoA.token),
      ).rejects.toThrow(/401|unauthorized|forbidden/i);
      expect(
        (await rawHead(server.server.url, server.workspaceId, whoB.token)).head
          .revision,
      ).toBe(headBefore);

      const remaining = expectOk(
        await run(server, whoB, bStore, "b-revoke-still-authorized", [
          { kind: "open" },
          { kind: "sync" },
          { kind: "status", saveAs: "status" },
          { kind: "close" },
        ]),
      );
      expect(status(remaining, "status").pending).toBe(false);
      expect(
        (await rawHead(server.server.url, server.workspaceId, whoB.token)).head
          .revision,
      ).toBe(headBefore);
    },
    TIMEOUT,
  );
});
