import { z } from "zod";

// A separate namespace: these identifiers must never be reduced to pageId.
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const sharedScopeSchema = z
  .object({
    workspaceId: id,
    documentId: id,
    incarnationId: id,
  })
  .strict();
export type SharedScope = z.infer<typeof sharedScopeSchema>;
export const sharedSessionSchema = z
  .object({
    scope: sharedScopeSchema,
    sessionId: id,
    actorId: id,
    deviceId: id,
    epoch: id,
    generation: z.number().int().safe().nonnegative(),
  })
  .strict();
export type SharedSession = z.infer<typeof sharedSessionSchema>;
export const sharedEnvelopeSchema = z
  .object({
    session: sharedSessionSchema,
    operationId: id,
    raw: z.string().max(2_000_000),
  })
  .strict();
export type SharedEnvelope = z.infer<typeof sharedEnvelopeSchema>;
export function sameSession(a: SharedSession, b: SharedSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.actorId === b.actorId &&
    a.deviceId === b.deviceId &&
    a.epoch === b.epoch &&
    a.generation === b.generation &&
    sameScope(a.scope, b.scope)
  );
}
export function sameScope(a: SharedScope, b: SharedScope): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.documentId === b.documentId &&
    a.incarnationId === b.incarnationId
  );
}
