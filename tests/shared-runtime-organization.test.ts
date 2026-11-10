import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CollaborationError,
  demand,
  type AuthContext,
  type Role,
} from "../src/collaboration/runtime/contract";
import {
  OrganizationService,
  type OrganizationRow,
  type WorkspaceAccess,
  type WorkspaceMember,
  type WorkspacePolicy,
} from "../src/collaboration/runtime/organization";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";

class TestStore implements StoragePort {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      "CREATE TABLE kv(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key));",
    );
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(namespace: string, key: string): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE namespace=? AND key=?")
      .get(namespace, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  set(namespace: string, key: string, value: unknown | null): void {
    if (value === null) {
      this.db
        .prepare("DELETE FROM kv WHERE namespace=? AND key=?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO kv(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(namespace, key, JSON.stringify(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    return (
      this.db
        .prepare("SELECT key,value FROM kv WHERE namespace=? ORDER BY key")
        .all(namespace) as {
        key: string;
        value: string;
      }[]
    ).map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
  }

  blobGet(): Uint8Array | null {
    return null;
  }

  blobPut(): void {}

  blobDelete(): void {}

  close(): void {
    this.db.close();
  }
}

class TestPolicy implements WorkspacePolicy {
  constructor(protected readonly store: TestStore) {}

  protected organization(orgId: string): OrganizationRow {
    const row = this.store.get("organization", orgId) as OrganizationRow | null;
    demand(row, "ORG_MISSING");
    return row;
  }

  protected saveOrganization(row: OrganizationRow): void {
    this.store.set("organization", row.orgId, row);
  }

  protected metadata(
    orgId: string,
  ): Record<string, { workspaceId: string; name: string }> {
    return (
      (this.store.get("workspace.meta", orgId) as Record<
        string,
        { workspaceId: string; name: string }
      > | null) ?? {}
    );
  }

  protected roles(orgId: string, workspaceId: string): Record<string, Role> {
    return (
      (this.store.get("workspace.roles", `${orgId}:${workspaceId}`) as Record<
        string,
        Role
      > | null) ?? {}
    );
  }

  role(orgId: string, workspaceId: string, userId: string): Role | null {
    return this.roles(orgId, workspaceId)[userId] ?? null;
  }

  createWorkspace(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    name: string,
  ): void {
    const organization = this.organization(orgId);
    demand(organization.memberIds.includes(auth.userId), "NOT_MEMBER");
    const metadata = this.metadata(orgId);
    this.store.set("workspace.meta", orgId, {
      ...metadata,
      [workspaceId]: { workspaceId, name },
    });
    const roles = this.roles(orgId, workspaceId);
    this.store.set("workspace.roles", `${orgId}:${workspaceId}`, {
      ...roles,
      [auth.userId]: "owner",
    });
  }

  grant(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    userId: string,
    role: Role | null,
  ): void {
    const organization = this.organization(orgId);
    demand(organization.memberIds.includes(auth.userId), "NOT_MEMBER");
    const roles = { ...this.roles(orgId, workspaceId) };
    if (role === null) delete roles[userId];
    else roles[userId] = role;
    this.store.set("workspace.roles", `${orgId}:${workspaceId}`, roles);
  }

  workspaces(auth: AuthContext, orgId: string): readonly WorkspaceAccess[] {
    const organization = this.organization(orgId);
    demand(organization.memberIds.includes(auth.userId), "NOT_MEMBER");
    const administrator = organization.ownerIds.includes(auth.userId);
    const metadata = this.metadata(orgId);
    return Object.keys(metadata)
      .sort()
      .flatMap((workspaceId) => {
        const role = this.roles(orgId, workspaceId)[auth.userId] ?? null;
        if (!administrator && role === null) return [];
        return [{ workspaceId, name: metadata[workspaceId].name, role }];
      });
  }

  members(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
  ): readonly WorkspaceMember[] {
    const organization = this.organization(orgId);
    demand(organization.memberIds.includes(auth.userId), "NOT_MEMBER");
    const roles = this.roles(orgId, workspaceId);
    demand(
      organization.ownerIds.includes(auth.userId) ||
        roles[auth.userId] !== undefined,
      "WORKSPACE_FORBIDDEN",
    );
    return Object.entries(roles).map(([userId, role]) => ({ userId, role }));
  }

  transferOrganization(
    auth: AuthContext,
    orgId: string,
    newOwnerId: string,
  ): void {
    const organization = this.organization(orgId);
    demand(organization.ownerIds.includes(auth.userId), "NOT_ADMINISTRATOR");
    const ownerIds = organization.ownerIds.filter(
      (ownerId) => ownerId !== auth.userId,
    );
    if (!ownerIds.includes(newOwnerId)) ownerIds.push(newOwnerId);
    this.saveOrganization({
      ...organization,
      ownerIds,
      version: organization.version + 1,
    });
  }

  leaveOrganization(auth: AuthContext, orgId: string): void {
    const organization = this.organization(orgId);
    demand(organization.memberIds.includes(auth.userId), "NOT_MEMBER");
    for (const workspaceId of Object.keys(this.metadata(orgId))) {
      const roles = { ...this.roles(orgId, workspaceId) };
      delete roles[auth.userId];
      this.store.set("workspace.roles", `${orgId}:${workspaceId}`, roles);
    }
    this.saveOrganization({
      ...organization,
      ownerIds: organization.ownerIds.filter(
        (ownerId) => ownerId !== auth.userId,
      ),
      memberIds: organization.memberIds.filter(
        (memberId) => memberId !== auth.userId,
      ),
      version: organization.version + 1,
    });
  }

  revokeMember(auth: AuthContext, orgId: string, userId: string): void {
    const organization = this.organization(orgId);
    demand(organization.ownerIds.includes(auth.userId), "NOT_ADMINISTRATOR");
    for (const workspaceId of Object.keys(this.metadata(orgId))) {
      const roles = { ...this.roles(orgId, workspaceId) };
      delete roles[userId];
      this.store.set("workspace.roles", `${orgId}:${workspaceId}`, roles);
    }
    this.saveOrganization({
      ...organization,
      ownerIds: organization.ownerIds.filter((ownerId) => ownerId !== userId),
      memberIds: organization.memberIds.filter(
        (memberId) => memberId !== userId,
      ),
      version: organization.version + 1,
    });
  }
}

class FailingPolicy extends TestPolicy {
  failOn = "";

  override grant(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
    userId: string,
    role: Role | null,
  ): void {
    if (workspaceId === this.failOn)
      throw new CollaborationError("INJECTED_FAILURE");
    super.grant(auth, orgId, workspaceId, userId, role);
  }
}

class LeakyPolicy extends TestPolicy {
  override workspaces(
    auth: AuthContext,
    orgId: string,
  ): readonly WorkspaceAccess[] {
    return super.workspaces(auth, orgId).map(
      (workspace) =>
        ({
          ...workspace,
          document: { body: "private-content" },
          token: "secret-token",
        }) as WorkspaceAccess,
    );
  }
}

function auth(userId: string): AuthContext {
  return {
    userId,
    deviceId: `device_${userId}`,
    writerId: `writer_${userId}`,
    sessionId: `session_${userId}`,
  };
}

function seed(
  store: TestStore,
  orgId: string,
  ownerIds: string[],
  memberIds: string[],
  version = 1,
): void {
  store.set("organization", orgId, { orgId, ownerIds, memberIds, version });
}

function organization(store: TestStore, orgId = "org"): OrganizationRow {
  return store.get("organization", orgId) as OrganizationRow;
}

function roleOf(
  policy: TestPolicy,
  orgId: string,
  workspaceId: string,
  userId: string,
): Role | null {
  return policy.role(orgId, workspaceId, userId);
}

function expectOrganizationFailure(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("OrganizationService overview", () => {
  it("returns administrators all membership metadata but no workspace payload", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice", "bob", "carol"]);
    const policy = new LeakyPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "shared", "Shared");
    policy.grant(auth("alice"), "org", "shared", "bob", "editor");
    policy.createWorkspace(
      auth("alice"),
      "org",
      "alice-private",
      "Alice Private",
    );
    policy.createWorkspace(auth("bob"), "org", "bob-private", "Bob Private");
    const service = new OrganizationService(store, policy);

    const overview = service.overview(auth("alice"), "org");

    expect(overview).toMatchObject({
      orgId: "org",
      version: 1,
      isAdministrator: true,
      members: ["alice", "bob", "carol"],
    });
    expect(overview.workspaces).toEqual([
      { workspaceId: "alice-private", name: "Alice Private", role: "owner" },
      { workspaceId: "bob-private", name: "Bob Private", role: null },
      { workspaceId: "shared", name: "Shared", role: "owner" },
    ]);
    for (const workspace of overview.workspaces)
      expect(Object.keys(workspace).sort()).toEqual([
        "name",
        "role",
        "workspaceId",
      ]);
    expect(JSON.stringify(overview)).not.toContain("private-content");
    expect(JSON.stringify(overview)).not.toContain("secret-token");
  });

  it("filters private workspace names and other members for ordinary members", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice", "bob", "carol"]);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "shared", "Shared");
    policy.grant(auth("alice"), "org", "shared", "bob", "viewer");
    policy.createWorkspace(
      auth("alice"),
      "org",
      "alice-private",
      "Alice Private",
    );
    policy.createWorkspace(auth("bob"), "org", "bob-private", "Bob Private");
    const service = new OrganizationService(store, policy);

    const overview = service.overview(auth("bob"), "org");

    expect(overview.isAdministrator).toBe(false);
    expect(overview.members).toEqual(["alice", "bob", "carol"]);
    expect(overview.workspaces).toEqual([
      { workspaceId: "bob-private", name: "Bob Private", role: "owner" },
      { workspaceId: "shared", name: "Shared", role: "viewer" },
    ]);
  });

  it("refuses non-members and missing organizations without writing", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice"]);
    const service = new OrganizationService(store, new TestPolicy(store));

    expectOrganizationFailure(
      () => service.overview(auth("bob"), "org"),
      "NOT_MEMBER",
    );
    expectOrganizationFailure(
      () => service.overview(auth("alice"), "missing"),
      "ORGANIZATION_MISSING",
    );
    expect(store.all("organization.audit")).toEqual([]);
  });
});

