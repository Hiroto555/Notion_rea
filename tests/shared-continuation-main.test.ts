import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { createSharedHttpServer } from "../src/collaboration/runtime/http-server";
import type { SharedRuntimeSession } from "../src/shared/shared-runtime-ipc";
import type { Receipt, Scope } from "../src/collaboration/runtime/contract";
import type { SharedCopySource } from "../src/collaboration/runtime/copy";
import type { Doc } from "../src/shared/types";
const paragraph=(id:string,text:string):Doc=>({type:"paragraph",attrs:{id},content:[{type:"text",text}]});
const document=(...content:Doc[]):Doc=>({type:"doc",content});
async function fixture(sources: SharedCopySource[] = []) {
 const root=mkdtempSync(join(tmpdir(),"folio-cont-main-")); const authority=new SharedAuthority(join(root,"authority"));
 const boot=authority.bootstrap({orgId:"org",workspaceId:"ws",documentId:"root",userId:"owner",deviceId:"device",document:document(paragraph("p","root"))});
 const server=createSharedHttpServer(authority);const {url}=await server.listen();
 const service=new SharedRuntimeService(join(root,"main"),undefined,{copySources:ids=>ids.map(id=>sources.find(s=>s.id===id)!),copyCatalog:()=>sources.map(s=>({id:s.id,title:s.title??s.id,kind:"page"}))});
 const request=(input:unknown)=>service.handle(input) as Promise<SharedRuntimeSession>;
 await request({type:"connect",url,orgId:"org",token:boot.token});const state=await request({type:"open",scope:boot.scope});
 return {root,authority,boot,server,service,request,state,url,async close(){service.close();await server.close();authority.close();rmSync(root,{recursive:true,force:true});}};
}
describe("remaining shared main connections",()=>{
 it("publishes a >850k copy and its separately staged binary assets at the final cut",async()=>{
  const bytes=new TextEncoder().encode("attachment bytes");const hash=createHash("sha256").update(bytes).digest("hex");
  const empty=new Uint8Array();const emptyHash=createHash("sha256").update(empty).digest("hex");
  const source:SharedCopySource={id:"source",parentId:null,title:"large",raw:JSON.stringify(document(paragraph("body","x".repeat(900_000)),{type:"image",attrs:{id:"img",src:"folio-asset://"+hash}},{type:"image",attrs:{id:"empty-img",src:"folio-asset://"+emptyHash}})),assets:[{hash,bytes},{hash:emptyHash,bytes:empty}]};
  const original=source.raw;const f=await fixture([source]);try{
   const submit=f.authority.submit.bind(f.authority);let partCount=0;
   f.authority.submit=(token,attempt,hooks)=>{
    if(attempt.intent.command.kind==="resource"&&attempt.intent.command.action==="copy.stage.part"){
     partCount++;expect(f.authority.store.get("asset","org:ws:"+hash)).toBeNull();expect(f.authority.store.all("documents")).toHaveLength(1);
    }
    return submit(token,attempt,hooks);
   };
   const review=await f.service.handle({type:"copyPreview",generation:f.state.generation,sourceIds:["source"]}) as {previewId:string};
   const receipt=await f.service.handle({type:"copyCommit",generation:f.state.generation,previewId:review.previewId}) as Receipt;
   expect(receipt.status).toBe("SERVER_ACCEPTED");expect(partCount).toBeGreaterThan(1);expect(source.raw).toBe(original);
   const copied=f.authority.workspaces(f.boot.token,"org")[0].documents.find(d=>d.documentId!=="root")!;
   const scope:Scope={...f.boot.scope,documentId:copied.documentId,incarnationId:copied.incarnationId};
   expect(f.authority.readAsset(f.boot.token,scope,hash)).toEqual(bytes);expect(f.authority.readAsset(f.boot.token,scope,emptyHash)).toEqual(empty);
   expect(f.authority.store.all("copy.staging").filter(row=>row.key.includes(":part:"))).toHaveLength(0);
   expect(f.authority.store.db.prepare("SELECT COUNT(*) AS n FROM runtime_blobs WHERE scope=?").get("stage:org:ws")?.n ?? 0).toBe(0);
   f.authority.verify();
  }finally{await f.close();}
 },30_000);
 it("reads an old writer's exact draft after recovery without selecting a document or replaying",async()=>{
  const f=await fixture();try{
   const raw='{"preserve":"old writer 原本😀"}';await f.request({type:"draft",generation:f.state.generation,raw});
   const fresh=f.authority.recover("org",f.boot.recoveryKey,"new-device");
   const connected=await f.request({type:"connect",url:f.url,orgId:"org",token:fresh.token});expect(connected.scope).toBeNull();
   const rows=await f.service.handle({type:"recoveryList",generation:connected.generation}) as {entryId:string;writerId:string;kind:string}[];
   const old=rows.find(r=>r.writerId===f.boot.auth.writerId&&r.kind==="document")!;expect(old).toBeDefined();
   const recovered=JSON.parse(await f.service.handle({type:"recoveryRead",generation:connected.generation,entryId:old.entryId}) as string) as {records:{namespace:string;value:{raw?:string}}[]};
   expect(recovered.records.some(r=>r.namespace==="client.editing"&&r.value.raw===raw)).toBe(true);
   expect(f.authority.snapshot(fresh.token,f.boot.scope).state.document.content![0].content![0].text).toBe("root");
  }finally{await f.close();}
 });
 it("lists trash without an active document and restores through a new incarnation",async()=>{
  const f=await fixture();try{
   const receipt=await f.service.handle({type:"resource",generation:f.state.generation,scope:f.boot.scope,command:{kind:"resource",action:"document.trash",payload:{}}}) as Receipt;expect(receipt.status).toBe("SERVER_ACCEPTED");
   const closed=await f.request({type:"closeDocument",generation:f.state.generation});expect(closed.scope).toBeNull();
   const trash=await f.service.handle({type:"admin",command:{action:"trash",scope:f.boot.scope}}) as {scope:Scope}[];expect(trash).toHaveLength(1);
   const incarnation=randomUUID();const restored=await f.service.handle({type:"resource",generation:closed.generation,scope:f.boot.scope,command:{kind:"resource",action:"document.restore",payload:{incarnationId:incarnation}}}) as Receipt;
   expect(restored.status).toBe("SERVER_ACCEPTED");expect(()=>f.authority.snapshot(f.boot.token,f.boot.scope)).toThrow();
   expect(f.authority.snapshot(f.boot.token,{...f.boot.scope,incarnationId:incarnation}).state.document.content![0].content![0].text).toBe("root");
   f.authority.verify();
  }finally{await f.close();}
 });
});
