import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Store } from "../src/persistence/store";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";
import { buildWorkspaceCheckpoint, validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { RecordRepository } from "../src/persistence/record-repository";
import { attachBuffer, decodeAttachment } from "../src/persistence/assets";
import { attachmentNode, attachmentPayload } from "../src/editor/external-attachments";
import { assertImportedImages, assertImageSource, assertSupportedRichMarkdown } from "../src/document-io/rich-html-guard";
import { isDocument } from "../src/shared/types";

function fixture(promote = false) {
  const dir = mkdtempSync(join(tmpdir(), "folio-purge-")), assets = join(dir, "assets");
  mkdirSync(assets);
  const store = new Store(join(dir, "workspace.sqlite"));
  onTestFinished(() => {store.close(); rmSync(dir, {recursive: true, force: true});});
  if (promote) new WorkspaceSyncStore(store, {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch"})
    .enable("publish", () => {});
  return {store, assets};
}

it("purges only a confirmed deleted subtree, refusing new trash or a live child atomically", () => {
  const {store} = fixture();
  const parent = store.create(null, "page", "parent"), child = store.create(parent.id, "page", "child");
  const other = store.create(null, "page", "unrelated");
  store.update(child.id, 0, {title: "revised"});
  store.trash(parent.id);
  const expected = store.pages().filter(p => p.deletedAt !== null).map(({id, revision}) => ({id, revision}));
  store.trash(other.id);
  expect(() => store.handle({type: "purgeTrash", expected})).toThrow(/確認後/);
  const deleted = store.get(child.id);
  store.write({...deleted, deletedAt: null});
  expect(() => store.handle({type: "purgeTrash", id: parent.id})).toThrow(/使用中/);
  expect(store.versions(child.id)).toHaveLength(1);
  store.write(deleted);
  expect(store.handle({type: "purgeTrash", id: parent.id})).toEqual([parent.id, child.id]);
  expect(store.versions(child.id)).toHaveLength(0);
  expect(store.pages().map(p => p.id)).toEqual([other.id]);
  expect(store.handle({type: "purgeTrash"})).toEqual([other.id]);
});

it("purges v5 database membership, version and trash rows under generation triggers", () => {
  const {store} = fixture(true);
  const owner = store.create(null, "database", "db");
  const repo = new RecordRepository(store), row = repo.create(owner.id, "row", {});
  repo.patch(row.pageId, owner.id, 0, {title: "new title"});
  store.handle({type: "trash", id: owner.id});
  const generation = () => Number(store.db.prepare("SELECT generation FROM workspace_sync_state").get()!.generation);
  const before = generation();
  expect(new Set(store.handle({type: "purgeTrash", id: owner.id}) as string[])).toEqual(new Set([owner.id, row.pageId]));
  expect(generation()).toBeGreaterThan(before);
  expect(validateWorkspaceCheckpoint(buildWorkspaceCheckpoint(store.db))).toBe(true);
  expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const table of ["versions","record_value_versions","record_databases","record_memberships","record_database_trash_members","record_database_trash_batches"])
    expect(store.db.prepare("SELECT count(*) n FROM " + table).get()!.n).toBe(0);
});

it("preserves legacy ID reservations and their registered owner", () => {
  const {store} = fixture(true), owner = store.create(null, "database", "migrated");
  store.db.prepare("INSERT INTO legacy_database_archive(database_page_id,data) VALUES(?,?)").run(owner.id, JSON.stringify(owner));
  store.db.prepare("INSERT INTO legacy_record_map(database_page_id,legacy_row_id,page_id) VALUES(?,?,?)").run(owner.id, "old", "reserved");
  expect(validateWorkspaceCheckpoint(buildWorkspaceCheckpoint(store.db))).toBe(true);
  store.handle({type: "trash", id: owner.id});
  expect(() => store.handle({type: "purgeTrash"})).toThrow(/ID対応表/);
  expect(store.get(owner.id).deletedAt).not.toBeNull();
  expect(store.db.prepare("SELECT page_id FROM legacy_record_map").get()!.page_id).toBe("reserved");
});

it("saves pasted bytes through exact capacity admission, keeps files after purge and preserves old inline images", async () => {
  const {store, assets} = fixture(), bytes = new Uint8Array(50001).fill(0xab);
  const input = await attachmentPayload(new File([bytes], "image.png", {type: "image/png"}));
  const decoded = decodeAttachment(input.dataBase64);
  expect(decoded).toEqual(Buffer.from(bytes));
  expect(() => decodeAttachment("A!B=")).toThrow();
  expect(() => attachBuffer(store.db, assets, input.name, input.mime, decoded, () => {throw new Error("capacity");})).toThrow("capacity");
  expect(readdirSync(assets)).toEqual([]);
  const image = attachBuffer(store.db, assets, input.name, input.mime, decoded, n => expect(n).toBe(bytes.length));
  expect(attachmentNode(image)).toMatchObject({type: "image", attrs: {src: image.url}});
  expect(attachmentNode({...image, image: false})).toMatchObject({type: "paragraph"});
  const page = store.create(null, "page");
  store.trash(page.id); store.handle({type: "purgeTrash"});
  expect(readFileSync(join(assets, image.id))).toEqual(decoded);
  const src = "data:image/png;base64,AA==";
  expect(isDocument({type: "doc", content: [{type: "image", attrs: {src}}]})).toBe(true);
  expect(() => assertImportedImages({type: "doc", content: [{type: "image", attrs: {src}}]})).toThrow(/添付/);
  expect(() => assertImageSource(src)).toThrow(/添付/);
  expect(() => assertSupportedRichMarkdown("![画像](" + src + ")")).toThrow(/添付/);
  expect(() => assertSupportedRichMarkdown("`![画像](" + src + ")`")).not.toThrow();
});


it("preserves pages already included in a pending sync commit", () => {
  const {store} = fixture(true), page = store.create(null, "page", "pending");
  const sync = new WorkspaceSyncStore(store, {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch"});
  expect(sync.prepare()).not.toBeNull();
  store.trash(page.id);
  expect(() => store.handle({type: "purgeTrash", id: page.id})).toThrow(/同期/);
  expect(store.get(page.id).deletedAt).not.toBeNull();
});
