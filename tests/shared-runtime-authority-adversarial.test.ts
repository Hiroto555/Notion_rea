import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Doc } from "../src/shared/types";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import {
  CollaborationError,
  type Attempt,
  type AuthContext,
  type Cut,
  type DocumentState,
  type Json,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import {
  RuntimeStore,
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
} from "../src/collaboration/runtime/store";
import { assertPrivateApplicationId } from "../src/persistence/schema-startup";

const ORG = "org1";
const WORKSPACE = "workspace1";
const OWNER = "owner1";
const EDITOR = "editor1";

const opened: SharedAuthority[] = [];
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-authority-"));
  directories.push(directory);
  return directory;
}

function createAuthority(): { authority: SharedAuthority; directory: string } {
  const directory = tempDirectory();
  return { authority: openAuthority(directory), directory };
}

function openAuthority(directory: string): SharedAuthority {
  const authority = new SharedAuthority(directory);
  opened.push(authority);
  return authority;
}

function reopen(
  authority: SharedAuthority,
  directory: string,
): SharedAuthority {
  authority.close();
  return openAuthority(directory);
}

afterEach(() => {
  for (const authority of opened.splice(0).reverse()) {
    try {
      authority.close();
    } catch {}
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function text(value: string): Doc {
  return { type: "text", text: value };
}

function paragraph(id: string, value = ""): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    ...(value ? { content: [text(value)] } : {}),
  };
}

function seedDocument(value = "hello"): Doc {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [paragraph("p1", value)],
  };
}

function bootstrap(
  authority: SharedAuthority,
  overrides: Partial<{
    orgId: string;
    userId: string;
    deviceId: string;
    workspaceId: string;
    documentId: string;
    document: Doc;
  }> = {},
): { token: string; recoveryKey: string; auth: AuthContext; scope: Scope } {
  return authority.bootstrap({
    orgId: ORG,
    userId: OWNER,
    deviceId: "deviceA",
    workspaceId: WORKSPACE,
    documentId: "document1",
    document: seedDocument(),
    ...overrides,
  });
}

function addEditor(
  authority: SharedAuthority,
  ownerToken: string,
  scope: Scope,
  userId = EDITOR,
  deviceId = "deviceB",
): { token: string; auth: AuthContext } {
  const invite = authority.invite(ownerToken, scope.orgId, userId);
  const accepted = authority.acceptInvite(invite, deviceId);
  authority.grant(ownerToken, scope, userId, "editor");
  return accepted;
}

function textAttempt(
  authority: SharedAuthority,
  options: {
    writerId: string;
    scope: Scope;
    text?: string;
    before?: string;
    from?: number;
    to?: number;
    blockId?: string;
    base?: Cut;
    intentBase?: Cut;
    attemptId?: string;
    intentId?: string;
  },
): Attempt {
  const base = options.base ?? authority.head();
  const intentBase = options.intentBase ?? base;
  return {
    v: 1,
    attemptId: options.attemptId ?? randomUUID(),
    intent: {
      v: 1,
      intentId: options.intentId ?? randomUUID(),
      writerId: options.writerId,
      scope: options.scope,
      base: intentBase,
      command: {
        kind: "text",
        blockId: options.blockId ?? "p1",
        from: options.from ?? 0,
        to: options.to ?? 0,
        text: options.text ?? "X",
        before: options.before ?? "hello",
      },
    },
    base,
  };
}

function resourceAttempt(
  authority: SharedAuthority,
  options: {
    writerId: string;
    scope: Scope;
    action: string;
    payload: Json;
    base?: Cut;
    attemptId?: string;
    intentId?: string;
  },
): Attempt {
  const base = options.base ?? authority.head();
  return {
    v: 1,
    attemptId: options.attemptId ?? randomUUID(),
    intent: {
      v: 1,
      intentId: options.intentId ?? randomUUID(),
      writerId: options.writerId,
      scope: options.scope,
      base,
      command: {
        kind: "resource",
        action: options.action,
        payload: options.payload,
      },
    },
    base,
  };
}

function failureCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("EXPECTED_FAILURE");
}

function flattenText(node: Doc): string {
  return node.type === "text"
    ? (node.text ?? "")
    : (node.content ?? []).map(flattenText).join("");
}

function nodeText(node: Doc, id: string): string | undefined {
  if (node.attrs?.id === id) return flattenText(node);
  for (const child of node.content ?? []) {
    const found = nodeText(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function documentText(state: DocumentState, id = "p1"): string {
  return nodeText(state.document, id) ?? "";
}

function rawDatabase(
  directory: string,
  configure: (db: DatabaseSync) => void,
): void {
  const db = new DatabaseSync(join(directory, SHARED_RUNTIME_FILE));
  try {
    configure(db);
  } finally {
    db.close();
  }
}

describe("legal shared authority flow", () => {
  it("bootstraps, applies text, receipts and proofs, and survives reopen", () => {
    const { authority, directory } = createAuthority();
    const session = bootstrap(authority);
    expect(authority.head().seq).toBe(1);

    const initial = authority.snapshot(session.token, session.scope);
    expect(documentText(initial.state)).toBe("hello");
    expect(initial.events).toHaveLength(1);
    expect(initial.events[0]!.command).toMatchObject({
      kind: "resource",
      action: "document.create",
    });

    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "A",
    });
    const receipt = authority.submit(session.token, attempt);
    expect(receipt.status).toBe("SERVER_ACCEPTED");
    expect(receipt.attemptHash).toBe(digest(attempt));
    expect(receipt.intentHash).toBe(digest(attempt.intent));
    expect(receipt.cut.seq).toBe(2);

    const applied = authority.snapshot(session.token, session.scope);
    expect(documentText(applied.state)).toBe("Ahello");
    expect(applied.events).toHaveLength(2);
    expect(applied.events[1]!.attemptId).toBe(attempt.attemptId);
    expect(authority.receipt(session.token, attempt)).toEqual(receipt);
    expect(
      authority.proof(session.token, session.scope, receipt.cut.seq),
    ).toEqual(receipt.cut);

    const reopened = reopen(authority, directory);
    expect(reopened.receipt(session.token, attempt)).toEqual(receipt);
    expect(
      documentText(reopened.snapshot(session.token, session.scope).state),
    ).toBe("Ahello");
  });
});

describe("cross org, workspace, device and writer isolation", () => {
  it("refuses a scope from another organization", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: { ...session.scope, orgId: "otherOrg" },
    });
    expect(failureCode(() => authority.submit(session.token, attempt))).toBe(
      "AUTH_SCOPE_MISMATCH",
    );
    expect(authority.head().seq).toBe(1);
  });

  it("refuses a write in a workspace where the member has no role", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    authority.createWorkspace(session.token, ORG, "workspace2", "Second");
    const attempt = textAttempt(authority, {
      writerId: editor.auth.writerId,
      scope: { ...session.scope, workspaceId: "workspace2" },
    });
    expect(failureCode(() => authority.submit(editor.token, attempt))).toBe(
      "FORBIDDEN",
    );
  });

  it("binds an attempt to the authenticated device writer", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    const head = authority.head();

    const ownerWriter = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "owner",
    });
    expect(failureCode(() => authority.submit(editor.token, ownerWriter))).toBe(
      "WRITER_MISMATCH",
    );

    const editorWriter = textAttempt(authority, {
      writerId: editor.auth.writerId,
      scope: session.scope,
      text: "editor",
    });
    expect(
      failureCode(() => authority.submit(session.token, editorWriter)),
    ).toBe("WRITER_MISMATCH");
    expect(authority.head()).toEqual(head);
  });

  it("keeps a second device of the same user from reusing the first writer", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const invite = authority.invite(session.token, ORG, OWNER);
    const secondDevice = authority.acceptInvite(invite, "deviceA2");
    expect(secondDevice.auth.userId).toBe(session.auth.userId);
    expect(secondDevice.auth.writerId).not.toBe(session.auth.writerId);

    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "shared",
    });
    const receipt = authority.submit(session.token, attempt);
    expect(
      failureCode(() => authority.submit(secondDevice.token, attempt)),
    ).toBe("WRITER_MISMATCH");
    expect(authority.receipt(secondDevice.token, attempt)).toEqual(receipt);
  });

  it("refuses receipt access across users", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "private",
    });
    authority.submit(session.token, attempt);
    expect(failureCode(() => authority.receipt(editor.token, attempt))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("epoch, prefix and attempt reuse", () => {
  it("refuses a foreign epoch and an unknown or rolled-back prefix", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const head = authority.head();

    const stale = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      base: { ...head, epoch: "foreign-epoch" },
    });
    expect(failureCode(() => authority.submit(session.token, stale))).toBe(
      "STALE_EPOCH",
    );

    const forged = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      base: { ...head, hash: "0".repeat(64) },
    });
    expect(failureCode(() => authority.submit(session.token, forged))).toBe(
      "PREFIX_UNKNOWN_OR_ROLLBACK",
    );

    const future = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      base: { ...head, seq: head.seq + 1 },
    });
    expect(failureCode(() => authority.submit(session.token, future))).toBe(
      "PREFIX_UNKNOWN_OR_ROLLBACK",
    );

    expect(authority.head()).toEqual(head);
  });

  it("refuses attempt-id payload replacement and intent-id resurrection", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const attemptId = "attempt-fixed";
    const intentId = "intent-fixed";
    const first = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "R",
      attemptId,
      intentId,
    });
    const firstReceipt = authority.submit(session.token, first);
    expect(firstReceipt.status).toBe("SERVER_ACCEPTED");
    const headAfterFirst = authority.head();
    const stateAfterFirst = JSON.stringify(
      authority.snapshot(session.token, session.scope).state,
    );

    const replaced = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "S",
      attemptId,
      intentId,
    });
    const replacedJson = JSON.stringify(replaced);
    expect(failureCode(() => authority.submit(session.token, replaced))).toBe(
      "ID_REUSE",
    );
    expect(JSON.stringify(replaced)).toBe(replacedJson);

    const deduped = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "R",
      before: "hello",
      base: first.intent.base,
      attemptId: "attempt-second",
      intentId,
    });
    expect(authority.submit(session.token, deduped)).toEqual(firstReceipt);
    expect(authority.head()).toEqual(headAfterFirst);
    expect(
      JSON.stringify(authority.snapshot(session.token, session.scope).state),
    ).toBe(stateAfterFirst);

    const changedIntent = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "T",
      base: first.intent.base,
      attemptId: "attempt-third",
      intentId,
    });
    expect(
      failureCode(() => authority.submit(session.token, changedIntent)),
    ).toBe("ID_REUSE");
    expect(authority.head()).toEqual(headAfterFirst);
  });
});

