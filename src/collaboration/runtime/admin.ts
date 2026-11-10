import { z } from "zod";
import { CollaborationError, wellFormed } from "./contract";
import type { SharedAuthority } from "./authority";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const counter = z.number().int().safe().nonnegative();
const role = z.enum(["owner", "editor", "viewer"]);
const scope = z
  .object({
    orgId: identifier,
    workspaceId: identifier,
    documentId: identifier,
    incarnationId: identifier,
  })
  .strict();
const name = z.string().min(1).max(200).refine(wellFormed);
const query = z.string().max(500).refine(wellFormed);
const inviteHash = z.string().regex(/^[a-f0-9]{64}$/);
const cut = z.object({epoch: identifier, seq: counter, hash: inviteHash}).strict();

export const adminCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("head"), scope }).strict(),
  z.object({action:z.literal("stagingPreview"),scope}).strict(),
  z.object({action:z.literal("stagingAbandon"),scope,writerId:identifier,copyId:identifier,manifestHash:inviteHash,expectedCut:cut}).strict(),
  z.object({action: z.literal("protocol"), scope}).strict(),
  z.object({action: z.literal("trash"), scope}).strict(),
  z.object({action: z.literal("copyStages"), scope}).strict(),
  z.object({action: z.literal("copyStageStatus"), scope, copyId: identifier}).strict(),
  z.object({ action: z.literal("documentExport"), scope }).strict(),
  z.object({ action: z.literal("organization"), orgId: identifier }).strict(),
  z.object({ action: z.literal("overview"), orgId: identifier }).strict(),
  z
    .object({
      action: z.literal("audit"),
      orgId: identifier,
      afterSeq: counter.optional(),
      limit: z.number().int().safe().nonnegative().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("invite"),
      orgId: identifier,
      userId: identifier,
      ttlMs: z.number().int().safe().min(60_000).max(604_800_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancelInvite"),
      orgId: identifier,
      inviteHash,
    })
    .strict(),
  z
    .object({
      action: z.literal("workspaceCreate"),
      orgId: identifier,
      workspaceId: identifier,
      name,
    })
    .strict(),
  z
    .object({
      action: z.literal("revokeMember"),
      orgId: identifier,
      userId: identifier,
    })
    .strict(),
  z
    .object({
      action: z.literal("handoff"),
      orgId: identifier,
      userId: identifier,
      workspaces: z.array(identifier).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("grant"),
      scope,
      userId: identifier,
      role: role.nullable(),
    })
    .strict(),
  z.object({ action: z.literal("records"), scope }).strict(),
  z.object({ action: z.literal("search"), scope, query }).strict(),
  z.object({ action: z.literal("backlinks"), scope }).strict(),
  z.object({ action: z.literal("history"), scope }).strict(),
  z.object({ action: z.literal("backup"), orgId: identifier }).strict(),
  z.object({ action: z.literal("recoveryStatus"), orgId: identifier }).strict(),
  z.object({ action: z.literal("rotateRecovery"), orgId: identifier }).strict(),
]);

export type AdminCommand = z.infer<typeof adminCommandSchema>;
export type RecoveryStatus = Readonly<{ configured: boolean }>;
export type RecoveryRotation = Readonly<{ recoveryKey: string }>;

export function executeSharedAdmin(
  authority: SharedAuthority,
  token: string,
  input: unknown,
): unknown {
  const parsed = adminCommandSchema.safeParse(input);
  if (!parsed.success) throw new CollaborationError("INVALID_ADMIN_COMMAND");
  const command = parsed.data;
  switch (command.action) {
    case "stagingPreview": return authority.stagingPreview(token, command.scope);
    case "stagingAbandon": return authority.stagingAbandon(token, command);
    case "trash": return authority.trashList(token, command.scope);
    case "protocol": return authority.protocol(token, command.scope);
    case "copyStages": return authority.copyStageList(token, command.scope);
    case "copyStageStatus": return authority.copyStageStatus(token, command.scope, command.copyId);
    case "head": {
      const auth = authority.session(token, command.scope.orgId);
      authority.policy.authorize(auth, command.scope, "read");
      return authority.head();
    }
    case "documentExport":
      return authority.projection(token).exportDocument(command.scope);
    case "organization": {
      const auth = authority.session(token, command.orgId);
      return authority.organization.overview(auth, command.orgId);
    }
    case "overview": {
      const auth = authority.session(token, command.orgId);
      return authority.operations.overview(auth, command.orgId);
    }
    case "audit": {
      const auth = authority.session(token, command.orgId);
      return authority.operations.audit(
        auth,
        command.orgId,
        command.afterSeq ?? 0,
        command.limit ?? 100,
      );
    }
    case "invite": {
      const inviteToken =
        command.ttlMs === undefined
          ? authority.invite(token, command.orgId, command.userId)
          : authority.invite(
              token,
              command.orgId,
              command.userId,
              command.ttlMs,
            );
      return { inviteToken };
    }
    case "cancelInvite":
      authority.cancelInvite(token, command.orgId, command.inviteHash);
      return { ok: true };
    case "workspaceCreate":
      authority.createWorkspace(
        token,
        command.orgId,
        command.workspaceId,
        command.name,
      );
      return { ok: true };
    case "revokeMember":
      authority.revokeMember(token, command.orgId, command.userId);
      return { ok: true };
    case "handoff":
      authority.handoff(
        token,
        command.orgId,
        command.userId,
        command.workspaces,
      );
      return { ok: true };
    case "grant":
      authority.grant(token, command.scope, command.userId, command.role);
      return { ok: true };
    case "records":
      return authority.records(token, command.scope);
    case "search": {
      const projection = authority.projection(token);
      return projection.search(
        command.scope.orgId,
        command.scope.workspaceId,
        command.query,
      );
    }
    case "backlinks":
      return authority.projection(token).backlinks(command.scope);
    case "history":
      return authority.documentHistory(token, command.scope);
    case "backup":
      return authority.backup(token, command.orgId);
    case "recoveryStatus":
      return authority.recoveryStatus(token, command.orgId);
    case "rotateRecovery": {
      const recoveryKey = authority.rotateRecovery(token, command.orgId);
      return { recoveryKey };
    }
  }
}
