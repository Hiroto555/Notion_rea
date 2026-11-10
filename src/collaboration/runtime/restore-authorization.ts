import { randomBytes } from "node:crypto";
import type { StoragePort } from "./storage-port";
import { demand, identifier, safeCounter } from "./contract";
import { digest } from "./digest";
/** Restore creates a new credential realm. Historical break-glass keys never reactivate. */
export function authorizeRestoredOperator(
  store: StoragePort,
  orgId: string,
  userId: string,
): { recoveryKey: string; bootstrapOwner: string } {
  demand(store.db.isTransaction, "TRANSACTION_REQUIRED");
  identifier(orgId);
  identifier(userId);
  demand(store.get("meta", "primary-org") === orgId, "AUTH_SCOPE_MISMATCH");
  const org = store.get("organization", orgId) as {
    orgId: string;
    ownerIds: string[];
    memberIds: string[];
    version: number;
  } | null;
  demand(
    org && org.orgId === orgId && Array.isArray(org.memberIds),
    "ORG_MISSING",
  );
  demand(org.version < Number.MAX_SAFE_INTEGER, "SEQUENCE_LIMIT");
  safeCounter(org.version);
  const members = [...new Set([...org.memberIds, userId])];
  for (const member of members) identifier(member);
  store.set("organization", orgId, {
    orgId,
    memberIds: members,
    ownerIds: [userId],
    version: org.version + 1,
  });
  for (const row of store.all("identity.users")) {
    const user = row.value as {
      orgId?: string;
      userId?: string;
      role?: string;
      status?: string;
    };
    if (user.orgId === orgId) {
      demand(typeof user.userId === "string", "CORRUPT_USER");
      store.set("identity.users", row.key, {
        ...user,
        role: user.userId === userId ? "owner" : "member",
      });
    }
  }
  store.set("identity.users", orgId + "/" + userId, {
    orgId,
    userId,
    role: "owner",
    status: "active",
  });
  const recoveryKey = randomBytes(32).toString("base64url");
  store.set("identity.recovery", orgId, {
    orgId,
    recoveryHash: digest(recoveryKey),
  });
  store.set("identity.recovery-status", orgId, { required: false });
  return { recoveryKey, bootstrapOwner: userId };
}