describe("acknowledgement loss and commit boundaries", () => {
  it("keeps a committed attempt recoverable when the acknowledgement is lost", () => {
    const { authority, directory } = createAuthority();
    const session = bootstrap(authority);
    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "K",
    });
    const beforeSeq = authority.head().seq;

    let failure: unknown;
    try {
      authority.submit(session.token, attempt, {
        afterCommit: () => {
          throw new Error("ACK_LOST");
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("UNKNOWN");
    expect(authority.store.db.isTransaction).toBe(false);
    expect(authority.head().seq).toBe(beforeSeq + 1);

    const recovered = authority.receipt(session.token, attempt);
    expect(recovered?.status).toBe("SERVER_ACCEPTED");
    expect(recovered?.cut.seq).toBe(beforeSeq + 1);

    const reopened = reopen(authority, directory);
    expect(reopened.receipt(session.token, attempt)).toEqual(recovered);
    const reopenedHead = reopened.head();
    expect(reopened.submit(session.token, attempt)).toEqual(recovered);
    expect(reopened.head()).toEqual(reopenedHead);
  });

  it("closes an unsubmitted attempt exactly once without applying it", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "I",
    });
    const beforeSeq = authority.head().seq;
    const invalidated = authority.invalidate(session.token, attempt);
    expect(invalidated.status).toBe("INVALIDATED");
    expect(invalidated.code).toBe("ATTEMPT_CLOSED");
    expect(invalidated.cut.seq).toBe(beforeSeq + 1);
    expect(
      documentText(authority.snapshot(session.token, session.scope).state),
    ).toBe("hello");

    const head = authority.head();
    expect(authority.invalidate(session.token, attempt)).toEqual(invalidated);
    expect(authority.submit(session.token, attempt)).toEqual(invalidated);
    expect(authority.head()).toEqual(head);
  });

  it("rolls back every write when beforeCommit fails", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const beforeSeq = authority.head().seq;
    const beforeState = JSON.stringify(
      authority.snapshot(session.token, session.scope).state,
    );
    const attempt = textAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      text: "B",
    });

    expect(
      failureCode(() =>
        authority.submit(session.token, attempt, {
          beforeCommit: () => {
            throw new Error("BEFORE_COMMIT");
          },
        }),
      ),
    ).toBe("BEFORE_COMMIT");
    expect(authority.head().seq).toBe(beforeSeq);
    expect(authority.receipt(session.token, attempt)).toBeNull();
    expect(
      JSON.stringify(authority.snapshot(session.token, session.scope).state),
    ).toBe(beforeState);

    const accepted = authority.submit(session.token, attempt);
    expect(accepted.status).toBe("SERVER_ACCEPTED");
    expect(
      documentText(authority.snapshot(session.token, session.scope).state),
    ).toBe("Bhello");
  });
});

