import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {describe,it,expect,afterEach,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/persistence/store';
import {createOriginalWorkspaceCopy,createRawWorkspaceSalvage} from '../src/persistence/raw-workspace-salvage';
import {withPrivatePersistence,type NativePrivateFilesystemPort,type NativePrivateFile} from '../src/platform/private-persistence';
import {NativePrivatePersistenceError} from '../src/platform/windows/private-persistence';
const roots:string[]=[],stores:Store[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});});
const sha=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'folio-original-copy-contract-')));roots.push(root);
 const dir=join(root,'workspace');fs.mkdirSync(join(dir,'assets'),{recursive:true});const store=new Store(join(dir,'workspace.sqlite'));stores.push(store);
 store.create(null,'page','committed WAL');store.db.exec("UPDATE pages SET data='broken{'");
 const asset=join(dir,'assets','original.bin'),bytes=Buffer.alloc(20_000_000,0x45);fs.writeFileSync(asset,bytes);fs.writeFileSync(join(dir,'crash-recovery.json'),'retained malformed original checkpoint');
 let failCopy=false;const calls:string[]=[];
 const identity=(p:string)=>{const s=fs.lstatSync(p,{bigint:true});return {path:p,fileId:s.ino.toString(16).padStart(32,'0'),volumeId:s.dev.toString(16).padStart(16,'0')};};
 const inspect=(p:string,max:number):NativePrivateFile=>{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)throw new Error('unsafe file');return {...identity(p),bytes:s.size,sha256:sha(p)};};
 const receipt=(p:string,max:number)=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1' as const,scope:'PROCESS_CRASH' as const,identity:inspect(p,max)});
 const unused=():never=>{throw new Error('unexpected operation');};
 // Native FAMILY simulation over disposable POSIX files. No NTFS/ACL/sharing or Windows durability claim.
 const port:NativePrivateFilesystemPort={platform:'win32',version:1,synchronous:true,
  inspectDirectory:identity,inspectFileIdentity:identity,inspectFile:inspect,read:(p)=>fs.readFileSync(p),
  createDirectory(p){calls.push('directory');fs.mkdirSync(p);return identity(p);},
  writeNew(p,b,max){calls.push('write');if(b.length>max)throw new Error('capacity');fs.writeFileSync(p,b,{flag:'wx'});return receipt(p,max);},
  copyNew(s,d,e,max){calls.push('copy');expect(inspect(s,max)).toEqual(e);fs.copyFileSync(s,d,fs.constants.COPYFILE_EXCL);if(failCopy)throw new NativePrivatePersistenceError('UNKNOWN','COPY_ACK_LOST');return receipt(d,max);},
  renameNew:unused,unlinkExact(p,e,max){expect(inspect(p,max)).toEqual(e);fs.unlinkSync(p);},proveSync:(p,e)=>receipt(p,e.bytes),
  snapshotSqlite(db,d){calls.push('snapshot');fs.writeFileSync(d,'',{flag:'wx'});db.prepare('VACUUM INTO ?').run(d);return receipt(d,256*1024*1024);},
  acquireSqliteLease(){return {assertHeld(){},close(){}};}
 };
 return {root,dir,store,port,bytes,calls,lostCopy(){failCopy=true;}};
}
describe('original-copy rescue route (actual writer, native-family simulation)',()=>{
 it('copies damaged Page JSON, committed WAL, 20MB assets and raw checkpoint without semantic decoding',()=>{
  const f=fixture();let admissions=0;expect(()=>f.store.pages()).toThrow();
  const result=withPrivatePersistence({nativePrivateFilesystem:f.port},()=>createOriginalWorkspaceCopy(f.store.db,f.dir,()=>{admissions++;}));
  expect(result.directory.startsWith(join(f.dir,'backups')+'/')).toBe(true);expect(admissions).toBe(1);
  const manifest=JSON.parse(fs.readFileSync(join(result.directory,'salvage-manifest.json'),'utf8'));expect(manifest.restorable).toBe(false);
  expect(fs.readFileSync(join(result.directory,'assets','original.bin')).equals(f.bytes)).toBe(true);
  expect(fs.readFileSync(join(result.directory,'crash-recovery.json'),'utf8')).toBe('retained malformed original checkpoint');
  expect(f.calls).toContain('snapshot');expect(f.calls).toContain('copy');
  expect(fs.existsSync(join(result.directory,'FOLIO-RAW-SALVAGE-INCOMPLETE'))).toBe(false);
 });
 it('retains the incomplete marker, snapshot and applied asset copy on an UNKNOWN acknowledgement',()=>{
  const f=fixture();f.lostCopy();expect(()=>withPrivatePersistence({nativePrivateFilesystem:f.port},()=>createOriginalWorkspaceCopy(f.store.db,f.dir))).toThrow('UNKNOWN');
  const directory=join(f.dir,'backups',fs.readdirSync(join(f.dir,'backups'))[0]);
  expect(fs.existsSync(join(directory,'FOLIO-RAW-SALVAGE-INCOMPLETE'))).toBe(true);expect(fs.existsSync(join(directory,'workspace.raw.sqlite'))).toBe(true);
  expect(fs.readFileSync(join(directory,'assets','original.bin')).equals(f.bytes)).toBe(true);
 });
 it.each([false,true])('keeps the output reader protector until SQLite definitely closed (closed first: %s)',closedFirst=>{
  const f=fixture();let leaseClosed=0,reader:DatabaseSync|undefined;
  const port={...f.port,acquireSqliteLease(){return {assertHeld(){},close(){leaseClosed++;}};}};
  const original=DatabaseSync.prototype.close;
  const close=vi.spyOn(DatabaseSync.prototype,'close').mockImplementation(function(this:DatabaseSync){
   const path=this.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
   if(typeof path==='string'&&path.endsWith('workspace.raw.sqlite')){
    reader=this;if(closedFirst)original.call(this);throw new Error('raw output reader close-cut');
   }
   return original.call(this);
  });
  expect(()=>withPrivatePersistence({nativePrivateFilesystem:port},()=>createOriginalWorkspaceCopy(f.store.db,f.dir))).toThrow(/close|unknown/i);
  close.mockRestore();expect(reader).toBeDefined();expect(reader!.isOpen).toBe(!closedFirst);
  expect(leaseClosed).toBe(closedFirst?1:0);
  const directory=join(f.dir,'backups',fs.readdirSync(join(f.dir,'backups'))[0]);
  expect(fs.existsSync(join(directory,'FOLIO-RAW-SALVAGE-INCOMPLETE'))).toBe(true);
  expect(fs.readFileSync(join(directory,'assets','original.bin')).equals(f.bytes)).toBe(true);
  // Test-owned manual disposal only; no product replay or resolution claim.
  if(reader!.isOpen)reader!.close();
 });
 it('refuses capacity before creating backups and keeps the external salvage guard intact',()=>{
  const f=fixture();expect(()=>withPrivatePersistence({nativePrivateFilesystem:f.port},()=>createOriginalWorkspaceCopy(f.store.db,f.dir,()=>{throw new Error('full');}))).toThrow('full');
  expect(fs.existsSync(join(f.dir,'backups'))).toBe(false);expect(f.calls).toEqual([]);
  expect(()=>createRawWorkspaceSalvage(f.store.db,f.dir,f.dir)).toThrow(/ワークスペース内/);
 });
});
