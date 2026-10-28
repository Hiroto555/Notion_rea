import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { requestSchema } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(resolve("output/record-page-owner-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const a = store.create(null, "database", "A");
  const b = store.create(null, "database", "B");
  const ordinary = store.create(null, "page", "ordinary");
  const records = new RecordRepository(store);
  store.transaction(() => { records.createSchema(); records.registerDatabase(a.id); records.registerDatabase(b.id); });
  const row = records.create(a.id, "record", { status: "initial" });
  return { root, store, a, b, ordinary, row, records, dispose() { store.close(); rmSync(root, {recursive:true, force:true}); } };
}
const doc = {type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"body"}]}]};
function raw(store:Store,id:string) { return store.db.prepare("SELECT data FROM pages WHERE id=?").get(id)?.data; }
function historyCount(store:Store,id:string) { return store.db.prepare("SELECT count(*) AS n FROM versions WHERE pageId=?").get(id)?.n; }

it("atomically saves a bound title and body, increments revision and snapshots values", () => {
  const f=fixture();
  try {
    const saved=f.store.handle({type:"record:pageUpdate",pageId:f.row.pageId,databasePageId:f.a.id,revision:0,patch:{title:"saved",doc}}) as ReturnType<Store["get"]>;
    expect(saved).toMatchObject({id:f.row.pageId,title:"saved",revision:1,doc});
    expect(f.records.projection(saved.id)).toMatchObject({title:"saved",revision:1,values:{status:"initial"}});
    const h=f.store.db.prepare("SELECT v.title,v.doc,r.values_json FROM versions v JOIN record_value_versions r ON r.version_id=v.id WHERE v.pageId=?").get(saved.id) as {title:string;doc:string;values_json:string};
    expect(h.title).toBe("record");
    expect(JSON.parse(h.values_json)).toEqual({status:"initial"});
    expect(() => f.store.updateRecordPage(saved.id,f.a.id,0,{title:"stale"})).toThrow(/競合/);
    expect(() => f.records.patch(saved.id,f.a.id,0,{values:{status:"stale"}})).toThrow(/競合/);
    expect(f.store.get(saved.id)).toEqual(saved);
  } finally { f.dispose(); }
});

it("rejects wrong owner, missing membership, unregistered/deleted owner and deleted Page without changing source or history", () => {
  const f=fixture();
  try {
    const id=f.row.pageId, before=raw(f.store,id), count=historyCount(f.store,id);
    expect(() => f.store.updateRecordPage(id,f.b.id,0,{title:"wrong"})).toThrow();
    f.store.db.prepare("UPDATE record_memberships SET database_page_id=? WHERE page_id=?").run(f.b.id,id);
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{title:"moved"})).toThrow();
    f.store.db.prepare("UPDATE record_memberships SET database_page_id=? WHERE page_id=?").run(f.a.id,id);
    f.store.db.prepare("DELETE FROM record_databases WHERE database_page_id=?").run(f.a.id);
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{title:"unregistered"})).toThrow();
    f.store.db.prepare("INSERT INTO record_databases(database_page_id) VALUES(?)").run(f.a.id);
    f.store.write({...f.a,deletedAt:1});
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{title:"owner deleted"})).toThrow();
    f.store.write(f.a);
    const page=f.store.get(id);
    f.store.write({...page,deletedAt:1});
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{title:"deleted"})).toThrow();
    f.store.write(page);
    f.store.db.prepare("DELETE FROM record_memberships WHERE page_id=?").run(id);
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{title:"missing"})).toThrow();
    expect(raw(f.store,id)).toBe(before);
    expect(historyCount(f.store,id)).toBe(count);
  } finally { f.dispose(); }
});

it("refuses unknown request and patch fields, empty patch and invalid document before writing", () => {
  const f=fixture();
  try {
    const req={type:"record:pageUpdate",pageId:f.row.pageId,databasePageId:f.a.id,revision:0,patch:{title:"safe"}};
    expect(requestSchema.safeParse({...req,extra:true}).success).toBe(false);
    expect(requestSchema.safeParse({...req,revision:Number.MAX_SAFE_INTEGER}).success).toBe(false);
    for (const patch of [{title:"bad",extra:true},{database:null},{},{doc:{type:"unknown",bad:true}},{title:undefined},{title:undefined,doc}]) {
      expect(requestSchema.safeParse({...req,patch}).success).toBe(false);
      expect(() => f.store.updateRecordPage(f.row.pageId,f.a.id,0,patch as any)).toThrow();
    }
    expect(f.store.get(f.row.pageId).revision).toBe(0);
    expect(historyCount(f.store,f.row.pageId)).toBe(0);
  } finally { f.dispose(); }
});

it("keeps unknown owner and malformed record values byte-for-byte without writing history", () => {
  const f=fixture();
  try {
    const id=f.row.pageId, ownerRaw=raw(f.store,f.a.id) as string, pageRaw=raw(f.store,id);
    const unknown=JSON.parse(ownerRaw);
    unknown.database.futureSchema={ preserved:true };
    const bytes=JSON.stringify(unknown);
    f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(bytes,f.a.id);
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{doc})).toThrow();
    expect(raw(f.store,f.a.id)).toBe(bytes);
    expect(raw(f.store,id)).toBe(pageRaw);
    f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(ownerRaw,f.a.id);
    f.store.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?").run("{invalid",id);
    expect(() => f.store.updateRecordPage(id,f.a.id,0,{favorite:true})).toThrow();
    expect(f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(id)?.values_json).toBe("{invalid");
    expect(raw(f.store,id)).toBe(pageRaw);
    expect(historyCount(f.store,id)).toBe(0);
  } finally { f.dispose(); }
});

