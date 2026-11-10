import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AuthContext,
  Role,
  Scope,
} from "../src/collaboration/runtime/contract";
import {
  ORGANIZATION_NAMESPACE,
  WORKSPACE_NAMESPACE,
  WORKSPACE_ROLE_NAMESPACE,
  WorkspacePolicy,
} from "../src/collaboration/runtime/policy";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";

class SqliteStorage implements StoragePort {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS entries(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))",
    );
  }

  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(namespace: string, key: string): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM entries WHERE namespace=? AND key=?")
      .get(namespace, key) as unknown as { value: unknown } | undefined;
    return row ? JSON.parse(String(row.value)) : null;
  }

  set(namespace: string, key: string, value: unknown | null): void {
    if (value === null) {
      this.db
        .prepare("DELETE FROM entries WHERE namespace=? AND key=?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO entries(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(namespace, key, JSON.stringify(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    return (
      this.db
        .prepare("SELECT key,value FROM entries WHERE namespace=? ORDER BY key")
        .all(namespace) as unknown as { key: unknown; value: unknown }[]
    ).map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.value)),
    }));
  }

  blobGet(): Uint8Array | null {
    throw new Error("BLOB_NOT_SUPPORTED_IN_TEST");
  }

  blobPut(): void {
    throw new Error("BLOB_NOT_SUPPORTED_IN_TEST");
  }

  blobDelete(): void {
    throw new Error("BLOB_NOT_SUPPORTED_IN_TEST");
  }

  close(): void {
    this.db.close();
  }
}

const stores: SqliteStorage[] = [];
const directories: string[] = [];

function memoryStore(): SqliteStorage {
  const store = new SqliteStorage(":memory:");
  stores.push(store);
  return store;
}

function fileStore(name: string): { store: SqliteStorage; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "folio-policy-"));
  directories.push(directory);
  const path = join(directory, name);
  const store = new SqliteStorage(path);
  stores.push(store);
  return { store, path };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      void 0;
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedOrganization(
  store: StoragePort,
  orgId: string,
  ownerIds: string[],
  memberIds: string[],
  version = 1,
): void {
  store.set(ORGANIZATION_NAMESPACE, orgId, {
    orgId,
    ownerIds,
    memberIds,
    version,
  });
}

const auth = (userId: string): AuthContext => ({
  userId,
  deviceId: "device-1",
  writerId: "writer-1",
  sessionId: "session-1",
});

const scope = (
  orgId: string,
  workspaceId: string,
  documentId = "doc-1",
  incarnationId = "incarnation-1",
): Scope => ({ orgId, workspaceId, documentId, incarnationId });

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return "NO_ERROR";
}

