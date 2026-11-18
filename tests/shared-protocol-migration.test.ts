import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import {
  OPERATIONS_NAMESPACES,
  RuntimeOperations,
} from "../src/collaboration/runtime/operations";
import { RetentionService } from "../src/collaboration/runtime/retention";
import { createRuntimeGenesis } from "../src/collaboration/runtime/state-root";
import { checkedState, initialState } from "../src/collaboration/runtime/document";
import { digest } from "../src/collaboration/runtime/digest";
import {
  CollaborationError,
  scopeKey,
  type AuthContext,
  type Cut,
  type DocumentState,
  type Scope,
} from "../src/collaboration/runtime/contract";
import {
  PROTOCOL_NAMESPACE,
  RUNTIME_PROTOCOL_FEATURES,
  migrateEditorProtocol,
  readRuntimeProtocol,
} from "../src/collaboration/runtime/protocol-migration";
import type { Doc } from "../src/shared/types";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-protocol-"));
  directories.push(directory);
  return directory;
}

function openStore(): RuntimeStore {
  const store = new RuntimeStore(tempDirectory());
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()!.close();
    } catch {
      // cleanup only
    }
  }
  while (directories.length > 0) {
    try {
      rmSync(directories.pop()!, { recursive: true, force: true });
    } catch {
      // cleanup only
    }
  }
});

function pageDoc(text: string): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p_" + text },
        content: [{ type: "text", text }],
      },
    ],
  };
}

function membershipAuthorizer(store: RuntimeStore, orgId: string) {
  return (auth: AuthContext, requestedOrg: string): void => {
    if (requestedOrg !== orgId)
      throw new CollaborationError("AUTH_SCOPE_MISMATCH");
    const organization = store.get("organization", orgId) as {
      ownerIds?: string[];
      memberIds?: string[];
    } | null;
    if (
      !organization ||
      !organization.ownerIds?.includes(auth.userId) ||
      !organization.memberIds?.includes(auth.userId)
    )
      throw new CollaborationError("FORBIDDEN");
  };
}

type Fixture = Readonly<{
  store: RuntimeStore;
  backupStore: RuntimeStore;
  orgId: string;
  auth: AuthContext;
  scopes: readonly [Scope, Scope];
  backupHash: string;
  head: Cut;
}>;

function fixture(): Fixture {
  const store = openStore();
  const backupStore = openStore();
  const orgId = "org_1";
  const auth: AuthContext = {
    userId: "user_1",
    deviceId: "device_1",
    writerId: "writer_1",
    sessionId: "session_1",
  };
  const scopes: [Scope, Scope] = [
    {
      orgId,
      workspaceId: "workspace_1",
      documentId: "document_a",
      incarnationId: "incarnation_a",
    },
    {
      orgId,
      workspaceId: "workspace_1",
      documentId: "document_b",
      incarnationId: "incarnation_b",
    },
  ];
  store.transaction(() => {
    store.set("organization", orgId, {
      ownerIds: [auth.userId],
      memberIds: [auth.userId],
    });
    store.set("documents", scopeKey(scopes[0]), initialState(pageDoc("alpha")));
    store.set("documents", scopeKey(scopes[1]), initialState(pageDoc("beta")));
    createRuntimeGenesis(store, "epoch_1", null);
  });
  const head = store.get("meta", "head") as Cut;
  const retention = new RetentionService(store);
  const proof = retention.verifyBackup(head, backupStore, "epoch_restore");
  store.transaction(() => {
    store.set("backup.verifications", proof.backupHash, {
      backupHash: proof.backupHash,
      epoch: proof.cut.epoch,
      cut: proof.cut,
    });
  });
  const operations = new RuntimeOperations(
    store,
    membershipAuthorizer(store, orgId),
  );
  operations.recordBackup(auth, orgId, {
    hash: proof.backupHash,
    cut: proof.cut,
    verified: true,
  });
  operations.beginUpgrade(auth, orgId, 1004, proof.backupHash);
  return {
    store,
    backupStore,
    orgId,
    auth,
    scopes,
    backupHash: proof.backupHash,
    head,
  };
}

