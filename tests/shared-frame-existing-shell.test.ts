import {describe, expect, it} from "vitest";
import {EditorState, TextSelection} from "@tiptap/pm/state";
import {history, undo} from "@tiptap/pm/history";
import type {Node as PMNode} from "@tiptap/pm/model";
import {documentSchema as schema} from "../src/shared/editor-schema";
import type {Doc} from "../src/shared/types";
import {initialState, locate} from "../src/collaboration/runtime/document";
import {lowerEditorDocument} from "../src/collaboration/runtime/editor-plan";
import {applyBlockFrame, type BlockFrameCommand} from "../src/collaboration/runtime/block-frame";
import {applyEditorBatch} from "../src/collaboration/runtime/editor-batch";
import {projectSharedDocument} from "../src/editor/shared-projection";
import {FolioFrameStep} from "../src/editor/shared-frame-step";
const p=(id:string,text:string):Doc=>({type:"paragraph",attrs:{id},content:[{type:"text",text}]});
const q=(...content:Doc[]):Doc=>({type:"blockquote",attrs:{id:"Q"},content});
const list=(...content:Doc[]):Doc=>({type:"bulletList",attrs:{id:"L"},content:[{type:"listItem",attrs:{id:"I"},content}]});
const doc=(...content:Doc[]):Doc=>({type:"doc",content});
const before=()=>doc(q(p("p1","one"),p("p2","two")),p("p3","three"));
const after=()=>doc(q(p("p2","two")),list(p("p1","one")),p("p3","three"));
function pos(doc:PMNode,id:string):number {let result=-1;doc.descendants((node,pos)=>{if(node.attrs.id===id)result=pos;});if(result<0)throw Error(id);return result;}
describe("existing wrapper shells",()=>{
 it("lowers a child into a new wrapper while keeping old sibling shell and latest retained rich text",()=>{
  const basis=initialState(before()),target=after(),plan=lowerEditorDocument(basis,target,"inc");
  const frame=plan.commands.find(command=>command.kind==="block.frame") as BlockFrameCommand;
  expect(frame.beforeIds).toEqual(["Q"]);expect(frame.retainIds.sort()).toEqual(["p1","p2"]);
  const current=structuredClone(basis);locate(current.document,"p1").node.content=[{type:"text",text:"KEEPone",marks:[{type:"bold"}]}];
  const result=applyEditorBatch(basis,current,plan.commands,"inc");
  expect(locate(result.document,"p1").parent.attrs?.id).toBe("I");
  expect(locate(result.document,"p1").node.content).toEqual([{type:"text",text:"KEEPone",marks:[{type:"bold"}]}]);
  expect(result.tombstones).not.toContain("Q");
  const actual=applyEditorBatch(basis,basis,plan.commands,"inc");
  const inverse=lowerEditorDocument(actual,before(),"inc");
  const undone=applyEditorBatch(actual,actual,inverse.commands,"inc");
  expect(undone.document).toEqual(initialState(before()).document);expect(undone.tombstones).toEqual(expect.arrayContaining(["L","I"]));
 });
 it("handles nested new wrappers around a changed existing shell once",()=>{
  const basis=initialState(before());
  const target=doc({type:"blockquote",attrs:{id:"OUTER"},content:[q(p("p2","two"),list(p("p1","one")))]},p("p3","three"));
  const plan=lowerEditorDocument(basis,target,"inc");
  expect(applyEditorBatch(basis,basis,plan.commands,"inc").document).toEqual(initialState(target).document);
  expect(projectSharedDocument(schema.nodeFromJSON(before()),schema.nodeFromJSON(target)).doc.eq(schema.nodeFromJSON(target))).toBe(true);
 });
 it("refuses unobserved extra shell child without modifying input",()=>{
  const basis=initialState(before()),plan=lowerEditorDocument(basis,after(),"inc");
  const current=structuredClone(basis);locate(current.document,"Q").node.content!.push(p("remote","KEEP"));
  const saved=structuredClone(current);
  expect(()=>applyEditorBatch(basis,current,plan.commands,"inc")).toThrow("DELETE_CONFLICT");expect(current).toEqual(saved);
 });
 it("compares dropped text and marks without rejecting edits inside retained siblings",()=>{
  const basis=initialState(doc({type:"bulletList",attrs:{id:"L"},content:[{type:"listItem",attrs:{id:"I1"},content:[p("p1","one")]},{type:"listItem",attrs:{id:"I2"},content:[p("p2","two")]},{type:"listItem",attrs:{id:"I3"},content:[p("p3","three")]}]}));
  const command:BlockFrameCommand={kind:"block.frame",parentId:null,beforeIds:["L"],retainIds:["p1","p3"],after:[p("p1","one"),p("p3","three")]};
  const current=structuredClone(basis);locate(current.document,"p2").node.content=[{type:"text",text:"two REMOTE",marks:[{type:"bold"}]}];
  expect(()=>applyBlockFrame(current,command,basis)).toThrow("DELETE_CONFLICT");
  const retained=structuredClone(basis);locate(retained.document,"p1").node.content=[{type:"text",text:"KEEP"}];
  expect(locate(applyBlockFrame(retained,command,basis).state.document,"p1").node.content![0].text).toBe("KEEP");
 });
 it("refuses outside collisions and text/table nodes masquerading as shells",()=>{
  const basis=initialState(before()),plan=lowerEditorDocument(basis,after(),"inc");
  const frame=structuredClone(plan.commands.find(command=>command.kind==="block.frame") as BlockFrameCommand);
  frame.after[1].attrs!.id="p3";
  expect(()=>applyBlockFrame(basis,frame,basis)).toThrow();
  const textShell:BlockFrameCommand={kind:"block.frame",parentId:null,beforeIds:["Q"],retainIds:["p2"],after:[q(p("p1","replaced"),p("p2","two"))]};
  expect(()=>applyBlockFrame(basis,textShell,basis)).toThrow("FRAME_CONFLICT");
  const table:Doc={type:"table",attrs:{id:"T"},content:[{type:"tableRow",attrs:{id:"R"},content:[{type:"tableCell",attrs:{id:"C"},content:[p("P","table")]}]}]};
  const tableState={document:doc(table),tables:[],tombstones:[]};
  const tableShell:BlockFrameCommand={kind:"block.frame",parentId:null,beforeIds:["T"],retainIds:["P"],after:[table]};
  expect(()=>applyBlockFrame(tableState,tableShell,tableState)).toThrow("FRAME_CONFLICT");
 });
 it("projects shells in both directions and maps selected/own history text",()=>{
  const initial=schema.nodeFromJSON(before()),x=pos(initial,"p1");
  let state=EditorState.create({doc:initial,schema,plugins:[history()],selection:TextSelection.create(initial,x+2)});
  state=state.apply(state.tr.insertText("!",x+4));
  const target=after();locate(target,"p1").node.content=[{type:"text",text:"KEEPone!"}];
  const pmTarget=schema.nodeFromJSON(target),projection=projectSharedDocument(state.doc,pmTarget);
  const transaction=state.tr;for(const step of projection.steps)transaction.step(step);transaction.setMeta("addToHistory",false);
  state=state.apply(transaction);expect(state.doc.eq(pmTarget)).toBe(true);
  expect(state.selection.from).toBe(pos(state.doc,"p1")+1+1+4);
  let undone=state;expect(undo(state,tr=>{undone=state.apply(tr);})).toBe(true);
  expect(undone.doc.textContent).toContain("KEEPone");expect(undone.doc.textContent).not.toContain("!");
  expect(projectSharedDocument(schema.nodeFromJSON(after()),initial).doc.eq(initial)).toBe(true);
 });
 it("rejects template reuse of descendant already embedded by a retained ancestor",()=>{
  const source=schema.nodeFromJSON(doc(q(p("p1","a"),p("X","b"))));
  const step=FolioFrameStep.create(source,{parentId:null,spanIds:["Q"],retainedIds:["Q"],template:[{type:"blockquote",attrs:{id:"L"},content:[q(p("p1","a")),p("X","b")]}]});
  expect(step.apply(source).failed).toContain("FRAME_ID_COLLISION:X");
 });
});

