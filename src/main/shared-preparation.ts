import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SharedDraftStore } from "../collaboration/draft-store";
import {
  sharedSessionSchema,
  sameScope,
  type SharedSession,
} from "../collaboration/contract";

const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shared-draft:list") }).strict(),
  z
    .object({
      type: z.literal("shared-draft:stage"),
      operationId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
      raw: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("shared-draft:read"),
      operationId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
]);

/** Main-process preparation service, intentionally unregistered with Electron IPC.
 * The eventual host must authenticate the sender and derive identity/permission
 * before binding. Renderer request bodies never supply those fields.
 * This service provides local raw draft retention, never server save receipts.
 */
export class SharedPreparationService {
  private closed = false;
  private readonly bindings = new Map<
    string,
    { session: SharedSession; writable: boolean }
  >();
  constructor(private readonly drafts: SharedDraftStore) {}
  bindTrusted(session: SharedSession, writable = false): string {
    if (this.closed) throw new Error("SHARED_SERVICE_CLOSED");
    if (this.bindings.size >= 32) throw new Error("SHARED_BINDING_LIMIT");
    const key = randomUUID();
    this.bindings.set(key, {
      session: sharedSessionSchema.parse(session),
      writable,
    });
    return key;
  }
  revoke(binding: string): void {
    this.bindings.delete(binding);
  }
  request(binding: string, input: unknown) {
    const current = this.bindings.get(binding);
    if (!current) throw new Error("STALE_SHARED_BINDING");
    const request = requestSchema.parse(input);
    if (request.type === "shared-draft:stage") {
      if (!current.writable) throw new Error("SHARED_READ_ONLY");
      const draft = this.drafts.stage({
        session: current.session,
        operationId: request.operationId,
        raw: request.raw,
      });
      return { kind: "LOCAL_DRAFT" as const, draft };
    }
    if (request.type === "shared-draft:list")
      return {
        kind: "LOCAL_DRAFTS" as const,
        drafts: this.drafts.listFor(current.session),
      };
    const draft = this.drafts.get(request.operationId);
    if (!draft) throw new Error("SHARED_DRAFT_NOT_FOUND");
    if (
      !sameScope(draft.envelope.session.scope, current.session.scope) ||
      draft.envelope.session.actorId !== current.session.actorId ||
      draft.envelope.session.deviceId !== current.session.deviceId
    )
      throw new Error("SHARED_DRAFT_SCOPE_MISMATCH");
    return { kind: "LOCAL_DRAFT" as const, draft };
  }
  close(): void {
    this.closed = true;
    this.bindings.clear();
  }
}
