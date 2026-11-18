import {
  CollaborationError,
  demand,
  identifier,
  wellFormed,
  type AuthContext,
  type Role,
  type Scope,
} from "./contract";
import type { StoragePort } from "./storage-port";

export const ORGANIZATION_NAMESPACE = "organization";
export const WORKSPACE_NAMESPACE = "workspaces";
export const WORKSPACE_ROLE_NAMESPACE = "workspace.roles";

type OrganizationRecord = {
  orgId: string;
  ownerIds: string[];
  memberIds: string[];
  version: number;
};

type WorkspaceRecord = {
  orgId: string;
  workspaceId: string;
  name: string;
  createdBy: string;
};

type WorkspaceRoleRecord = {
  orgId: string;
  workspaceId: string;
  userId: string;
  role: Role;
};

export type WorkspaceAction = "read" | "write" | "manage" | "audit";
type Action = WorkspaceAction;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROLES: readonly Role[] = ["owner", "editor", "viewer"];
const ACTIONS: readonly Action[] = ["read", "write", "manage", "audit"];

function validId(value: unknown, code: string): string {
  demand(typeof value === "string" && ID.test(value), code);
  return value;
}

function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

function isAction(value: unknown): value is Action {
  return (
    typeof value === "string" && (ACTIONS as readonly string[]).includes(value)
  );
}

function record(value: unknown, code: string): Record<string, unknown> {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    code,
  );
  const proto = Object.getPrototypeOf(value);
  demand(proto === Object.prototype || proto === null, code);
  demand(Object.getOwnPropertySymbols(value).length === 0, code);
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  const object = record(value, code);
  const names = Object.getOwnPropertyNames(object);
  demand(names.length === keys.length, code);
  for (const key of keys) {
    demand(Object.prototype.hasOwnProperty.call(object, key), code);
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    demand(
      descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable,
      code,
    );
  }
  return object;
}

function idList(value: unknown, code: string): string[] {
  demand(Array.isArray(value), code);
  const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    demand(
      descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable,
      code,
    );
    ids.push(validId(descriptor.value, code));
  }
  demand(Object.getOwnPropertyNames(value).length === value.length + 1, code);
  demand(new Set(ids).size === ids.length, code);
  return ids;
}

function validName(value: unknown, code = "INVALID_WORKSPACE_NAME"): string {
  demand(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      wellFormed(value),
    code,
  );
  return value;
}

function authUser(auth: AuthContext): string {
  const value = record(auth, "INVALID_AUTH");
  return validId(value.userId, "INVALID_AUTH");
}

function organizationKey(orgId: string): string {
  return orgId;
}

function workspaceKey(orgId: string, workspaceId: string): string {
  return orgId + ":" + workspaceId;
}

function roleKey(orgId: string, workspaceId: string, userId: string): string {
  return orgId + ":" + workspaceId + ":" + userId;
}

function parseOrganization(value: unknown, key: string): OrganizationRecord {
  const object = exact(
    value,
    ["orgId", "ownerIds", "memberIds", "version"],
    "CORRUPT_ORGANIZATION",
  );
  const orgId = validId(object.orgId, "CORRUPT_ORGANIZATION");
  demand(orgId === key, "CORRUPT_ORGANIZATION");
  const ownerIds = idList(object.ownerIds, "CORRUPT_ORGANIZATION");
  const memberIds = idList(object.memberIds, "CORRUPT_ORGANIZATION");
  demand(
    ownerIds.every((owner) => memberIds.includes(owner)),
    "CORRUPT_ORGANIZATION",
  );
  demand(
    Number.isSafeInteger(object.version) && Number(object.version) >= 0,
    "CORRUPT_ORGANIZATION",
  );
  return { orgId, ownerIds, memberIds, version: Number(object.version) };
}

function parseWorkspace(value: unknown, key: string): WorkspaceRecord {
  const object = exact(
    value,
    ["orgId", "workspaceId", "name", "createdBy"],
    "CORRUPT_WORKSPACE",
  );
  const orgId = validId(object.orgId, "CORRUPT_WORKSPACE");
  const workspaceId = validId(object.workspaceId, "CORRUPT_WORKSPACE");
  demand(key === workspaceKey(orgId, workspaceId), "CORRUPT_WORKSPACE");
  const name = validName(object.name, "CORRUPT_WORKSPACE");
  const createdBy = validId(object.createdBy, "CORRUPT_WORKSPACE");
  return { orgId, workspaceId, name, createdBy };
}