it("persists existing-shell wrap and own Undo over HTTP while refusing unseen dropped content",async()=>{
 const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{randomUUID}=await import("node:crypto");
 const {SharedAuthority}=await import("../src/collaboration/runtime/authority"),{SharedRuntimeClient}=await import("../src/collaboration/runtime/client"),{HttpSharedProvider}=await import("../src/collaboration/runtime/http-provider"),{createSharedHttpServer}=await import("../src/collaboration/runtime/http-server");
 const root=mkdtempSync(join(tmpdir(),"folio-frame-shell-http-")),authority=new SharedAuthority(join(root,"server"));
 const boot=authority.bootstrap({orgId:"org",userId:"owner",deviceId:"device",workspaceId:"ws",documentId:"page",document:before()});
 const server=createSharedHttpServer(authority),{url}=await server.listen(),client=new SharedRuntimeClient(join(root,"client"),new HttpSharedProvider(url,boot.token),boot.scope,boot.auth.writerId);
 try{
  const base=await client.open();
  const remote=structuredClone(base.state.document);locate(remote,"p1").node.content=[{type:"text",text:"KEEPone",marks:[{type:"bold"}]}];
  const remoteCommand={kind:"batch" as const,commands:lowerEditorDocument(base.state,remote,"inc").commands};
  const accepted=authority.submit(boot.token,{v:1,attemptId:randomUUID(),base:authority.head(),intent:{v:1,intentId:randomUUID(),writerId:boot.auth.writerId,scope:boot.scope,base:base.cut,command:remoteCommand}});
  expect(accepted.status).toBe("SERVER_ACCEPTED");
  const wrapped=await client.submit({kind:"batch",commands:lowerEditorDocument(base.state,after(),boot.scope.incarnationId).commands});
  expect(wrapped.receipt.status).toBe("SERVER_ACCEPTED");expect(locate(wrapped.snapshot.state.document,"p1").node.content![0].text).toBe("KEEPone");
  const undone=await client.historyStep("undo");expect(undone.receipt.status).toBe("SERVER_ACCEPTED");expect(locate(undone.snapshot.state.document,"p1").parent.attrs?.id).toBe("Q");expect(locate(undone.snapshot.state.document,"p1").node.content![0].text).toBe("KEEPone");
  const beforeDelete=undone.snapshot;
  const remoteDeleteBasis=structuredClone(beforeDelete.state.document);locate(remoteDeleteBasis,"p2").node.content=[{type:"text",text:"two REMOTE"}];
  const write=authority.submit(boot.token,{v:1,attemptId:randomUUID(),base:authority.head(),intent:{v:1,intentId:randomUUID(),writerId:boot.auth.writerId,scope:boot.scope,base:beforeDelete.cut,command:{kind:"batch",commands:lowerEditorDocument(beforeDelete.state,remoteDeleteBasis,boot.scope.incarnationId).commands}}});
  expect(write.status).toBe("SERVER_ACCEPTED");
  const dropped=await client.submit({kind:"batch",commands:[{kind:"block.frame",parentId:null,beforeIds:["Q"],retainIds:["p1"],after:[locate(beforeDelete.state.document,"p1").node]}]});
  expect(dropped.receipt).toMatchObject({status:"REJECTED",code:"DELETE_CONFLICT"});expect(locate(dropped.snapshot.state.document,"p2").node.content![0].text).toBe("two REMOTE");authority.verify();
 }finally{client.close();await server.close();authority.close();rmSync(root,{recursive:true,force:true});}
});
