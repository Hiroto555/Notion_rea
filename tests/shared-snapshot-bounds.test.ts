import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {SharedAuthority} from '../src/collaboration/runtime/authority';
import {createSharedHttpServer} from '../src/collaboration/runtime/http-server';
import {HttpSharedProvider} from '../src/collaboration/runtime/http-provider';
import {SharedRuntimeClient} from '../src/collaboration/runtime/client';
import {previewSharedCopy} from '../src/collaboration/runtime/copy';
import {sharedCopyTransfer} from '../src/main/shared-copy-transfer';
import {CollaborationError} from '../src/collaboration/runtime/contract';
import type {Command} from '../src/collaboration/runtime/contract';
async function fixture(text="base") {
 const root=mkdtempSync(join(tmpdir(),'folio-state-bounds-'));
 const authority=new SharedAuthority(join(root,'server'));
 const boot=authority.bootstrap({orgId:'org',workspaceId:'ws',documentId:'page',userId:'owner',deviceId:'device',document:{type:'doc',content:[{type:'paragraph',attrs:{id:'p'},content:[{type:'text',text}]}]}});
 const server=createSharedHttpServer(authority);const {url}=await server.listen();
 const provider=new HttpSharedProvider(url,boot.token);
 const submit=(command:Command)=>provider.submit({v:1,attemptId:randomUUID(),base:authority.head(),intent:{v:1,intentId:randomUUID(),writerId:boot.auth.writerId,scope:boot.scope,base:authority.head(),command}});
 return {root,authority,boot,server,url,provider,submit,async close(){provider.close();await server.close();authority.close();rmSync(root,{recursive:true,force:true});}};
}
describe('bounded snapshots and private unpublished sources over HTTP',()=>{
 it('hides rejected drafts and staged copy bytes from a different authorized writer',async()=>{
  const f=await fixture();let peer:HttpSharedProvider|undefined;
  try {
   const bob=f.authority.acceptInvite(f.authority.invite(f.boot.token,'org','bob'),'bob-device');f.authority.grant(f.boot.token,f.boot.scope,'bob','editor');peer=new HttpSharedProvider(f.url,bob.token);
   const rejected=await f.submit({kind:'inline',blockId:'p',before:[{type:'text',text:'fabricated'}],after:[{type:'text',text:'PRIVATE_REJECTED_SOURCE'}]});expect(rejected.status).toBe('REJECTED');
   const sources=[{id:'source',parentId:null,assets:[],raw:JSON.stringify({type:'doc',content:[{type:'paragraph',attrs:{id:'private-p'},content:[{type:'text',text:'PRIVATE_STAGED_SOURCE'}]}]})}];
   const preview=previewSharedCopy(sources,['source'],{orgId:'org',workspaceId:'ws'},()=> 'copied');const transfer=sharedCopyTransfer(sources,preview,'copy');
   expect((await f.submit({kind:'resource',action:'copy.stage.prepare',payload:{manifest:transfer.manifest as never}})).status).toBe('SERVER_ACCEPTED');
   for (let index=0;index<transfer.parts.length;index++) expect((await f.submit({kind:'resource',action:'copy.stage.part',payload:{copyId:'copy',index,raw:transfer.parts[index]}})).status).toBe('SERVER_ACCEPTED');
   const visible=JSON.stringify(await peer.snapshot(f.boot.scope));expect(visible).not.toContain('PRIVATE_REJECTED_SOURCE');expect(visible).not.toContain('PRIVATE_STAGED_SOURCE');
   expect(JSON.stringify(await f.provider.snapshot(f.boot.scope))).toContain('PRIVATE_STAGED_SOURCE');
   expect(await f.provider.state(f.boot.scope)).toMatchObject({events:[]});
   const committed=await f.submit({kind:'resource',action:'copy.stage.commit',payload:{copyId:'copy',manifestHash:transfer.manifestHash}});expect(committed.status).toBe('SERVER_ACCEPTED');
   const copied=f.authority.workspaces(bob.token,'org')[0].documents.find(d=>d.documentId==='copied')!;
   expect(JSON.stringify(await peer.state({...f.boot.scope,documentId:'copied',incarnationId:copied.incarnationId}))).toContain('PRIVATE_STAGED_SOURCE');
   await expect(peer.acceptedEvent(f.boot.scope,committed.attemptId)).rejects.toThrow('ACCEPTED_EVENT_MISSING');
   expect((await f.provider.acceptedEvent(f.boot.scope,committed.attemptId)).receipt).toEqual(committed);
   f.authority.verify();
  }finally {peer?.close();await f.close();}
 });
 it('requests current state on first open and only deltas thereafter, retaining prefix proof',async()=>{
  const f=await fixture();let stateCalls=0;const cursors:(number|undefined)[]=[];
  const client=new SharedRuntimeClient(join(f.root,'client'),{state:scope=>{stateCalls++;return f.provider.state(scope);},snapshot:(scope,after)=>{cursors.push(after);return f.provider.snapshot(scope,after);},acceptedEvent:f.provider.acceptedEvent.bind(f.provider),protocol:f.provider.protocol.bind(f.provider),submit:attempt=>f.provider.submit(attempt),receipt:f.provider.receipt.bind(f.provider),invalidate:f.provider.invalidate.bind(f.provider),proof:f.provider.proof.bind(f.provider),workspaces:f.provider.workspaces.bind(f.provider),close(){}},f.boot.scope,f.boot.auth.writerId);
  try {
   const first=await client.open();expect(first.events).toEqual([]);expect(stateCalls).toBe(1);
   const result=await client.submit({kind:'inline',blockId:'p',before:[{type:'text',text:'base'}],after:[{type:'text',text:'edited'}]});expect(cursors).toEqual([first.cut.seq]);
   await client.open();expect(cursors.at(-1)).toBe(result.snapshot.cut.seq);expect(client.history.canUndo()).toBe(true);
   expect((await client.historyStep('undo')).snapshot.state.document.content![0].content![0].text).toBe('base');
  } finally {client.close();await f.close();}
 });
});


