import { commandSchema } from "../collaboration/runtime/wire";
import { adminCommandSchema } from "../collaboration/runtime/admin";
import { z } from "zod";
import type { Doc } from "./types";
import type { Scope, Snapshot, Cut } from "../collaboration/runtime/contract";
import type { WorkspaceListing } from "../collaboration/runtime/provider-port";
import type { SharedRuntimeView } from "../renderer/shared/runtime-state";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scope = z
  .object({ orgId: id, workspaceId: id, documentId: id, incarnationId: id })
  .strict();
const generation = z.number().int().nonnegative().safe();
export const sharedRuntimeRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("assetStage"),
      generation,
      uploadId: id,
      base64: z.string().max(28_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("assetRead"),
      generation,
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal("backupExport"), orgId: id }).strict(),
  z
    .object({ type: z.literal("command"), generation, command: commandSchema })
    .strict(),
  z
    .object({
      type: z.literal("resource"),
      generation,
      scope,
      command: commandSchema,
    })
    .strict(),
  z.object({ type: z.literal("resourceReconcile"), generation }).strict(),
  z.object({ type: z.literal("resourceRecover"), generation }).strict(),
  z.object({type: z.literal("recoveryList"), generation}).strict(),
  z.object({type: z.literal("recoveryRead"), generation, entryId: z.string().regex(/^rec_[a-f0-9]{64}$/)}).strict(),
  z
    .object({
      type: z.literal("resourceInvalidate"),
      generation,
      scope,
      intentId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("resourceArchive"),
      generation,
      scope,
      intentId: id,
    })
    .strict(),
  z.object({ type: z.literal("admin"), command: adminCommandSchema }).strict(),
  z
    .object({
      type: z.literal("join"),
      url: z.string().max(2048),
      orgId: id,
      deviceId: id,
      inviteToken: z.string().min(32).max(256),
      remember: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("connect"),
      url: z.string().max(2048),
      token: z.string().min(1).max(256),
      orgId: id,
      remember: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resume"),
      connectionId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal("connections") }).strict(),
  z.object({ type: z.literal("disconnect") }).strict(),
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("open"), scope }).strict(),
  z.object({ type: z.literal("refresh"), generation }).strict(),
  z.object({type: z.literal("closeDocument"), generation}).strict(),
  z
    .object({
      type: z.literal("copyPreview"),
      generation,
      sourceIds: z.array(id).min(1).max(100),
    })
    .strict(),
  z
    .object({ type: z.literal("copyCommit"), generation, previewId: id })
    .strict(),
  z.object({type: z.literal("copyAbandon"), generation, scope, copyId: id,
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({ type: z.literal("parkDraft"), generation }).strict(),
  z.object({type: z.literal("copyCatalog"), generation}).strict(),
  z
    .object({
      type: z.literal("draft"),
      generation,
      raw: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      type: z.enum(["document", "editorDocument"]),
      generation,
      base: z
        .object({
          epoch: id,
          seq: generation,
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      document: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal("reconcile"), generation }).strict(),
  z.object({ type: z.literal("undo"), generation }).strict(),
  z.object({ type: z.literal("redo"), generation }).strict(),
  z.object({ type: z.literal("recover"), generation }).strict(),
  z
    .object({ type: z.literal("invalidate"), generation, intentId: id })
    .strict(),
  z.object({ type: z.literal("archive"), generation, intentId: id }).strict(),
]);
export type SharedRuntimeRequest = z.infer<typeof sharedRuntimeRequestSchema>;
export type SharedRuntimeSession = {
  orgId?: string | null;
  generation: number;
  scope: Scope | null;
  snapshot: Snapshot | null;
  view: SharedRuntimeView;
  workspaces: WorkspaceListing[];
  pendingIntents?: {
    kind: "document" | "resource";
    scope: Scope;
    intentId: string;
    state: string;
  }[];
};
export interface SharedRuntimeAPI {
  request<T = SharedRuntimeSession>(input: SharedRuntimeRequest): Promise<T>;
}
export type SharedDocumentSubmission = { document: Doc; base: Cut };
