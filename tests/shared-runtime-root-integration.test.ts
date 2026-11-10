import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import {
  CollaborationError,
  scopeKey,
  type Attempt,
  type Json,
  type RuntimeEvent,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import { digest } from "../src/collaboration/runtime/digest";
import {
  authorityStateRoot,
  createRuntimeGenesis,
} from "../src/collaboration/runtime/state-root";
import { readRetentionCheckpoint } from "../src/collaboration/runtime/retention";
import {
  BACKUP_FORMAT,
  restoreBackup,
  validateRuntimeBackup,
  type RuntimeBackup,
} from "../src/collaboration/runtime/backup";

const ORG = "org_root";
const USER = "user_root";
const WORKSPACE = "ws_root";
const DOCUMENT = "doc_root";

const PROPERTIES: Json = [
  { id: "status", name: "Status", type: "select", options: ["todo", "done"] },
];

type Harness = {
  dir: string;
  authority: SharedAuthority;
  token: string;
  recoveryKey: string;
  scope: Scope;
};

const directories: string[] = [];
const authorities: SharedAuthority[] = [];
const stores: RuntimeStore[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "folio-root-integration-"));
  directories.push(value);
  return value;
}

function trackAuthority(authority: SharedAuthority): SharedAuthority {
  authorities.push(authority);
  return authority;
}

function trackStore(store: RuntimeStore): RuntimeStore {
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const authority of authorities.splice(0)) {
    try {
      authority.close();
    } catch {
      void 0;
    }
  }
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      void 0;
    }
  }
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeDoc(text: string, prefix: string): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: `${prefix}_p` },
        content: [{ type: "text", text }],
      },
    ],
  };
}

function harness(): Harness {
  const dir = directory();
  const authority = trackAuthority(new SharedAuthority(dir));
  const boot = authority.bootstrap({
    orgId: ORG,
    userId: USER,
    deviceId: "device_owner",
    workspaceId: WORKSPACE,
    documentId: DOCUMENT,
    document: makeDoc("seed", "seed"),
  });
  return {
    dir,
    authority,
    token: boot.token,
    recoveryKey: boot.recoveryKey,
    scope: boot.scope,
  };
}

function submitResource(
  authority: SharedAuthority,
  token: string,
  scope: Scope,
  action: string,
  payload: unknown,
): { attempt: Attempt; receipt: ReturnType<SharedAuthority["submit"]> } {
  const auth = authority.session(token, scope.orgId);
  const base = authority.head();
  const attempt: Attempt = {
    v: 1,
    attemptId: `attempt_${digest({ action, base, scope }).slice(0, 40)}`,
    intent: {
      v: 1,
      intentId: `intent_${digest({ action, base, scope, payload }).slice(0, 40)}`,
      writerId: auth.writerId,
      scope,
      base,
      command: { kind: "resource", action, payload: payload as Json },
    },
    base,
  };
  return { attempt, receipt: authority.submit(token, attempt) };
}

function codeOf(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    if (error instanceof Error) return error.message.split(":")[0];
    return String(error);
  }
}

function eventsOf(store: RuntimeStore): RuntimeEvent[] {
  const head = store.get("meta", "head") as { epoch: string };
  return store
    .all("authority.events")
    .map((entry) => entry.value as RuntimeEvent)
    .filter((event) => event.epoch === head.epoch)
    .sort((left, right) => left.seq - right.seq);
}

function reopen(dir: string): SharedAuthority | null {
  try {
    const value = new SharedAuthority(dir);
    trackAuthority(value);
    return value;
  } catch {
    return null;
  }
}

function reopenCode(dir: string): string | null {
  return codeOf(() => {
    const value = new SharedAuthority(dir);
    value.close();
  });
}

function lastEvent(store: RuntimeStore): RuntimeEvent {
  const events = eventsOf(store);
  expect(events.length).toBeGreaterThan(0);
  return events[events.length - 1];
}

