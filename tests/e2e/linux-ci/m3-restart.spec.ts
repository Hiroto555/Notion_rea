import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../src/persistence/store";
import { initializeOperationalServer, issueOperationalCredential, startOperationalServer } from "../../../src/sync/operational-server";
import { readIssuedSyncCredential } from "../../../src/sync/server-ops-config";
import { openWorkspaceSync, type WorkspaceSync } from "../../../src/sync/workspace-sync";
import type { CheckpointServerHandle } from "../../../src/sync/checkpoint-server";
import { M3GuiFixture, freeLoopbackPort } from "./m3-runtime";

let fixture: M3GuiFixture, server: CheckpointServerHandle | undefined, peerStore: Store | undefined;
let peer: WorkspaceSync, pageId: string, environment: Record<string,string>;
const workspaceId = "m3-restart-workspace";
test.beforeEach(async () => {
  fixture = new M3GuiFixture();
  const host = join(fixture.root, "host"), handoff = join(fixture.root, "handoff");
  mkdirSync(host, {mode: 0o700}); mkdirSync(handoff, {mode: 0o700});
  const serverDirectory = join(host, "server"), port = await freeLoopbackPort();
  await initializeOperationalServer(serverDirectory, {format: "folio-server-config/v1", workspaceId, ownerId: "owner", port});
  for (const clientId of ["gui", "peer"]) await issueOperationalCredential({directory: serverDirectory, clientId, credentialFile: join(handoff, clientId + ".json")});
  const credential = readIssuedSyncCredential(join(handoff, "gui.json")), other = readIssuedSyncCredential(join(handoff, "peer.json"));
  server = await startOperationalServer(serverDirectory);
  const initial = new Store(join(fixture.directory, "workspace.sqlite"));
  mkdirSync(join(fixture.directory, "assets"), {mode: 0o700});
  const page = initial.create(null, "page", "Shared base"); pageId = page.id;
  const bindingId = randomUUID();
  const publisher = await openWorkspaceSync({store: initial, ...credential, bindingId, mode: "publish", canApply: () => true});
  await publisher.sendPending(); initial.close();
  environment = {FOLIO_SYNC_ENABLED: "1", FOLIO_SYNC_URL: credential.baseUrl, FOLIO_SYNC_WORKSPACE: workspaceId,
    FOLIO_SYNC_CLIENT: credential.clientId, FOLIO_SYNC_BINDING: bindingId, FOLIO_SYNC_TOKEN: credential.token};
  const peerDirectory = join(fixture.root, "peer"); mkdirSync(peerDirectory, {mode: 0o700}); mkdirSync(join(peerDirectory, "assets"), {mode: 0o700});
  peerStore = new Store(join(peerDirectory, "workspace.sqlite"));
  peer = await openWorkspaceSync({store: peerStore, ...other, bindingId: randomUUID(), mode: "join", canApply: () => true});
  await peer.receiveAndStage(); await peer.applyStaged(peer.stagedTarget()!);
  await fixture.start(environment);
  await expect(fixture.window!.locator(".page-title")).toHaveValue("Shared base");
});
test.afterEach(async () => {try {await fixture?.dispose();} finally {peerStore?.close(); peerStore = undefined; await server?.close(); server = undefined;}});
async function load() {return fixture.window!.evaluate(() => window.folio.request<any>({type: "load"}));}
async function syncState() {return fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:status"}));}
async function transfer() {
  await fixture.window!.getByRole("button", {name: "同期", exact: true}).click();
  await expect.poll(async () => (await syncState()).running).toBe(false);
}
function readSql(query: string) {
  const db = new DatabaseSync(join(fixture.directory, "workspace.sqlite"), {readOnly: true});
  try {return db.prepare(query).all();} finally {db.close();}
}

test("real normal apply is provisional, cancellable and applied once only after all windows close", async () => {
  const added = peerStore!.create(null, "page", "Remote addition"); await peer.sendPending();
  await transfer();
  await expect.poll(async () => (await syncState()).workspace?.receivedCursor).toBe(2);
  expect((await syncState()).workspace.appliedRevision).toBe(1);
  expect((await load()).pages.some((page: any) => page.id === added.id)).toBe(false);
  await fixture.window!.getByRole("button", {name: "適用を予約", exact: true}).click();
  await expect.poll(() => fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:restartStatus"})).then(v => v.state)).toBe("requested");
  expect((await load()).pages.some((page: any) => page.id === added.id)).toBe(false);
  await fixture.window!.getByRole("button", {name: "予約を取り消す", exact: true}).click();
  await expect.poll(() => fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:restartStatus"})).then(v => v.state)).toBe("idle");
  await fixture.window!.getByRole("button", {name: "適用を予約", exact: true}).click();
  await expect.poll(() => fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:restartStatus"})).then(v => v.state)).toBe("requested");
  await fixture.quit(); await fixture.start(environment);
  expect((await syncState()).workspace.appliedRevision).toBe(2);
  expect((await load()).pages.filter((page: any) => page.id === added.id)).toHaveLength(1);
  await fixture.quit(); await fixture.start(environment);
  expect((await syncState()).workspace.appliedRevision).toBe(2);
  expect((await load()).pages.filter((page: any) => page.id === added.id)).toHaveLength(1);
});

test("real conflict choice preserves both candidates and latest local content before one restart apply", async () => {
  peerStore!.update(pageId, peerStore!.get(pageId).revision, {title: "Remote winner"}); await peer.sendPending();
  await fixture.window!.locator(".page-title").fill("Local candidate");
  await expect(fixture.window!.locator(".save-state[data-state]")).toHaveText("保存済み");
  await transfer();
  await expect.poll(async () => (await syncState()).workspace?.conflict).toBe(true);
  await fixture.window!.locator(".page-title").fill("Latest local content");
  await expect(fixture.window!.locator(".save-state[data-state]")).toHaveText("保存済み");
  await fixture.window!.getByRole("button", {name: "競合候補", exact: true}).click();
  const reviewButton = fixture.window!.getByRole("button", {name: "リモート版を使う内容を確認", exact: true});
  await expect(reviewButton).toBeEnabled(); await reviewButton.click();
  const review = fixture.window!.getByRole("region", {name: "競合の選択内容を確認", exact: true});
  await expect(review).toBeVisible();
  await expect(review).toContainText("Latest local content"); await expect(review).toContainText("Remote winner");
  await expect(review).toContainText("競合時点より後の保存内容があります");
  const confirm = review.getByRole("button", {name: "この選択を終了時に確定する準備", exact: true});
  await expect(confirm).toBeDisabled();
  await review.getByRole("checkbox").check(); await expect(confirm).toBeEnabled(); await confirm.click();
  await expect.poll(() => fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:conflictDecisionStatus"})).then(v => v.state)).toBe("requested");
  expect((await load()).pages.find((page: any) => page.id === pageId).title).toBe("Latest local content");
  expect(readSql("SELECT * FROM workspace_sync_archives")).toHaveLength(0);
  await fixture.quit(); await fixture.start(environment);
  expect((await load()).pages.find((page: any) => page.id === pageId).title).toBe("Remote winner");
  expect((await syncState()).workspace.conflict).toBe(false);
  const archives = readSql("SELECT kind,checkpoint_json FROM workspace_sync_archives ORDER BY id");
  expect(archives.map(row => row.kind)).toEqual(expect.arrayContaining(["conflict-local", "conflict-remote", "choose-remote-latest"]));
  expect(JSON.stringify(archives).includes("Local candidate")).toBe(true);
  expect(JSON.stringify(archives).includes("Latest local content")).toBe(true);
  expect(JSON.stringify(archives).includes("Remote winner")).toBe(true);
  await fixture.quit(); await fixture.start(environment);
  expect(readSql("SELECT kind,checkpoint_json FROM workspace_sync_archives ORDER BY id")).toEqual(archives);
  expect((await load()).pages.find((page: any) => page.id === pageId).title).toBe("Remote winner");
});