describe("OrganizationService handoff", () => {
  it("grants only selected workspaces and transfers organization ownership atomically", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice", "bob", "carol"], 4);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.grant(auth("alice"), "org", "one", "bob", "viewer");
    policy.createWorkspace(auth("alice"), "org", "two", "Two");
    policy.grant(auth("alice"), "org", "two", "bob", "viewer");
    policy.createWorkspace(auth("alice"), "org", "three", "Three");
    policy.grant(auth("alice"), "org", "three", "bob", "viewer");
    const service = new OrganizationService(store, policy);

    service.handoff(auth("alice"), "org", "bob", ["one"]);

    const after = organization(store);
    expect(after.ownerIds).toEqual(["bob"]);
    expect(after.memberIds).toEqual(["alice", "bob", "carol"]);
    expect(after.version).toBe(5);
    expect(roleOf(policy, "org", "one", "bob")).toBe("owner");
    expect(roleOf(policy, "org", "two", "bob")).toBe("viewer");
    expect(roleOf(policy, "org", "three", "bob")).toBe("viewer");
    const audits = store.all("organization.audit");
    expect(audits).toHaveLength(1);
    expect(audits[0].value).toEqual({
      action: "handoff",
      orgId: "org",
      actorId: "alice",
      targetId: "bob",
      workspaceIds: ["one"],
      fromVersion: 4,
      toVersion: 5,
    });
    expect(JSON.stringify(audits)).not.toContain("One");
    expect(JSON.stringify(audits)).not.toContain("secret");
  });

  it("rolls back every workspace grant when a later grant fails", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice", "bob"], 7);
    const policy = new FailingPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.grant(auth("alice"), "org", "one", "bob", "viewer");
    policy.createWorkspace(auth("alice"), "org", "two", "Two");
    policy.grant(auth("alice"), "org", "two", "bob", "viewer");
    policy.failOn = "two";
    const service = new OrganizationService(store, policy);

    expectOrganizationFailure(
      () => service.handoff(auth("alice"), "org", "bob", ["one", "two"]),
      "INJECTED_FAILURE",
    );

    expect(organization(store)).toEqual({
      orgId: "org",
      ownerIds: ["alice"],
      memberIds: ["alice", "bob"],
      version: 7,
    });
    expect(roleOf(policy, "org", "one", "bob")).toBe("viewer");
    expect(roleOf(policy, "org", "two", "bob")).toBe("viewer");
    expect(store.all("organization.audit")).toEqual([]);
  });

  it("rejects missing, inactive, duplicate and unknown targets before mutating", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice", "bob"], 3);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.grant(auth("alice"), "org", "one", "bob", "viewer");
    policy.createWorkspace(auth("alice"), "org", "two", "Two");
    const service = new OrganizationService(store, policy);

    expectOrganizationFailure(
      () => service.handoff(auth("alice"), "org", "dave", ["one"]),
      "TARGET_MISSING",
    );
    expectOrganizationFailure(
      () => service.handoff(auth("alice"), "org", "bob", ["two"]),
      "TARGET_INACTIVE",
    );
    expectOrganizationFailure(
      () => service.handoff(auth("alice"), "org", "bob", ["one", "one"]),
      "INVALID_WORKSPACES",
    );
    expectOrganizationFailure(
      () => service.handoff(auth("alice"), "org", "bob", ["missing"]),
      "WORKSPACE_MISSING",
    );
    expectOrganizationFailure(
      () => service.handoff(auth("alice"), "org", "alice", ["one"]),
      "TARGET_INVALID",
    );
    expect(organization(store).version).toBe(3);
    expect(roleOf(policy, "org", "one", "bob")).toBe("viewer");
    expect(store.all("organization.audit")).toEqual([]);
  });

  it("refuses non-administrator handoff", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice", "bob", "carol"]);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.grant(auth("alice"), "org", "one", "bob", "owner");
    policy.grant(auth("alice"), "org", "one", "carol", "viewer");
    const service = new OrganizationService(store, policy);

    expectOrganizationFailure(
      () => service.handoff(auth("bob"), "org", "carol", ["one"]),
      "NOT_ADMINISTRATOR",
    );
    expect(organization(store).ownerIds).toEqual(["alice"]);
    expect(store.all("organization.audit")).toEqual([]);
  });
});

