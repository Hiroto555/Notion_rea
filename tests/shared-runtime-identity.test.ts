import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";
import { IdentityAuthority } from "../src/collaboration/runtime/identity";

type Row = { key: string; value: string };

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

function temporaryDatabase(): { path: string; store: SqliteStoragePort } {
  const directory = mkdtempSync(join(tmpdir(), "folio-identity-"));
  directories.push(directory);
  const path = join(directory, "identity.db");
  return { path, store: openStore(path) };
}

function organization(store: SqliteStoragePort, orgId: string): unknown {
  return store.get("organization", orgId);
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

describe("IdentityAuthority", () => {
  it("persists bootstrap identity across a SQLite reopen without storing secrets", () => {
    const { path, store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-1", "user-1", "device-1");

    expect(boot.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(boot.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Object.values(boot.auth)).size).toBe(4);
    expect(boot.auth).toMatchObject({
      userId: "user-1",
      deviceId: "device-1",
    });

    const durable = JSON.stringify([
      store.all("organization"),
      store.all("identity.users"),
      store.all("identity.devices"),
      store.all("identity.sessions"),
      store.all("identity.recovery"),
    ]);
    expect(durable).not.toContain(boot.token);
    expect(durable).not.toContain(boot.recoveryKey);
    expect(organization(store, "org-1")).toEqual({
      orgId: "org-1",
      ownerIds: ["user-1"],
      memberIds: ["user-1"],
      version: 1,
    });

    store.close();
    const reopened = openStore(path);
    const restarted = new IdentityAuthority(reopened, () => clock);
    expect(restarted.authenticate(boot.token)).toEqual(boot.auth);
    expect(() => restarted.bootstrap("org-1", "user-2", "device-2")).toThrow(
      "ORG_EXISTS",
    );
  });

  it("rejects invalid identifiers and unknown tokens", () => {
    const { store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    expect(() => authority.bootstrap("org/1", "user-1", "device-1")).toThrow(
      "INVALID_ID",
    );
    expect(() => authority.authenticate("")).toThrow("TOKEN_INVALID");
    expect(() => authority.authenticate("missing-token")).toThrow(
      "TOKEN_INVALID",
    );
    expect(() => authority.acceptInvite("missing", "device-1")).toThrow(
      "INVITE_INVALID",
    );
  });

  it("binds invites to the recipient, consumes them once and refuses device reuse", () => {
    const { store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-1", "user-1", "device-1");

    const inviteToken = authority.invite(boot.token, "org-1", "user-2", 60_000);
    const accepted = authority.acceptInvite(inviteToken, "device-2");
    expect(accepted.auth).toMatchObject({
      userId: "user-2",
      deviceId: "device-2",
    });
    expect(new Set(Object.values(accepted.auth)).size).toBe(4);
    expect(authority.authenticate(accepted.token)).toEqual(accepted.auth);
    expect(() => authority.acceptInvite(inviteToken, "device-3")).toThrow(
      "INVITE_USED",
    );
    expect(organization(store, "org-1")).toMatchObject({
      ownerIds: ["user-1"],
      memberIds: ["user-1", "user-2"],
      version: 2,
    });

    expect(() =>
      authority.invite(accepted.token, "org-1", "user-3", 60_000),
    ).toThrow("NOT_OWNER");

    const other = authority.bootstrap("org-2", "user-9", "device-9");
    expect(() =>
      authority.invite(other.token, "org-1", "user-3", 60_000),
    ).toThrow("ORG_MISMATCH");

    const secondInvite = authority.invite(
      boot.token,
      "org-1",
      "user-3",
      60_000,
    );
    expect(() => authority.acceptInvite(secondInvite, "device-2")).toThrow(
      "DEVICE_EXISTS",
    );
    const second = authority.acceptInvite(secondInvite, "device-3");
    expect(second.auth.userId).toBe("user-3");
    expect(authority.authenticate(second.token)).toEqual(second.auth);
  });

  it("enforces the bounded server-clock invite lifetime", () => {
    const { store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-1", "user-1", "device-1");

    expect(() =>
      authority.invite(boot.token, "org-1", "user-2", 59_999),
    ).toThrow("TTL_INVALID");
    expect(() =>
      authority.invite(boot.token, "org-1", "user-2", 604_800_001),
    ).toThrow("TTL_INVALID");
    expect(() =>
      authority.invite(boot.token, "org-1", "user-2", 60_000.5),
    ).toThrow("TTL_INVALID");

    const inviteToken = authority.invite(boot.token, "org-1", "user-2", 60_000);
    clock += 60_000;
    expect(() => authority.acceptInvite(inviteToken, "device-2")).toThrow(
      "INVITE_EXPIRED",
    );
    expect(organization(store, "org-1")).toMatchObject({
      memberIds: ["user-1"],
      version: 1,
    });
  });

  it("revokes live authentication while protecting the last owner device", () => {
    const { store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-r", "owner", "owner-device");
    const secondInvite = authority.invite(boot.token, "org-r", "owner", 60_000);
    const second = authority.acceptInvite(secondInvite, "owner-device-2");

    authority.revokeDevice(boot.token, "owner-device-2");
    expect(() => authority.authenticate(second.token)).toThrow("TOKEN_INVALID");
    expect(authority.authenticate(boot.token)).toEqual(boot.auth);
    expect(() => authority.revokeDevice(boot.token, "owner-device")).toThrow(
      "LAST_OWNER_DEVICE",
    );
    expect(authority.authenticate(boot.token)).toEqual(boot.auth);

    const memberInvite = authority.invite(
      boot.token,
      "org-r",
      "member",
      60_000,
    );
    const member = authority.acceptInvite(memberInvite, "member-device");
    expect(() => authority.revokeDevice(member.token, "owner-device")).toThrow(
      "NOT_OWNER",
    );
    authority.revokeDevice(member.token, "member-device");
    expect(() => authority.authenticate(member.token)).toThrow("TOKEN_INVALID");
  });

  it("rotates recovery material, revokes every old device and preserves membership", () => {
    const { store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);
    const boot = authority.bootstrap("org-rec", "owner", "owner-device");
    const memberInvite = authority.invite(
      boot.token,
      "org-rec",
      "member",
      60_000,
    );
    const member = authority.acceptInvite(memberInvite, "member-device");
    const before = organization(store, "org-rec");

    const recovered = authority.recover(
      "org-rec",
      boot.recoveryKey,
      "recovered-device",
    );
    expect(recovered.recoveryKey).not.toBe(boot.recoveryKey);
    expect(recovered.auth).toMatchObject({
      userId: "owner",
      deviceId: "recovered-device",
    });
    expect(() => authority.authenticate(boot.token)).toThrow("TOKEN_INVALID");
    expect(() => authority.authenticate(member.token)).toThrow("TOKEN_INVALID");
    expect(authority.authenticate(recovered.token)).toEqual(recovered.auth);
    expect(organization(store, "org-rec")).toEqual(before);

    expect(() =>
      authority.recover("org-rec", boot.recoveryKey, "replacement-device"),
    ).toThrow("RECOVERY_INVALID");

    const again = authority.recover(
      "org-rec",
      recovered.recoveryKey,
      "recovered-device-2",
    );
    expect(again.auth.userId).toBe("owner");
    expect(() => authority.authenticate(recovered.token)).toThrow(
      "TOKEN_INVALID",
    );
    expect(() =>
      authority.recover("org-rec", again.recoveryKey, "recovered-device"),
    ).toThrow("DEVICE_EXISTS");
  });

  it("participates in an existing parent transaction and rolls back with it", () => {
    const { store } = temporaryDatabase();
    const authority = new IdentityAuthority(store, () => clock);

    expect(() =>
      store.transaction(() => {
        authority.bootstrap("org-tx", "user-tx", "device-tx");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(organization(store, "org-tx")).toBeNull();

    const boot = authority.bootstrap("org-tx", "user-tx", "device-tx");
    expect(authority.authenticate(boot.token)).toEqual(boot.auth);
  });
});