describe("WorkspacePolicy persistence and membership", () => {
  it("reopens a SQLite workspace with the same role and authorization", () => {
    const { store, path } = fileStore("policy.sqlite");
    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    let policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "ws", "Private");
    policy.grant(auth("alice"), "org", "ws", "bob", "viewer");
    policy.authorize(auth("bob"), scope("org", "ws"), "read");
    store.close();

    const reopened = new SqliteStorage(path);
    stores.push(reopened);
    policy = new WorkspacePolicy(reopened);
    expect(policy.workspaces(auth("bob"), "org")).toEqual([
      { workspaceId: "ws", name: "Private", role: "viewer" },
    ]);
    policy.authorize(auth("bob"), scope("org", "ws"), "read");
    expect(
      errorCode(() =>
        policy.authorize(auth("bob"), scope("org", "ws"), "write"),
      ),
    ).toBe("FORBIDDEN");
  });

  it("keeps an organization owner from reading a private workspace it only administers", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["admin"], ["admin", "alice", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "private", "Alice private");

    expect(
      errorCode(() =>
        policy.authorize(auth("admin"), scope("org", "private"), "read"),
      ),
    ).toBe("FORBIDDEN");
    expect(
      errorCode(() =>
        policy.authorize(auth("admin"), scope("org", "private"), "audit"),
      ),
    ).toBe("FORBIDDEN");
    policy.authorize(auth("admin"), scope("org", "private"), "manage");
    expect(
      errorCode(() =>
        policy.grant(auth("admin"), "org", "private", "admin", "viewer"),
      ),
    ).toBe("NOT_WORKSPACE_OWNER");
    expect(
      errorCode(() =>
        policy.grant(auth("admin"), "org", "private", "bob", "viewer"),
      ),
    ).toBe("NOT_WORKSPACE_OWNER");
    policy.authorize(auth("alice"), scope("org", "private"), "read");
    policy.grant(auth("alice"), "org", "private", "bob", "viewer");
    policy.authorize(auth("bob"), scope("org", "private"), "read");
    expect(
      errorCode(() =>
        policy.authorize(auth("bob"), scope("org", "private"), "write"),
      ),
    ).toBe("FORBIDDEN");
    expect(policy.members(auth("admin"), "org", "private")).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "bob", role: "viewer" },
    ]);
  });

  it("requires an active owner and an organization member to grant", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice"], ["alice", "bob", "charlie"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "ws", "Shared");
    policy.grant(auth("alice"), "org", "ws", "bob", "editor");

    expect(
      errorCode(() =>
        policy.grant(auth("bob"), "org", "ws", "charlie", "viewer"),
      ),
    ).toBe("NOT_WORKSPACE_OWNER");
    expect(
      errorCode(() =>
        policy.grant(auth("alice"), "org", "ws", "outsider", "viewer"),
      ),
    ).toBe("NOT_ORG_MEMBER");
    expect(
      errorCode(() =>
        policy.grant(
          auth("alice"),
          "org",
          "ws",
          "bob",
          "admin" as unknown as Role,
        ),
      ),
    ).toBe("INVALID_ROLE");
    expect(policy.members(auth("alice"), "org", "ws")).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "bob", role: "editor" },
    ]);
  });

  it("protects the last workspace owner and hands off before removal", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice", "dana"], ["alice", "dana", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "ws", "Owned");

    expect(
      errorCode(() => policy.grant(auth("alice"), "org", "ws", "alice", null)),
    ).toBe("LAST_WORKSPACE_OWNER");
    expect(policy.workspaces(auth("alice"), "org")).toEqual([
      { workspaceId: "ws", name: "Owned", role: "owner" },
    ]);

    policy.grant(auth("alice"), "org", "ws", "bob", "owner");
    policy.grant(auth("alice"), "org", "ws", "alice", null);
    policy.authorize(auth("bob"), scope("org", "ws"), "manage");
    expect(
      errorCode(() => policy.grant(auth("bob"), "org", "ws", "bob", null)),
    ).toBe("LAST_WORKSPACE_OWNER");
    expect(policy.workspaces(auth("alice"), "org")).toEqual([
      { workspaceId: "ws", name: "Owned", role: null },
    ]);
  });
});

