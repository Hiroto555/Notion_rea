import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedDemo } from "../scripts/r7-demo-seed";
import { Store } from "../src/persistence/store";
import { recoveryContent, parseRecovery } from "../src/shared/recovery";
import { effectivePageWidth } from "../src/shared/page-layout";
import { validateEditRecovery } from "../src/shared/crash-recovery";
import { exportMixedPortableRecovery, parsePortableRecordRecovery, restorePortableRecordRecoveryToNewWorkspace } from "../src/persistence/portable-recovery";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import type { Page, RecordProjection } from "../src/shared/types";

const roots: string[] = [], stores: Store[] = [];
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const p of roots.splice(0)) rmSync(p, {recursive:true,force:true});});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-r8-width-")); roots.push(root);
  const source = join(root, "source"); mkdirSync(source);
  const ids = seedDemo(join(source,"workspace.sqlite"), undefined, resolve("tests/fixtures/image.png"));
  const store = new Store(join(source,"workspace.sqlite")); stores.push(store);
  return {root, source, ids, store};
}

it("persists width through the real ordinary, record and owner save lanes and reload without altering legacy defaults", async () => {
  const {store, ids} = fixture();
  const normal = store.get(ids.pages[0].id), recordId = ids.records[0].pageId, owner = store.get(ids.database.id);
  expect(effectivePageWidth(normal)).toBe("standard"); expect(effectivePageWidth(owner)).toBe("wide");
  expect(normal.width).toBeUndefined(); expect(owner.width).toBeUndefined();
  const transport = async (request: any) => store.handle(request) as any;
  const sessions = new EditSessionCoordinator(transport);
  const handle = sessions.attach(normal); sessions.edit(handle,{width:"wide"}); await sessions.flush(normal.id);
  const pair = store.handle({type:"record:read",pageId:recordId}) as {page:Page;record:RecordProjection};
  sessions.edit(sessions.attach(pair.page,pair.record), {width:"wide"}); await sessions.flush(recordId);
  const databases = new DatabaseSessionCoordinator(transport);
  const dbRead = store.handle({type:"database:read", databasePageId:owner.id}) as any;
  databases.attach(dbRead.page,dbRead.database);
  databases.editPage(databases.get(owner.id)!.handle,{width:"standard"}); await databases.flush(owner.id);
  expect(sessions.hasUnsaved()).toBe(false); expect(databases.hasUnsaved()).toBe(false);
  expect(store.get(normal.id).width).toBe("wide"); expect(store.get(recordId).width).toBe("wide"); expect(store.get(owner.id).width).toBe("standard");
  store.move(normal.id,null,null);
  expect(store.get(normal.id).width).toBe("wide");
  const reopened = new Store(store.path); stores.push(reopened);
  expect(reopened.get(normal.id).width).toBe("wide"); expect(reopened.get(recordId).width).toBe("wide"); expect(reopened.get(owner.id).width).toBe("standard");
});

it("retains width in crash input and versioned page-only recovery, preserving the source", () => {
  const {store,ids} = fixture(); const page = store.get(ids.pages[0].id);
  const snapshot = validateEditRecovery({sessionId:"width-session",base:{...page,width:"standard"},seq:1,intents:[{seq:1,patch:{width:"wide"}}]});
  expect(snapshot.base.width).toBe("standard"); expect(snapshot.intents[0].patch.width).toBe("wide");
  const content = recoveryContent([page],[{id:page.id,patch:{width:"wide",title:"体裁を復旧"}}]);
  expect(JSON.parse(content).format).toBe("folio-page-recovery"); expect(parseRecovery(content)[0].width).toBe("wide");
  const [copy] = store.recover(JSON.parse(content)); expect(copy.width).toBe("wide"); expect(store.get(page.id)).toEqual(page);
  const old = JSON.parse(content); old.format="folio-recovery";old.schemaVersion=2;
  expect(() => parseRecovery(JSON.stringify(old))).toThrow();
});

it("uses portable format 5 for width and restores normal, record and owner layouts", () => {
  const {store,ids,root,source} = fixture(); const normal = store.get(ids.pages[0].id);
  const record = store.handle({type:"record:read",pageId:ids.records[0].pageId}) as {page:Page;record:RecordProjection};
  const owner = store.get(ids.database.id);
  const content = exportMixedPortableRecovery(store,join(source,"assets"),{
    normalPages:[{page:{...normal,width:"wide"},baseRevision:normal.revision}],
    records:ids.records.map(({pageId}) => {const pair = store.handle({type:"record:read",pageId}) as {page:Page;record:RecordProjection}; return {page:{...pair.page,width:"wide" as const},baseRevision:pair.page.revision,baseValues:pair.record.values,valuesPatch:{}};}),
    databaseSettings:[], ownerPatches:{[owner.id]:{baseRevision:owner.revision,patch:{width:"standard"}}},
  });
  expect(parsePortableRecordRecovery(content).schemaVersion).toBe(5);
  const destination = join(root,"portable");
  restorePortableRecordRecoveryToNewWorkspace(content,destination);
  const restored = new Store(join(destination,"workspace.sqlite")); stores.push(restored);
  expect(restored.pages().find(p=>p.title===normal.title)?.width).toBe("wide");
  expect(restored.pages().find(p=>p.title===record.page.title)?.width).toBe("wide");
  expect(restored.pages().find(p=>p.title===owner.title)?.width).toBe("standard");
});
