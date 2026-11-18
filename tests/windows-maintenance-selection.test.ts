import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {describe,it,expect,afterEach,vi} from 'vitest';
import {Store} from '../src/persistence/store';
import {WorkspaceStorageService} from '../src/main/workspace-storage-service';
import {WorkspaceBackupService} from '../src/main/workspace-backup-service';
import {privatePersistencePort} from '../src/platform/private-persistence';
import type {NativePrivateFile,NativePrivateFilesystemPort} from '../src/platform/private-persistence';
import {planWindowsMaintenanceSelection,createNativeMaintenance,proveMaintenanceOutputParent} from '../src/main/windows-maintenance-selection';
import type {NativeMaintenance,NativeMaintenanceRequest,PreparedRestoreHandoff} from '../src/main/windows-maintenance-selection';
import {verifyFullBackup} from '../src/persistence/full-backup-verify';

const roots:string[]=[],stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});});
function fixture(){const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'folio-maint-sel-')));roots.push(root);const directory=join(root,'workspace');const out=join(root,'out');fs.mkdirSync(join(directory,'assets'),{recursive:true});fs.mkdirSync(out,{recursive:true});const store=new Store(join(directory,'workspace.sqlite'));stores.push(store);store.create(null,'page','preserve');return {root,directory,out,store};}

const CONFIG={root:'C:\\Private\\Folio',probeExecutable:'C:\\Folio\\helper.exe',expectedHash:'a'.repeat(64),systemRoot:'C:\\Windows',publicationStateRoot:'D:\\FolioState',publicationStateDirectory:'D:\\FolioState\\bound'};
const WS='C:\\Private\\Folio\\workspace';

describe('planWindowsMaintenanceSelection (pure lexical)',()=>{
 it('defaults to a deterministic per-workspace sibling inside the single container',()=>{
  const plan=planWindowsMaintenanceSelection(CONFIG,WS,{});
  expect(plan.capabilityRoot).toBe('C:\\Private\\Folio');
  expect(plan.outputParent).toMatch(/^C:\\Private\\Folio\\FolioExports-[a-f0-9]{16}$/);
  const expected='FolioExports-'+createHash('sha256').update(WS.toLowerCase()).digest('hex').slice(0,16);
  expect(plan.outputParent).toBe('C:\\Private\\Folio\\'+expected);
 });
 it('derives a different non-ancestor output for a restored workspace',()=>{
  const a=planWindowsMaintenanceSelection(CONFIG,WS,{});
  const b=planWindowsMaintenanceSelection(CONFIG,'C:\\Private\\Folio\\restored-ws',{});
  expect(a.outputParent).not.toBe(b.outputParent);
  expect(b.outputParent.toLowerCase().startsWith(a.outputParent.toLowerCase()+'\\')).toBe(false);
 });
 it('accepts a trusted env output parent inside the container',()=>{
  const plan=planWindowsMaintenanceSelection(CONFIG,WS,{FOLIO_WINDOWS_OUTPUT_PARENT:'C:\\Private\\Folio\\Exports'});
  expect(plan.outputParent).toBe('C:\\Private\\Folio\\Exports');
 });
 it.each([
  ['root==workspace','C:\\Private\\Folio'],
  ['workspace outside root','C:\\Other\\workspace'],
  ['drive root','C:\\Private\\Folio\\..\\..'],
 ])('rejects %s',(_name,workspace)=>{
  expect(()=>planWindowsMaintenanceSelection(CONFIG,workspace,{})).toThrow();
 });
 it('requires an output disjoint from the full Main profile as well as workspace',()=>{
  expect(()=>planWindowsMaintenanceSelection(CONFIG,WS,{},[CONFIG.root])).toThrow('プロファイル');
  const plan=planWindowsMaintenanceSelection(CONFIG,WS,{},['C:\\Private\\Folio\\AppProfile']);
  expect(plan.outputParent).toContain('FolioExports-');
  expect(()=>planWindowsMaintenanceSelection(CONFIG,WS,{FOLIO_WINDOWS_OUTPUT_PARENT:'C:\\Private\\Folio\\AppProfile\\export'},['C:\\Private\\Folio\\AppProfile'])).toThrow('プロファイル');
 });
 it('rejects a drive root as the private container',()=>{
  expect(()=>planWindowsMaintenanceSelection({...CONFIG,root:'C:\\'},'C:\\ws',{})).toThrow();
 });
 it('rejects an env output parent outside the container or inside the workspace',()=>{
  expect(()=>planWindowsMaintenanceSelection(CONFIG,WS,{FOLIO_WINDOWS_OUTPUT_PARENT:'E:\\External'})).toThrow();
  expect(()=>planWindowsMaintenanceSelection(CONFIG,WS,{FOLIO_WINDOWS_OUTPUT_PARENT:'C:\\Private\\Folio\\workspace\\out'})).toThrow();
 });
 it('rejects a state root overlapping the private container',()=>{
  expect(()=>planWindowsMaintenanceSelection({...CONFIG,publicationStateRoot:'C:\\Private\\Folio'},WS,{})).toThrow();
  expect(()=>planWindowsMaintenanceSelection({...CONFIG,publicationStateRoot:'C:\\Private\\Folio\\state',publicationStateDirectory:'C:\\Private\\Folio\\state\\bound'},WS,{})).toThrow();
 });
});