describe("rooted authority lifecycle", () => {
  it("bootstraps a rooted genesis and survives a genuine restart", () => {
    const h = harness();
    const genesis = h.authority.store.get("meta", "genesis") as {
      authorityStateHash: string;
    };
    expect(genesis.authorityStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.authority.store.get("meta", "state-root")).toBe(
      authorityStateRoot(h.authority.store),
    );
    const head = h.authority.head();
    const snapshot = h.authority.snapshot(h.token, h.scope);

    h.authority.close();
    const reopened = reopen(h.dir);
    expect(reopened).not.toBeNull();
    expect(reopened!.head()).toEqual(head);
    expect(reopened!.snapshot(h.token, h.scope).state).toEqual(snapshot.state);
    expect(reopened!.store.get("meta", "state-root")).toBe(
      authorityStateRoot(reopened!.store),
    );
  });

  it("binds every accepted and rejected event to the authoritative state root", () => {
    const h = harness();
    const created = submitResource(h.authority, h.token, h.scope, "db.create", {
      databaseId: "db_root",
      revision: 0,
      properties: PROPERTIES,
    });
    expect(created.receipt.status).toBe("SERVER_ACCEPTED");
    const accepted = lastEvent(h.authority.store);
    expect(accepted.authorityStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.authorityStateHash).toBe(
      h.authority.store.get("meta", "state-root"),
    );
    expect(accepted.authorityStateHash).toBe(
      authorityStateRoot(h.authority.store),
    );

    const rejected = submitResource(
      h.authority,
      h.token,
      h.scope,
      "workspace.grant",
      { userId: USER, role: "editor" },
    );
    expect(rejected.receipt.status).toBe("REJECTED");
    const rejectedEvent = lastEvent(h.authority.store);
    expect(rejectedEvent.receipt.status).toBe("REJECTED");
    expect(rejectedEvent.authorityStateHash).toBe(
      h.authority.store.get("meta", "state-root"),
    );

    expect(() => h.authority.verify()).not.toThrow();
  });

  it("keeps a retention checkpoint root and validates the surviving suffix", () => {
    const h = harness();
    const oldCut = h.authority.head();
    const removedEvent = lastEvent(h.authority.store);
    const destination = trackStore(new RuntimeStore(directory()));
    const verification = h.authority
      .retention(h.token, ORG)
      .verifyBackup(oldCut, destination, "epoch_retention_restore");

    const invite = h.authority.invite(h.token, ORG, USER);
    const joined = h.authority.join(invite, ORG, "device_second");
    h.authority.revokeDevice(joined.token, ORG, "device_owner");

    const result = h.authority
      .retention(joined.token, ORG)
      .compact(oldCut, verification);
    expect(result.removed).toBe(1);

    const checkpoint = readRetentionCheckpoint(h.authority.store);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.body.authorityStateHash).toBe(
      removedEvent.authorityStateHash,
    );
    expect(checkpoint!.body.cut).toEqual(oldCut);

    const suffix = h.authority.createDocument(
      joined.token,
      { ...h.scope, documentId: "doc_suffix", incarnationId: "inc_suffix" },
      makeDoc("after checkpoint", "suffix"),
      "Suffix",
    );
    expect(suffix.status).toBe("SERVER_ACCEPTED");
    expect(() => h.authority.verify()).not.toThrow();

    h.authority.close();
    const reopened = reopen(h.dir);
    expect(reopened).not.toBeNull();
    expect(reopened!.head()).toEqual(suffix.cut);
    expect(reopened!.store.get("meta", "state-root")).toBe(
      authorityStateRoot(reopened!.store),
    );
  });

  it("restores a rooted backup with a new genesis, new key and archived old epoch", () => {
    const h = harness();
    submitResource(h.authority, h.token, h.scope, "db.create", {
      databaseId: "db_restore",
      revision: 0,
      properties: PROPERTIES,
    });
    const backup = h.authority.backup(h.token, ORG);
    const archivedBefore = backup.records.filter(
      (record) => record.namespace === "authority.events",
    ).length;
    expect(archivedBefore).toBeGreaterThan(0);

    const destinationDir = directory();
    const destination = trackStore(new RuntimeStore(destinationDir));
    const restored = h.authority.restoreInto(
      h.token,
      ORG,
      backup,
      destination,
      "epoch_restored",
    );
    expect(restored.newCut.epoch).toBe("epoch_restored");
    expect(restored.newCut.seq).toBe(0);
    destination.close();

    const reopened = reopen(destinationDir);
    expect(reopened).not.toBeNull();
    const genesis = reopened!.store.get("meta", "genesis") as {
      sourceHash: string;
      authorityStateHash: string;
    };
    expect(genesis.sourceHash).toBe(backup.hash);
    expect(genesis.authorityStateHash).toBe(
      authorityStateRoot(reopened!.store),
    );
    expect(reopened!.store.get("meta", "restore")).toMatchObject({
      epoch: "epoch_restored",
      backupHash: backup.hash,
      requiresReauthorization: true,
    });
    expect(reopened!.store.get("meta", "restore-authorization")).toMatchObject({
      reset: true,
      epoch: "epoch_restored",
      sourceHash: backup.hash,
    });
    const archiveBefore = reopened!.store.all(
      "authority.archive.events",
    ).length;
    expect(archiveBefore).toBeGreaterThanOrEqual(archivedBefore);
    expect(reopened!.store.all("authority.events")).toHaveLength(0);

    const recovered = reopened!.recover(
      ORG,
      restored.recoveryKey,
      "device_after_restore",
    );
    const created = submitResource(
      reopened!,
      recovered.token,
      h.scope,
      "db.create",
      { databaseId: "db_after_restore", revision: 0, properties: PROPERTIES },
    );
    expect(created.receipt.status).toBe("SERVER_ACCEPTED");
    expect(created.receipt.cut.epoch).toBe("epoch_restored");
    expect(created.receipt.cut.seq).toBe(2);
    expect(reopened!.store.all("authority.events")).toHaveLength(2);
    expect(reopened!.store.all("authority.archive.events").length).toBe(
      archiveBefore,
    );
    expect(() => reopened!.verify()).not.toThrow();
  });
});