function parseRole(value: unknown, key: string): WorkspaceRoleRecord {
  const object = exact(
    value,
    ["orgId", "workspaceId", "userId", "role"],
    "CORRUPT_ROLE",
  );
  const orgId = validId(object.orgId, "CORRUPT_ROLE");
  const workspaceId = validId(object.workspaceId, "CORRUPT_ROLE");
  const userId = validId(object.userId, "CORRUPT_ROLE");
  demand(key === roleKey(orgId, workspaceId, userId), "CORRUPT_ROLE");
  const role = object.role;
  if (!isRole(role)) throw new CollaborationError("CORRUPT_ROLE");
  return { orgId, workspaceId, userId, role };
}

export class WorkspacePolicy {
  constructor(private readonly store: StoragePort) {}

  private run<T>(work: () => T): T {
    return this.store.db.isTransaction ? work() : this.store.transaction(work);
  }

  private organization(orgId: string): OrganizationRecord {
    const key = organizationKey(identifier(orgId));
    const value = this.store.get(ORGANIZATION_NAMESPACE, key);
    demand(value !== null && value !== undefined, "ORGANIZATION_MISSING");
    return parseOrganization(value, key);
  }

  private workspace(orgId: string, workspaceId: string): WorkspaceRecord {
    const key = workspaceKey(identifier(orgId), identifier(workspaceId));
    const value = this.store.get(WORKSPACE_NAMESPACE, key);
    demand(value !== null && value !== undefined, "WORKSPACE_MISSING");
    return parseWorkspace(value, key);
  }

  private role(
    orgId: string,
    workspaceId: string,
    userId: string,
  ): Role | null {
    const key = roleKey(
      identifier(orgId),
      identifier(workspaceId),
      identifier(userId),
    );
    const value = this.store.get(WORKSPACE_ROLE_NAMESPACE, key);
    return value === null || value === undefined
      ? null
      : parseRole(value, key).role;
  }

  private allWorkspaces(): WorkspaceRecord[] {
    return this.store.all(WORKSPACE_NAMESPACE).map((row) => {
      demand(typeof row === "object" && row !== null, "CORRUPT_WORKSPACE");
      const raw = row as { key?: unknown; value?: unknown };
      demand(typeof raw.key === "string", "CORRUPT_WORKSPACE");
      return parseWorkspace(raw.value, raw.key);
    });
  }

  private allRoles(): WorkspaceRoleRecord[] {
    return this.store.all(WORKSPACE_ROLE_NAMESPACE).map((row) => {
      demand(typeof row === "object" && row !== null, "CORRUPT_ROLE");
      const raw = row as { key?: unknown; value?: unknown };
      demand(typeof raw.key === "string", "CORRUPT_ROLE");
      return parseRole(raw.value, raw.key);
    });
  }

  private requireMember(org: OrganizationRecord, userId: string): void {
    demand(org.memberIds.includes(userId), "NOT_ORG_MEMBER");
  }

  private requireOwner(org: OrganizationRecord, userId: string): void {
    demand(org.ownerIds.includes(userId), "NOT_ORG_OWNER");
  }

  private writeOrganization(org: OrganizationRecord): void {
    this.store.set(ORGANIZATION_NAMESPACE, organizationKey(org.orgId), org);
  }

  createWorkspace(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    name: string,
  ): void {
    const user = authUser(auth);
    const workspace = validId(workspaceId, "INVALID_ID");
    const label = validName(name);
    this.run(() => {
      const org = this.organization(orgId);
      this.requireMember(org, user);
      const key = workspaceKey(org.orgId, workspace);
      demand(
        this.store.get(WORKSPACE_NAMESPACE, key) == null,
        "WORKSPACE_EXISTS",
      );
      const existingRole = this.store.get(
        WORKSPACE_ROLE_NAMESPACE,
        roleKey(org.orgId, workspace, user),
      );
      demand(existingRole == null, "WORKSPACE_EXISTS");
      const metadata: WorkspaceRecord = {
        orgId: org.orgId,
        workspaceId: workspace,
        name: label,
        createdBy: user,
      };
      const role: WorkspaceRoleRecord = {
        orgId: org.orgId,
        workspaceId: workspace,
        userId: user,
        role: "owner",
      };
      this.store.set(WORKSPACE_NAMESPACE, key, metadata);
      this.store.set(
        WORKSPACE_ROLE_NAMESPACE,
        roleKey(org.orgId, workspace, user),
        role,
      );
    });
  }