describe("WorkspacePolicy organization lifecycle", () => {
  it("protects the last organization owner and transfers ownership to a member", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    const policy = new WorkspacePolicy(store);

    expect(
      errorCode(() => policy.leaveOrganization(auth("alice"), "org")),
    ).toBe("LAST_ORG_OWNER");
    expect(
      errorCode(() =>
        policy.transferOrganization(auth("alice"), "org", "carol"),
      ),
    ).toBe("NOT_ORG_MEMBER");
    expect(
      errorCode(() => policy.transferOrganization(auth("bob"), "org", "bob")),
    ).toBe("NOT_ORG_OWNER");

    policy.transferOrganization(auth("alice"), "org", "bob");
    expect(store.get(ORGANIZATION_NAMESPACE, "org")).toEqual({
      orgId: "org",
      ownerIds: ["bob"],
      memberIds: ["alice", "bob"],
      version: 2,
    });
    expect(errorCode(() => policy.leaveOrganization(auth("bob"), "org"))).toBe(
      "LAST_ORG_OWNER",
    );
    policy.leaveOrganization(auth("alice"), "org");
    expect(store.get(ORGANIZATION_NAMESPACE, "org")).toEqual({
      orgId: "org",
      ownerIds: ["bob"],
      memberIds: ["bob"],
      version: 3,
    });
  });

  it("cascades a leave across every workspace and refuses to strand a workspace owner", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice", "dana"], ["alice", "dana", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.createWorkspace(auth("alice"), "org", "two", "Two");

    expect(
      errorCode(() => policy.leaveOrganization(auth("alice"), "org")),
    ).toBe("LAST_WORKSPACE_OWNER");
    policy.grant(auth("alice"), "org", "one", "dana", "owner");
    expect(
      errorCode(() => policy.leaveOrganization(auth("alice"), "org")),
    ).toBe("LAST_WORKSPACE_OWNER");
    policy.grant(auth("alice"), "org", "two", "bob", "owner");

    policy.leaveOrganization(auth("alice"), "org");
    expect(
      errorCode(() =>
        policy.authorize(auth("alice"), scope("org", "one"), "read"),
      ),
    ).toBe("NOT_ORG_MEMBER");
    policy.authorize(auth("dana"), scope("org", "one"), "read");
    policy.authorize(auth("bob"), scope("org", "two"), "read");
    expect(store.get(ORGANIZATION_NAMESPACE, "org")).toEqual({
      orgId: "org",
      ownerIds: ["dana"],
      memberIds: ["dana", "bob"],
      version: 2,
    });
    expect(
      store.all(WORKSPACE_ROLE_NAMESPACE).map((entry) => entry.key),
    ).toEqual(["org:one:dana", "org:two:bob"]);
  });

  it("revokes a member from all workspaces and live authorization fails immediately", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "one", "One");
    policy.createWorkspace(auth("alice"), "org", "two", "Two");
    policy.grant(auth("alice"), "org", "one", "bob", "editor");
    policy.grant(auth("alice"), "org", "two", "bob", "editor");
    for (const workspaceId of ["one", "two"]) {
      policy.authorize(auth("bob"), scope("org", workspaceId), "read");
      policy.authorize(auth("bob"), scope("org", workspaceId), "write");
    }

    policy.revokeMember(auth("alice"), "org", "bob");
    for (const workspaceId of ["one", "two"]) {
      expect(
        errorCode(() =>
          policy.authorize(auth("bob"), scope("org", workspaceId), "read"),
        ),
      ).toBe("NOT_ORG_MEMBER");
      expect(policy.members(auth("alice"), "org", workspaceId)).toEqual([
        { userId: "alice", role: "owner" },
      ]);
    }
    expect(errorCode(() => policy.workspaces(auth("bob"), "org"))).toBe(
      "NOT_ORG_MEMBER",
    );
  });

  it("refuses to revoke the last workspace owner without mutating records", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice", "dana"], ["alice", "dana", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "ws", "Owned");
    const beforeRoles = store.all(WORKSPACE_ROLE_NAMESPACE);
    const beforeOrganization = store.get(ORGANIZATION_NAMESPACE, "org");

    expect(
      errorCode(() => policy.revokeMember(auth("alice"), "org", "alice")),
    ).toBe("LAST_WORKSPACE_OWNER");
    expect(store.all(WORKSPACE_ROLE_NAMESPACE)).toEqual(beforeRoles);
    expect(store.get(ORGANIZATION_NAMESPACE, "org")).toEqual(
      beforeOrganization,
    );

    policy.grant(auth("alice"), "org", "ws", "bob", "owner");
    policy.revokeMember(auth("alice"), "org", "alice");
    policy.authorize(auth("bob"), scope("org", "ws"), "read");
    expect(
      errorCode(() =>
        policy.authorize(auth("alice"), scope("org", "ws"), "read"),
      ),
    ).toBe("NOT_ORG_MEMBER");
    expect(store.get(ORGANIZATION_NAMESPACE, "org")).toEqual({
      orgId: "org",
      ownerIds: ["dana"],
      memberIds: ["dana", "bob"],
      version: 2,
    });
  });
});

