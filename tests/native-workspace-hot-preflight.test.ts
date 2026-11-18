import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect,afterEach} from 'vitest';
import {Store} from '../src/persistence/store';
import type {HotJournalSnapshot} from '../src/sync/private-platform';
const roots:string[]=[];
const root=()=>{const p=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'folio-workspace-hot-contract-')));roots.push(p);return p;};
afterEach(()=>{for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});
function fixture(foreign=false){
 const staging=join(root(),'workspace.sqlite'),source=join(root(),'workspace.sqlite');
 const store=new Store(staging);store.create(null,'page','committed page');store.close();
 const writer=new DatabaseSync(staging);
 if(foreign)writer.exec('PRAGMA user_version=4');
 writer.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=1;PRAGMA cache_spill=ON;BEGIN IMMEDIATE;PRAGMA user_version=999;CREATE TABLE uncommitted_spill(value BLOB);INSERT INTO uncommitted_spill VALUES(zeroblob(131072))');
 fs.copyFileSync(staging,source);fs.copyFileSync(staging+'-journal',source+'-journal');writer.exec('ROLLBACK');writer.close();
 const before=[fs.readFileSync(source),fs.readFileSync(source+'-journal')];let calls=0;
 const snapshot:HotJournalSnapshot=(p,cb)=>{calls++;const copy=join(root(),'snapshot.sqlite');for(const s of ['', '-journal'])fs.copyFileSync(p+s,copy+s);cb(copy);expect(fs.readFileSync(source).equals(before[0])).toBe(true);expect(fs.readFileSync(source+'-journal').equals(before[1])).toBe(true);};
 return {source,before,snapshot,calls:()=>calls};
}
describe('workspace native hot-journal preflight (real disposable SQLite, simulated native copy)',()=>{
 it('validates committed schema on the private copy before recovering a valid original',()=>{
  const f=fixture(),store=new Store(f.source,{nativeHotJournalSnapshot:f.snapshot});
  try{expect(store.pages()[0].title).toBe('committed page');expect(f.calls()).toBe(1);}finally{store.close();}
 });
 it('preserves both raw files when the committed copy has an unsupported record schema',()=>{
  const f=fixture(true);expect(()=>new Store(f.source,{nativeHotJournalSnapshot:f.snapshot})).toThrow();expect(f.calls()).toBe(1);
  expect(fs.readFileSync(f.source).equals(f.before[0])).toBe(true);expect(fs.readFileSync(f.source+'-journal').equals(f.before[1])).toBe(true);
 });
 it('rejects an omitted or asynchronous snapshot callback before opening the source writable',()=>{
  const f=fixture();expect(()=>new Store(f.source,{nativeHotJournalSnapshot:()=>{}})).toThrow(/synchronously/);
  expect(()=>new Store(f.source,{nativeHotJournalSnapshot:async()=>{}})).toThrow(/Synchronous/);
  expect(fs.readFileSync(f.source).equals(f.before[0])).toBe(true);expect(fs.readFileSync(f.source+'-journal').equals(f.before[1])).toBe(true);
 });
});
