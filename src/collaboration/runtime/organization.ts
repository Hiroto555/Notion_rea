import {
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type AuthContext,
  type Role,
} from "./contract";
import type { StoragePort } from "./storage-port";

export type OrganizationRow = {
  orgId: string;
  ownerIds: string[];
  memberIds: string[];
  version: number;
};

export type WorkspaceAccess = {
  workspaceId: string;
  name: string;
  role: Role | null;
};

export type WorkspaceMember = {
  userId: string;
  role: Role;
};

export type OrganizationOverview = {
  orgId: string;
  version: number;
  isAdministrator: boolean;
  members: string[];
  workspaces: { workspaceId: string; name: string; role: Role | null }[];
};

export type OrganizationAuditAction = "handoff" | "leave" | "revoke";

export type OrganizationAudit = Readonly<{
  action: OrganizationAuditAction;
  orgId: string;
  actorId: string;
  targetId: string | null;
  workspaceIds: string[];
  fromVersion: number;
  toVersion: number;
}>;

export interface WorkspacePolicy {
  createWorkspace(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    name: string,
  ): void;
  grant(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    userId: string,
    role: Role | null,
  ): void;
  workspaces(auth: AuthContext, orgId: string): readonly WorkspaceAccess[];
  members(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
  ): readonly WorkspaceMember[];
  leaveOrganization(auth: AuthContext, orgId: string): void;
  transferOrganization(
    auth: AuthContext,
    orgId: string,
    newOwnerId: string,
  ): void;
  revokeMember(auth: AuthContext, orgId: string, userId: string): void;
}

const ORGANIZATION_NAMESPACE = "organization";
const AUDIT_NAMESPACE = "organization.audit";

function userIdOf(auth: AuthContext): string {
  demand(auth !== null && typeof auth === "object", "INVALID_AUTH");
  return identifier(auth.userId);
}

function idList(value: unknown, code: string): string[] {
  demand(Array.isArray(value), code);
  const ids = value.map((item) => identifier(item));
  demand(new Set(ids).size === ids.length, code);
  return ids;
}

function organizationRow(value: unknown, orgId: string): OrganizationRow {
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "ORGANIZATION_MISSING",
  );
  const raw = value as Record<string, unknown>;
  demand(raw.orgId === orgId, "ORGANIZATION_MISMATCH");
  const ownerIds = idList(raw.ownerIds, "INVALID_OWNERS");
  const memberIds = idList(raw.memberIds, "INVALID_MEMBERS");
  const version = safeCounter(raw.version);
  demand(
    ownerIds.every((ownerId) => memberIds.includes(ownerId)),
    "INVALID_OWNERS",
  );
  return { orgId, ownerIds, memberIds, version };
}

function roleValue(value: unknown): Role | null {
  if (value === null) return null;
  demand(
    value === "owner" || value === "editor" || value === "viewer",
    "INVALID_ROLE",
  );
  return value;
}

function workspaceList(value: readonly WorkspaceAccess[]): WorkspaceAccess[] {
  demand(Array.isArray(value), "INVALID_WORKSPACES");
  const seen = new Set<string>();
  return value.map((item) => {
    demand(
      item !== null && typeof item === "object" && !Array.isArray(item),
      "INVALID_WORKSPACE",
    );
    const workspaceId = identifier((item as WorkspaceAccess).workspaceId);
    demand(!seen.has(workspaceId), "DUPLICATE_WORKSPACE");
    seen.add(workspaceId);
    const name = (item as WorkspaceAccess).name;
    demand(
      typeof name === "string" && wellFormed(name),
      "INVALID_WORKSPACE_NAME",
    );
    const rawRole = (item as { role?: unknown }).role;
    const role = rawRole === undefined ? null : roleValue(rawRole);
    return { workspaceId, name, role };
  });
}

function memberList(value: readonly WorkspaceMember[]): WorkspaceMember[] {
  demand(Array.isArray(value), "INVALID_MEMBERS");
  const seen = new Set<string>();
  return value.map((item) => {
    demand(
      item !== null && typeof item === "object" && !Array.isArray(item),
      "INVALID_MEMBER",
    );
    const userId = identifier((item as WorkspaceMember).userId);
    demand(!seen.has(userId), "DUPLICATE_MEMBER");
    seen.add(userId);
    const role = roleValue((item as WorkspaceMember).role);
    demand(role !== null, "INVALID_ROLE");
    return { userId, role };
  });
}

function selectedWorkspaces(value: readonly string[]): string[] {
  const ids = idList(value, "INVALID_WORKSPACES");
  const seen = new Set<string>();
  for (const id of ids) {
    demand(!seen.has(id), "DUPLICATE_WORKSPACE");
    seen.add(id);
  }
  return ids;
}

export class OrganizationService {
  constructor(
    private readonly store: StoragePort,
    private readonly policy: WorkspacePolicy,
  ) {}