describe("current revocation", () => {
  it("blocks submit, receipt, proof, snapshot, listing and projection after member revocation", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    const attempt = textAttempt(authority, {
      writerId: editor.auth.writerId,
      scope: session.scope,
      text: "E",
    });
    const receipt = authority.submit(editor.token, attempt);
    expect(receipt.status).toBe("SERVER_ACCEPTED");
    const projection = authority.projection(editor.token);

    authority.revokeMember(session.token, ORG, EDITOR);

    const next = textAttempt(authority, {
      writerId: editor.auth.writerId,
      scope: session.scope,
      text: "F",
      before: "Ehello",
    });
    expect(failureCode(() => authority.submit(editor.token, next))).toBe(
      "TOKEN_INVALID",
    );
    expect(failureCode(() => authority.receipt(editor.token, attempt))).toBe(
      "TOKEN_INVALID",
    );
    expect(
      failureCode(() => authority.proof(editor.token, session.scope, 0)),
    ).toBe("TOKEN_INVALID");
    expect(
      failureCode(() => authority.snapshot(editor.token, session.scope)),
    ).toBe("TOKEN_INVALID");
    expect(failureCode(() => authority.workspaces(editor.token, ORG))).toBe(
      "TOKEN_INVALID",
    );
    expect(failureCode(() => projection.exportDocument(session.scope))).toBe(
      "TOKEN_INVALID",
    );
  });

  it("invalidates a revoked device token", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    authority.identity.revokeDevice(session.token, editor.auth.deviceId);

    expect(
      failureCode(() => authority.proof(editor.token, session.scope, 0)),
    ).toBe("TOKEN_INVALID");
    expect(
      failureCode(() =>
        authority.submit(
          editor.token,
          textAttempt(authority, {
            writerId: editor.auth.writerId,
            scope: session.scope,
            text: "revoked",
          }),
        ),
      ),
    ).toBe("TOKEN_INVALID");
    expect(authority.proof(session.token, session.scope, 0)).not.toBeNull();
  });

  it("rechecks asset authorization after member revocation", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    const bytes = new TextEncoder().encode("asset-bytes");
    const staged = authority.stageAsset(
      editor.token,
      session.scope,
      "upload1",
      bytes,
    );
    const receipt = authority.submit(
      editor.token,
      resourceAttempt(authority, {
        writerId: editor.auth.writerId,
        scope: session.scope,
        action: "asset.publish",
        payload: { uploadId: "upload1", hash: staged.hash },
      }),
    );
    expect(receipt.status).toBe("SERVER_ACCEPTED");
    expect(
      authority.readAsset(editor.token, session.scope, staged.hash),
    ).toEqual(bytes);
    authority.revokeMember(session.token, ORG, EDITOR);
    expect(() =>
      authority.readAsset(editor.token, session.scope, staged.hash),
    ).toThrow();
    expect(() =>
      authority.stageAsset(editor.token, session.scope, "upload2", bytes),
    ).toThrow();
    expect(
      authority.readAsset(session.token, session.scope, staged.hash),
    ).toEqual(bytes);
  });
});

