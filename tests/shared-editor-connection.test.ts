import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import { createSharedHttpServer } from "../src/collaboration/runtime/http-server";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import { lowerEditorDocument } from "../src/collaboration/runtime/editor-plan";
import { locate } from "../src/collaboration/runtime/document";
import type { Doc } from "../src/shared/types";
import type { SharedRuntimeSession } from "../src/shared/shared-runtime-ipc";
import type { Command, Cut } from "../src/collaboration/runtime/contract";
const p = (id: string, text: string): Doc => ({type: "paragraph", attrs: {id}, content: [{type: "text", text}]});
const doc = (...content: Doc[]): Doc => ({type: "doc", schemaVersion: 1, content});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "folio-editor-connected-"));
  const authority = new SharedAuthority(join(root, "server"));
  const boot = authority.bootstrap({orgId:"org",userId:"owner",deviceId:"device",workspaceId:"ws",documentId:"page",document:doc(p("a","abc"),p("b","def"))});
  const server = createSharedHttpServer(authority); const {url} = await server.listen();
  const service = new SharedRuntimeService(join(root, "local"));
  const request = (input: unknown) => service.handle(input) as Promise<SharedRuntimeSession>;
  let state = await request({type:"connect",url,orgId:"org",token:boot.token});
  state = await request({type:"open",scope:boot.scope});
  const submit = (command: Command, base: Cut = authority.head()) => authority.submit(boot.token,{v:1,attemptId:randomUUID(),base:authority.head(),intent:{v:1,intentId:randomUUID(),writerId:boot.auth.writerId,scope:boot.scope,base,command}});
  return {root, authority, boot, service, server, url, request, state, submit,
    async close() {service.close();await server.close();authority.close();rmSync(root,{recursive:true,force:true});}};
}
describe("normal rich Editor -> main -> actual HTTP -> SQLite", () => {
  it("connects marks, multiple blocks, Enter, move and main Undo without private save", async () => {
    const f = await setup(); try {
      let next = structuredClone(f.state.snapshot!.state.document);
      next.content![0].content![0].marks = [{type:"bold"}];
      next.content![1].content![0].text = "日本語😀";
      let s = await f.request({type:"editorDocument",generation:f.state.generation,base:f.state.snapshot!.cut,document:next});
      expect(s.view.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(locate(s.snapshot!.state.document,"a").node.content![0].marks).toEqual([{type:"bold"}]);
      expect(locate(s.snapshot!.state.document,"b").node.content![0].text).toBe("日本語😀");
      next = structuredClone(s.snapshot!.state.document);
      next.content!.reverse();
      s = await f.request({type:"editorDocument",generation:s.generation,base:s.snapshot!.cut,document:next});
      expect(s.snapshot!.state.document.content![0].attrs!.id).toBe("b");
      s = await f.request({type:"undo",generation:s.generation});
      expect(s.snapshot!.state.document.content![0].attrs!.id).toBe("a");
      s = await f.request({type:"undo",generation:s.generation});
      expect(locate(s.snapshot!.state.document,"a").node.content![0].marks).toBeUndefined();
      expect(locate(s.snapshot!.state.document,"b").node.content![0].text).toBe("def");
      s = await f.request({type:"redo",generation:s.generation});
      expect(locate(s.snapshot!.state.document,"a").node.content![0].marks).toEqual([{type:"bold"}]);
      f.authority.verify();
    } finally {await f.close();}
  });
  it("merges concurrent marks at one trusted base and undo preserves earlier remote marks", async () => {
    const f = await setup(); const client = new SharedRuntimeClient(join(f.root,"second"),new HttpSharedProvider(f.url,f.boot.token),f.boot.scope,f.boot.auth.writerId);
    try {
      const first = await client.open(); const stale = structuredClone(first.state.document);
      const remote = structuredClone(first.state.document); remote.content![0].content![0].marks = [{type:"italic"}];
      expect(f.submit({kind:"batch",commands:lowerEditorDocument(first.state,remote,f.boot.scope.incarnationId).commands},first.cut).status).toBe("SERVER_ACCEPTED");
      stale.content![0].content![0].marks = [{type:"bold"}];
      const result = await client.submit({kind:"batch",commands:lowerEditorDocument(first.state,stale,f.boot.scope.incarnationId).commands});
      expect(result.receipt.status).toBe("SERVER_ACCEPTED");
      expect(locate(result.snapshot.state.document,"a").node.content![0].marks!.map(m=>m.type).sort()).toEqual(["bold","italic"]);
      const undone = await client.historyStep("undo"); expect(undone.receipt.status).toBe("SERVER_ACCEPTED");
      expect(locate(undone.snapshot.state.document,"a").node.content![0].marks).toEqual([{type:"italic"}]);
      f.authority.verify();
    } finally {client.close();await f.close();}
  });
  it("rejects fabricated before content and rolls back all earlier atoms", async () => {
    const f = await setup(); try {
      const original = f.authority.snapshot(f.boot.token,f.boot.scope);
      const receipt = f.submit({kind:"batch",commands:[{kind:"block.move",blockId:"a",parentId:null,beforeId:null},{kind:"inline",blockId:"a",before:[{type:"text",text:"forged"}],after:[{type:"text",text:"lost"}]}]});
      expect(receipt).toMatchObject({status:"REJECTED",code:"EDITOR_SOURCE_MISMATCH"});
      expect(f.authority.snapshot(f.boot.token,f.boot.scope).state).toEqual(original.state);
      f.authority.verify();
    } finally {await f.close();}
  });
  it("refuses stale delete over accepted remote batch text and keeps raw immutable", async () => {
    const f = await setup(); try {
      const first = f.authority.snapshot(f.boot.token,f.boot.scope);
      const next = structuredClone(first.state.document); next.content![0].content![0].text = "KEEPabc";
      expect(f.submit({kind:"batch",commands:lowerEditorDocument(first.state,next,f.boot.scope.incarnationId).commands},first.cut).status).toBe("SERVER_ACCEPTED");
      const receipt = f.submit({kind:"batch",commands:[{kind:"block.delete",blockId:"a"}]},first.cut);
      expect(receipt.status).toBe("REJECTED");
      expect(locate(f.authority.snapshot(f.boot.token,f.boot.scope).state.document,"a").node.content![0].text).toBe("KEEPabc");
      f.authority.verify();
    } finally {await f.close();}
  });
});

describe("editor maintenance and migration over actual stored state", () => {
  it("verifies an editor backup artifact after writer fencing, compacts, migrates and restores protocol 1004", async () => {
    const {RuntimeStore} = await import("../src/collaboration/runtime/store");
    const {readRuntimeProtocol} = await import("../src/collaboration/runtime/protocol-migration");
    const f = await setup(); let verification: InstanceType<typeof RuntimeStore> | undefined; let restored: InstanceType<typeof RuntimeStore> | undefined; let client: SharedRuntimeClient | undefined;
    try {
      let next = structuredClone(f.state.snapshot!.state.document);next.content![0].content![0].text = "editor backup";
      await f.request({type:"editorDocument",generation:f.state.generation,base:f.state.snapshot!.cut,document:next});
      const artifact = f.authority.backup(f.boot.token,"org");
      const recovered = f.authority.recover("org",f.boot.recoveryKey,"new-device");
      verification = new RuntimeStore(join(f.root,"verified-old"));
      const proof = f.authority.verifyBackupArtifact(recovered.token,"org",artifact,verification,"artifact-restore");
      expect(f.authority.retention(recovered.token,"org").compact(proof.cut,proof).removed).toBeGreaterThan(0);
      f.authority.verify();
      restored = new RuntimeStore(join(f.root,"verify-upgrade"));
      const currentProof = f.authority.retention(recovered.token,"org").verifyBackup(f.authority.head(),restored,"upgrade-restore");
      expect(f.authority.upgradeProtocol(recovered.token,"org",currentProof.backupHash)).toMatchObject({status:"COMMITTED",protocol:1004});
      f.authority.verify();
      const base = f.authority.head();
      expect(()=>f.authority.submit(recovered.token,{v:1,attemptId:randomUUID(),base,intent:{v:1,intentId:randomUUID(),writerId:recovered.auth.writerId,scope:f.boot.scope,base,command:{kind:"block.move",blockId:"a",parentId:null,beforeId:null}}})).toThrow("WRITER_VERSION_MISMATCH");
      client = new SharedRuntimeClient(join(f.root,"protocol-client"),new HttpSharedProvider(f.url,recovered.token),f.boot.scope,recovered.auth.writerId);
      const opened = await client.open();next = structuredClone(opened.state.document);next.content![0].content![0].marks=[{type:"bold"}];
      const accepted = await client.submit({kind:"batch",commands:lowerEditorDocument(opened.state,next,f.boot.scope.incarnationId).commands});
      expect(accepted.receipt.status).toBe("SERVER_ACCEPTED");expect(client.entries().at(-1)!.attempts[0].attempt.protocol).toBe(1004);
      const finalDestination = new RuntimeStore(join(f.root,"protocol-restored"));
      try {
        f.authority.retention(recovered.token,"org").verifyBackup(f.authority.head(),finalDestination,"restored-upgraded");
        expect(readRuntimeProtocol(finalDestination,"org").protocol).toBe(1004);
      } finally {finalDestination.close();}
    } finally {client?.close();verification?.close();restored?.close();await f.close();}
  });
  it("saves toggle summary edits and refuses undo that would overwrite a later remote move", async () => {
    const f = await setup();try {
      let next = structuredClone(f.state.snapshot!.state.document);
      next.content!.push({type:"details",attrs:{id:"toggle"},content:[{type:"detailsSummary",attrs:{id:"summary"},content:[{type:"text",text:"before"}]},{type:"detailsContent",attrs:{id:"inside"},content:[p("inside-p","body")]}]});
      let s = await f.request({type:"editorDocument",generation:f.state.generation,base:f.state.snapshot!.cut,document:next});
      next = structuredClone(s.snapshot!.state.document);locate(next,"summary").node.content![0].text="after";
      s = await f.request({type:"editorDocument",generation:s.generation,base:s.snapshot!.cut,document:next});
      expect(locate(s.snapshot!.state.document,"summary").node.content![0].text).toBe("after");
      next = structuredClone(s.snapshot!.state.document);const moved=next.content!.splice(0,1)[0];next.content!.push(moved);
      s = await f.request({type:"editorDocument",generation:s.generation,base:s.snapshot!.cut,document:next});
      expect(f.submit({kind:"block.move",blockId:"a",parentId:"inside",beforeId:"inside-p"}).status).toBe("SERVER_ACCEPTED");
      s = await f.request({type:"undo",generation:s.generation});
      expect(s.view.state).toBe("REJECTED");expect(locate(s.snapshot!.state.document,"a").parent.attrs!.id).toBe("inside");
      f.authority.verify();
    } finally {await f.close();}
  });
  it("maps concurrent marked inserts through an Enter split without losing text", async () => {
    const f = await setup();try {
      const base=f.authority.snapshot(f.boot.token,f.boot.scope);const remote=structuredClone(base.state.document);
      remote.content![0].content=[{type:"text",text:"KEEP",marks:[{type:"bold"}]},{type:"text",text:"abc"}];
      expect(f.submit({kind:"batch",commands:lowerEditorDocument(base.state,remote,f.boot.scope.incarnationId).commands},base.cut).status).toBe("SERVER_ACCEPTED");
      const receipt=f.submit({kind:"batch",commands:[{kind:"block.split",blockId:"a",offset:1,newId:"split-p"}]},base.cut);
      expect(receipt.status).toBe("SERVER_ACCEPTED");const state=f.authority.snapshot(f.boot.token,f.boot.scope).state;
      expect(locate(state.document,"a").node.content!.map(n=>n.text??"").join("")).toBe("KEEPa");
      expect(locate(state.document,"split-p").node.content!.map(n=>n.text??"").join("")).toBe("bc");
    } finally {await f.close();}
  });
});


describe("unknown history resolution", () => {
 it("recovers accepted own history after a lost receipt and keeps later remote text on undo", async () => {
  const f = await setup();
  const provider = new HttpSharedProvider(f.url, f.boot.token);
  let lose = true;
  const client = new SharedRuntimeClient(join(f.root, "lost-client"), {
    snapshot: provider.snapshot.bind(provider), protocol: provider.protocol.bind(provider),
    receipt: provider.receipt.bind(provider), invalidate: provider.invalidate.bind(provider),
    proof: provider.proof.bind(provider), workspaces: provider.workspaces.bind(provider), close: provider.close.bind(provider),
    submit: async attempt => {const result = await provider.submit(attempt); if(lose) {lose=false;throw new Error("LOST_RECEIPT");} return result;},
  }, f.boot.scope, f.boot.auth.writerId);
  try {
   const base = await client.open();const next = structuredClone(base.state.document);next.content![0].content![0].text = "Xabc";
   await expect(client.submit({kind:"batch",commands:lowerEditorDocument(base.state,next,f.boot.scope.incarnationId).commands})).rejects.toThrow("LOST_RECEIPT");
   await client.reconcile();expect(client.history.canUndo()).toBe(true);
   const current = f.authority.snapshot(f.boot.token,f.boot.scope);const remote = structuredClone(current.state.document);remote.content![1].content![0].text = "KEEPdef";
   expect(f.submit({kind:"batch",commands:lowerEditorDocument(current.state,remote,f.boot.scope.incarnationId).commands}).status).toBe("SERVER_ACCEPTED");
   const undone = await client.historyStep("undo");expect(undone.receipt.status).toBe("SERVER_ACCEPTED");
   expect(locate(undone.snapshot.state.document,"a").node.content![0].text).toBe("abc");
   expect(locate(undone.snapshot.state.document,"b").node.content![0].text).toBe("KEEPdef");
  } finally {client.close();await f.close();}
 });
});


describe("normal editor wrapping over main and HTTP", () => {
 it("wraps and unwraps a list through own undo while carrying later remote text", async () => {
  const f=await setup();try {
   const before=f.state.snapshot!;
   const after=structuredClone(before.state.document);const a=after.content!.shift()!;
   after.content!.unshift({type:"bulletList",attrs:{id:"list"},content:[{type:"listItem",attrs:{id:"item"},content:[a]}]});
   let s=await f.request({type:"editorDocument",generation:f.state.generation,base:before.cut,document:after});
   expect(s.view.state).toBe("CLIENT_RECEIPT_DURABLE");expect(locate(s.snapshot!.state.document,"a").parent.attrs!.id).toBe("item");
   expect(f.submit({kind:"text",blockId:"a",from:0,to:0,text:"KEEP",before:"abc"}).status).toBe("SERVER_ACCEPTED");
   s=await f.request({type:"undo",generation:s.generation});expect(s.view.state).toBe("CLIENT_RECEIPT_DURABLE");
   expect(s.snapshot!.state.document.content![0].attrs!.id).toBe("a");expect(locate(s.snapshot!.state.document,"a").node.content![0].text).toBe("KEEPabc");
   s=await f.request({type:"redo",generation:s.generation});expect(s.view.state).toBe("CLIENT_RECEIPT_DURABLE");
   expect(s.snapshot!.state.document.content![0].type).toBe("bulletList");expect(s.snapshot!.state.document.content![0].attrs!.id).not.toBe("list");
   expect(locate(s.snapshot!.state.document,"a").node.content![0].text).toBe("KEEPabc");f.authority.verify();
  }finally{await f.close();}
 });
});