describe('Main wiring ordering (source contract, static)',()=>{
 const source=fs.readFileSync(join(__dirname,'..','src','main','index.ts'),'utf8');
 const launchSource=fs.readFileSync(join(__dirname,'..','src','main','private-workspace-launch.ts'),'utf8');
 it('adjudicates the maintenance plan before startup storage and runtime',()=>{
  const planAt=source.indexOf('planWindowsMaintenanceSelection(nativeConfiguration');
  const admitAt=source.indexOf('admitStartupStorage(profile');
  const runtimeAt=source.indexOf('new WindowsRuntimePlatform({...configuration');
  expect(runtimeAt).toBeGreaterThanOrEqual(0);
  expect(planAt).toBeGreaterThan(-1);
  expect(planAt).toBeLessThan(admitAt);
  expect(planAt).toBeLessThan(runtimeAt);
 });
 it('nests the raw32 recovery write inside a raw-rescue scope',()=>{
  const scopeAt=source.indexOf('kind: "raw-rescue", parent: dirname(result.filePath)');
  const writeAt=source.indexOf('writeRecoveryFile(result.filePath!');
  expect(scopeAt).toBeGreaterThan(-1);
  expect(writeAt).toBeGreaterThan(scopeAt);
 });
 it('wires the real maintenance port into storage and save admissions',()=>{
  expect(source).toContain('createNativeMaintenance({product: productNative');
  expect(source).toContain('proveMaintenanceOutputParent(productNative, maintenanceSelection');
  expect(source).toContain('admitNativeSaveParent(');
  expect(source).toContain('readWindowsRestoreHandoff(nativeConfiguration, dataDir, process.env)');
  expect(source).toContain('restoredStartupHandoff?.stateReady(productNative)');
  expect(source).toContain('restoredStartupHandoff.workspaceReady(store)');
  expect(source).toContain('import {launchRestoredWorkspace} from "./private-workspace-launch"');
  const openAt=source.indexOf('req.type === "workspaceBackup:open"');
  const openEnd=source.indexOf('req.type === "restoreVersion"',openAt);
  expect(openAt).toBeGreaterThan(-1);
  expect(openEnd).toBeGreaterThan(openAt);
  const openBranch=source.slice(openAt,openEnd);
  expect(openBranch).toContain('context.openBackup(workspaceBackups, req.ticket');
  expect(openBranch).toContain('launchRestoredWorkspace({');
  expect(openBranch).toContain('directory, handoff, markStarted, spawn');
  expect(openBranch).toContain('parentEnv: process.env');
  expect(openBranch).not.toContain('childEnvironment(');
  expect(openBranch).not.toContain('delete env.');
  expect(openBranch).not.toContain('delete process.env');
  expect(launchSource).toContain('export function launchRestoredWorkspace');
  const envAt=launchSource.indexOf('config.handoff.childEnvironment(config.parentEnv)');
  const assertAt=launchSource.indexOf('config.handoff?.assertCurrent()');
  const markAt=launchSource.indexOf('config.markStarted?.()');
  const spawnAt=launchSource.indexOf('config.spawn(');
  expect(envAt).toBeGreaterThan(-1);
  expect(assertAt).toBeGreaterThan(envAt);
  expect(markAt).toBeGreaterThan(assertAt);
  expect(spawnAt).toBeGreaterThan(markAt);
  for(const removal of ['delete env.FOLIO_DEV_URL','delete env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES','delete env.FOLIO_WINDOWS_OUTPUT_PARENT']){
   const at=launchSource.indexOf(removal);
   expect(at).toBeGreaterThan(assertAt);
   expect(at).toBeLessThan(markAt);
  }
  expect(launchSource).toContain('key.toUpperCase()');
  expect(launchSource).toContain('startsWith("FOLIO_SYNC_")');
  expect(launchSource).toContain('FOLIO_DATA_DIR: config.directory');
 });
 it('passes the port as the new trailing optional constructor argument',()=>{
  expect(source).toMatch(/: undefined,\s*nativeMaintenance\)/);
 });
});

