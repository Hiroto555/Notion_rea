import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedDemo } from "../scripts/r7-demo-seed";
import { Store } from "../src/persistence/store";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";
import { requestSchema } from "../src/shared/types";
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const p of roots.splice(0)) rmSync(p,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"folio-r8-service-"));roots.push(root);
  const source=join(root,"source");mkdirSync(source);
  seedDemo(join(source,"workspace.sqlite"),undefined,resolve("tests/fixtures/image.png"));
  const store=new Store(join(source,"workspace.sqlite"));stores.push(store);
  return {root,source,store,service:new WorkspaceBackupService(store.db,source)};
}
it("pins a verified backup, restores to a fresh child and launches only that destination once",async()=>{
  const {root,service,store}=fixture();const original=store.pages();
  const preview=service.create();expect(preview.inventory.records).toBe(4);
  const chosen=service.choose(preview.directory);const result=service.restore(chosen.ticket,root);
  expect(result.directory).not.toBe(preview.directory);expect(result.sourceDirectory).toBe(preview.directory);
  const launched:string[]=[];
  await expect(service.open(chosen.ticket,async p=>{launched.push(p);})).rejects.toThrow();
  await service.open(result.ticket,async p=>{launched.push(p);});
  await expect(service.open(result.ticket,async p=>{launched.push(p);})).rejects.toThrow();
  expect(launched).toEqual([result.directory]);expect(store.pages()).toEqual(original);
});
it("refuses stale manifests before creating any restore target and keeps renderer paths out of IPC",()=>{
  const {root,service}=fixture();const preview=service.create();
  const file=join(preview.directory,"manifest.json");const value=JSON.parse(readFileSync(file,"utf8"));value.createdAt="2026-11-01T00:00:00.000Z";writeFileSync(file,JSON.stringify(value));
  const before=readdirSync(root);expect(()=>service.restore(preview.ticket,root)).toThrow();expect(readdirSync(root)).toEqual(before);
  expect(requestSchema.safeParse({type:"workspaceBackup:restore",ticket:preview.ticket,destination:"/tmp/arbitrary"}).success).toBe(false);
  expect(requestSchema.safeParse({type:"workspaceBackup:open",ticket:preview.ticket,executable:"/bin/sh"}).success).toBe(false);
});
