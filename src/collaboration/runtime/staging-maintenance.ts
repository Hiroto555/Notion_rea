import { SharedCopyStaging, COPY_STAGING_NAMESPACE } from "./copy-staging";
import { canonical } from "./canonical";
import { digest } from "./digest";
import {
  CollaborationError,
  demand,
  identifier,
  sameScope,
  type AuthContext,
  type Cut,
  type Scope,
} from "./contract";
import { parseCut, parseScope } from "./wire";
import type { StoragePort } from "./storage-port";

const HASH = /^[a-f0-9]{64}$/;
type StoredActor = Pick<AuthContext, "userId" | "deviceId" | "writerId">;
type Manifest = {
  base: string;
  scope: Scope;
  actor: StoredActor;
  copyId: string;
  manifestHash: string;
};
export type StagingReclaimRequest = {
  scope: Scope;
  writerId: string;
  copyId: string;
  manifestHash: string;
  expectedCut: Cut;
};
export type StagingReclaimPreview = {
  scope: Scope;
  cut: Cut;
  stages: {
    scope: Scope;
    writerId: string;
    copyId: string;
    manifestHash: string;
    reservedBytes: number;
    stagedParts: number;
    fenced: boolean;
  }[];
};
function record(value: unknown): Record<string, unknown> {
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "CORRUPT_COPY_STAGING",
  );
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  demand(
    typeof value === "string" && HASH.test(value),
    "COPY_MANIFEST_HASH_MISMATCH",
  );
  return value;
}
function manifest(row: { key: string; value: unknown }): Manifest {
  const value = record(row.value),
    scope = parseScope(value.scope),
    actorValue = record(value.actor),
    manifestValue = record(value.manifest);
  const actor = {
      userId: identifier(actorValue.userId),
      deviceId: identifier(actorValue.deviceId),
      writerId: identifier(actorValue.writerId),
    },
    copyId = identifier(manifestValue.copyId),
    manifestHash = hash(value.manifestHash);
  const base =
    digest({
      scope: [
        scope.orgId,
        scope.workspaceId,
        scope.documentId,
        scope.incarnationId,
      ],
      writerId: actor.writerId,
    }) +
    ":" +
    copyId;
  demand(row.key === base + ":manifest", "CORRUPT_COPY_STAGING");
  return { base, scope, actor, copyId, manifestHash };
}
/** Every matching device AND session must be revoked; a missing identity is never a fence. */
function fencedActor(
  store: StoragePort,
  scope: Scope,
  actor: StoredActor,
): AuthContext {
  let deviceKnown = false,
    sessionId: string | null = null;
  for (const namespace of ["identity.devices", "identity.sessions"]) {
    let known = false;
    for (const row of store.all(namespace)) {
      const value = record(row.value);
      demand(
        value.status === "active" || value.status === "revoked",
        "STORAGE_DRIFT",
      );
      if (identifier(value.writerId) !== actor.writerId) continue;
      demand(
        identifier(value.orgId) === scope.orgId && value.status === "revoked",
        "WRITER_NOT_FENCED",
      );
      const userId = identifier(value.userId),
        deviceId = identifier(value.deviceId);
      if (userId !== actor.userId || deviceId !== actor.deviceId) continue;
      known = true;
      if (namespace === "identity.sessions")
        sessionId = identifier(value.sessionId);
    }
    demand(known, "WRITER_NOT_FENCED");
    if (namespace === "identity.devices") deviceKnown = true;
  }
  demand(deviceKnown && sessionId !== null, "WRITER_NOT_FENCED");
  return { ...actor, sessionId };
}
function head(store: StoragePort): Cut {
  return parseCut(store.get("meta", "head"));
}
/** Owner authorization belongs to SharedAuthority; this function never reads source part bytes into its result. */
export function previewFencedStaging(
  store: StoragePort,
  input: Scope,
): StagingReclaimPreview {
  const scope = parseScope(input),
    staging = new SharedCopyStaging(store),
    stages: StagingReclaimPreview["stages"] = [];
  for (const row of store.all(COPY_STAGING_NAMESPACE)) {
    if (!row.key.endsWith(":manifest")) continue;
    const value = manifest(row);
    if (
      value.scope.orgId !== scope.orgId ||
      value.scope.workspaceId !== scope.workspaceId
    )
      continue;
    if (
      store.get(COPY_STAGING_NAMESPACE, value.base + ":abandoned") !== null ||
      store.get(COPY_STAGING_NAMESPACE, value.base + ":committed") !== null
    )
      continue;
    let fenced = false;
    try {
      fencedActor(store, value.scope, value.actor);
      fenced = true;
    } catch (error) {
      if (
        !(error instanceof CollaborationError) ||
        error.code !== "WRITER_NOT_FENCED"
      )
        throw error;
    }
    const auth: AuthContext = {
      ...value.actor,
      sessionId: "maintenance-preview",
    };
    const inspected = staging.inspect(auth, value.scope, value.copyId);
    demand(
      inspected.manifestHash === value.manifestHash,
      "CORRUPT_COPY_STAGING",
    );
    stages.push({
      scope: value.scope,
      writerId: value.actor.writerId,
      copyId: value.copyId,
      manifestHash: value.manifestHash,
      reservedBytes: inspected.totalSourceBytes,
      stagedParts: inspected.stagedParts,
      fenced,
    });
  }
  return {
    scope,
    cut: head(store),
    stages: stages.sort(
      (a, b) =>
        a.writerId.localeCompare(b.writerId) ||
        a.copyId.localeCompare(b.copyId),
    ),
  };
}
/** Explicit exact-cut cleanup of source parts only. Immutable manifest/audit/intents/receipts survive. */
export function abandonFencedStaging(
  store: StoragePort,
  input: StagingReclaimRequest,
): { writerId: string; copyId: string; abandoned: true; removedParts: number } {
  demand(store.db.isTransaction === true, "TRANSACTION_REQUIRED");
  const scope = parseScope(input.scope),
    expectedCut = parseCut(input.expectedCut),
    writerId = identifier(input.writerId),
    copyId = identifier(input.copyId),
    manifestHash = hash(input.manifestHash);
  demand(
    canonical(head(store)) === canonical(expectedCut),
    "STAGING_PLAN_STALE",
  );
  const found = store
    .all(COPY_STAGING_NAMESPACE)
    .filter((row) => row.key.endsWith(":manifest"))
    .map(manifest)
    .find(
      (value) =>
        sameScope(value.scope, scope) &&
        value.actor.writerId === writerId &&
        value.copyId === copyId,
    );
  demand(found, "COPY_NOT_FOUND");
  demand(found.manifestHash === manifestHash, "COPY_MANIFEST_HASH_MISMATCH");
  const auth = fencedActor(store, scope, found.actor);
  const result = new SharedCopyStaging(store).abandon(
    auth,
    scope,
    copyId,
    manifestHash,
  );
  return { writerId, ...result };
}
