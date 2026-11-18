import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect,afterEach,vi} from 'vitest';
import {openWorkspaceAtStartup} from '../src/main/workspace-startup';
import {Store,storeInitializationRetainsNativeLease} from '../src/persistence/store';
import type {NativePrivateFilesystemPort,NativePrivateFile} from '../src/platform/private-persistence';
const roots:string[]=[],stores:Store[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const s of stores.splice(0))try{s.close();}catch{};for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});});
const digest=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'folio-native-startup-contract-')));roots.push(root);
 const dir=join(root,'workspace'),path=join(dir,'workspace.sqlite');
 const events:string[]=[];let held=true,connection:DatabaseSync|undefined,failClose:Error|undefined;
 const identity=(p:string)=>{const st=fs.lstatSync(p,{bigint:true});return {path:p,fileId:st.ino.toString(16).padStart(32,'0'),volumeId:st.dev.toString(16).padStart(16,'0')};};
 const inspect=(p:string,max:number):NativePrivateFile=>{const st=fs.lstatSync(p);if(st.size>max)throw new Error('capacity');return {...identity(p),bytes:st.size,sha256:digest(p)};};
 const receipt=(p:string,max:number)=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1' as const,scope:'PROCESS_CRASH' as const,identity:inspect(p,max)});
 const unused=():never=>{throw new Error('unexpected filesystem operation');};
 const port:NativePrivateFilesystemPort={platform:'win32',version:1,synchronous:true,
  inspectDirectory:p=>identity(p),inspectFileIdentity:p=>identity(p),inspectFile:inspect,read:unused,
  createDirectory(p){events.push('directory');fs.mkdirSync(p,{mode:0o700});return identity(p);},
  writeNew(p,b,max){events.push('new');if(b.length>max)throw new Error('capacity');fs.writeFileSync(p,b,{flag:'wx'});return receipt(p,max);},
  copyNew(s,d,e,max){expect(inspect(s,max)).toEqual(e);fs.copyFileSync(s,d,fs.constants.COPYFILE_EXCL);return receipt(d,max);},
  renameNew:unused,unlinkExact:unused,proveSync:(p,e)=>receipt(p,e.bytes),
  snapshotSqlite(db,d){events.push('snapshot');fs.writeFileSync(d,'',{flag:'wx'});db.prepare('VACUUM INTO ?').run(d);return receipt(d,256*1024*1024);},
  acquireSqliteLease(p,e){events.push('lease');expect(identity(p)).toEqual(e);return {
   assertHeld(){if(!held)throw new Error('lease lost');},
   close(){events.push('lease-close');if(connection)expect(connection.isOpen).toBe(false);if(failClose)throw failClose;}
  };}
 };
 return {root,dir,path,port,events,lost(){held=false;},connection(db:DatabaseSync){connection=db;},failClose(e:Error){failClose=e;}};
}
describe('native workspace startup lifetime (POSIX simulation, no Windows acceptance)',()=>{
 it.each(['preflight-success','preflight-semantic-rejection','read-only-opener'] as const)('retains the native lease after an unclosed %s connection, without a repeated close',kind=>{
  const f=fixture();fs.mkdirSync(f.dir);const setup=new DatabaseSync(f.path);
  setup.exec('CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE versions(id INTEGER PRIMARY KEY,pageId TEXT,createdAt INTEGER,title TEXT,doc TEXT,database TEXT);CREATE TABLE save_receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL)');
  setup.exec('PRAGMA user_version='+ (kind==='preflight-semantic-rejection'?4:kind==='read-only-opener'?2:3));setup.close();
  const original=DatabaseSync.prototype.close, sentinel=new Error('preflight close sentinel');let calls=0, retained:DatabaseSync|undefined;
  const failAt=kind==='read-only-opener'?2:1;
  const close=vi.spyOn(DatabaseSync.prototype,'close').mockImplementation(function(this:DatabaseSync){if(++calls===failAt){retained=this;throw sentinel;}return original.call(this);});
  let error:any;try{openWorkspaceAtStartup(f.dir,()=>{if(kind==='read-only-opener')throw new Error('full');},{nativePrivateFilesystem:f.port});}catch(e){error=e;}
  expect(storeInitializationRetainsNativeLease(error)).toBe(true);expect(retained?.isOpen).toBe(true);expect(calls).toBe(failAt);
  expect(f.events.filter(x=>x==='lease-close')).toHaveLength(kind==='read-only-opener'?1:0);
  expect(error.errors).toContain(sentinel);close.mockRestore();original.call(retained!);
 });
 it('admits before native creation and releases the lease after SQLite close',()=>{
  const f=fixture();const opened=openWorkspaceAtStartup(f.dir,()=>{f.events.push('admit');},{nativePrivateFilesystem:f.port});stores.push(opened.store);
  expect(f.events.slice(0,4)).toEqual(['admit','directory','new','lease']);
  f.connection(opened.store.db);opened.store.create(null,'page','native startup');opened.store.close();
  expect(f.events.at(-1)).toBe('lease-close');
 });
 it('refuses DB access when the owned helper lease is lost, while permitting ordered close',()=>{
  const f=fixture(),opened=openWorkspaceAtStartup(f.dir,()=>{},{nativePrivateFilesystem:f.port});stores.push(opened.store);f.connection(opened.store.db);
  f.lost();expect(()=>opened.store.db).toThrow('lease lost');opened.store.close();
 });
 it('retains a foreign database unchanged and preserves both startup and lease cleanup errors',()=>{
  const f=fixture();fs.mkdirSync(f.dir);const db=new DatabaseSync(f.path);db.exec('PRAGMA user_version=999');db.close();const before=digest(f.path),cleanup=new Error('lease cleanup');f.failClose(cleanup);
  let error:any;try{openWorkspaceAtStartup(f.dir,()=>{},{nativePrivateFilesystem:f.port});}catch(e){error=e;}
  expect(error).toBeInstanceOf(AggregateError);expect(storeInitializationRetainsNativeLease(error)).toBe(true);expect(error.errors[0].message).toMatch(/newer Folio/);expect(error.errors[1]).toBe(cleanup);expect(digest(f.path)).toBe(before);
 });
 it('falls back to a fresh leased read-only Store after admission refusal',()=>{
  const f=fixture();fs.mkdirSync(f.dir);const initial=new Store(f.path);initial.create(null,'page','preserve');initial.close();
  const opened=openWorkspaceAtStartup(f.dir,()=>{throw new Error('full');},{nativePrivateFilesystem:f.port});stores.push(opened.store);
  expect(opened.status.mode).toBe('readOnly');expect(opened.store.pages()).toHaveLength(1);expect(f.events.filter(x=>x==='lease')).toHaveLength(2);
 });
 it('creates verified native snapshots before migrating a v1 database and preserves a prior canonical snapshot',()=>{
  const f=fixture();fs.mkdirSync(f.dir);const db=new DatabaseSync(f.path);db.exec('CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE versions(id INTEGER PRIMARY KEY,pageId TEXT,createdAt INTEGER,title TEXT,doc TEXT);CREATE TABLE save_receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL);PRAGMA user_version=1');db.close();
  const old=f.path+'.pre-v2.sqlite';fs.writeFileSync(old,'retain original');
  const opened=openWorkspaceAtStartup(f.dir,()=>{},{nativePrivateFilesystem:f.port});stores.push(opened.store);
  expect(opened.store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);expect(f.events.filter(x=>x==='snapshot')).toHaveLength(1);expect(fs.readFileSync(old,'utf8')).toBe('retain original');
 });
});