it('edits and bolds a 900k page repeatedly with bounded wire and reopens without full event history',async()=>{
 const text="x".repeat(900_000), f=await fixture(text);
 const client=new SharedRuntimeClient(join(f.root,'large-client'),f.provider,f.boot.scope,f.boot.auth.writerId);
 try {
  let state=await client.open();expect(state.events).toEqual([]);
  for (let i=0;i<4;i++) {
   const after=text.slice(0,-1)+String(i);
   const result=await client.submit({kind:'inline',blockId:'p',before:state.state.document.content![0].content!,after:[{type:'text',text:after}]});
   expect(result.receipt.status).toBe('SERVER_ACCEPTED');
   expect(JSON.stringify(client.queue.read(result.receipt.intentId)!.intent.command).length).toBeLessThan(1000);
   state=result.snapshot;
   expect(JSON.stringify(state.events).length).toBeLessThan(4_000_000);
  }
  const bold = await client.submit({kind:'inline',blockId:'p',before:state.state.document.content![0].content!,after:[{type:'text',text:state.state.document.content![0].content![0].text,marks:[{type:'bold'}]}]});
  expect(bold.receipt.status).toBe('SERVER_ACCEPTED');expect(client.queue.read(bold.receipt.intentId)!.intent.command.kind).toBe('inline.mark');
  expect(JSON.stringify(client.queue.read(bold.receipt.intentId)!.intent.command).length).toBeLessThan(1000);state=bold.snapshot;
  const readerProvider=new HttpSharedProvider(f.url,f.boot.token), reader=new SharedRuntimeClient(join(f.root,'reopened-large'),readerProvider,f.boot.scope,f.boot.auth.writerId);
  try {const reopened=await reader.open();expect(reopened.events).toEqual([]);expect(reopened.state).toEqual(state.state);}finally {reader.close();}
  f.authority.verify();
 }finally {client.close();await f.close();}
},30_000);

it('finishes accepted undo after state fallback and after transient refresh loss without replacing immutable intent',async()=>{
 const f=await fixture();let fail=false, overflow=false;
 const client=new SharedRuntimeClient(join(f.root,'history-failure'),{
  state:f.provider.state.bind(f.provider),acceptedEvent:f.provider.acceptedEvent.bind(f.provider),
  snapshot:async(scope,after)=>{if(fail){fail=false;throw new Error('READ_LOST');}if(overflow){overflow=false;throw new CollaborationError('RESPONSE_TOO_LARGE');}return f.provider.snapshot(scope,after);},
  protocol:f.provider.protocol.bind(f.provider),submit:attempt=>f.provider.submit(attempt),receipt:f.provider.receipt.bind(f.provider),invalidate:f.provider.invalidate.bind(f.provider),proof:f.provider.proof.bind(f.provider),workspaces:f.provider.workspaces.bind(f.provider),close(){}
 },f.boot.scope,f.boot.auth.writerId);
 try {
  await client.open();await client.submit({kind:'inline',blockId:'p',before:[{type:'text',text:'base'}],after:[{type:'text',text:'edit'}]});
  // Trigger only the post-write refresh, not historyStep's initial read.
  const submit=f.provider.submit.bind(f.provider);f.provider.submit=async attempt=>{const receipt=await submit(attempt);fail=true;return receipt;};
  await expect(client.historyStep('undo')).rejects.toThrow('READ_LOST');expect(client.canWrite()).toBe(false);
  const raw=client.entries().at(-1)!.raw;
  await expect(client.historyStep('undo')).rejects.toThrow('HISTORY_RECONCILIATION_REQUIRED');
  await expect(client.submit({kind:'inline',blockId:'p',before:[],after:[]})).rejects.toThrow('HISTORY_RECONCILIATION_REQUIRED');
  await client.reconcile();expect(client.entries().at(-1)!.raw).toBe(raw);expect(client.history.canRedo()).toBe(true);
  f.provider.submit=async attempt=>{const receipt=await submit(attempt);overflow=true;return receipt;};
  expect((await client.historyStep('redo')).receipt.status).toBe('SERVER_ACCEPTED');
  expect(client.snapshot().state.document.content![0].content![0].text).toBe('edit');
 }finally {client.close();await f.close();}
});