describe("rooted authority tamper detection", () => {
  it("rejects tampered current documents with an intact head and event chain", () => {
    const h = harness();
    const key = scopeKey(h.scope);
    const state = h.authority.store.get("documents", key) as {
      tombstones: string[];
      document: Doc;
    } | null;
    expect(state).not.toBeNull();
    h.authority.store.transaction(() =>
      h.authority.store.set("documents", key, {
        ...state!,
        tombstones: [...state!.tombstones, "tampered"],
      }),
    );
    h.authority.close();
    expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("rejects tampered record values", () => {
    const h = harness();
    submitResource(h.authority, h.token, h.scope, "db.create", {
      databaseId: "db_values",
      revision: 0,
      properties: PROPERTIES,
    });
    const recordScope: Scope = {
      ...h.scope,
      documentId: "record_values",
      incarnationId: "inc_values",
    };
    const created = submitResource(
      h.authority,
      h.token,
      recordScope,
      "record.create",
      {
        databaseId: "db_values",
        revision: 0,
        title: "Record",
        values: { status: "todo" },
        document: makeDoc("record body", "record"),
      },
    );
    expect(created.receipt.status).toBe("SERVER_ACCEPTED");
    const row = h.authority.store.all("records")[0];
    expect(row).toBeDefined();
    h.authority.store.transaction(() =>
      h.authority.store.set("records", row.key, {
        ...(row.value as Record<string, unknown>),
        values: { status: "done" },
      }),
    );
    h.authority.close();
    expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("rejects tampered workspace roles and identity state", () => {
    const role = harness();
    const roleRow = role.authority.store.all("workspace.roles")[0];
    expect(roleRow).toBeDefined();
    role.authority.store.transaction(() =>
      role.authority.store.set("workspace.roles", roleRow.key, {
        ...(roleRow.value as Record<string, unknown>),
        role: "viewer",
      }),
    );
    role.authority.close();
    expect(reopenCode(role.dir)).toBe("STATE_ROOT_MISMATCH");

    const identity = harness();
    const userRow = identity.authority.store.all("identity.users")[0];
    expect(userRow).toBeDefined();
    identity.authority.store.transaction(() =>
      identity.authority.store.set("identity.users", userRow.key, {
        ...(userRow.value as Record<string, unknown>),
        status: "revoked",
      }),
    );
    identity.authority.close();
    expect(reopenCode(identity.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("rejects a changed root metadata value even when data is untouched", () => {
    const h = harness();
    h.authority.store.transaction(() =>
      h.authority.store.set("meta", "state-root", digest("forged-root")),
    );
    h.authority.close();
    expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("rejects an unrooted legacy authority with no fake migration", () => {
    const dir = directory();
    const store = trackStore(new RuntimeStore(dir));
    const epoch = "legacy_epoch";
    const cut = { epoch, seq: 0, hash: digest({ epoch, genesis: 1 }) };
    store.transaction(() => {
      store.set("meta", "role", "authority");
      store.set("meta", "head", cut);
      store.set("authority.prefix", `${epoch}:0`, cut);
    });
    store.close();
    expect(reopenCode(dir)).toBe("UNROOTED_AUTHORITY");
  });

  it("rejects a tampered exported backup before the authorization reset", () => {
    const h = harness();
    submitResource(h.authority, h.token, h.scope, "db.create", {
      databaseId: "db_backup_tamper",
      revision: 0,
      properties: PROPERTIES,
    });
    const backup = h.authority.backup(h.token, ORG);
    const records = backup.records.map((record) =>
      record.namespace === "documents"
        ? {
            ...record,
            value: {
              ...(record.value as Record<string, unknown>),
              tombstones: [
                ...((record.value as { tombstones?: string[] }).tombstones ??
                  []),
                "backup-tamper",
              ],
            },
          }
        : record,
    );
    const forged: RuntimeBackup = {
      ...backup,
      records,
      hash: digest({
        format: BACKUP_FORMAT,
        head: backup.head,
        records,
        blobs: backup.blobs,
      }),
    };
    expect(canonical(forged).length).toBeGreaterThan(0);

    const destination = trackStore(new RuntimeStore(directory()));
    let authorized = false;
    const code = codeOf(() =>
      restoreBackup(forged, destination, "epoch_backup_tamper", () => {
        authorized = true;
      }),
    );
    expect(code).toBe("STATE_ROOT_MISMATCH");
    expect(authorized).toBe(false);
    expect(destination.all("documents")).toHaveLength(0);
    expect(destination.all("authority.events")).toHaveLength(0);
  });
});

describe("rooted genesis construction", () => {
  it("creates a genesis that binds source hash and refuses duplicate genesis", () => {
    const dir = directory();
    const store = trackStore(new RuntimeStore(dir));
    const cut = store.transaction(() =>
      createRuntimeGenesis(store, "epoch_manual", digest("source")),
    );
    expect(cut.seq).toBe(0);
    expect(store.get("meta", "state-root")).toBe(authorityStateRoot(store));
    expect(store.get("meta", "genesis")).toMatchObject({
      format: "folio.shared.genesis/2",
      epoch: "epoch_manual",
      sourceHash: digest("source"),
    });
    expect(
      codeOf(() => {
        store.transaction(() =>
          createRuntimeGenesis(store, "epoch_manual", null),
        );
      }),
    ).toBe("GENESIS_CONFLICT");
  });
});

describe("root covers receipt, dedup and undo evidence", () => {
  it("detects tampered attempt receipts with an intact head", () => {
    const h = harness();
    const row = h.authority.store.all("authority.attempts")[0];
    expect(row).toBeDefined();
    h.authority.store.transaction(() =>
      h.authority.store.set("authority.attempts", row.key, {
        ...(row.value as Record<string, unknown>),
        attemptHash: digest("forged-attempt"),
      }),
    );
    h.authority.close();
    expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("detects tampered intent dedup records with an intact head", () => {
    const h = harness();
    const row = h.authority.store.all("authority.intents")[0];
    expect(row).toBeDefined();
    h.authority.store.transaction(() =>
      h.authority.store.set("authority.intents", row.key, {
        ...(row.value as Record<string, unknown>),
        intentHash: digest("forged-intent"),
      }),
    );
    h.authority.close();
    expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("keeps a committed undo witness rooted across restart, then rejects tamper", () => {
    const h = harness();
    const auth = h.authority.session(h.token, ORG);
    const witnessKey = `${scopeKey(h.scope)}:${auth.writerId}:intent_undo_probe`;
    const witness = {
      userId: auth.userId,
      writerId: auth.writerId,
      template: {
        kind: "table.row.restore",
        tableId: "table_probe",
        beforeId: null,
        sourceRow: { type: "paragraph", attrs: { id: "row_probe" } },
        columnIds: ["col_probe"],
      },
      cut: null,
      usedBy: null,
    };
    h.authority.store.transaction(() =>
      h.authority.store.set("authority.undo", witnessKey, witness),
    );
    const committed = submitResource(
      h.authority,
      h.token,
      h.scope,
      "db.create",
      { databaseId: "db_undo_probe", revision: 0, properties: PROPERTIES },
    );
    expect(committed.receipt.status).toBe("SERVER_ACCEPTED");
    expect(h.authority.store.get("authority.undo", witnessKey)).toMatchObject({
      usedBy: null,
    });
    expect(h.authority.store.get("meta", "state-root")).toBe(
      authorityStateRoot(h.authority.store),
    );

    h.authority.close();
    const reopened = reopen(h.dir);
    expect(reopened).not.toBeNull();
    expect(reopened!.store.get("authority.undo", witnessKey)).not.toBeNull();

    reopened!.store.transaction(() =>
      reopened!.store.set("authority.undo", witnessKey, {
        ...witness,
        template: { ...witness.template, tableId: "tampered_table" },
      }),
    );
    reopened!.close();
    expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
  });

  it("still exports and restores a backup containing attempt, intent and undo evidence", () => {
    const h = harness();
    const auth = h.authority.session(h.token, ORG);
    const witnessKey = `${scopeKey(h.scope)}:${auth.writerId}:intent_undo_restore`;
    h.authority.store.transaction(() =>
      h.authority.store.set("authority.undo", witnessKey, {
        userId: auth.userId,
        writerId: auth.writerId,
        template: {
          kind: "table.column.restore",
          tableId: "table_restore",
          beforeId: null,
          sourceColumnId: "col_restore",
          rows: [],
        },
        cut: null,
        usedBy: null,
      }),
    );
    const created = submitResource(h.authority, h.token, h.scope, "db.create", {
      databaseId: "db_root_restore",
      revision: 0,
      properties: PROPERTIES,
    });
    expect(created.receipt.status).toBe("SERVER_ACCEPTED");
    const backup = h.authority.backup(h.token, ORG);
    const destinationDir = directory();
    const destination = trackStore(new RuntimeStore(destinationDir));
    const restored = h.authority.restoreInto(
      h.token,
      ORG,
      backup,
      destination,
      "epoch_root_restore",
    );
    destination.close();
    const reopened = reopen(destinationDir);
    expect(reopened).not.toBeNull();
    expect(reopened!.store.get("authority.undo", witnessKey)).not.toBeNull();
    expect(reopened!.store.all("authority.attempts").length).toBeGreaterThan(0);
    expect(reopened!.store.all("authority.intents").length).toBeGreaterThan(0);
    expect(() => reopened!.verify()).not.toThrow();
    const recovered = reopened!.recover(
      ORG,
      restored.recoveryKey,
      "device_root_restore",
    );
    expect(
      submitResource(reopened!, recovered.token, h.scope, "db.create", {
        databaseId: "db_root_after_restore",
        revision: 0,
        properties: PROPERTIES,
      }).receipt.status,
    ).toBe("SERVER_ACCEPTED");
  });
});

describe("large asset backups", () => {
  it("validates a 9MiB asset backup without base64 recursion failure", () => {
    const h = harness();
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(0x5a);
    const hash = createHash("sha256").update(bytes).digest("hex");
    h.authority.stageAsset(h.token, h.scope, "upload_large", bytes);
    const published = submitResource(
      h.authority,
      h.token,
      h.scope,
      "asset.publish",
      { uploadId: "upload_large", hash },
    );
    expect(published.receipt.status).toBe("SERVER_ACCEPTED");

    const backup = h.authority.backup(h.token, ORG);
    const validated = validateRuntimeBackup(backup);
    const blob = validated.blobs.find((entry) => entry.hash === hash);
    expect(blob).toBeDefined();
    expect(Buffer.from(blob!.base64, "base64").byteLength).toBe(
      bytes.byteLength,
    );
    expect(validated.hash).toBe(backup.hash);
  }, 30_000);
});