describe("document lifecycle", () => {
  it("trashes, rejects writes, restores into a fresh incarnation and keeps history", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const trash = resourceAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      action: "document.trash",
      payload: null,
    });
    expect(authority.submit(session.token, trash).status).toBe(
      "SERVER_ACCEPTED",
    );
    expect(
      failureCode(() => authority.snapshot(session.token, session.scope)),
    ).toBe("DOCUMENT_DELETED");

    const rejected = authority.submit(
      session.token,
      textAttempt(authority, {
        writerId: session.auth.writerId,
        scope: session.scope,
        text: "late",
      }),
    );
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.code).toBe("DOCUMENT_DELETED");

    const restore = resourceAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      action: "document.restore",
      payload: { incarnationId: "incarnation2" },
    });
    expect(authority.submit(session.token, restore).status).toBe(
      "SERVER_ACCEPTED",
    );

    const restoredScope = { ...session.scope, incarnationId: "incarnation2" };
    expect(
      documentText(authority.snapshot(session.token, restoredScope).state),
    ).toBe("hello");
    expect(
      failureCode(() => authority.snapshot(session.token, session.scope)),
    ).toBe("SCOPE_NOT_ACTIVE");
    expect(authority.lifecycle.history(session.scope).length).toBeGreaterThan(
      0,
    );
  });

  it("survives reopen between trash and restore", () => {
    const { authority, directory } = createAuthority();
    const session = bootstrap(authority);
    authority.submit(
      session.token,
      resourceAttempt(authority, {
        writerId: session.auth.writerId,
        scope: session.scope,
        action: "document.trash",
        payload: null,
      }),
    );
    const reopened = reopen(authority, directory);
    expect(
      failureCode(() => reopened.snapshot(session.token, session.scope)),
    ).toBe("DOCUMENT_DELETED");
    reopened.submit(
      session.token,
      resourceAttempt(reopened, {
        writerId: session.auth.writerId,
        scope: session.scope,
        action: "document.restore",
        payload: { incarnationId: "incarnation-reopen" },
      }),
    );
    const restoredScope = {
      ...session.scope,
      incarnationId: "incarnation-reopen",
    };
    expect(
      documentText(reopened.snapshot(session.token, restoredScope).state),
    ).toBe("hello");
  });

  it("refuses restoring a document that was never deleted", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const restore = resourceAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      action: "document.restore",
      payload: { incarnationId: "never-deleted" },
    });
    const receipt = authority.submit(session.token, restore);
    expect(receipt.status).toBe("REJECTED");
    expect(receipt.code).toBe("NOT_DELETED");
  });

  it("resource commands respect the active lifecycle", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    authority.submit(
      session.token,
      resourceAttempt(authority, {
        writerId: session.auth.writerId,
        scope: session.scope,
        action: "document.trash",
        payload: null,
      }),
    );
    expect(
      failureCode(() => authority.snapshot(session.token, session.scope)),
    ).toBe("DOCUMENT_DELETED");

    const createDatabase = resourceAttempt(authority, {
      writerId: session.auth.writerId,
      scope: session.scope,
      action: "db.create",
      payload: { databaseId: "db-after-trash", revision: 0, properties: [] },
    });
    const receipt = authority.submit(session.token, createDatabase);
    expect(receipt.status).toBe("REJECTED");
    expect(receipt.code).toBe("DOCUMENT_DELETED");
    expect(() => authority.records(session.token, session.scope)).toThrow();
    expect(authority.store.all("databases")).toHaveLength(0);
  });

  it("document.create refuses incarnation takeover of an existing logical document", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const hijackedScope = {
      ...session.scope,
      incarnationId: "incarnation-hijack",
    };
    const receipt = authority.createDocument(
      session.token,
      hijackedScope,
      seedDocument("hijacked"),
      "Hijacked",
    );
    expect(receipt.status).toBe("REJECTED");
    expect(receipt.code).toBe("DOCUMENT_EXISTS");
    expect(
      documentText(authority.snapshot(session.token, session.scope).state),
    ).toBe("hello");
    expect(() => authority.snapshot(session.token, hijackedScope)).toThrow();
  });
});

