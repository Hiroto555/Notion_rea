import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { requestSchema } from "../src/shared/types";
import { RECOVERY_ORIGIN_KEY } from "../src/shared/conflict-recovery";
import { NORMAL_APPLY_KEY } from "../src/sync/normal-apply-journal";
import { CONFLICT_DECISION_KEY } from "../src/sync/conflict-decision";
import { assertReadOnlyRequest } from "../src/main/read-only-workspace";
const target={source:"a".repeat(64),id:1,operationId:randomUUID(),kind:"conflict-local",createdAt:1,checkpointHash:"b".repeat(64)};
it("keeps recovery policy and both consent journals outside generic setting IPC",()=>{
  for(const key of [RECOVERY_ORIGIN_KEY,NORMAL_APPLY_KEY,CONFLICT_DECISION_KEY,"folio.recovery.workspaceId"])
    expect(requestSchema.safeParse({type:"setting",key,value:""}).success).toBe(false);
  expect(requestSchema.safeParse({type:"setting",key:"theme",value:"dark"}).success).toBe(true);
});
it("accepts bounded archive selection but never renderer filesystem paths or checkpoint bytes",()=>{
  const request={type:"recovery:export",target,mode:"complete-bundle",operationId:randomUUID()};
  expect(requestSchema.safeParse(request).success).toBe(true);
  for(const extra of [{destination:"/tmp/renderer-selected"},{checkpointJson:"{}"},{ticket:"forged"}])
    expect(requestSchema.safeParse({...request,...extra}).success).toBe(false);
  expect(requestSchema.safeParse({...request,target:{...target,checkpointJson:"{}"}}).success).toBe(false);
  expect(requestSchema.safeParse({...request,operationId:"invalid"}).success).toBe(false);
  expect(requestSchema.safeParse({type:"recovery:list",cursor:{anchor:-1,before:1}}).success).toBe(false);
});
it("allows external recovery from read-only source while refusing consent and local mutation",()=>{
  for(const request of [{type:"recovery:list"},{type:"recovery:status"},
    {type:"recovery:export",target,mode:"metadata-only",operationId:randomUUID()},
    {type:"recovery:restore",target,operationId:randomUUID()}])
    expect(()=>assertReadOnlyRequest(requestSchema.parse(request))).not.toThrow();
  for(const request of [{type:"sync:restartRequest"},{type:"sync:restartCancel",reservationId:randomUUID()}])
    expect(()=>assertReadOnlyRequest(requestSchema.parse(request))).toThrow();
});