it("refuses an unknown source document without altering its raw bytes", () => {
  const f=fixture();
  try {
    const page=JSON.parse(raw(f.store,f.row.pageId) as string);
    page.doc={type:"doc",schemaVersion:999,content:[]};
    const original=JSON.stringify(page);
    f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(original,f.row.pageId);
    expect(() => f.store.updateRecordPage(f.row.pageId,f.a.id,0,{title:"overwrite"})).toThrow();
    expect(raw(f.store,f.row.pageId)).toBe(original);
    expect(historyCount(f.store,f.row.pageId)).toBe(0);
  } finally { f.dispose(); }
});

it("refuses generic writes if a v4 record schema is incomplete", () => {
  const f=fixture();
  try {
    f.store.transaction(() => markRecordStoreVersion(f.store.db));
    f.store.db.exec("DROP TABLE record_memberships");
    const before=raw(f.store,f.row.pageId);
    expect(() => f.store.update(f.row.pageId,0,{title:"cannot classify"})).toThrow(/record store/);
    expect(raw(f.store,f.row.pageId)).toBe(before);
  } finally { f.dispose(); }
});

it("refuses generic writes if an experimental v3 record schema becomes incomplete", () => {
  const f=fixture();
  try {
    expect(f.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    f.store.db.exec("DROP TABLE record_memberships");
    const before=raw(f.store,f.row.pageId);
    expect(() => f.store.update(f.row.pageId,0,{title:"cannot classify"})).toThrow(/record store/);
    expect(raw(f.store,f.row.pageId)).toBe(before);
  } finally { f.dispose(); }
});

it("refuses generic update even when an ordinary Page becomes a record after it was read", () => {
  const f=fixture(), other=new Store(f.store.path);
  try {
    const viewed=f.store.get(f.ordinary.id);
    other.transaction(() => new RecordRepository(other).attachForMigration(viewed.id,f.a.id,1,{}));
    const before=raw(f.store,viewed.id);
    expect(() => f.store.update(viewed.id,viewed.revision,{title:"wrong generic"})).toThrow(/所有/);
    expect(raw(f.store,viewed.id)).toBe(before);
    expect(historyCount(f.store,viewed.id)).toBe(0);
    expect(f.store.updateRecordPage(viewed.id,f.a.id,viewed.revision,{title:"bound"}).title).toBe("bound");
  } finally { other.close(); f.dispose(); }
});

it("rejects a membership change committed by a second connection before a bound write", () => {
  const f=fixture(), other=new Store(f.store.path);
  try {
    const original=f.records.readSnapshot(f.row.pageId);
    other.transaction(() => other.db.prepare("UPDATE record_memberships SET database_page_id=? WHERE page_id=?").run(f.b.id,f.row.pageId));
    const before=raw(f.store,f.row.pageId);
    expect(() => f.store.updateRecordPage(original.page.id,f.a.id,original.page.revision,{doc})).toThrow(/所有/);
    expect(raw(f.store,f.row.pageId)).toBe(before);
    expect(historyCount(f.store,f.row.pageId)).toBe(0);
    expect(f.store.updateRecordPage(original.page.id,f.b.id,0,{doc}).doc).toEqual(doc);
  } finally { other.close(); f.dispose(); }
});

it("rolls back Page and history together on write failure and keeps generic v3 behavior", () => {
  const f=fixture();
  try {
    f.store.db.exec("CREATE TRIGGER fail_owner_write BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    const before=raw(f.store,f.row.pageId);
    expect(() => f.store.updateRecordPage(f.row.pageId,f.a.id,0,{title:"no",doc})).toThrow(/synthetic failure/);
    expect(raw(f.store,f.row.pageId)).toBe(before);
    expect(historyCount(f.store,f.row.pageId)).toBe(0);
    f.store.db.exec("DROP TRIGGER fail_owner_write");
    expect(f.store.update(f.ordinary.id,0,{title:"normal"}).title).toBe("normal");
  } finally { f.dispose(); }
});

it("retains record history restore and record duplication after a bound Page save", () => {
  const f=fixture();
  try {
    const first=f.store.updateRecordPage(f.row.pageId,f.a.id,0,{title:"new",doc});
    const version=f.store.versions(first.id)[0];
    const restored=f.store.handle({type:"restoreVersion",id:first.id,versionId:version.id,revision:first.revision}) as ReturnType<Store["get"]>;
    expect(restored.title).toBe("record");
    expect(f.records.projection(first.id).values).toEqual({status:"initial"});
    const copy=f.store.handle({type:"record:duplicate",pageId:first.id,revision:restored.revision}) as {pageId:string;databasePageId:string};
    expect(copy.databasePageId).toBe(f.a.id);
    expect(f.records.projection(copy.pageId).title).toBe("record のコピー");
  } finally { f.dispose(); }
});