  grant(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    userId: string,
    role: Role | null,
  ): void {
    const user = authUser(auth);
    const target = validId(userId, "INVALID_ID");
    demand(role === null || isRole(role), "INVALID_ROLE");
    this.run(() => {
      const org = this.organization(orgId);
      const workspace = this.workspace(org.orgId, workspaceId);
      this.requireMember(org, user);
      this.requireMember(org, target);
      const callerRole = this.role(org.orgId, workspace.workspaceId, user);
      demand(callerRole === "owner", "NOT_WORKSPACE_OWNER");

      const existing = this.role(org.orgId, workspace.workspaceId, target);
      if (existing === "owner" && role !== "owner") {
        const owners = this.allRoles().filter(
          (entry) =>
            entry.orgId === org.orgId &&
            entry.workspaceId === workspace.workspaceId &&
            entry.role === "owner",
        );
        demand(owners.length > 1, "LAST_WORKSPACE_OWNER");
      }

      const key = roleKey(org.orgId, workspace.workspaceId, target);
      if (role === null) {
        if (existing !== null)
          this.store.set(WORKSPACE_ROLE_NAMESPACE, key, null);
      } else {
        const next: WorkspaceRoleRecord = {
          orgId: org.orgId,
          workspaceId: workspace.workspaceId,
          userId: target,
          role,
        };
        this.store.set(WORKSPACE_ROLE_NAMESPACE, key, next);
      }
    });
  }

  authorize(auth: AuthContext, scope: Scope, action: Action): void {
    const user = authUser(auth);
    const scoped = record(scope, "INVALID_SCOPE");
    const orgId = validId(scoped.orgId, "INVALID_SCOPE");
    const workspaceId = validId(scoped.workspaceId, "INVALID_SCOPE");
    validId(scoped.documentId, "INVALID_SCOPE");
    validId(scoped.incarnationId, "INVALID_SCOPE");
    demand(isAction(action), "INVALID_ACTION");
    this.run(() => {
      const org = this.organization(orgId);
      const workspace = this.workspace(org.orgId, workspaceId);
      this.requireMember(org, user);
      const role = this.role(org.orgId, workspace.workspaceId, user);
      const owner = org.ownerIds.includes(user);
      let allowed = false;
      switch (action) {
        case "read":
          allowed = role === "owner" || role === "editor" || role === "viewer";
          break;
        case "write":
          allowed = role === "owner" || role === "editor";
          break;
        case "manage":
          allowed = role === "owner" || owner;
          break;
        case "audit":
          allowed = role === "owner";
          break;
      }
      demand(allowed, "FORBIDDEN");
    });
  }

