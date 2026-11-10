import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";
import { IdentityAuthority } from "../src/collaboration/runtime/identity";
import { digest } from "../src/collaboration/runtime/digest";

type Row = { key: string; value: string };
type Org = {
  orgId: string;
  ownerIds: string[];
  memberIds: string[];
  version: number;
};
type UserRow = {
  orgId: string;
  userId: string;
  role: "owner" | "member";
  status: "active" | "revoked";
};
type InviteRow = {
  orgId: string;
  userId: string;
  status: "pending" | "accepted" | "expired";
  membershipGeneration?: number;
};

class SqliteStoragePort implements StoragePort {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS runtime_kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key))",
    );
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(namespace: string, key: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM runtime_kv WHERE namespace = ? AND key = ?")
      .get(namespace, key) as unknown as Row | undefined;
    return row === undefined ? null : (JSON.parse(row.value) as unknown);
  }

  set(namespace: string, key: string, value: unknown | null): void {
    if (value === null) {
      this.db
        .prepare("DELETE FROM runtime_kv WHERE namespace = ? AND key = ?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO runtime_kv (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value",
      )
      .run(namespace, key, JSON.stringify(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM runtime_kv WHERE namespace = ? ORDER BY key",
      )
      .all(namespace) as unknown as Row[];
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value) as unknown,
    }));
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

const directories: string[] = [];
const stores: SqliteStoragePort[] = [];
let clock = 1_700_000_000_000;

function openStore(path: string): SqliteStoragePort {
  const store = new SqliteStoragePort(path);
  stores.push(store);
  return store;
}

function temporaryDatabase(): SqliteStoragePort {
  const directory = mkdtempSync(join(tmpdir(), "folio-identity-handoff-"));
  directories.push(directory);
  return openStore(join(directory, "identity.db"));
}

function organization(store: SqliteStoragePort, orgId: string): Org {
  return store.get("organization", orgId) as Org;
}

function writeOrganization(store: SqliteStoragePort, value: Org): void {
  store.set("organization", value.orgId, value);
}

function user(
  store: SqliteStoragePort,
  orgId: string,
  userId: string,
): UserRow {
  return store.get("identity.users", orgId + "/" + userId) as UserRow;
}

function writeUser(
  store: SqliteStoragePort,
  orgId: string,
  value: UserRow,
): void {
  store.set("identity.users", orgId + "/" + value.userId, value);
}

function invite(store: SqliteStoragePort, token: string): InviteRow {
  return store.get("identity.invites", digest(token)) as InviteRow;
}

function writeInvite(
  store: SqliteStoragePort,
  token: string,
  value: InviteRow,
): void {
  store.set("identity.invites", digest(token), value);
}

beforeEach(() => {
  clock = 1_700_000_000_000;
});

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

