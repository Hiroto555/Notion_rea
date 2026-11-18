import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import {
  RuntimeStore,
  SHARED_RUNTIME_VERSION,
} from "../src/collaboration/runtime/store";
import {
  CollaborationError,
  type Attempt,
  type AuthContext,
  type Json,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { textOf, type Doc } from "../src/shared/types";

type PropertyView = {
  id: string;
  name: string;
  type: string;
  options?: string[];
};
type RecordView = {
  id: string;
  databaseId: string;
  revision: number;
  title: string;
  values: Record<string, string | number | boolean>;
  deleted: boolean;
};
type RecordsView = {
  databases: {
    id: string;
    revision: number;
    properties: PropertyView[];
    deleted: boolean;
  }[];
  records: RecordView[];
  pages: { id: string; parentId: string | null; order: number }[];
  document: {
    document: Doc;
    tables: unknown[];
    tombstones: string[];
  } | null;
};

const PROPERTIES: Json = [
  {
    id: "status",
    name: "Status",
    type: "select",
    options: ["todo", "doing", "done"],
  },
  { id: "count", name: "Count", type: "number" },
];

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

type Harness = {
  authority: SharedAuthority;
  dir: string;
  token: string;
  recoveryKey: string;
  orgId: string;
  userId: string;
  workspaceId: string;
  seedScope: Scope;
  auth: AuthContext;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "folio-r11-resources-"));
  chmodSync(dir, 0o700);
  const authority = new SharedAuthority(dir);
  const orgId = "org1";
  const userId = "alice";
  const workspaceId = "workspace-a";
  const boot = authority.bootstrap({
    orgId,
    userId,
    deviceId: "device-alice",
    workspaceId,
    documentId: "seed-doc",
    document: makeDoc("seed body", "seed"),
  });
  return {
    authority,
    dir,
    token: boot.token,
    recoveryKey: boot.recoveryKey,
    orgId,
    userId,
    workspaceId,
    seedScope: boot.scope,
    auth: boot.auth,
    cleanup: () => {
      authority.close();
      rmSync(dir, { recursive: true, force: true });
    },
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
    attemptId: randomUUID(),
    intent: {
      v: 1,
      intentId: randomUUID(),
      writerId: auth.writerId,
      scope,
      base,
      command: { kind: "resource", action, payload: payload as Json },
    },
    base,
  };
  return { attempt, receipt: authority.submit(token, attempt) };
}

function createDatabase(h: Harness, databaseId = "db1") {
  const result = submitResource(
    h.authority,
    h.token,
    h.seedScope,
    "db.create",
    { databaseId, revision: 0, properties: PROPERTIES },
  );
  expect(result.receipt.status).toBe("SERVER_ACCEPTED");
  return result;
}

function setupRecord(
  h: Harness,
  options: {
    databaseId: string;
    recordId: string;
    incarnationId: string;
    body: string;
    title: string;
    values: Record<string, string | number | boolean>;
  },
) {
  const recordScope: Scope = {
    orgId: h.orgId,
    workspaceId: h.workspaceId,
    documentId: options.recordId,
    incarnationId: options.incarnationId,
  };
  const doc = makeDoc(options.body, options.recordId);
  const created = submitResource(
    h.authority,
    h.token,
    recordScope,
    "record.create",
    {
      databaseId: options.databaseId,
      revision: 0,
      title: options.title,
      values: options.values,
      document: doc,
    },
  );
  expect(created.receipt.status).toBe("SERVER_ACCEPTED");
  return { recordScope, created };
}

function captureCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message))
      return error.message;
    throw error;
  }
  throw new Error("EXPECTED_REFUSAL");
}