  workspaces(
    auth: AuthContext,
    orgId: string,
  ): { workspaceId: string; name: string; role: Role | null }[] {
    const user = authUser(auth);
    return this.run(() => {
      const org = this.organization(orgId);
      this.requireMember(org, user);
      const roles = new Map<string, Role>();
      for (const entry of this.allRoles()) {
        if (entry.userId === user)
          roles.set(roleKey(entry.orgId, entry.workspaceId, user), entry.role);
      }
      return this.allWorkspaces()
        .filter((workspace) => workspace.orgId === org.orgId)
        .sort((left, right) =>
          left.workspaceId.localeCompare(right.workspaceId),
        )
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          role:
            roles.get(roleKey(org.orgId, workspace.workspaceId, user)) ?? null,
        }));
    });
  }

  members(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
  ): { userId: string; role: Role }[] {
    const user = authUser(auth);
    return this.run(() => {
      const org = this.organization(orgId);
      const workspace = this.workspace(org.orgId, workspaceId);
      this.requireMember(org, user);
      return this.allRoles()
        .filter(
          (entry) =>
            entry.orgId === org.orgId &&
            entry.workspaceId === workspace.workspaceId &&
            org.memberIds.includes(entry.userId),
        )
        .sort((left, right) => left.userId.localeCompare(right.userId))
        .map((entry) => ({ userId: entry.userId, role: entry.role }));
    });
  }

  leaveOrganization(auth: AuthContext, orgId: string): void {
    const user = authUser(auth);
    this.run(() => {
      const org = this.organization(orgId);
      this.requireMember(org, user);
      const isOrganizationOwner = org.ownerIds.includes(user);
      if (isOrganizationOwner) {
        demand(org.ownerIds.length > 1, "LAST_ORG_OWNER");
      }
      const workspaces = this.allWorkspaces().filter(
        (workspace) => workspace.orgId === org.orgId,
      );
      const roles = this.allRoles();
      const leaving = roles.filter(
        (entry) => entry.orgId === org.orgId && entry.userId === user,
      );
      for (const role of leaving) {
        if (role.role !== "owner") continue;
        const owners = roles.filter(
          (entry) =>
            entry.orgId === org.orgId &&
            entry.workspaceId === role.workspaceId &&
            entry.role === "owner",
        );
        demand(owners.length > 1, "LAST_WORKSPACE_OWNER");
      }
      const workspaceIds = new Set(
        workspaces.map((workspace) => workspace.workspaceId),
      );
      for (const role of leaving) {
        demand(workspaceIds.has(role.workspaceId), "CORRUPT_ROLE");
      }
      const next: OrganizationRecord = {
        orgId: org.orgId,
        ownerIds: org.ownerIds.filter((owner) => owner !== user),
        memberIds: org.memberIds.filter((member) => member !== user),
        version: org.version + 1,
      };
      this.writeOrganization(next);
      for (const role of leaving) {
        this.store.set(
          WORKSPACE_ROLE_NAMESPACE,
          roleKey(role.orgId, role.workspaceId, role.userId),
          null,
        );
      }
    });
  }

  transferOrganization(
    auth: AuthContext,
    orgId: string,
    newOwnerId: string,
  ): void {
    const user = authUser(auth);
    const nextOwner = validId(newOwnerId, "INVALID_ID");
    this.run(() => {
      const org = this.organization(orgId);
      this.requireMember(org, user);
      this.requireOwner(org, user);
      this.requireMember(org, nextOwner);
      if (nextOwner === user) return;
      const ownerIds = org.ownerIds.includes(nextOwner)
        ? org.ownerIds
        : [...org.ownerIds, nextOwner];
      const remaining = ownerIds.filter((owner) => owner !== user);
      demand(remaining.length > 0, "LAST_ORG_OWNER");
      this.writeOrganization({
        orgId: org.orgId,
        ownerIds: remaining,
        memberIds: org.memberIds,
        version: org.version + 1,
      });
    });
  }

  revokeMember(auth: AuthContext, orgId: string, userId: string): void {
    const user = authUser(auth);
    const target = validId(userId, "INVALID_ID");
    this.run(() => {
      const org = this.organization(orgId);
      this.requireMember(org, user);
      this.requireOwner(org, user);
      this.requireMember(org, target);
      if (org.ownerIds.includes(target)) {
        demand(org.ownerIds.length > 1, "LAST_ORG_OWNER");
      }
      const workspaces = this.allWorkspaces().filter(
        (workspace) => workspace.orgId === org.orgId,
      );
      const roles = this.allRoles();
      const targetRoles = roles.filter(
        (entry) => entry.orgId === org.orgId && entry.userId === target,
      );
      for (const role of targetRoles) {
        if (role.role !== "owner") continue;
        const owners = roles.filter(
          (entry) =>
            entry.orgId === org.orgId &&
            entry.workspaceId === role.workspaceId &&
            entry.role === "owner",
        );
        demand(owners.length > 1, "LAST_WORKSPACE_OWNER");
      }
      const workspaceIds = new Set(
        workspaces.map((workspace) => workspace.workspaceId),
      );
      for (const role of targetRoles) {
        demand(workspaceIds.has(role.workspaceId), "CORRUPT_ROLE");
      }
      this.writeOrganization({
        orgId: org.orgId,
        ownerIds: org.ownerIds.filter((owner) => owner !== target),
        memberIds: org.memberIds.filter((member) => member !== target),
        version: org.version + 1,
      });
      for (const role of targetRoles) {
        this.store.set(
          WORKSPACE_ROLE_NAMESPACE,
          roleKey(role.orgId, role.workspaceId, role.userId),
          null,
        );
      }
    });
  }
}