function fakePort(tag:string):NativePrivateFilesystemPort&{calls:string[]}{
 const calls:string[]=[];
 const marker=tag==='base'?'1':'2';
 const id=(path:string)=>({path,fileId:marker+'0'.repeat(31),volumeId:'0'.repeat(15)+marker});
 const file=(path:string)=>({...id(path),bytes:1,sha256:'0'.repeat(64)});
 const p:NativePrivateFilesystemPort&{calls:string[]}={
  platform:'win32',version:1,synchronous:true,calls,
  inspectDirectory:(path)=>{calls.push('inspectDirectory:'+tag+':'+path);return id(path);},
  inspectFile:(path,maxBytes)=>{calls.push('inspectFile:'+tag+':'+path);return file(path);},
  inspectFileIdentity:(path)=>{calls.push('inspectFileIdentity:'+tag+':'+path);return id(path);},
  read:(path,expected,maxBytes)=>{calls.push('read:'+tag);return new Uint8Array(1);},
  writeNew:(path,bytes,maxBytes)=>{calls.push('writeNew:'+tag);return {profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:file(path)};},
  copyNew:(s,d,e,m)=>{calls.push('copyNew:'+tag);return {profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:file(d)};},
  renameNew:(s,d,e,m)=>{calls.push('renameNew:'+tag);return {profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:file(d)};},
  unlinkExact:(p2,e,m)=>{calls.push('unlinkExact:'+tag);},
  proveSync:(p2,e)=>{calls.push('proveSync:'+tag);return {profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:file(p2)};},
  createDirectory:(path)=>{calls.push('createDirectory:'+tag+':'+path);return id(path);},
  snapshotSqlite:(db,d)=>{calls.push('snapshotSqlite:'+tag);return {profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:file(d)};},
 };
 return p;
}

function fakeProduct(){
 const base=fakePort('base'),selected=fakePort('sel');
 const record={admitted:[] as any[],files:[] as any[],inspected:[] as any[],caps:[] as any[]};
 const expected:NativePrivateFile={path:'C:\\Private\\Folio\\workspace\\assets\\orphan.bin',fileId:'f'.repeat(32),volumeId:'e'.repeat(16),bytes:3,sha256:'1'.repeat(64)};
 const product={
  privateFilesystem:base,
  admitSelectedSource(r:any){record.admitted.push(r);return {fingerprint:r.manifestSha256,manifestSha256:r.manifestSha256,tree:{path:r.path,fileId:'T',volumeId:'TV'}};},
  inspectSelectedFile(r:any){record.inspected.push(r);return expected;},
  admitSelectedFile(r:any){record.files.push(r);return {file:r.expected};},
  authorizeExternalCapability(r:any){record.caps.push(r);return Object.freeze({kind:r.kind,path:r.path,capabilityRoot:r.capabilityRoot,privateFilesystem:selected,assertCurrent:r.assertCurrent});},
 };
 return {product:product as any,base,selected,record,expected};
}
const SELECTION={root:'C:\\Private\\Folio',workspace:'C:\\Private\\Folio\\workspace',stateRoot:'D:\\FolioState',capabilityRoot:'C:\\Private\\Folio',outputParent:'C:\\Private\\Folio\\Out'};