describe("projection integration", () => {
  it("projection reads authoritative shared documents", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const projection = authority.projection(session.token);
    expect(
      documentText(authority.snapshot(session.token, session.scope).state),
    ).toBe("hello");
    expect(projection.search(ORG, WORKSPACE, "hello")).toHaveLength(1);
    expect(projection.backlinks(session.scope)).toEqual([]);
    expect(projection.exportDocument(session.scope).state).toEqual(
      authority.snapshot(session.token, session.scope).state,
    );
  });
});

describe("backup and restore", () => {
  it("refuses a backup export by a non-administrator", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    const editor = addEditor(authority, session.token, session.scope);
    expect(failureCode(() => authority.backup(editor.token, ORG))).toBe(
      "FORBIDDEN",
    );
  });

  it("refuses tampered backups and stale epochs and requires an empty destination", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    authority.submit(
      session.token,
      textAttempt(authority, {
        writerId: session.auth.writerId,
        scope: session.scope,
        text: "backup",
      }),
    );
    const backup = authority.backup(session.token, ORG);
    expect(backup.format).toBe("folio-shared-runtime-backup/1");
    expect(backup.hash).toMatch(/^[a-f0-9]{64}$/);

    const tampered = JSON.parse(JSON.stringify(backup)) as typeof backup;
    tampered.records[0]!.value = { tampered: true };
    const tamperedDestination = new RuntimeStore(tempDirectory());
    try {
      expect(
        failureCode(() =>
          authority.restoreInto(
            session.token,
            ORG,
            tampered,
            tamperedDestination,
            "epoch-tampered",
          ),
        ),
      ).toBe("BACKUP_HASH_MISMATCH");
    } finally {
      tamperedDestination.close();
    }

    const staleDestination = new RuntimeStore(tempDirectory());
    try {
      expect(
        failureCode(() =>
          authority.restoreInto(
            session.token,
            ORG,
            backup,
            staleDestination,
            backup.head.epoch,
          ),
        ),
      ).toBe("EPOCH_NOT_FRESH");
    } finally {
      staleDestination.close();
    }

    const busyDestination = new RuntimeStore(tempDirectory());
    try {
      authority.restoreInto(
        session.token,
        ORG,
        backup,
        busyDestination,
        "epoch-first",
      );
      expect(
        failureCode(() =>
          authority.restoreInto(
            session.token,
            ORG,
            backup,
            busyDestination,
            "epoch-second",
          ),
        ),
      ).toBe("DESTINATION_NOT_EMPTY");
    } finally {
      busyDestination.close();
    }
  });

  it("restored authority reopens with new epoch and old sessions revoked", () => {
    const { authority } = createAuthority();
    const session = bootstrap(authority);
    authority.submit(
      session.token,
      textAttempt(authority, {
        writerId: session.auth.writerId,
        scope: session.scope,
        text: "restore",
      }),
    );
    const backup = authority.backup(session.token, ORG);
    const destinationDirectory = tempDirectory();
    const destination = new RuntimeStore(destinationDirectory);
    let result: ReturnType<SharedAuthority["restoreInto"]>;
    try {
      result = authority.restoreInto(
        session.token,
        ORG,
        backup,
        destination,
        "epoch-restored",
      );
      expect(result.oldCut).toEqual(backup.head);
      expect(result.newCut.epoch).toBe("epoch-restored");
      expect(result.newCut.seq).toBe(0);
      expect(destination.get("meta", "head")).toEqual(result.newCut);
      expect(
        destination.get("authority.prefix", result.newCut.epoch + ":0"),
      ).toEqual(result.newCut);
      const sessionRecord = destination.get(
        "identity.sessions",
        digest(session.token),
      ) as { status: string };
      expect(sessionRecord.status).toBe("revoked");
    } finally {
      destination.close();
    }

    const restored = new SharedAuthority(destinationDirectory);
    try {
      expect(restored.head().epoch).toBe("epoch-restored");
      expect(() => restored.snapshot(session.token, session.scope)).toThrow();
    } finally {
      restored.close();
    }
  });
});

