import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect,afterEach} from 'vitest';
import {Store} from '../src/persistence/store';
import {WorkspaceStorageService} from '../src/main/workspace-storage-service';
import {WorkspaceBackupService} from '../src/main/workspace-backup-service';
import {assertPrivateOperationAuthority,withPrivateOperationAuthority} from '../src/platform/private-operation-authority';
const roots:string[]=[],stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});});
function fixture(){const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'folio-picker-authority-')));roots.push(root);const directory=join(root,'workspace');fs.mkdirSync(join(directory,'assets'),{recursive:true});const store=new Store(join(directory,'workspace.sqlite'));stores.push(store);store.create(null,'page','preserve');return {root,directory,store};}
function deferred(){let resolve!:(value:string|null)=>void;const promise=new Promise<string|null>(r=>{resolve=r;});return {promise,resolve};}
describe('private mutation current request authority across picker awaits (Node only)',()=>{
 it.each(['storage:archivePlan','storage:orphanPlan','storage:rawSalvage'] as const)('refuses stale %s picker before planning or mutation',async type=>{
  const f=fixture(),picker=deferred();let current=true;
  const service=new WorkspaceStorageService(f.directory,f.store.db,{},()=>picker.promise);
  const before=fs.readdirSync(f.root);const pending=service.handleUtility({type},()=>current)!;
  current=false;picker.resolve(join(f.root,'selected'));
  await expect(pending).rejects.toMatchObject({code:'unauthorized'});expect(fs.readdirSync(f.root)).toEqual(before);
 });
 it('refuses a stale restore picker without creating a restored workspace',async()=>{
  const f=fixture(),service=new WorkspaceBackupService(f.store.db,f.directory),backup=service.create(),picker=deferred();
  const before=fs.readdirSync(f.root);let current=true;
  const pending=service.restoreAfterPicker(backup.ticket,()=>picker.promise,()=>current);current=false;picker.resolve(f.root);
  await expect(pending).rejects.toMatchObject({code:'unauthorized'});expect(fs.readdirSync(f.root)).toEqual(before);
  const restored=await service.restoreAfterPicker(backup.ticket,async()=>f.root,()=>true);expect(restored?.sourceDirectory).toBe(backup.directory);
 });
 it('admits the exact chosen manifest before verification and repeats the originating authority',()=>{
  const f=fixture(),source=new WorkspaceBackupService(f.store.db,f.directory).create();
  let current=true,admitted=0;
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,(selection,fence)=>{
   fence();admitted++;expect(selection.directory).toBe(source.directory);
   expect(selection.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
   expect(selection.manifestPath).toBe(join(source.directory,'manifest.json'));
  });
  withPrivateOperationAuthority(()=>{if(!current)throw new Error('revoked');},()=>{
   expect(service.choose(source.directory).directory).toBe(source.directory);current=false;
   expect(()=>service.choose(source.directory)).toThrow('revoked');
  });
  expect(admitted).toBe(1);
 });
 it('retains the originating fence across an await and checks it at native mutation phases',async()=>{
  const picker=deferred();let current=true,mutations=0;
  const pending=withPrivateOperationAuthority(()=>{if(!current)throw new Error('revoked');},async()=>{await picker.promise;assertPrivateOperationAuthority();mutations++;});
  current=false;picker.resolve('/owned-output');await expect(pending).rejects.toThrow('revoked');expect(mutations).toBe(0);
  assertPrivateOperationAuthority(); // No leaked stale request context.
 });
 it('combines the authorized predicate with ambient private operation authority',async()=>{
  const f=fixture(),picker=deferred();let current=true;
  const service=new WorkspaceStorageService(f.directory,f.store.db,{},()=>picker.promise);
  const before=fs.readdirSync(f.root);
  const pending=withPrivateOperationAuthority(()=>{if(!current)throw new Error('revoked');},async()=>{
   await service.handleUtility({type:'storage:rawSalvage'},()=>true)!;
  });
  current=false;picker.resolve(join(f.root,'selected'));
  await expect(pending).rejects.toThrow('revoked');expect(fs.readdirSync(f.root)).toEqual(before);
 });
 it('passes the retained exact orphan proof into the orphan-archive scope',async()=>{
  const f=fixture();
  fs.writeFileSync(join(f.directory,'assets','zz-orphan.txt'),'orphan');
  fs.mkdirSync(join(f.root,'out'));
  const scopes:any[]=[];
  const expectedFile={path:'p',fileId:'f'.repeat(32),volumeId:'e'.repeat(16),bytes:1,sha256:'3'.repeat(64)};
  const maintenance={withScope(req:any,current:any,work:any){scopes.push(req);current();return work();},
   admitOrphan(path:string,current:()=>void){current();return expectedFile;},
   withOrphan(work:any){return work();}};
  const service=new WorkspaceStorageService(f.directory,f.store.db,{},
   async(title,create,file)=>file?join(f.directory,'assets','zz-orphan.txt'):join(f.root,'out'),
   undefined,undefined,undefined,maintenance as any);
  const plan=await service.handleUtility({type:'storage:orphanPlan'},()=>true) as any;
  expect(plan.ticket).toBeTruthy();
  const moved=await service.handleUtility({type:'storage:orphanMove',ticket:plan.ticket},()=>true) as any;
  expect(moved.destination).toContain('zz-orphan.txt');
  expect(scopes.some(r=>r.kind==='orphan-archive'&&r.file===expectedFile)).toBe(true);
 });
 it('stale archive picker after await performs no admission or mutation',async()=>{
  const f=fixture();let current=true;const admitted:string[]=[];
  const service=new WorkspaceStorageService(f.directory,f.store.db,{},
   async()=>join(f.root,'out'),undefined,undefined,
   (selection,fence)=>{fence();admitted.push(selection.directory);},
   {withScope(req:any,current:any,work:any){current();return work();},admitOrphan(p:string,c:any){c();return {path:p,fileId:'f'.repeat(32),volumeId:'e'.repeat(16),bytes:1,sha256:'0'.repeat(64)};},withOrphan(w:any){return w();}} as any);
  const backup=service.backups.create();
  const picker=deferred();
  const late=new WorkspaceStorageService(f.directory,f.store.db,{},()=>picker.promise,undefined,undefined,
   (s,fence)=>{fence();admitted.push(s.directory);});
  const pending=late.handleUtility({type:'storage:archivePlan'},()=>current)!;
  current=false;picker.resolve(backup.directory);
  await expect(pending).rejects.toMatchObject({code:'unauthorized'});
  expect(admitted).toHaveLength(0);
 });
 it('isolates concurrent request fences and refuses asynchronous authority',async()=>{
  const first=deferred(),second=deferred();let a=true,b=true,mutations=0;
  const p1=withPrivateOperationAuthority(()=>{if(!a)throw new Error('first revoked');},async()=>{await first.promise;assertPrivateOperationAuthority();mutations++;});
  const p2=withPrivateOperationAuthority(()=>{if(!b)throw new Error('second revoked');},async()=>{await second.promise;assertPrivateOperationAuthority();mutations++;});
  a=false;first.resolve('/a');second.resolve('/b');await expect(p1).rejects.toThrow('first revoked');await p2;expect(mutations).toBe(1);
  expect(()=>withPrivateOperationAuthority(async()=>{},()=>{mutations++;})).toThrow(/Synchronous/);expect(mutations).toBe(1);
 });
});