describe("identity handoff and membership continuity", () => {
  it("derives the user role from organization owners instead of stale cached roles", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-role", "owner", "owner-device");
    const firstInvite = authority.invite(
      boot.token,
      "org-role",
      "member",
      60_000,
    );
    authority.acceptInvite(firstInvite, "member-device");

    writeUser(store, "org-role", {
      ...user(store, "org-role", "member"),
      role: "owner",
    });

    const secondInvite = authority.invite(
      boot.token,
      "org-role",
      "member",
      60_000,
    );
    const accepted = authority.acceptInvite(secondInvite, "member-device-2");

    expect(organization(store, "org-role")).toMatchObject({
      ownerIds: ["owner"],
      memberIds: ["owner", "member"],
    });
    expect(user(store, "org-role", "member").role).toBe("member");
    expect(authority.authenticate(accepted.token)).toEqual(accepted.auth);
  });

  it("recovers an active owner from ownerIds even when the cached role is stale", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-recover", "owner", "owner-device");

    writeUser(store, "org-recover", {
      ...user(store, "org-recover", "owner"),
      role: "member",
    });

    const recovered = authority.recover(
      "org-recover",
      boot.recoveryKey,
      "recovered-device",
    );
    expect(recovered.auth.userId).toBe("owner");
    expect(authority.authenticate(recovered.token)).toEqual(recovered.auth);
    expect(() =>
      authority.recover(
        "org-recover",
        recovered.recoveryKey,
        "recovered-device-2",
      ),
    ).not.toThrow();
  });

  it("rejects a live token once the user is removed from organization membership", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-resolve", "owner", "owner-device");
    const memberInvite = authority.invite(
      boot.token,
      "org-resolve",
      "member",
      60_000,
    );
    const member = authority.acceptInvite(memberInvite, "member-device");
    expect(authority.authenticate(member.token)).toEqual(member.auth);

    const before = organization(store, "org-resolve");
    writeOrganization(store, {
      ...before,
      memberIds: before.memberIds.filter((id) => id !== "member"),
      version: before.version + 1,
    });

    expect(() => authority.authenticate(member.token)).toThrow("TOKEN_INVALID");
    expect(user(store, "org-resolve", "member").status).toBe("active");
  });

  it("fences a removed member atomically and allows only a fresh invite to reactivate", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-fence", "owner", "owner-device");
    const memberInvite = authority.invite(
      boot.token,
      "org-fence",
      "member",
      60_000,
    );
    const member = authority.acceptInvite(memberInvite, "member-device");
    const oldPendingInvite = authority.invite(
      boot.token,
      "org-fence",
      "member",
      60_000,
    );
    const before = organization(store, "org-fence");

    expect(() => authority.fenceRemovedMember("org-fence", "member")).toThrow(
      "MEMBER_PRESENT",
    );
    expect(user(store, "org-fence", "member").status).toBe("active");
    expect(authority.authenticate(member.token)).toEqual(member.auth);
    expect(invite(store, oldPendingInvite).status).toBe("pending");
    expect(
      store.get("identity.membership-generations", "org-fence:member"),
    ).toBeNull();

    writeOrganization(store, {
      ...before,
      memberIds: before.memberIds.filter((id) => id !== "member"),
      version: before.version + 1,
    });
    authority.fenceRemovedMember("org-fence", "member");

    expect(user(store, "org-fence", "member").status).toBe("revoked");
    expect(() => authority.authenticate(member.token)).toThrow("TOKEN_INVALID");
    expect(
      store.get("identity.devices", "org-fence/member-device"),
    ).toMatchObject({
      status: "revoked",
      generation: 2,
    });
    expect(invite(store, oldPendingInvite).status).toBe("expired");
    expect(
      store.get("identity.membership-generations", "org-fence:member"),
    ).toBe(1);
    expect(() =>
      authority.acceptInvite(oldPendingInvite, "member-device-2"),
    ).toThrow("INVITE_EXPIRED");

    const freshInvite = authority.invite(
      boot.token,
      "org-fence",
      "member",
      60_000,
    );
    expect(invite(store, freshInvite).membershipGeneration).toBe(1);
    const reactivated = authority.acceptInvite(freshInvite, "member-device-3");

    expect(user(store, "org-fence", "member").status).toBe("active");
    expect(user(store, "org-fence", "member").role).toBe("member");
    expect(organization(store, "org-fence")).toMatchObject({
      ownerIds: ["owner"],
      memberIds: ["owner", "member"],
    });
    expect(authority.authenticate(reactivated.token)).toEqual(reactivated.auth);
  });

  it("refuses an old generation invite even if it is made pending again", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-gen", "owner", "owner-device");
    const memberInvite = authority.invite(
      boot.token,
      "org-gen",
      "member",
      60_000,
    );
    authority.acceptInvite(memberInvite, "member-device");
    const oldPendingInvite = authority.invite(
      boot.token,
      "org-gen",
      "member",
      60_000,
    );
    const before = organization(store, "org-gen");
    writeOrganization(store, {
      ...before,
      memberIds: before.memberIds.filter((id) => id !== "member"),
      version: before.version + 1,
    });
    authority.fenceRemovedMember("org-gen", "member");

    writeInvite(store, oldPendingInvite, {
      ...invite(store, oldPendingInvite),
      status: "pending",
    });

    expect(() =>
      authority.acceptInvite(oldPendingInvite, "member-device-2"),
    ).toThrow("INVITE_STALE");
    expect(user(store, "org-gen", "member").status).toBe("revoked");
  });

  it("accepts legacy invitations that predate membership generation binding", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-legacy", "owner", "owner-device");
    const legacyInvite = authority.invite(
      boot.token,
      "org-legacy",
      "member",
      60_000,
    );
    const raw = store.get("identity.invites", digest(legacyInvite)) as Record<
      string,
      unknown
    >;
    delete raw.membershipGeneration;
    store.set("identity.invites", digest(legacyInvite), raw);

    const accepted = authority.acceptInvite(legacyInvite, "member-device");
    expect(accepted.auth.userId).toBe("member");
    expect(organization(store, "org-legacy").memberIds).toEqual([
      "owner",
      "member",
    ]);
  });

  it("synchronizes roles on handoff and retires the old owner recovery and invites", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap(
      "org-handoff",
      "old-owner",
      "owner-device",
    );
    const memberInvite = authority.invite(
      boot.token,
      "org-handoff",
      "new-owner",
      60_000,
    );
    const newOwner = authority.acceptInvite(memberInvite, "new-owner-device");
    const oldPendingInvite = authority.invite(
      boot.token,
      "org-handoff",
      "pending-user",
      60_000,
    );
    const before = organization(store, "org-handoff");
    writeOrganization(store, {
      ...before,
      ownerIds: ["new-owner"],
      version: before.version + 1,
    });

    authority.synchronizeOrganization("org-handoff", true);

    expect(user(store, "org-handoff", "old-owner").role).toBe("member");
    expect(user(store, "org-handoff", "new-owner").role).toBe("owner");
    expect(store.get("identity.recovery", "org-handoff")).toBeNull();
    expect(store.get("identity.recovery-status", "org-handoff")).toEqual({
      required: true,
    });
    expect(invite(store, oldPendingInvite).status).toBe("expired");
    expect(authority.authenticate(boot.token)).toEqual(boot.auth);
    expect(() =>
      authority.recover("org-handoff", boot.recoveryKey, "replacement-device"),
    ).toThrow("RECOVERY_INVALID");
    expect(() =>
      authority.acceptInvite(oldPendingInvite, "pending-user-device"),
    ).toThrow("INVITE_EXPIRED");

    expect(() => authority.rotateRecovery(boot.token, "org-handoff")).toThrow(
      "NOT_OWNER",
    );
    expect(store.get("identity.recovery-status", "org-handoff")).toEqual({
      required: true,
    });

    const rotatedKey = authority.rotateRecovery(newOwner.token, "org-handoff");
    expect(rotatedKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.get("identity.recovery-status", "org-handoff")).toEqual({
      required: false,
    });
    expect(JSON.stringify(store.all("identity.recovery"))).not.toContain(
      rotatedKey,
    );

    const recovered = authority.recover(
      "org-handoff",
      rotatedKey,
      "new-owner-recovered",
    );
    expect(recovered.auth.userId).toBe("new-owner");
    expect(authority.authenticate(recovered.token)).toEqual(recovered.auth);
    expect(() =>
      authority.recover("org-handoff", boot.recoveryKey, "stale-device"),
    ).toThrow("RECOVERY_INVALID");
  });

  it("does not invalidate recovery when synchronization only refreshes roles", () => {
    const store = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-sync", "owner", "owner-device");
    const inviteToken = authority.invite(
      boot.token,
      "org-sync",
      "member",
      60_000,
    );
    authority.acceptInvite(inviteToken, "member-device");
    writeUser(store, "org-sync", {
      ...user(store, "org-sync", "owner"),
      role: "member",
    });

    authority.synchronizeOrganization("org-sync");

    expect(user(store, "org-sync", "owner").role).toBe("owner");
    expect(store.get("identity.recovery", "org-sync")).not.toBeNull();
    expect(store.get("identity.recovery-status", "org-sync")).toBeNull();
    const recovered = authority.recover(
      "org-sync",
      boot.recoveryKey,
      "recovered-device",
    );
    expect(recovered.auth.userId).toBe("owner");
  });
});
