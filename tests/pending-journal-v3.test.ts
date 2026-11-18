import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {writePendingJournalFileV3} from '../src/persistence/pending-journal-file-v3';
import {parsePendingJournal} from '../src/shared/pending-journal';
import {WINDOWS_RECOVERY_MAX_BYTES,type PrivateFileV3Port} from '../src/platform/windows/private-recovery-io';
const path='C:\\Folio\\exports\\raw.json';
function fixture() {
 let calls=0;
 const port:PrivateFileV3Port={contractVersion:3,platform:'win32',publish(req){
  calls++;req.beforePublish(Uint8Array.from(req.bytes));
  return {contractVersion:3,state:'PUBLISHED',path:req.path,stagingPath:req.stagingPath,attemptId:req.attemptId,
   identity:{canonicalPath:req.path,fileId:'a'.repeat(32),volumeId:'b'.repeat(16)},
   byteLength:req.bytes.length,sha256:createHash('sha256').update(req.bytes).digest('hex'),readback:Uint8Array.from(req.bytes),
   stagingDisposition:'RENAMED_TO_FINAL',contentFlushed:true,namespace:'EXCLUSIVE_NO_REPLACE',durability:{profile:'WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1',scope:'PROCESS_CRASH'}};
 }};
 return {port,calls:()=>calls};
}
describe('actual pending journal export v3 seam (contract simulation, no Windows OS claim)',()=>{
 it('exports a valid asset-free pending journal over 1MiB and revalidates its exact text',()=>{
  const f=fixture();
  const content=JSON.stringify({format:'folio-pending-journal',schemaVersion:1,use:'manual-inspection-only',capturedThrough:20,failedIds:[],entries:Array.from({length:20},(_,i)=>({kind:'values',seq:i+1,id:'record-'+i,values:{text:'x'.repeat(80000)}}))});
  let validations=0,authorizations=0;
  const receipt=writePendingJournalFileV3(path,content,{platform:'win32',privateFilePortV3:f.port,validate:text=>{validations++;return parsePendingJournal(text);},checkDestination:()=>{authorizations++;}});
  expect(receipt.contractVersion).toBe(3);expect(Buffer.byteLength(content)).toBeGreaterThan(1024*1024);
  expect(receipt.stagingDisposition).toBe('RENAMED_TO_FINAL');
  expect(f.calls()).toBe(1);expect(validations).toBe(2);expect(authorizations).toBe(2);
 });
 it('rejects max+1 bytes and asynchronous checks before publication',()=>{
  const f=fixture();
  const options={platform:'win32' as const,privateFilePortV3:f.port,validate:()=>{},checkDestination:()=>{}};
  expect(()=>writePendingJournalFileV3(path,'x'.repeat(WINDOWS_RECOVERY_MAX_BYTES+1),options)).toThrow(/CAPACITY/);
  expect(()=>writePendingJournalFileV3(path,'{}',{...options,validate:async()=>{}})).toThrow(/synchronous/);
  expect(f.calls()).toBe(0);
 });
 it('keeps a publication uncertain if destination authority is lost at the staged readback',()=>{
  const f=fixture();let auth=0;
  expect(()=>writePendingJournalFileV3(path,'{}',{platform:'win32',privateFilePortV3:f.port,validate:JSON.parse,checkDestination:()=>{if(++auth===2)throw new Error('revoked');}})).toThrow(/preserve/);
  expect(f.calls()).toBe(1);
 });
});