describe("OrganizationService leave", () => {
  it("refuses the last organization owner and workspace owner", () => {
    const store = new TestStore();
    seed(store, "org", ["alice"], ["alice"]);
    const lone = new TestPolicy(store);
    const loneService = new OrganizationService(store, lone);

    expectOrganizationFailure(
      () => loneService.leave(auth("alice"), "org"),
      "LAST_OWNER",
    );
    expect(organization(store).memberIds).toEqual(["alice"]);
    expect(store.all("organization.audit")).toEqual([]);

    seed(store, "org", ["alice", "bob"], ["alice", "bob"], 2);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    const service = new OrganizationService(store, policy);

    expectOrganizationFailure(
      () => service.leave(auth("alice"), "org"),
      "LAST_OWNER",
    );
    expect(organization(store)).toEqual({
      orgId: "org",
      ownerIds: ["alice", "bob"],
      memberIds: ["alice", "bob"],
      version: 2,
    });
  });

  it("allows an owner to leave when another organization and workspace owner remains", () => {
    const store = new TestStore();
    seed(store, "org", ["alice", "bob"], ["alice", "bob", "carol"], 5);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.grant(auth("alice"), "org", "one", "carol", "owner");
    const service = new OrganizationService(store, policy);

    service.leave(auth("alice"), "org");

    const after = organization(store);
    expect(after).toEqual({
      orgId: "org",
      ownerIds: ["bob"],
      memberIds: ["bob", "carol"],
      version: 6,
    });
    expect(roleOf(policy, "org", "one", "alice")).toBeNull();
    expect(roleOf(policy, "org", "one", "carol")).toBe("owner");
    const audit = store.all("organization.audit")[0].value;
    expect(audit).toEqual({
      action: "leave",
      orgId: "org",
      actorId: "alice",
      targetId: null,
      workspaceIds: [],
      fromVersion: 5,
      toVersion: 6,
    });
  });
});