  overview(auth: AuthContext, orgId: string): OrganizationOverview {
    const actorId = userIdOf(auth);
    const organization = this.readOrganization(orgId);
    this.requireMember(organization, actorId);
    const isAdministrator = organization.ownerIds.includes(actorId);
    const workspaces = workspaceList(
      this.policy.workspaces(auth, organization.orgId),
    ).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      role: workspace.role,
    }));
    return {
      orgId: organization.orgId,
      version: organization.version,
      isAdministrator,
      members: [...organization.memberIds].sort(),
      workspaces,
    };
  }

  handoff(
    auth: AuthContext,
    orgId: string,
    targetUserId: string,
    workspaceIds: readonly string[],
  ): void {
    const actorId = userIdOf(auth);
    const targetId = identifier(targetUserId);
    const selected = selectedWorkspaces(workspaceIds);
    demand(targetId !== actorId, "TARGET_INVALID");
    this.inTransaction(() => {
      const before = this.readOrganization(orgId);
      this.requireAdministrator(before, actorId);
      this.requireActiveMember(before, targetId);
      const workspaces = workspaceList(
        this.policy.workspaces(auth, before.orgId),
      );
      for (const workspaceId of selected) {
        demand(
          workspaces.some((workspace) => workspace.workspaceId === workspaceId),
          "WORKSPACE_MISSING",
        );
        const members = memberList(
          this.policy.members(auth, before.orgId, workspaceId),
        );
        demand(
          members.some((member) => member.userId === targetId),
          "TARGET_INACTIVE",
        );
      }
      for (const workspaceId of selected) {
        this.policy.grant(auth, before.orgId, workspaceId, targetId, "owner");
      }
      this.policy.transferOrganization(auth, before.orgId, targetId);
      const after = this.readOrganization(before.orgId);
      demand(after.ownerIds.includes(targetId), "TRANSFER_FAILED");
      demand(after.memberIds.includes(targetId), "TRANSFER_FAILED");
      this.writeAudit(before, after, {
        action: "handoff",
        actorId,
        targetId,
        workspaceIds: selected,
      });
    });
  }

  leave(auth: AuthContext, orgId: string): void {
    const actorId = userIdOf(auth);
    this.inTransaction(() => {
      const before = this.readOrganization(orgId);
      this.requireMember(before, actorId);
      if (before.ownerIds.includes(actorId))
        demand(
          before.ownerIds.some((ownerId) => ownerId !== actorId),
          "LAST_OWNER",
        );
      for (const workspace of workspaceList(
        this.policy.workspaces(auth, before.orgId),
      )) {
        if (workspace.role !== "owner") continue;
        const members = memberList(
          this.policy.members(auth, before.orgId, workspace.workspaceId),
        );
        demand(
          members.some(
            (member) => member.role === "owner" && member.userId !== actorId,
          ),
          "LAST_OWNER",
        );
      }
      this.policy.leaveOrganization(auth, before.orgId);
      const after = this.readOrganization(before.orgId);
      demand(!after.memberIds.includes(actorId), "LEAVE_FAILED");
      demand(!after.ownerIds.includes(actorId), "LEAVE_FAILED");
      this.writeAudit(before, after, {
        action: "leave",
        actorId,
        targetId: null,
        workspaceIds: [],
      });
    });
  }

  revoke(auth: AuthContext, orgId: string, userId: string): void {
    const actorId = userIdOf(auth);
    const targetId = identifier(userId);
    demand(targetId !== actorId, "TARGET_INVALID");
    this.inTransaction(() => {
      const before = this.readOrganization(orgId);
      this.requireAdministrator(before, actorId);
      this.requireActiveMember(before, targetId);
      if (before.ownerIds.includes(targetId))
        demand(
          before.ownerIds.some((ownerId) => ownerId !== targetId),
          "LAST_OWNER",
        );
      for (const workspace of workspaceList(
        this.policy.workspaces(auth, before.orgId),
      )) {
        const members = memberList(
          this.policy.members(auth, before.orgId, workspace.workspaceId),
        );
        const target = members.find((member) => member.userId === targetId);
        if (target?.role !== "owner") continue;
        demand(
          members.some(
            (member) => member.role === "owner" && member.userId !== targetId,
          ),
          "LAST_OWNER",
        );
      }
      this.policy.revokeMember(auth, before.orgId, targetId);
      const after = this.readOrganization(before.orgId);
      demand(!after.memberIds.includes(targetId), "REVOKE_FAILED");
      demand(!after.ownerIds.includes(targetId), "REVOKE_FAILED");
      this.writeAudit(before, after, {
        action: "revoke",
        actorId,
        targetId,
        workspaceIds: [],
      });
    });
  }

  private readOrganization(orgId: string): OrganizationRow {
    const normalized = identifier(orgId);
    return organizationRow(
      this.store.get(ORGANIZATION_NAMESPACE, normalized),
      normalized,
    );
  }

  private requireMember(organization: OrganizationRow, userId: string): void {
    demand(organization.memberIds.includes(userId), "NOT_MEMBER");
  }

  private requireAdministrator(
    organization: OrganizationRow,
    userId: string,
  ): void {
    this.requireMember(organization, userId);
    demand(organization.ownerIds.includes(userId), "NOT_ADMINISTRATOR");
  }

  private requireActiveMember(
    organization: OrganizationRow,
    userId: string,
  ): void {
    demand(organization.memberIds.includes(userId), "TARGET_MISSING");
  }

  private inTransaction<T>(work: () => T): T {
    const active = this.store.db.isTransaction;
    demand(typeof active === "boolean", "TRANSACTION_STATE_UNKNOWN");
    return active ? work() : this.store.transaction(work);
  }

  private writeAudit(
    before: OrganizationRow,
    after: OrganizationRow,
    event: Pick<
      OrganizationAudit,
      "action" | "actorId" | "targetId" | "workspaceIds"
    >,
  ): void {
    demand(after.version >= before.version, "VERSION_REGRESSION");
    const sequence = this.store.all(AUDIT_NAMESPACE).length;
    const audit: OrganizationAudit = {
      action: event.action,
      orgId: after.orgId,
      actorId: event.actorId,
      targetId: event.targetId,
      workspaceIds: [...event.workspaceIds],
      fromVersion: before.version,
      toVersion: after.version,
    };
    this.store.set(
      AUDIT_NAMESPACE,
      `${after.orgId}:${String(after.version)}:${event.action}:${String(sequence).padStart(12, "0")}`,
      audit,
    );
  }
}
