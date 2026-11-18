import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {SharedAuthority} from "../src/collaboration/runtime/authority";
import {SharedRuntimeService} from "../src/main/shared-runtime-service";
import {createSharedHttpServer} from "../src/collaboration/runtime/http-server";
import {previewSharedCopy,type SharedCopySource} from "../src/collaboration/runtime/copy";
import {sharedCopyTransfer} from "../src/main/shared-copy-transfer";
import type {Command,Receipt,Scope} from "../src/collaboration/runtime/contract";
import type {SharedRuntimeSession} from "../src/shared/shared-runtime-ipc";
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),"folio-abandon-main-")),authority=new SharedAuthority(join(root,"server"));
 const boot=authority.bootstrap({orgId:"org",workspaceId:"ws",documentId:"page",userId:"owner",deviceId:"device",document:{type:"doc",content:[{type:"paragraph",attrs:{id:"p"},content:[{type:"text",text:"root"}]}]}});
 const server=createSharedHttpServer(authority),{url}=await server.listen();
 let service=new SharedRuntimeService(join(root,"main"));
 let session=await service.handle({type:"connect",url,orgId:"org",token:boot.token}) as SharedRuntimeSession;
 const submit=(command:Command,scope:Scope=boot.scope)=>authority.submit(boot.token,{v:1,attemptId:randomUUID(),base:authority.head(),intent:{v:1,intentId:randomUUID(),writerId:boot.auth.writerId,scope,base:authority.head(),command}});
 const stage=(copyId:string)=>{
  const source:SharedCopySource={id:"source",parentId:null,title:"private",raw:JSON.stringify({type:"doc",content:[{type:"paragraph",attrs:{id:"private-p"},content:[{type:"text",text:"PRIVATE-UNPUBLISHED"}]}]}),assets:[]};
  const preview=previewSharedCopy([source],["source"],{orgId:"org",workspaceId:"ws"},()=>"destination-"+copyId),transfer=sharedCopyTransfer([source],preview,copyId);
  expect(submit({kind:"resource",action:"copy.stage.prepare",payload:{manifest:transfer.manifest} as never}).status).toBe("SERVER_ACCEPTED");
  transfer.parts.forEach((raw,index)=>expect(submit({kind:"resource",action:"copy.stage.part",payload:{copyId,index,raw}}).status).toBe("SERVER_ACCEPTED"));return transfer;
 };
 return {root,authority,boot,server,url,submit,stage,get service(){return service;},get session(){return session;},
  async reopen(){service.close();service=new SharedRuntimeService(join(root,"main"));session=await service.handle({type:"connect",url,orgId:"org",token:boot.token}) as SharedRuntimeSession;return session;},
  async close(){service.close();await server.close();authority.close();rmSync(root,{recursive:true,force:true});}};
}
const list=async(f:Awaited<ReturnType<typeof fixture>>,scope=f.boot.scope)=>f.service.handle({type:"admin",command:{action:"copyStages",scope}}) as Promise<{scope:Scope;copyId:string;manifestHash:string;stagedParts:number}[]>;
describe("explicit staged copy abandonment main connection",()=>{
 it("lists metadata after process reopen and explicitly abandons with durable receipt, no document open",async()=>{
  const f=await fixture();try{
   const transfer=f.stage("cancel-me");await f.reopen();expect(f.session.scope).toBeNull();
   const rows=await list(f);expect(rows).toEqual([{scope:f.boot.scope,copyId:"cancel-me",manifestHash:transfer.manifestHash,stagedParts:transfer.parts.length}]);expect(JSON.stringify(rows)).not.toContain("PRIVATE");
   const receipt=await f.service.handle({type:"copyAbandon",generation:f.session.generation,scope:rows[0].scope,copyId:rows[0].copyId,manifestHash:rows[0].manifestHash}) as Receipt;
   expect(receipt.status).toBe("SERVER_ACCEPTED");expect(await list(f)).toEqual([]);
   expect(f.authority.store.all("copy.staging").filter(row=>row.key.includes(":part:"))).toHaveLength(0);expect(f.authority.store.all("documents")).toHaveLength(1);f.authority.verify();
  }finally{await f.close();}
 });
 it("isolates actor metadata and refuses wrong manifest, stale generation and pending document draft",async()=>{
  const f=await fixture();try{
   const transfer=f.stage("guarded");
   const invite=f.authority.invite(f.boot.token,"org","bob"),bob=f.authority.acceptInvite(invite,"bob-device");f.authority.grant(f.boot.token,f.boot.scope,"bob","editor");
   expect(f.authority.copyStageList(bob.token,f.boot.scope)).toEqual([]);
   const request={type:"copyAbandon",generation:f.session.generation,scope:f.boot.scope,copyId:"guarded",manifestHash:transfer.manifestHash};
   await expect(f.service.handle({...request,generation:999})).rejects.toThrow("STALE_SHARED_SESSION");
   await expect(f.service.handle({type:"resource",generation:f.session.generation,scope:f.boot.scope,command:{kind:"resource",action:"copy.stage.abandon",payload:{copyId:"guarded",manifestHash:transfer.manifestHash}}})).rejects.toThrow("COPY_ABANDON_REQUIRES_TYPED_REQUEST");
   const opened=await f.service.handle({type:"open",scope:f.boot.scope}) as SharedRuntimeSession;
   await f.service.handle({type:"draft",generation:opened.generation,raw:"unsaved draft"});
   await expect(f.service.handle({...request,generation:opened.generation})).rejects.toThrow("PENDING_INTENT_BLOCKS_WRITE");
   expect(await list(f)).toHaveLength(1);
   await f.service.handle({type:"parkDraft",generation:opened.generation});
   const rejected=await f.service.handle({...request,generation:opened.generation,manifestHash:"0".repeat(64)}) as Receipt;expect(rejected).toMatchObject({status:"REJECTED",code:"COPY_MANIFEST_HASH_MISMATCH"});expect(await list(f)).toHaveLength(1);
  }finally{await f.close();}
 });
 it("abandons a staged copy after its original anchor is trashed without restoring that document",async()=>{
  const f=await fixture();try{
   const transfer=f.stage("trash-anchor");
   expect(f.submit({kind:"resource",action:"document.create",payload:{document:{type:"doc",content:[{type:"paragraph",attrs:{id:"p2"},content:[{type:"text",text:"other"}]}]},title:"other"}},{...f.boot.scope,documentId:"other",incarnationId:"other-inc"}).status).toBe("SERVER_ACCEPTED");
   expect(f.submit({kind:"resource",action:"document.trash",payload:{}}).status).toBe("SERVER_ACCEPTED");
   const active={...f.boot.scope,documentId:"other",incarnationId:"other-inc"};expect(await list(f,active)).toHaveLength(1);
   const receipt=await f.service.handle({type:"copyAbandon",generation:f.session.generation,scope:f.boot.scope,copyId:"trash-anchor",manifestHash:transfer.manifestHash}) as Receipt;
   expect(receipt.status).toBe("SERVER_ACCEPTED");expect(()=>f.authority.snapshot(f.boot.token,f.boot.scope)).toThrow();expect(await list(f,active)).toEqual([]);expect(f.authority.store.all("documents")).toHaveLength(2);f.authority.verify();
  }finally{await f.close();}
 });
 it("keeps UNKNOWN after lost abandonment receipt and blocks further attempts until reconciliation",async()=>{
  const f=await fixture();try{
   const transfer=f.stage("lost");let lose=true;const original=f.authority.submit.bind(f.authority);
   f.authority.submit=(token,attempt,hooks)=>{const result=original(token,attempt,hooks);if(lose&&attempt.intent.command.kind==="resource"&&attempt.intent.command.action==="copy.stage.abandon"){lose=false;throw Error("lost response");}return result;};
   const request={type:"copyAbandon",generation:f.session.generation,scope:f.boot.scope,copyId:"lost",manifestHash:transfer.manifestHash};
   await expect(f.service.handle(request)).rejects.toThrow();
   const unknown=await f.service.handle({type:"list"}) as SharedRuntimeSession;expect(unknown.pendingIntents?.some(row=>row.state==="UNKNOWN")).toBe(true);
   const count=f.authority.store.all("authority.attempts").length;
   await expect(f.service.handle(request)).rejects.toThrow("PENDING_INTENT_BLOCKS_WRITE");expect(f.authority.store.all("authority.attempts")).toHaveLength(count);
   await f.service.handle({type:"resourceReconcile",generation:f.session.generation});const settled=await f.service.handle({type:"list"}) as SharedRuntimeSession;expect(settled.pendingIntents).toEqual([]);expect(await list(f)).toEqual([]);
  }finally{await f.close();}
 });
});