describe('createNativeMaintenance factory scopes (fake product, Node only)',()=>{
 const mk=()=>{const f=fakeProduct();const m=createNativeMaintenance({product:f.product,operatorConfig:CONFIG as any,selection:SELECTION,workspace:'C:\\Private\\Folio\\workspace',current:()=>{}});return {...f,m};};
 it('internal backup-source admits the exact manifest and runs on the base filesystem',()=>{
  const {m,record,selected}=mk();
  const out=m.withScope({kind:'backup-source',source:{directory:'C:\\Private\\Folio\\workspace\\backups\\b1',manifestPath:'C:\\Private\\Folio\\workspace\\backups\\b1\\manifest.json',manifestSha256:'a'.repeat(64)}},()=>{},()=>42);
  expect(out).toBe(42);
  expect(record.admitted).toHaveLength(1);
  expect(record.admitted[0].manifestSha256).toBe('a'.repeat(64));
  expect(record.caps).toHaveLength(0);
  expect(selected.calls).toHaveLength(0);
 });
 it('external backup-source authorizes a capability and scopes the selected port',()=>{
  const {m,record,selected}=mk();
  let inside:unknown;
  m.withScope({kind:'backup-source',source:{directory:'C:\\Private\\Folio\\ext\\b2',manifestPath:'C:\\Private\\Folio\\ext\\b2\\manifest.json',manifestSha256:'b'.repeat(64)}},()=>{},()=>{inside=privatePersistencePort();});
  expect(record.caps).toHaveLength(1);
  expect(record.caps[0].kind).toBe('backup-source');
  expect(record.caps[0].path).toBe('C:\\Private\\Folio\\ext\\b2');
  expect(inside).toBeTruthy();
 });
 it('restore-target and backup-archive forward source+parent; raw-rescue parent only',()=>{
  const {m,record}=mk();const source={directory:'C:\\Private\\Folio\\ext\\b3',manifestPath:'C:\\Private\\Folio\\ext\\b3\\manifest.json',manifestSha256:'c'.repeat(64)};
  m.withScope({kind:'restore-target',source,parent:'C:\\Private\\Folio\\Out'},()=>{},()=>{});
  m.withScope({kind:'backup-archive',source,parent:'C:\\Private\\Folio\\Out'},()=>{},()=>{});
  m.withScope({kind:'raw-rescue',parent:'C:\\Private\\Folio\\Out'},()=>{},()=>{});
  expect(record.caps.map((c:any)=>c.kind)).toEqual(['restore-target','backup-archive','raw-rescue']);
  expect(record.caps[0].source.manifestSha256).toBe('c'.repeat(64));
  expect(record.caps[2].source).toBeUndefined();
 });
 it('orphan-archive forwards the retained expected file proof',()=>{
  const {m,record,expected}=mk();
  m.withScope({kind:'orphan-archive',file:expected,parent:'C:\\Private\\Folio\\Out'},()=>{},()=>{});
  expect(record.caps[0].file.expected).toBe(expected);
 });
 it('routes diagnostic output through retained native directory authority and rejects restore mutations',()=>{
  const f=fakeProduct(),pin={path:WS,fileId:'a'.repeat(32),volumeId:'b'.repeat(16)};
  const requests:any[]=[];
  f.product.authorizeReadOnlyRescue=(request:any)=>{requests.push(request);return {kind:request.kind,path:request.path,capabilityRoot:request.capabilityRoot,privateFilesystem:f.selected,assertCurrent:request.assertCurrent};};
  const m=createNativeMaintenance({product:f.product,operatorConfig:CONFIG,selection:SELECTION,workspace:WS,current:()=>{},readOnlyWorkspace:pin});
  m.withScope({kind:'raw-rescue',parent:SELECTION.outputParent},()=>{},()=>{expect(privatePersistencePort()).toBeTruthy();});
  expect(requests).toHaveLength(1);expect(requests[0].workspaceDirectory).toBe(pin);expect(f.record.caps).toHaveLength(0);
  expect(()=>m.withScope({kind:'restore-target',source:{directory:SELECTION.outputParent,manifestPath:'m',manifestSha256:'a'.repeat(64)},parent:SELECTION.outputParent},()=>{},()=>{})).toThrow('readonly-maintenance-mutation');
  proveMaintenanceOutputParent(f.product,SELECTION,()=>{},{exists:()=>true,directory:()=>({isDirectory:()=>true,isSymbolicLink:()=>false})},pin);
  expect(requests).toHaveLength(2);expect(f.record.caps).toHaveLength(0);
 });
 it('a stale current fence stops admission before any capability minted',()=>{
  const {m,record}=mk();
  expect(()=>m.withScope({kind:'raw-rescue',parent:'C:\\Private\\Folio\\Out'},()=>{throw new Error('stale');},()=>{})).toThrow('stale');
  expect(record.caps).toHaveLength(0);
 });
 it('admitOrphan inspects then admits the same detached expected proof',()=>{
  const {m,record,expected}=mk();
  const got=m.admitOrphan(expected.path,()=>{});
  expect(got).toBe(expected);
  expect(record.inspected[0].path).toBe(expected.path);
  expect(record.files[0].expected).toBe(expected);
 });
 it('the captured facade resolves the selected port at move time, not the base port',()=>{
  const {m,selected,base}=mk();
  let captured:NativePrivateFilesystemPort|undefined;
  m.withOrphan(()=>{captured=privatePersistencePort();});
  expect(captured).toBeTruthy();
  captured!.inspectFile('C:\\Private\\Folio\\workspace\\assets\\o.bin',10);
  expect(base.calls.some(c=>c.startsWith('inspectFile:base'))).toBe(true);
  base.calls.length=0;
  m.withScope({kind:'orphan-archive',file:{path:'p',fileId:'d'.repeat(32),volumeId:'c'.repeat(16),bytes:1,sha256:'2'.repeat(64)},parent:'C:\\Private\\Folio\\Out'},()=>{},()=>{
   captured!.inspectFile('C:\\Private\\Folio\\workspace\\assets\\o.bin',10);
  });
  expect(selected.calls.some(c=>c.startsWith('inspectFile:sel'))).toBe(true);
  expect(base.calls).toHaveLength(0);
 });
});

