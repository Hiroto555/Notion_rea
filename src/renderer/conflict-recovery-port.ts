import type { ArchivePage, RecoveryActionResult, RecoveryPanelPort } from "../shared/conflict-recovery";
/** The UI operation ID is an idempotency key; main owns the pinned target ticket. */
let operationId:string|undefined;
export const conflictRecoveryPort:RecoveryPanelPort={
  list:cursor=>window.folio.request<ArchivePage>({type:"recovery:list",cursor}),
  export:(target,mode)=> {
    operationId=crypto.randomUUID();
    return window.folio.request<RecoveryActionResult>({type:"recovery:export",target,mode,operationId});
  },
  restore:target=> {
    operationId=crypto.randomUUID();
    return window.folio.request<RecoveryActionResult>({type:"recovery:restore",target,operationId});
  },
  status:()=>window.folio.request<RecoveryActionResult|null>({type:"recovery:status",operationId}),
};