describe("shared and private physical format isolation", () => {
  it("refuses a private-format SQLite file", () => {
    const directory = tempDirectory();
    rawDatabase(directory, (db) => {
      db.exec(
        "PRAGMA application_id=0; PRAGMA user_version=5; CREATE TABLE pages(id TEXT)",
      );
    });
    expect(
      failureCode(() => {
        const store = new RuntimeStore(directory);
        store.close();
      }),
    ).toBe("NOT_SHARED_RUNTIME_FORMAT");
  });

  it("refuses a shared application id with the wrong runtime version", () => {
    const directory = tempDirectory();
    rawDatabase(directory, (db) => {
      db.exec(
        `PRAGMA application_id=${SHARED_RUNTIME_APPLICATION_ID}; PRAGMA user_version=${SHARED_RUNTIME_VERSION - 1}; CREATE TABLE runtime_records(x TEXT); CREATE TABLE runtime_blobs(x TEXT)`,
      );
    });
    expect(
      failureCode(() => {
        const store = new RuntimeStore(directory);
        store.close();
      }),
    ).toBe("NOT_SHARED_RUNTIME_FORMAT");
  });

  it("refuses a shared header with an unexpected schema", () => {
    const directory = tempDirectory();
    rawDatabase(directory, (db) => {
      db.exec(
        `PRAGMA application_id=${SHARED_RUNTIME_APPLICATION_ID}; PRAGMA user_version=${SHARED_RUNTIME_VERSION}; CREATE TABLE runtime_records(x TEXT); CREATE TABLE runtime_blobs(x TEXT)`,
      );
    });
    expect(
      failureCode(() => {
        const store = new RuntimeStore(directory);
        store.close();
      }),
    ).toBe("CORRUPT_SHARED_RUNTIME_SCHEMA");
  });

  it("is refused by the private workspace application-id guard", () => {
    const { authority, directory } = createAuthority();
    bootstrap(authority);
    authority.close();
    const db = new DatabaseSync(join(directory, SHARED_RUNTIME_FILE), {
      readOnly: true,
    });
    try {
      expect(() => assertPrivateApplicationId(db)).toThrow(
        /Foreign application id/,
      );
    } finally {
      db.close();
    }
  });
});
