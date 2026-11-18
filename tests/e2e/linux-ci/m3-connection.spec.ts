import { test, expect, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { M3GuiFixture, freeLoopbackPort } from "./m3-runtime";
import { initializeOperationalServer, issueOperationalCredential, startOperationalServer } from "../../../src/sync/operational-server";
import { readIssuedSyncCredential, type IssuedSyncCredential } from "../../../src/sync/server-ops-config";
import type { CheckpointServerHandle } from "../../../src/sync/checkpoint-server";
import type { SyncConnectionView } from "../../../src/shared/sync-management";

let fixture: M3GuiFixture, server: CheckpointServerHandle | undefined;
let serverDirectory: string, handoff: string;
const workspaceId = "m3-connection", clientId = "gui-device";
test.beforeEach(async () => {
  fixture = new M3GuiFixture();
  const host = join(fixture.root, "host"); handoff = join(fixture.root, "handoff");
  mkdirSync(host, {mode: 0o700}); mkdirSync(handoff, {mode: 0o700});
  serverDirectory = join(host, "server");
  await initializeOperationalServer(serverDirectory, {format: "folio-server-config/v1", workspaceId, ownerId: "owner", port: await freeLoopbackPort()});
});
test.afterEach(async () => {try {await fixture?.dispose();} finally {await server?.close(); server = undefined;}});
async function issue(name = "first") {
  const file = join(handoff, name + ".json");
  await issueOperationalCredential({directory: serverDirectory, clientId, credentialFile: file});
  return readIssuedSyncCredential(file);
}
async function state() {return fixture.window!.evaluate(() => window.folio.request<SyncConnectionView>({type: "sync:connectionStatus"}));}
async function fill(dialog: Locator, credential: IssuedSyncCredential) {
  await dialog.getByLabel("URL", {exact: true}).fill(credential.baseUrl);
  await dialog.getByLabel("ワークスペース ID", {exact: true}).fill(credential.workspaceId);
  await dialog.getByLabel("クライアント ID", {exact: true}).fill(credential.clientId);
  await dialog.getByLabel("サーバー発行トークン", {exact: true}).fill(credential.token);
  await dialog.getByLabel("接続モード", {exact: true}).selectOption("publish");
}
async function save(credential: IssuedSyncCredential) {
  const dialog = await fixture.openSettings(); await fill(dialog, credential);
  await dialog.getByRole("button", {name: "接続情報を保存", exact: true}).click();
  await expect.poll(async () => (await state()).state).toBe("pending-restart");
  await expect(dialog.getByLabel("サーバー発行トークン", {exact: true})).toHaveValue("");
  return dialog;
}
function assertNoPlaintext(token: string) {
  for (const name of readdirSync(fixture.vaultDirectory))
    expect(readFileSync(join(fixture.vaultDirectory, name)).includes(Buffer.from(token))).toBe(false);
}

test("real Secret Service saves only ciphertext and activates publish only after restart", async () => {
  const credential = await issue(); server = await startOperationalServer(serverDirectory);
  await fixture.start();
  expect(await fixture.app!.evaluate(({safeStorage}) => safeStorage.getSelectedStorageBackend())).toBe("gnome_libsecret");
  const original = await fixture.window!.evaluate(() => window.folio.request<any>({type: "load"}));
  const dialog = await save(credential);
  const view = await state();
  expect(view.hasCredential).toBe(true); expect(JSON.stringify(view).includes(credential.token)).toBe(false);
  expect((await fixture.window!.evaluate(() => window.folio.request<any>({type: "load"}))).pages).toEqual(original.pages);
  assertNoPlaintext(credential.token);
  const head = await fetch(credential.baseUrl + `/v1/workspaces/${workspaceId}/head`, {headers: {Authorization: "Bearer " + credential.token}}).then(r => r.json());
  expect(head.head.revision).toBe(0);
  await dialog.getByRole("button", {name: "同期設定を閉じる"}).click();
  await fixture.quit(); await fixture.start();
  expect((await state()).state).toBe("configured");
  const sync = await fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:status"}));
  expect(sync).toMatchObject({available: true, connection: "connected", workspace: {appliedRevision: 1}});
  const db = new DatabaseSync(join(fixture.directory, "workspace.sqlite"), {readOnly: true});
  try {expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(5);} finally {db.close();}
  assertNoPlaintext(credential.token);
});

test("real token rotation preserves binding and disable persists over legacy environment", async () => {
  const first = await issue(); server = await startOperationalServer(serverDirectory);
  await fixture.start(); await save(first); await fixture.quit(); await fixture.start();
  const binding = readFileSync(join(fixture.directory, ".folio-sync-binding"));
  await server.close(); server = undefined;
  const rotated = await issue("rotated"); server = await startOperationalServer(serverDirectory);
  expect((await fetch(first.baseUrl + `/v1/workspaces/${workspaceId}/head`, {headers: {Authorization: "Bearer " + first.token}})).status).toBe(401);
  await save(rotated); await fixture.quit(); await fixture.start();
  expect((await state()).state).toBe("configured");
  expect(readFileSync(join(fixture.directory, ".folio-sync-binding")).equals(binding)).toBe(true);
  const dialog = await fixture.openSettings();
  await dialog.getByRole("button", {name: "接続を無効化", exact: true}).click();
  await expect.poll(async () => (await state()).state).toBe("disabled");
  expect((await state()).hasCredential).toBe(false);
  const run = await fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:run"}));
  expect(run).toMatchObject({available: true, connection: "disconnected", lastError: "sync-disabled"});
  await fixture.quit();
  await fixture.start({FOLIO_SYNC_ENABLED: "1", FOLIO_SYNC_URL: rotated.baseUrl, FOLIO_SYNC_WORKSPACE: workspaceId,
    FOLIO_SYNC_CLIENT: clientId, FOLIO_SYNC_BINDING: randomUUID(), FOLIO_SYNC_TOKEN: rotated.token});
  expect((await state()).state).toBe("disabled");
  expect(await fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:status"}))).toMatchObject({available: false, reason: "not-connected"});
  assertNoPlaintext(rotated.token);
});

test("basic_text fails closed and permits local disable without secure encryption", async () => {
  const credential = await issue(); server = await startOperationalServer(serverDirectory);
  await fixture.start({}, "basic");
  const dialog = await fixture.openSettings(); await fill(dialog, credential);
  await dialog.getByRole("button", {name: "接続情報を保存", exact: true}).click();
  await expect.poll(async () => (await state()).reason).toBe("secure-store-unavailable");
  expect((await state()).hasCredential).toBe(false); assertNoPlaintext(credential.token);
  await expect(dialog.getByLabel("サーバー発行トークン", {exact: true})).toHaveValue("");
  await expect(dialog.getByRole("button", {name: "接続を無効化", exact: true})).toBeEnabled();
  await dialog.getByRole("button", {name: "接続を無効化", exact: true}).click();
  await expect.poll(async () => (await state()).state).toBe("disabled");
});

test("a lost configure response resolves the original request and stale CAS cannot replace it", async () => {
  const credential = await issue(); server = await startOperationalServer(serverDirectory);
  await fixture.start();
  await fixture.app!.evaluate(({ipcMain}) => {
    const original = (ipcMain as any)._invokeHandlers.get("folio:request"); let lost = false;
    ipcMain.removeHandler("folio:request");
    ipcMain.handle("folio:request", async (event, input) => {
      const result = await original(event, input);
      if (input?.type === "sync:connectionConfigure" && !lost) {lost = true; throw new Error("synthetic lost management acknowledgement");}
      return result;
    });
  });
  const dialog = await fixture.openSettings(); await fill(dialog, credential);
  await dialog.getByRole("button", {name: "接続情報を保存", exact: true}).click();
  await expect(dialog.getByText("保存結果を確認できませんでした。更新して状態を確認してください。", {exact: true})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "接続情報を保存", exact: true})).toBeDisabled();
  await dialog.getByRole("button", {name: "接続状態を更新", exact: true}).click();
  await expect.poll(async () => (await state()).state).toBe("pending-restart");
  await expect(dialog.getByRole("button", {name: "接続情報を保存", exact: true})).toBeEnabled();
  const view = await state();
  const stale = await fixture.window!.evaluate(input => window.folio.request<any>({type: "sync:connectionConfigure", input}),
    {requestId: randomUUID(), expectedRevision: null, baseUrl: credential.baseUrl, workspaceId, clientId, token: credential.token, mode: "publish" as const});
  expect(stale).toMatchObject({outcome: "held", view: {reason: "conflict"}});
  expect((await state()).revision).toBe(view.revision);
  const db = new DatabaseSync(join(fixture.vaultDirectory, "connections.sqlite"), {readOnly: true});
  try {expect(db.prepare("SELECT COUNT(*) AS n FROM m3_private_records WHERE key LIKE '%:request:%'").get()!.n).toBe(1);} finally {db.close();}
  assertNoPlaintext(credential.token);
  await fixture.stop();
  const copy = join(fixture.root, "copied"); mkdirSync(copy, {mode: 0o700});
  copyFileSync(join(fixture.directory, "workspace.sqlite"), join(copy, "workspace.sqlite"));
  await fixture.start({FOLIO_DATA_DIR: copy});
  expect((await state()).hasCredential).toBe(false);
  expect(await fixture.window!.evaluate(() => window.folio.request<any>({type: "sync:status"}))).toMatchObject({available: false});
});