describe("OrganizationService revoke", () => {
  it("refuses revoking a last workspace owner without changing members", () => {
    const store = new TestStore();
    seed(store, "org", ["alice", "bob"], ["alice", "bob", "carol"], 9);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("bob"), "org", "private", "Private");
    const service = new OrganizationService(store, policy);

    expectOrganizationFailure(
      () => service.revoke(auth("alice"), "org", "bob"),
      "LAST_OWNER",
    );
    expect(organization(store)).toEqual({
      orgId: "org",
      ownerIds: ["alice", "bob"],
      memberIds: ["alice", "bob", "carol"],
      version: 9,
    });
    expect(store.all("organization.audit")).toEqual([]);
  });

  it("revokes a member while preserving unrelated owners and workspace roles", () => {
    const store = new TestStore();
    seed(store, "org", ["alice", "bob"], ["alice", "bob", "carol"], 11);
    const policy = new TestPolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.grant(auth("alice"), "org", "one", "bob", "owner");
    policy.grant(auth("alice"), "org", "one", "carol", "owner");
    const service = new OrganizationService(store, policy);

    service.revoke(auth("alice"), "org", "bob");

    expect(organization(store)).toEqual({
      orgId: "org",
      ownerIds: ["alice"],
      memberIds: ["alice", "carol"],
      version: 12,
    });
    expect(roleOf(policy, "org", "one", "bob")).toBeNull();
    expect(roleOf(policy, "org", "one", "alice")).toBe("owner");
    expect(roleOf(policy, "org", "one", "carol")).toBe("owner");
    expect(store.all("organization.audit")[0].value).toMatchObject({
      action: "revoke",
      actorId: "alice",
      targetId: "bob",
      fromVersion: 11,
      toVersion: 12,
    });
  });

  it("rejects missing targets and self-revocation", () => {
    const store = new TestStore();
    seed(store, "org", ["alice", "bob"], ["alice", "bob"]);
    const service = new OrganizationService(store, new TestPolicy(store));

    expectOrganizationFailure(
      () => service.revoke(auth("alice"), "org", "dave"),
      "TARGET_MISSING",
    );
    expectOrganizationFailure(
      () => service.revoke(auth("alice"), "org", "alice"),
      "TARGET_INVALID",
    );
    expect(store.all("organization.audit")).toEqual([]);
  });
});