function fakeMaintenance(log:NativeMaintenanceRequest[]=[],handoff?:PreparedRestoreHandoff):NativeMaintenance{
 return {
  withScope(req,current,work){log.push(req);current();return work();},
  admitOrphan(path,current){current();return {path,fileId:'F',volumeId:'V',bytes:1,sha256:'3'.repeat(64)};},
  withOrphan(work){return work();},
  prepareRestored(verified,current){current();if(!handoff)throw new Error('prepare-failed');return handoff;},
  checkRestored(h,current){current();},
 };
}

describe('service wiring with a scoped nativeMaintenance port',()=>{
 it('choose runs verification inside a backup-source scope with the exact selection',()=>{
  const f=fixture(),source=new WorkspaceBackupService(f.store.db,f.directory).create();
  const log:NativeMaintenanceRequest[]=[];
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,fakeMaintenance(log));
  const preview=service.choose(source.directory);
  expect(preview.directory).toBe(source.directory);
  expect(log).toHaveLength(1);
  expect(log[0].kind).toBe('backup-source');
  expect((log[0] as any).source.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('restore rereads the exact manifest and rejects a changed manifest hash',()=>{
  const f=fixture(),maker=new WorkspaceBackupService(f.store.db,f.directory),source=maker.create();
  const log:NativeMaintenanceRequest[]=[];
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,fakeMaintenance(log));
  const preview=service.choose(source.directory);
  const manifestPath=join(source.directory,'manifest.json');
  fs.appendFileSync(manifestPath,'\n');
  expect(()=>service.restore(preview.ticket,f.root)).toThrow(/変更/);
  expect(fs.readdirSync(f.root).filter(n=>n.startsWith('Folio-restored-'))).toHaveLength(0);
 });
 it('restore runs inside a restore-target scope carrying source+parent',()=>{
  const f=fixture(),source=new WorkspaceBackupService(f.store.db,f.directory).create();
  const log:NativeMaintenanceRequest[]=[];
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,fakeMaintenance(log));
  const preview=service.choose(source.directory);
  const restored=service.restore(preview.ticket,f.root);
  expect(restored.sourceDirectory).toBe(source.directory);
  const req=log.find(r=>r.kind==='restore-target')!;
  expect((req as any).parent).toBe(f.root);
  expect((req as any).source.directory).toBe(source.directory);
  expect((req as any).source.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('open prepares and re-checks the handoff, passing it to launch',async()=>{
  const f=fixture(),source=new WorkspaceBackupService(f.store.db,f.directory).create();
  const close=vi.fn();
  const handoff:PreparedRestoreHandoff={assertCurrent(){},childEnvironment:env=>({...env}),close};
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,fakeMaintenance([],handoff));
  const preview=service.choose(source.directory);
  const restored=service.restore(preview.ticket,f.root);
  let launched:unknown;
  await service.open(restored.ticket,async(dir,h)=>{launched={dir,h};});
  expect((launched as any).h).toBe(handoff);
  expect(close).toHaveBeenCalledTimes(1);
  await expect(service.open(restored.ticket,async()=>{})).rejects.toThrow(/既に開いています/);
 });
 it('a failed preparation blocks the ticket instead of adopting partial state',async()=>{
  const f=fixture(),source=new WorkspaceBackupService(f.store.db,f.directory).create();
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,fakeMaintenance([]));
  const preview=service.choose(source.directory);
  const restored=service.restore(preview.ticket,f.root);
  await expect(service.open(restored.ticket,async()=>{})).rejects.toThrow('prepare-failed');
  await expect(service.open(restored.ticket,async()=>{})).rejects.toThrow(/既に開いています/);
 });
 it('storage rawSalvage forwards a raw-rescue scope to the selected parent',async()=>{
  const f=fixture();
  const log:NativeMaintenanceRequest[]=[];
  const service=new WorkspaceStorageService(f.directory,f.store.db,{},async()=>f.out,undefined,undefined,undefined,fakeMaintenance(log));
  const salvage=await service.handleUtility({type:'storage:rawSalvage'},()=>true) as any;
  expect(salvage).toBeTruthy();
  expect(log.some(r=>r.kind==='raw-rescue'&&(r as any).parent===f.out)).toBe(true);
 });
 it('archive plan/move uses the ticket source and a backup-archive scope',async()=>{
  const f=fixture();
  const older=(service:WorkspaceStorageService)=>{const b=service.backups.create();const mp=join(b.directory,'manifest.json');const m=JSON.parse(fs.readFileSync(mp,'utf8'));m.createdAt='2020-01-01T00:00:00.000Z';fs.writeFileSync(mp,JSON.stringify(m));return b;};
  const log:NativeMaintenanceRequest[]=[];
  let pickCount=0;
  const service=new WorkspaceStorageService(f.directory,f.store.db,{},async()=>++pickCount===1?null:f.out,undefined,undefined,undefined,fakeMaintenance(log));
  const first=older(service);
  service.backups.create();
  let pickCount2=0;
  const picker=async()=>++pickCount2===1?first.directory:f.out;
  const planning=new WorkspaceStorageService(f.directory,f.store.db,{},picker,undefined,undefined,undefined,fakeMaintenance(log));
  planning.backups.releaseTickets();
  const proposal=await planning.handleUtility({type:'storage:archivePlan'},()=>true) as any;
  expect(proposal.ticket).toBeTruthy();
  const moved=await planning.handleUtility({type:'storage:archiveMove',ticket:proposal.ticket},()=>true) as any;
  expect(moved.destination).toContain('out');
  const archiveReq=log.find(r=>r.kind==='backup-archive') as any;
  expect(archiveReq).toBeTruthy();
  expect(archiveReq.source.directory).toBe(first.directory);
  expect(archiveReq.parent).toBe(f.out);
 });
});

describe('trusted restore launch adapter (off-host contract only)',()=>{
 it('forwards exact tree, manifest fingerprint, originating fence and single ticket without initializing owner metadata',()=>{
  const f=fixture(),maker=new WorkspaceBackupService(f.store.db,f.directory);
  const restored=maker.restore(maker.create().ticket,f.out),verified=verifyFullBackup(restored.directory);
  const product=fakeProduct().product;
  const tree={path:verified.directory,fileId:'d'.repeat(32),volumeId:'e'.repeat(16),entries:2,bytes:verified.manifest.database.bytes,sha256:'f'.repeat(64)};
  product.privateFilesystem.inspectTree=()=>tree;
  const launch:PreparedRestoreHandoff={childEnvironment:env=>({...env}),assertCurrent(){},close(){}};
  const prepare=vi.fn(()=>launch);let allowed=true;
  const maintenance=createNativeMaintenance({product,operatorConfig:CONFIG,selection:SELECTION,workspace:WS,workspaceId:'ws-current',current:()=>{},prepareRestoreLaunch:prepare});
  expect(maintenance.prepareRestored!(verified,()=>{if(!allowed)throw new Error('stale');},restored.ticket)).toBe(launch);
  expect(prepare).toHaveBeenCalledTimes(1);
  const [config,request]=prepare.mock.calls[0] as unknown as [typeof CONFIG,import('../src/platform/windows/restored-workspace-handoff').WindowsRestoreLaunchRequest];
  expect(config).toBe(CONFIG);expect(request.ticket).toBe(restored.ticket);expect(request.verifiedFingerprint).toBe(verified.fingerprint);expect(request.verifiedTree).toBe(tree);
  expect(request.current.directory).toBe(WS);expect(request.current.workspaceId).toBe('ws-current');
  allowed=false;expect(()=>request.current.assertCurrent()).toThrow('stale');
  expect(fs.existsSync(join(verified.directory,'private-owner.sqlite'))).toBe(false);
  expect(verifyFullBackup(verified.directory).fingerprint).toBe(verified.fingerprint);
 });
 it('refuses launch preparation without the actual current workspace identity',()=>{
  const f=fixture(),maker=new WorkspaceBackupService(f.store.db,f.directory),verified=verifyFullBackup(maker.create().directory);
  const prepare=vi.fn(()=>{throw new Error('unexpected');});
  const m=createNativeMaintenance({product:fakeProduct().product,operatorConfig:CONFIG,selection:SELECTION,workspace:WS,current:()=>{},prepareRestoreLaunch:prepare});
  expect(()=>m.prepareRestored!(verified,()=>{},'ticket')).toThrow('restored-current-workspace-required');expect(prepare).not.toHaveBeenCalled();
 });
 it('the strict verifier continues rejecting an extra initialized owner',()=>{
  const f=fixture(),maker=new WorkspaceBackupService(f.store.db,f.directory),restored=maker.restore(maker.create().ticket,f.out);
  fs.writeFileSync(join(restored.directory,'private-owner.sqlite'),'unexpected owner');
  expect(()=>verifyFullBackup(restored.directory)).toThrow();
 });
 for(const cleanupFails of [false,true])it(`consumes a failed launch once and retains cleanup failure (cleanupFails=${cleanupFails})`,async()=>{
  const f=fixture(),maker=new WorkspaceBackupService(f.store.db,f.directory),original=new Error('spawn unknown'),cleanup=new Error('raw protector unknown');
  const close=vi.fn(()=>{if(cleanupFails)throw cleanup;});
  const handoff:PreparedRestoreHandoff={childEnvironment:env=>({...env}),assertCurrent(){},close};
  const m=fakeMaintenance([],handoff),prepare=vi.spyOn(m,'prepareRestored');
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,m);
  const restored=service.restore(service.choose(maker.create().directory).ticket,f.out);
  const launch=vi.fn(async()=>{throw original;});
  try{await service.open(restored.ticket,launch);throw new Error('unexpected success');}catch(error){
   if(cleanupFails)expect((error as AggregateError).errors).toEqual([original,cleanup]);else expect(error).toBe(original);
  }
  await expect(service.open(restored.ticket,launch)).rejects.toThrow(/既に開いています/);
  expect(prepare).toHaveBeenCalledTimes(1);expect(launch).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
 });
});