describe("shared runtime resource integration", () => {
  test("db.create and record.create accept a fresh document scope and keep values, body and schema at one cut", () => {
    const h = makeHarness();
    try {
      createDatabase(h, "db-fresh");
      const recordScope: Scope = {
        orgId: h.orgId,
        workspaceId: h.workspaceId,
        documentId: "record-fresh",
        incarnationId: "inc-fresh",
      };
      const body = makeDoc("fresh record body", "fresh");
      const { receipt } = submitResource(
        h.authority,
        h.token,
        recordScope,
        "record.create",
        {
          databaseId: "db-fresh",
          revision: 0,
          title: "Fresh record",
          values: { status: "doing", count: 7 },
          document: body,
        },
      );
      expect(receipt.status).toBe("SERVER_ACCEPTED");
      expect(receipt.scope).toEqual(recordScope);
      expect(receipt.cut).toEqual(h.authority.head());

      const view = h.authority.records(
        h.token,
        recordScope,
      ) as unknown as RecordsView;
      expect(view.records).toHaveLength(1);
      const record = view.records[0];
      expect(record.id).toBe("record-fresh");
      expect(record.databaseId).toBe("db-fresh");
      expect(record.revision).toBe(0);
      expect(record.title).toBe("Fresh record");
      expect(record.values).toEqual({ status: "doing", count: 7 });
      expect(view.databases).toHaveLength(1);
      expect(view.databases[0].properties.map((p) => p.id)).toEqual([
        "status",
        "count",
      ]);
      expect(view.document).not.toBeNull();
      expect(textOf(view.document!.document)).toBe("fresh record body");
      expect(h.authority.head()).toEqual(receipt.cut);
    } finally {
      h.cleanup();
    }
  });

  test("record.patch changes metadata only and leaves the record body text intact", () => {
    const h = makeHarness();
    try {
      createDatabase(h, "db-meta");
      const body = "body survives record.patch";
      const { recordScope } = setupRecord(h, {
        databaseId: "db-meta",
        recordId: "record-meta",
        incarnationId: "inc-meta",
        body,
        title: "Before",
        values: { status: "todo", count: 5 },
      });

      const patch = submitResource(
        h.authority,
        h.token,
        recordScope,
        "record.patch",
        {
          databaseId: "db-meta",
          revision: 0,
          schemaRevision: 0,
          title: "After",
          values: { status: "done" },
        },
      );
      expect(patch.receipt.status).toBe("SERVER_ACCEPTED");

      const view = h.authority.records(
        h.token,
        recordScope,
      ) as unknown as RecordsView;
      const record = view.records[0];
      expect(record.revision).toBe(1);
      expect(record.title).toBe("After");
      expect(record.values).toEqual({ status: "done", count: 5 });
      expect(view.document).not.toBeNull();
      expect(textOf(view.document!.document)).toBe(body);
      expect(patch.receipt.cut).toEqual(h.authority.head());
    } finally {
      h.cleanup();
    }
  });

  test("record.trash rejects later writes, is lifecycle-visible and restore uses a fresh incarnation", () => {
    const h = makeHarness();
    try {
      createDatabase(h, "db-trash");
      const body = "trashed record body";
      const { recordScope } = setupRecord(h, {
        databaseId: "db-trash",
        recordId: "record-trash",
        incarnationId: "inc-trash",
        body,
        title: "Trash me",
        values: { status: "doing", count: 3 },
      });

      const trash = submitResource(
        h.authority,
        h.token,
        recordScope,
        "record.trash",
        { databaseId: "db-trash", revision: 0 },
      );
      expect(trash.receipt.status).toBe("SERVER_ACCEPTED");

      const rejected = submitResource(
        h.authority,
        h.token,
        recordScope,
        "record.patch",
        {
          databaseId: "db-trash",
          revision: 1,
          schemaRevision: 0,
          title: "should not write",
        },
      );
      expect(rejected.receipt.status).toBe("REJECTED");
      expect(rejected.receipt.code).toBe("DOCUMENT_DELETED");

      expect(captureCode(() => h.authority.records(h.token, recordScope))).toBe(
        "DOCUMENT_DELETED",
      );

      const newIncarnation = "inc-trash-restored";
      const restore = submitResource(
        h.authority,
        h.token,
        recordScope,
        "record.restore",
        {
          databaseId: "db-trash",
          revision: 1,
          newIncarnationId: newIncarnation,
        },
      );
      expect(restore.receipt.status).toBe("SERVER_ACCEPTED");

      const restoredScope: Scope = {
        ...recordScope,
        incarnationId: newIncarnation,
      };
      const view = h.authority.records(
        h.token,
        restoredScope,
      ) as unknown as RecordsView;
      expect(view.records[0].deleted).toBe(false);
      expect(textOf(view.document!.document)).toBe(body);

      const write = submitResource(
        h.authority,
        h.token,
        restoredScope,
        "record.patch",
        {
          databaseId: "db-trash",
          revision: view.records[0].revision,
          schemaRevision: 0,
          title: "restored write",
        },
      );
      expect(write.receipt.status).toBe("SERVER_ACCEPTED");

      const stale = submitResource(
        h.authority,
        h.token,
        recordScope,
        "record.patch",
        {
          databaseId: "db-trash",
          revision: view.records[0].revision,
          schemaRevision: 0,
          title: "stale incarnation",
        },
      );
      expect(stale.receipt.status).toBe("REJECTED");
      const staleCode = stale.receipt.code;
      expect(
        staleCode === "SCOPE_NOT_ACTIVE" ||
          staleCode === "DOCUMENT_DELETED" ||
          staleCode === "LIFECYCLE_MISSING",
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("stale incarnation is rejected at the authority boundary", () => {
    const h = makeHarness();
    try {
      const staleScope: Scope = {
        ...h.seedScope,
        incarnationId: "inc-not-active",
      };
      expect(captureCode(() => h.authority.snapshot(h.token, staleScope))).toBe(
        "SCOPE_NOT_ACTIVE",
      );
      expect(captureCode(() => h.authority.records(h.token, staleScope))).toBe(
        "SCOPE_NOT_ACTIVE",
      );
    } finally {
      h.cleanup();
    }
  });

  test("shared projection is isolated by workspace", () => {
    const h = makeHarness();
    try {
      h.authority.createWorkspace(h.token, h.orgId, "workspace-b", "Other");
      const scopeB: Scope = {
        orgId: h.orgId,
        workspaceId: "workspace-b",
        documentId: "doc-b",
        incarnationId: "inc-b",
      };
      const created = h.authority.createDocument(
        h.token,
        scopeB,
        makeDoc("needle-b unique", "pb"),
        "B page",
      );
      expect(created.status).toBe("SERVER_ACCEPTED");

      const projection = h.authority.projection(h.token);
      expect(
        projection.search(h.orgId, h.workspaceId, "needle-b unique"),
      ).toHaveLength(0);
      const inB = projection.search(h.orgId, "workspace-b", "needle-b unique");
      expect(inB).toHaveLength(1);
      expect(inB[0].scope.workspaceId).toBe("workspace-b");
      expect(
        projection.search(h.orgId, "workspace-b", "seed body"),
      ).toHaveLength(0);
      const seedInA = projection.search(h.orgId, h.workspaceId, "seed body");
      expect(seedInA.map((entry) => entry.scope.documentId)).toEqual([
        h.seedScope.documentId,
      ]);
      expect(projection.exportDocument(scopeB).scope).toEqual(scopeB);
    } finally {
      h.cleanup();
    }
  });

  test("staged asset publishes at the same cut and failed publish preserves staged bytes", () => {
    const h = makeHarness();
    try {
      const bytes = new TextEncoder().encode("asset payload bytes");
      const expectedHash = createHash("sha256").update(bytes).digest("hex");
      const headBefore = h.authority.head();
      const staged = h.authority.stageAsset(
        h.token,
        h.seedScope,
        "upload-1",
        bytes,
      );
      expect(staged.hash).toBe(expectedHash);
      expect(staged.bytes).toBe(bytes.byteLength);
      expect(h.authority.head()).toEqual(headBefore);

      expect(
        captureCode(() =>
          h.authority.readAsset(h.token, h.seedScope, expectedHash),
        ),
      ).toBe("ASSET_NOT_FOUND");

      const wrongHash = createHash("sha256")
        .update(new TextEncoder().encode("other bytes"))
        .digest("hex");
      const failed = submitResource(
        h.authority,
        h.token,
        h.seedScope,
        "asset.publish",
        { uploadId: "upload-1", hash: wrongHash },
      );
      expect(failed.receipt.status).toBe("REJECTED");
      expect(failed.receipt.code).toBe("UPLOAD_HASH_MISMATCH");
      expect(
        captureCode(() =>
          h.authority.readAsset(h.token, h.seedScope, expectedHash),
        ),
      ).toBe("ASSET_NOT_FOUND");

      const published = submitResource(
        h.authority,
        h.token,
        h.seedScope,
        "asset.publish",
        { uploadId: "upload-1", hash: expectedHash },
      );
      expect(published.receipt.status).toBe("SERVER_ACCEPTED");
      expect(published.receipt.cut).toEqual(h.authority.head());

      const read = h.authority.readAsset(h.token, h.seedScope, expectedHash);
      expect(createHash("sha256").update(read).digest("hex")).toBe(
        expectedHash,
      );
      expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
      expect(
        captureCode(() =>
          h.authority.readAsset("not-a-token", h.seedScope, expectedHash),
        ),
      ).toBe("TOKEN_INVALID");
    } finally {
      h.cleanup();
    }
  });

  test("the last workspace owner cannot be demoted", () => {
    const h = makeHarness();
    try {
      const demote = submitResource(
        h.authority,
        h.token,
        h.seedScope,
        "workspace.grant",
        { userId: h.userId, role: "editor" },
      );
      expect(demote.receipt.status).toBe("REJECTED");
      expect(demote.receipt.code).toBe("LAST_WORKSPACE_OWNER");
    } finally {
      h.cleanup();
    }
  });

  test("organization handoff, revoke and current permissions follow the new owner", () => {
    const h = makeHarness();
    try {
      const invite = h.authority.invite(h.token, h.orgId, "bob");
      const bob = h.authority.acceptInvite(invite, "device-bob");
      expect(bob.auth.userId).toBe("bob");

      h.authority.grant(h.token, h.seedScope, "bob", "editor");
      expect(h.authority.records(bob.token, h.seedScope)).toBeDefined();
      expect(
        captureCode(() =>
          submitResource(
            h.authority,
            bob.token,
            h.seedScope,
            "workspace.grant",
            { userId: "bob", role: "owner" },
          ),
        ),
      ).toBe("FORBIDDEN");

      h.authority.handoff(h.token, h.orgId, "bob", [h.workspaceId]);
      const overview = h.authority.organization.overview(bob.auth, h.orgId);
      expect(overview.isAdministrator).toBe(true);
      expect(overview.members).toContain(h.userId);

      expect(
        captureCode(() => h.authority.revokeMember(h.token, h.orgId, "bob")),
      ).toBe("FORBIDDEN");

      h.authority.revokeMember(bob.token, h.orgId, h.userId);
      const after = h.authority.organization.overview(bob.auth, h.orgId);
      expect(after.members).not.toContain(h.userId);
      expect(captureCode(() => h.authority.records(h.token, h.seedScope))).toBe(
        "TOKEN_INVALID",
      );
    } finally {
      h.cleanup();
    }
  });

  test("backup restore uses a fresh schema, requires reauthorization, keeps old receipts and rejects old-epoch bases", () => {
    const h = makeHarness();
    const destinationDir = mkdtempSync(
      join(tmpdir(), "folio-r11-resources-restore-"),
    );
    chmodSync(destinationDir, 0o700);
    let restored: SharedAuthority | null = null;
    let freshRecoveryKey = "";
    try {
      const created = createDatabase(h, "db-backup");
      const oldAttempt = created.attempt;
      const oldReceipt = created.receipt;
      const backup = h.authority.backup(h.token, h.orgId);
      expect(backup.format).toBe("folio-shared-runtime-backup/1");
      expect(backup.hash).toMatch(/^[a-f0-9]{64}$/);

      const newEpoch = "restore_epoch_1";
      const destination = new RuntimeStore(destinationDir);
      try {
        const result = h.authority.restoreInto(
          h.token,
          h.orgId,
          backup,
          destination,
          newEpoch,
        );
        freshRecoveryKey = result.recoveryKey;
        expect(result.oldCut).toEqual(backup.head);
        expect(result.newCut.epoch).toBe(newEpoch);
        expect(result.newCut.seq).toBe(0);
        expect(result.hash).toBe(backup.hash);
      } finally {
        destination.close();
      }

      restored = new SharedAuthority(destinationDir);
      expect(restored.head().epoch).toBe(newEpoch);
      expect(restored.head().seq).toBe(0);
      expect(captureCode(() => restored!.snapshot(h.token, h.seedScope))).toBe(
        "TOKEN_INVALID",
      );

      expect(() =>
        restored!.recover(h.orgId, h.recoveryKey, "old-key-device"),
      ).toThrow("RECOVERY_INVALID");
      const recovered = restored.recover(
        h.orgId,
        freshRecoveryKey,
        "device-recovered",
      );
      const newToken = recovered.token;
      const old = restored.receipt(newToken, oldAttempt);
      expect(old).not.toBeNull();
      expect(old!.status).toBe("SERVER_ACCEPTED");
      expect(old!.cut).toEqual(oldReceipt.cut);
      expect(old!.cut.epoch).toBe(backup.head.epoch);

      const view = restored.records(
        newToken,
        h.seedScope,
      ) as unknown as RecordsView;
      expect(view.databases.map((database) => database.id)).toContain(
        "db-backup",
      );
      const versionRow = restored.store.db
        .prepare("PRAGMA user_version")
        .get() as { user_version: number };
      expect(Number(versionRow.user_version)).toBe(SHARED_RUNTIME_VERSION);

      const auth = restored.session(newToken, h.orgId);
      const rollback: Attempt = {
        v: 1,
        attemptId: randomUUID(),
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId: auth.writerId,
          scope: h.seedScope,
          base: backup.head,
          command: {
            kind: "resource",
            action: "db.create",
            payload: {
              databaseId: "db-rollback",
              revision: 0,
              properties: PROPERTIES,
            } as Json,
          },
        },
        base: backup.head,
      };
      expect(captureCode(() => restored!.submit(newToken, rollback))).toBe(
        "STALE_EPOCH",
      );

      const base = restored.head();
      const accepted = restored.submit(newToken, {
        v: 1,
        attemptId: randomUUID(),
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId: auth.writerId,
          scope: h.seedScope,
          base,
          command: {
            kind: "resource",
            action: "db.create",
            payload: {
              databaseId: "db-post-restore",
              revision: 0,
              properties: PROPERTIES,
            } as Json,
          },
        },
        base,
      });
      expect(accepted.status).toBe("SERVER_ACCEPTED");
      expect(restored.head().epoch).toBe(newEpoch);
    } finally {
      if (restored !== null) restored.close();
      rmSync(destinationDir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});