describe("WorkspacePolicy isolation and fail-closed validation", () => {
  it("isolates the same workspace and document IDs in different organizations", () => {
    const store = memoryStore();
    seedOrganization(store, "org-1", ["owner-1"], ["owner-1", "alice", "bob"]);
    seedOrganization(store, "org-2", ["owner-2"], ["owner-2", "alice", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org-1", "shared", "Org one");
    policy.createWorkspace(auth("alice"), "org-2", "shared", "Org two");
    policy.grant(auth("alice"), "org-1", "shared", "bob", "viewer");

    policy.authorize(
      auth("bob"),
      scope("org-1", "shared", "same-doc", "same-inc"),
      "read",
    );
    expect(
      errorCode(() =>
        policy.authorize(
          auth("bob"),
          scope("org-2", "shared", "same-doc", "same-inc"),
          "read",
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      errorCode(() =>
        policy.authorize(
          auth("owner-2"),
          scope("org-2", "shared", "same-doc", "same-inc"),
          "read",
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      errorCode(() =>
        policy.authorize(
          auth("owner-1"),
          scope("org-1", "shared", "same-doc", "same-inc"),
          "read",
        ),
      ),
    ).toBe("FORBIDDEN");

    policy.authorize(
      auth("alice"),
      scope("org-1", "shared", "same-doc", "same-inc"),
      "read",
    );
    policy.authorize(
      auth("alice"),
      scope("org-2", "shared", "same-doc", "same-inc"),
      "read",
    );
    expect(policy.members(auth("alice"), "org-1", "shared")).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "bob", role: "viewer" },
    ]);
    expect(policy.members(auth("alice"), "org-2", "shared")).toEqual([
      { userId: "alice", role: "owner" },
    ]);
  });

  it("fails closed on malformed organization, workspace and role records", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "ws", "Valid");
    policy.grant(auth("alice"), "org", "ws", "bob", "viewer");

    store.set(ORGANIZATION_NAMESPACE, "org", {
      orgId: "org",
      ownerIds: ["alice", "alice"],
      memberIds: ["alice", "bob"],
      version: 1,
    });
    expect(errorCode(() => policy.workspaces(auth("alice"), "org"))).toBe(
      "CORRUPT_ORGANIZATION",
    );

    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    store.set(WORKSPACE_NAMESPACE, "org:ws", {
      orgId: "org",
      workspaceId: "ws",
      name: 7,
      createdBy: "alice",
    });
    expect(errorCode(() => policy.workspaces(auth("alice"), "org"))).toBe(
      "CORRUPT_WORKSPACE",
    );
    expect(
      errorCode(() =>
        policy.authorize(auth("alice"), scope("org", "ws"), "read"),
      ),
    ).toBe("CORRUPT_WORKSPACE");

    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    store.set(WORKSPACE_NAMESPACE, "org:ws", {
      orgId: "org",
      workspaceId: "ws",
      name: "Valid",
      createdBy: "alice",
    });
    store.set(WORKSPACE_ROLE_NAMESPACE, "org:ws:bob", {
      orgId: "org",
      workspaceId: "ws",
      userId: "bob",
      role: "admin",
    });
    expect(
      errorCode(() =>
        policy.authorize(auth("bob"), scope("org", "ws"), "read"),
      ),
    ).toBe("CORRUPT_ROLE");
    expect(errorCode(() => policy.workspaces(auth("alice"), "org"))).toBe(
      "CORRUPT_ROLE",
    );
  });

  it("keeps the original records when a write is rejected", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice"], ["alice", "bob"]);
    const policy = new WorkspacePolicy(store);
    policy.createWorkspace(auth("alice"), "org", "ws", "Original");
    const beforeWorkspaces = store.all(WORKSPACE_NAMESPACE);
    const beforeRoles = store.all(WORKSPACE_ROLE_NAMESPACE);

    expect(
      errorCode(() =>
        policy.createWorkspace(auth("alice"), "org", "ws", "Replacement"),
      ),
    ).toBe("WORKSPACE_EXISTS");

    expect(store.all(WORKSPACE_NAMESPACE)).toEqual(beforeWorkspaces);
    expect(store.all(WORKSPACE_ROLE_NAMESPACE)).toEqual(beforeRoles);
  });

  it("joins a parent transaction and rolls back with it", () => {
    const store = memoryStore();
    seedOrganization(store, "org", ["alice"], ["alice"]);
    const policy = new WorkspacePolicy(store);

    expect(() =>
      store.transaction(() => {
        policy.createWorkspace(
          auth("alice"),
          "org",
          "rolled-back",
          "Rolled back",
        );
        throw new Error("ABORT_TEST");
      }),
    ).toThrow("ABORT_TEST");
    expect(store.all(WORKSPACE_NAMESPACE)).toEqual([]);
    expect(policy.workspaces(auth("alice"), "org")).toEqual([]);

    store.transaction(() =>
      policy.createWorkspace(auth("alice"), "org", "kept", "Kept"),
    );
    policy.authorize(auth("alice"), scope("org", "kept"), "read");
    expect(policy.workspaces(auth("alice"), "org")).toEqual([
      { workspaceId: "kept", name: "Kept", role: "owner" },
    ]);
  });
});