describe('restore stale-fence and output-parent proofs',()=>{
 it('restoreAfterPicker refuses mutation when authority flips inside the scope',async()=>{
  const f=fixture();
  let ok=true;
  const maintenance={withScope(_r:any,current:any,work:any){ok=false;current();return work();},admitOrphan:()=>{throw new Error('unexpected')},withOrphan:(w:any)=>w()} as unknown as NativeMaintenance;
  const service=new WorkspaceBackupService(f.store.db,f.directory,{},undefined,undefined,maintenance);
  const src=service.create();
  await expect(service.restoreAfterPicker(src.ticket,async()=>f.out,()=>ok)).rejects.toThrow('unauthorized');
  expect(fs.readdirSync(f.out)).toEqual([]);
 });
 it('a stale current at output-parent proof performs zero capability calls',()=>{
  const f=fixture();
  const calls:any[]=[];
  const product={privateFilesystem:posixishPort(),authorizeExternalCapability:(r:any)=>{calls.push(r);return {privateFilesystem:posixishPort(),assertCurrent:()=>{}};}} as any;
  expect(()=>proveMaintenanceOutputParent(product,{root:f.root,workspace:f.directory,capabilityRoot:f.root,stateRoot:join(f.root,'state'),outputParent:f.out} as any,()=>{throw new Error('stale');})).toThrow('stale');
  expect(calls).toEqual([]);
 });
 it('an existing unknown output is authorized before its capability inspect',()=>{
  // Windows-STRING fixture: the V planner adjudicates lexical windows
  // paths without host FS; the observations seam supplies the existence
  // answers so no real Windows FS is required.
  const calls:string[]=[];
  const spy=(tag:string)=>{const base=posixishPort();return {...base,inspectDirectory:(p:string)=>{calls.push(`${tag}:inspect:${p}`);return base.inspectDirectory(p);},createDirectory:(p:string)=>{calls.push(`${tag}:create:${p}`);return {path:p,fileId:'1'.repeat(32),volumeId:'2'.repeat(16)};}};};
  const product={privateFilesystem:spy('base'),authorizeExternalCapability:(r:any)=>{calls.push(`authorize:${r.kind}`);return {privateFilesystem:spy('cap'),assertCurrent:()=>calls.push('cap:assert')};}} as any;
  const sel={root:'D:\\FolioData',capabilityRoot:'D:\\FolioData',workspace:'D:\\FolioData\\workspace',stateRoot:'D:\\FolioState',outputParent:'D:\\FolioData\\out'} as any;
  const obs={exists:()=>true,directory:()=>({isDirectory:()=>true,isSymbolicLink:()=>false})};
  proveMaintenanceOutputParent(product,sel,()=>{},obs);
  expect(calls[0]).toBe('authorize:raw-rescue');
  expect(calls.some(c=>c==='cap:inspect:D:\\FolioData\\out')).toBe(true);
  expect(calls.some(c=>c.startsWith('base:'))).toBe(false);
 });
 it('a missing final child is created via the base port after the root proof',()=>{
  const calls:string[]=[];
  const spy=(tag:string)=>{const base=posixishPort();return {...base,inspectDirectory:(p:string)=>{calls.push(`${tag}:inspect:${p}`);return base.inspectDirectory(p);},createDirectory:(p:string)=>{calls.push(`${tag}:create:${p}`);return {path:p,fileId:'1'.repeat(32),volumeId:'2'.repeat(16)};}};};
  const product={privateFilesystem:spy('base'),authorizeExternalCapability:(r:any)=>{calls.push(`authorize:${r.kind}`);return {privateFilesystem:spy('cap'),assertCurrent:()=>calls.push('cap:assert')};}} as any;
  const sel={root:'D:\\FolioData',capabilityRoot:'D:\\FolioData',workspace:'D:\\FolioData\\workspace',stateRoot:'D:\\FolioState',outputParent:'D:\\FolioData\\out2'} as any;
  const obs={exists:(p:string)=>p==='D:\\FolioData',directory:()=>({isDirectory:()=>true,isSymbolicLink:()=>false})};
  proveMaintenanceOutputParent(product,sel,()=>{},obs);
  expect(calls).toEqual(['base:inspect:D:\\FolioData','base:create:D:\\FolioData\\out2','authorize:raw-rescue','cap:assert']);
 });
 it('a denied output capability propagates with zero base mutations',()=>{
  const calls:string[]=[];
  const spy=(tag:string)=>{const base=posixishPort();return {...base,inspectDirectory:(p:string)=>{calls.push(`${tag}:inspect:${p}`);return base.inspectDirectory(p);},createDirectory:(p:string)=>{calls.push(`${tag}:create:${p}`);return {path:p,fileId:'1'.repeat(32),volumeId:'2'.repeat(16)};}};};
  const product={privateFilesystem:spy('base'),authorizeExternalCapability:()=>{calls.push('authorize');throw new Error('capability-denied');}} as any;
  const sel={root:'D:\\FolioData',capabilityRoot:'D:\\FolioData',workspace:'D:\\FolioData\\workspace',stateRoot:'D:\\FolioState',outputParent:'D:\\FolioData\\out'} as any;
  const obs={exists:()=>true,directory:()=>({isDirectory:()=>true,isSymbolicLink:()=>false})};
  expect(()=>proveMaintenanceOutputParent(product,sel,()=>{},obs)).toThrow('capability-denied');
  expect(calls.some(c=>c.includes(':create:'))).toBe(false);
 });
});

function posixishPort():NativePrivateFilesystemPort{
 const id=(p:string)=>({path:p,fileId:createHash('sha256').update('id:'+p).digest('hex').slice(0,32),volumeId:'0'.repeat(15)+'1'});
 return {platform:'win32',version:1,synchronous:true,
  inspectDirectory:id,
  inspectFile:(p:string)=>{const b=fs.readFileSync(p);return {...id(p),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};},
  inspectFileIdentity:id,
  read:()=>new Uint8Array(0),
  writeNew:()=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:{...id('w'),bytes:0,sha256:'0'.repeat(64)}}),
  copyNew:()=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:{...id('c'),bytes:0,sha256:'0'.repeat(64)}}),
  renameNew:()=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:{...id('r'),bytes:0,sha256:'0'.repeat(64)}}),
  unlinkExact:()=>{},
  proveSync:()=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:{...id('s'),bytes:0,sha256:'0'.repeat(64)}}),
  createDirectory:id,
  snapshotSqlite:()=>({profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH',identity:{...id('q'),bytes:0,sha256:'0'.repeat(64)}}),
 } as NativePrivateFilesystemPort;
}
function verify(directory:string){return verifyFullBackup(directory);}
