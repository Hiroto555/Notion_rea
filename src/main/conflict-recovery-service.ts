import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../persistence/store";
import { inspectRecoveredContent } from "../persistence/recovered-content";
import { assertExternalOutput, assertOutsideFolioData } from "../persistence/output-path";
import { assertRecoveryDirectory, readRecoveryFile, syncRecoveryDirectory, type RecoveryFault } from "../persistence/recovery-io";
import { exportRecoveryArchive } from "../persistence/conflict-recovery-export";
import { restoreRecoveryBundle } from "../persistence/conflict-recovery-import";
import { verifyRecoveryBundle } from "../persistence/conflict-recovery-verify";
import { listConflictArchives, readConflictArchive } from "../sync/conflict-archive-catalog";
import { canonicalJson, hashCheckpoint, parseCheckpoint, requireCondition } from "../sync/protocol";
import { RECOVERY_INCOMPLETE, type ArchiveCursor, type ArchiveTarget, type RecoveryActionResult } from "../shared/conflict-recovery";

type Mode = "metadata-only" | "complete-bundle" | "restored";
type RequestRecord = {target:ArchiveTarget;mode:string;result:RecoveryActionResult;promise:Promise<RecoveryActionResult>;op?:Operation};
type Operation = {id:string;target:ArchiveTarget;mode:Mode;directory:string;result:RecoveryActionResult};
export function admitRecoveryDestination(parent: string, payload: number): void {
  requireCondition(Number.isSafeInteger(payload) && payload >= 0,"recovery-capacity-unknown");
  const fs = statfsSync(parent), available = fs.bavail * fs.bsize;
  const required = payload; // The core supplies its conservative budget, including margin.
  requireCondition(Number.isSafeInteger(available) && Number.isSafeInteger(required) && available >= required,
    "recovery-capacity-insufficient");
}
function checkParent(source: string, parent: string): string {
  const canonical = assertRecoveryDirectory(parent);
  assertExternalOutput(source,canonical); assertOutsideFolioData(canonical);
  // A recovery bundle has no workspace.sqlite. Keep its ancestry protected too.
  for(let path=canonical;;path=dirname(path)) {
    if (existsSync(join(path,"manifest.json"))) {
      const value=JSON.parse(readRecoveryFile(path,"manifest.json",1024*1024).toString("utf8"));
      requireCondition(value?.format !== "folio-conflict-recovery" && value?.format !== "folio-workspace-backup","recovery-destination-inside-backup");
    }
    if(dirname(path)===path)break;
  }
  return canonical;
}
/** Local-only recovery. No sync registration, network, source writes, or launches. */
export class ConflictRecoveryService {
  private last?:Operation;
  private running=false;
  private requests=new Map<string,RequestRecord>();
  constructor(private readonly store:Store, private readonly directory:string,
    private readonly options:{admitBytes?:(parent:string,bytes:number)=>void;fault?:RecoveryFault}={}) {
    assertRecoveryDirectory(directory);
  }
  list(cursor?:ArchiveCursor) {return listConflictArchives(this.store.db,{cursor});}
  private assertTarget(target:ArchiveTarget):void {readConflictArchive(this.store.db,target);}
  private begin(target:ArchiveTarget,mode:Mode,directory:string,request:RequestRecord):Operation {
    const operation:Operation={id:randomUUID(),target:structuredClone(target),mode,directory,
      result:{kind:"outcome-unknown",reason:"recovery-result-unconfirmed",directory,target:structuredClone(target)}};
    this.last=operation;request.op=operation;return operation;
  }
  private inspectOperation(op:Operation|undefined):RecoveryActionResult|null {
    if(!op)return null;
    if(op.result.kind!=="outcome-unknown" || this.running)return op.result;
    try {
      const marker=lstatOptional(join(op.directory,RECOVERY_INCOMPLETE));
      if(marker) {
        requireCondition(marker.isFile() && !marker.isSymbolicLink() && marker.nlink===1,"unsafe-recovery-marker");
        op.result={kind:"blocked",reason:"recovery-incomplete-preserved",directory:op.directory,target:op.target};
        return op.result;
      }
      this.assertTarget(op.target);
      if(op.mode==="complete-bundle") {
        const verified=verifyRecoveryBundle(op.directory);
        requireCondition(canonicalJson(verified.manifest.archive)===canonicalJson(op.target),"recovery-result-changed");
      } else if(op.mode==="metadata-only") {
        const checkpoint=parseCheckpoint(JSON.parse(readRecoveryFile(op.directory,"checkpoint.json",1048576).toString("utf8")));
        requireCondition(hashCheckpoint(checkpoint)===op.target.checkpointHash,"recovery-result-changed");
      } else {
        inspectRecoveredContent(op.directory,op.target.checkpointHash);
      }
      syncRecoveryDirectory(op.directory);
      op.result={kind:op.mode,directory:op.directory,checkpointHash:op.target.checkpointHash};
    } catch { /* Preserve the exact output and keep unknown; never retry effects. */ }
    return op.result;
  }
  status(operationId?:string):RecoveryActionResult|null {
    if(operationId) {
      const request=this.requests.get(operationId);
      return request ? (request.op ? this.inspectOperation(request.op) : request.result) : {kind:"blocked",reason:"recovery-operation-not-found"};
    }
    const recent=Array.from(this.requests.values()).at(-1);
    if(this.running && recent && !recent.op && recent.result.kind==="blocked" && recent.result.reason==="recovery-operation-pending")return recent.result;
    return this.inspectOperation(this.last)??recent?.result??null;
  }
  run(target:ArchiveTarget,mode:"metadata-only"|"complete-bundle"|"restore",pick:()=>Promise<string|null>,
    authorized:()=>boolean,operationId:string=randomUUID()):Promise<RecoveryActionResult> {
    const previous=this.requests.get(operationId);
    if(previous) {
      if(previous.mode!==mode || canonicalJson(previous.target)!==canonicalJson(target))return Promise.resolve({kind:"blocked",reason:"recovery-operation-id-reused"});
      return previous.promise;
    }
    // Session-scoped idempotency: never evict an ID or an in-flight request.
    if(this.requests.size>=16)return Promise.resolve({kind:"blocked",reason:"recovery-operation-limit"});
    let settle!:(result:RecoveryActionResult)=>void;
    const promise=new Promise<RecoveryActionResult>(resolve=>{settle=resolve;});
    const request:RequestRecord={target:structuredClone(target),mode,promise,result:{kind:"blocked",reason:"recovery-operation-pending",target:structuredClone(target)}};
    this.requests.set(operationId,request);
    void this.perform(target,mode,pick,authorized,request).then(result=>{
      request.result=result;settle(result);
    },()=>{
      request.result=request.op?.result??{kind:"blocked",reason:"recovery-refused",target:request.target};settle(request.result);
    });
    return promise;
  }
  private async perform(target:ArchiveTarget, mode:"metadata-only"|"complete-bundle"|"restore",
    pick:()=>Promise<string|null>, authorized:()=>boolean,request:RequestRecord):Promise<RecoveryActionResult> {
    requireCondition(!this.running,"recovery-busy");
    if(this.last?.result.kind==="outcome-unknown" && this.inspectOperation(this.last)?.kind==="outcome-unknown")
      return {kind:"blocked",reason:"previous-recovery-result-unconfirmed",target:structuredClone(target),directory:this.last.directory};
    this.running=true;
    let op:Operation|undefined;
    try {
      const snapshot=readConflictArchive(this.store.db,structuredClone(target));
      const ticket={id:randomUUID(),target:structuredClone(snapshot.target)};
      const selected=await pick();
      if(!selected)return {kind:"cancelled"};
      requireCondition(authorized(),"unauthorized");this.assertTarget(ticket.target);
      const parent=checkParent(this.directory,selected);
      const admitBytes=(bytes:number)=>(this.options.admitBytes??admitRecoveryDestination)(parent,bytes);
      const destination=join(parent,`Folio-recovery-${Date.now()}-${ticket.id}`);
      op=this.begin(ticket.target,mode==="restore"?"complete-bundle":mode,destination,request);
      const exported=exportRecoveryArchive(snapshot,this.directory,destination,mode==="metadata-only"?"metadata-only":"complete-bundle",
        {assertTarget:()=>{requireCondition(authorized(),"unauthorized");this.assertTarget(ticket.target);},admitBytes,fault:this.options.fault});
      if(mode!=="restore") {
        op.result={kind:exported.kind,directory:exported.directory,checkpointHash:exported.checkpointHash};return op.result;
      }
      const bundle=verifyRecoveryBundle(destination);
      const restoredDestination=join(parent,`Folio-recovered-${Date.now()}-${randomUUID()}`);
      op=this.begin(ticket.target,"restored",restoredDestination,request);
      this.assertTarget(ticket.target);
      const restored=restoreRecoveryBundle(bundle,restoredDestination,{admitBytes,fault:this.options.fault});
      inspectRecoveredContent(restored.directory,ticket.target.checkpointHash);
      requireCondition(authorized(),"unauthorized");this.assertTarget(ticket.target);
      op.result={kind:"restored",directory:restored.directory,checkpointHash:restored.checkpointHash};return op.result;
    } catch {
      if(op) {
        try {
          if(lstatOptional(op.directory)) {
            const marker=lstatOptional(join(op.directory,RECOVERY_INCOMPLETE));
            if(marker?.isFile() && !marker.isSymbolicLink()) {
              op.result={kind:"blocked",reason:"recovery-incomplete-preserved",directory:op.directory,target:op.target};
            }
            return op.result;
          }
        } catch {return op.result;}
      }
      const result:RecoveryActionResult={kind:"blocked",reason:"recovery-refused",target:structuredClone(target)};
      if(op)op.result=result;return result;
    } finally {this.running=false;}
  }
}
function lstatOptional(path:string):ReturnType<typeof lstatSync>|undefined {
  try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
}