function runnerFor(fixture: Fixture): RuntimeOperations {
  return new RuntimeOperations(
    fixture.store,
    membershipAuthorizer(fixture.store, fixture.orgId),
    migrateEditorProtocol,
  );
}

function versionKey(scope: Scope, cut: Cut): string {
  return scopeKey(scope) + ":" + cut.epoch + ":" + String(cut.seq).padStart(16, "0");
}

describe("protocol 1003 -> 1004 migration", () => {
  it("writes protocol metadata and editor versions for two owned documents", () => {
    const f = fixture();
    const operations = runnerFor(f);
    operations.finishUpgrade(f.auth, f.orgId, true);

    const hashA = digest(
      checkedState(
        f.store.get("documents", scopeKey(f.scopes[0])) as DocumentState,
      ),
    );
    const hashB = digest(
      checkedState(
        f.store.get("documents", scopeKey(f.scopes[1])) as DocumentState,
      ),
    );
    const protocol = f.store.get(PROTOCOL_NAMESPACE, f.orgId) as Record<
      string,
      any
    >;
    expect(protocol.v).toBe(1);
    expect(protocol.protocol).toBe(1004);
    expect(protocol.minimumWriter).toBe(1004);
    expect(protocol.features).toEqual([...RUNTIME_PROTOCOL_FEATURES]);
    expect(protocol.baselineCut).toEqual(f.head);
    expect(protocol.documentHashes).toEqual({
      [scopeKey(f.scopes[0])]: hashA,
      [scopeKey(f.scopes[1])]: hashB,
    });

    expect(f.store.get("editor.versions", versionKey(f.scopes[0], f.head))).toBe(
      hashA,
    );
    expect(f.store.get("editor.versions", versionKey(f.scopes[1], f.head))).toBe(
      hashB,
    );
    expect(digest(f.store.get("editor.states", hashA))).toBe(hashA);
    expect(digest(f.store.get("editor.states", hashB))).toBe(hashB);

    const upgrade = f.store.get(
      OPERATIONS_NAMESPACES.upgrades,
      f.orgId,
    ) as Record<string, any>;
    expect(upgrade.status).toBe("COMMITTED");
    expect(upgrade.protocolCurrent).toBe(1004);
    expect(upgrade.protocolTarget).toBe(1004);
    expect(f.store.get(OPERATIONS_NAMESPACES.fences, f.orgId)).toBeNull();

    expect(readRuntimeProtocol(f.store, f.orgId)).toEqual({
      storageFormat: 1003,
      protocol: 1004,
      features: [...RUNTIME_PROTOCOL_FEATURES],
      status: "COMMITTED",
    });

    expect(() => operations.assertWriter(1003)).toThrow(
      /WRITER_VERSION_MISMATCH/,
    );
    expect(() => operations.assertWriter(1004)).not.toThrow();

    const version = f.store.db.prepare("PRAGMA user_version").get() as {
      user_version: unknown;
    };
    expect(Number(version.user_version)).toBe(1003);
  });

  it("rolls back all writes and keeps the fence when a document is invalid", () => {
    const f = fixture();
    const operations = runnerFor(f);
    f.store.transaction(() => {
      f.store.set("documents", scopeKey(f.scopes[1]), {
        document: {
          type: "doc",
          content: [{ type: "unsupportedNode" }],
        },
        tables: [],
        tombstones: [],
      } as unknown as DocumentState);
    });

    expect(() => operations.finishUpgrade(f.auth, f.orgId, true)).toThrow();
    const upgrade = f.store.get(
      OPERATIONS_NAMESPACES.upgrades,
      f.orgId,
    ) as Record<string, any>;
    expect(upgrade.status).toBe("ACTIVE");
    expect(f.store.get(OPERATIONS_NAMESPACES.fences, f.orgId)).toEqual({
      readOnly: true,
      protocolTarget: 1004,
      backupHash: f.backupHash,
    });
    expect(f.store.get(PROTOCOL_NAMESPACE, f.orgId)).toBeNull();
    expect(f.store.all("editor.versions")).toEqual([]);
    expect(readRuntimeProtocol(f.store, f.orgId)).toEqual({
      storageFormat: 1003,
      protocol: 1003,
      features: [],
      status: "ACTIVE",
    });

    operations.finishUpgrade(f.auth, f.orgId, false);
    const recovered = f.store.get(
      OPERATIONS_NAMESPACES.upgrades,
      f.orgId,
    ) as Record<string, any>;
    expect(recovered.status).toBe("RECOVERY_REQUIRED");
    expect(readRuntimeProtocol(f.store, f.orgId)).toEqual({
      storageFormat: 1003,
      protocol: 1003,
      features: [],
      status: "RECOVERY_REQUIRED",
    });
  });

  it("rejects unsupported versions and a repeated migration", () => {
    const f = fixture();
    expect(() =>
      migrateEditorProtocol({
        store: f.store,
        orgId: f.orgId,
        storageFormat: 1003,
        fromProtocol: 1003,
        toProtocol: 1005,
        backupHash: f.backupHash,
      }),
    ).toThrow(/UNSUPPORTED_UPGRADE/);
    expect(f.store.get(PROTOCOL_NAMESPACE, f.orgId)).toBeNull();

    const operations = runnerFor(f);
    operations.finishUpgrade(f.auth, f.orgId, true);
    expect(() =>
      migrateEditorProtocol({
        store: f.store,
        orgId: f.orgId,
        storageFormat: 1003,
        fromProtocol: 1003,
        toProtocol: 1004,
        backupHash: f.backupHash,
      }),
    ).toThrow(/NO_ACTIVE_UPGRADE/);
  });

  it("never reports a fake 1004 protocol from a read-only fence", () => {
    const store = openStore();
    store.transaction(() => createRuntimeGenesis(store, "epoch_legacy", null));
    expect(readRuntimeProtocol(store, "org_1")).toEqual({
      storageFormat: 1003,
      protocol: 1003,
      features: [],
      status: "LEGACY",
    });
    store.transaction(() => {
      store.set(OPERATIONS_NAMESPACES.fences, "org_1", {
        readOnly: true,
        protocolTarget: 1004,
        backupHash: "a".repeat(64),
      });
    });
    expect(readRuntimeProtocol(store, "org_1")).toEqual({
      storageFormat: 1003,
      protocol: 1003,
      features: [],
      status: "FENCED",
    });
  });

  it("denies finishUpgrade through the real membership authorizer after revocation", () => {
    const f = fixture();
    const operations = runnerFor(f);
    f.store.transaction(() => {
      f.store.set("organization", f.orgId, {
        ownerIds: [f.auth.userId],
        memberIds: [],
      });
    });

    expect(() => operations.finishUpgrade(f.auth, f.orgId, true)).toThrow(
      /FORBIDDEN/,
    );
    const upgrade = f.store.get(
      OPERATIONS_NAMESPACES.upgrades,
      f.orgId,
    ) as Record<string, any>;
    expect(upgrade.status).toBe("ACTIVE");
    expect(f.store.get(PROTOCOL_NAMESPACE, f.orgId)).toBeNull();
    expect(readRuntimeProtocol(f.store, f.orgId)).toEqual({
      storageFormat: 1003,
      protocol: 1003,
      features: [],
      status: "ACTIVE",
    });

    f.store.transaction(() => {
      f.store.set("organization", f.orgId, {
        ownerIds: [f.auth.userId],
        memberIds: [f.auth.userId],
      });
    });
    operations.finishUpgrade(f.auth, f.orgId, true);
    expect(readRuntimeProtocol(f.store, f.orgId).status).toBe("COMMITTED");
  });
});
