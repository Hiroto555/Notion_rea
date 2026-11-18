import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import { SharedResourceClient } from "../src/collaboration/runtime/resource-client";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import {
  handleSharedBackupRequest,
  BACKUP_HASH_HEADER,
} from "../src/collaboration/runtime/backup-http";
import {
  BACKUP_FORMAT,
  restoreBackup,
  validateRuntimeBackup,
} from "../src/collaboration/runtime/backup";
import {
  assertRuntimeGenesis,
  assertRuntimeStateRoot,
  authorityStateRoot,
  createRuntimeGenesis,
} from "../src/collaboration/runtime/state-root";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { CredentialProvider } from "../src/platform/credential-provider";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  CollaborationError,
  scopeKey,
  type Attempt,
  type AuthContext,
  type Command,
  type Cut,
  type Json,
  type ResourceCommand,
  type Scope,
  type TextCommand,
} from "../src/collaboration/runtime/contract";
import type { SharedProvider } from "../src/collaboration/runtime/provider-port";
import { textOf, type Doc } from "../src/shared/types";

const PROPERTIES: Json = [
  {
    id: "status",
    name: "Status",
    type: "select",
    options: ["todo", "doing", "done"],
  },
];

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    ...(text.length > 0 ? { content: [{ type: "text", text }] } : {}),
  };
}

function documentWith(id: string, text: string): Doc {
  return { type: "doc", content: [paragraph(id, text)] };
}

function tableDocument(): Doc {
  return {
    type: "doc",
    content: [
      paragraph("p1", "before"),
      {
        type: "table",
        attrs: { id: "t1" },
        content: [
          {
            type: "tableRow",
            attrs: { id: "r1" },
            content: [
              {
                type: "tableHeader",
                attrs: { id: "c11" },
                content: [paragraph("cp11", "H")],
              },
            ],
          },
          {
            type: "tableRow",
            attrs: { id: "r2" },
            content: [
              {
                type: "tableCell",
                attrs: { id: "c21" },
                content: [paragraph("cp21", "A")],
              },
            ],
          },
        ],
      },
    ],
  };
}

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    throw error;
  }
  throw new Error("EXPECTED_REFUSAL");
}

function expectCode(work: () => unknown, code: string): void {
  expect(codeOf(work)).toBe(code);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawHttp(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method,
        headers:
          body === undefined
            ? headers
            : { ...headers, "content-length": String(Buffer.byteLength(body)) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

type Fixture = {
  dir: string;
  authority: SharedAuthority;
  orgId: string;
  userId: string;
  workspaceId: string;
  token: string;
  recoveryKey: string;
  auth: AuthContext;
  scope: Scope;
  cleanup(): void;
};

function makeHarness(document = documentWith("p1", "Hello")): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "folio-final-review-"));
  const authority = new SharedAuthority(dir);
  const orgId = "org1";
  const userId = "alice";
  const workspaceId = "ws1";
  const boot = authority.bootstrap({
    orgId,
    userId,
    deviceId: "device-alice",
    workspaceId,
    documentId: "doc1",
    document,
  });
  return {
    dir,
    authority,
    orgId,
    userId,
    workspaceId,
    token: boot.token,
    recoveryKey: boot.recoveryKey,
    auth: boot.auth,
    scope: boot.scope,
    cleanup() {
      authority.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type HttpFixture = Fixture & {
  server: SharedHttpServer;
  url: string;
  cleanupAll(): Promise<void>;
};

async function makeHttpFixture(document?: Doc): Promise<HttpFixture> {
  const base = makeHarness(document);
  const server = createSharedHttpServer(base.authority);
  const { url } = await server.listen();
  return {
    ...base,
    server,
    url,
    async cleanupAll() {
      await server.close();
      base.cleanup();
    },
  };
}

function submitCommand(
  authority: SharedAuthority,
  token: string,
  scope: Scope,
  command: Command,
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
      command,
    },
    base,
  };
  return { attempt, receipt: authority.submit(token, attempt) };
}

function textCommand(
  text: string,
  before: string,
  from = before.length,
): TextCommand {
  return { kind: "text", blockId: "p1", from, to: from, text, before };
}

class FaultProvider implements SharedProvider {
  submits = 0;
  receipts = 0;
  private mode: "before" | "after-once" | "done";

  constructor(
    private readonly inner: HttpSharedProvider,
    mode: "before" | "after-once",
  ) {
    this.mode = mode;
  }

  async snapshot(scope: Scope, after?: number) {
    return this.inner.snapshot(scope, after);
  }

  async submit(attempt: Attempt) {
    this.submits++;
    if (this.mode === "before") throw new CollaborationError("LOST_RESPONSE");
    const receipt = await this.inner.submit(attempt);
    if (this.mode === "after-once") {
      this.mode = "done";
      throw new CollaborationError("LOST_RESPONSE");
    }
    return receipt;
  }

  async receipt(attempt: Attempt) {
    this.receipts++;
    return this.inner.receipt(attempt);
  }

  async invalidate(attempt: Attempt) {
    return this.inner.invalidate(attempt);
  }

  async proof(scope: Scope, seq: number) {
    return this.inner.proof(scope, seq);
  }

  async workspaces(orgId: string) {
    return this.inner.workspaces(orgId);
  }

  close(): void {
    this.inner.close();
  }
}

class FakeAsyncSafeStorage {
  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true;
  }

  async encryptStringAsync(text: string): Promise<Uint8Array> {
    const input = new TextEncoder().encode(text);
    const output = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index++)
      output[index] = input[index] ^ 0x5a;
    return output;
  }

  async decryptStringAsync(bytes: Uint8Array): Promise<string> {
    const output = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index++)
      output[index] = bytes[index] ^ 0x5a;
    return new TextDecoder().decode(output);
  }

  getSelectedStorageBackend(): string {
    return "keychain";
  }
}

type RelayDelays = Partial<Record<string, number>>;

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    request.on("end", () =>
      resolve(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
    request.on("error", reject);
  });
}

async function startRelay(
  authority: SharedAuthority,
  delays: RelayDelays = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const match = /^\/v1\/([a-z]+)$/.exec(url.pathname);
        if (!match) throw new CollaborationError("NOT_FOUND");
        const operation = match[1];
        const header = request.headers.authorization;
        if (typeof header !== "string")
          throw new CollaborationError("TOKEN_INVALID");
        const bearer = /^Bearer ([^\s]+)$/.exec(header);
        if (!bearer) throw new CollaborationError("TOKEN_INVALID");
        const token = bearer[1];
        const body = JSON.parse(await readRequest(request)) as Record<
          string,
          unknown
        >;
        const delay = delays[operation] ?? 0;
        if (delay > 0) await wait(delay);
        let result: unknown;
        switch (operation) {
          case "session":
            result = authority.session(token, String(body.orgId));
            break;
          case "workspaces":
            result = authority.workspaces(token, String(body.orgId));
            break;
          case "snapshot":
            result = authority.snapshot(
              token,
              body.scope as Scope,
              typeof body.after === "number" ? body.after : undefined,
            );
            break;
          case "submit":
            result = authority.submit(token, body.attempt as Attempt);
            break;
          case "receipt":
            result = authority.receipt(token, body.attempt as Attempt);
            break;
          case "invalidate":
            result = authority.invalidate(token, body.attempt as Attempt);
            break;
          case "proof":
            result = authority.proof(
              token,
              body.scope as Scope,
              Number(body.seq),
            );
            break;
          case "join":
            result = authority.join(
              token,
              String(body.orgId),
              String(body.deviceId),
            );
            break;
          case "admin":
            result = authority.admin(token, body.command);
            break;
          default:
            throw new CollaborationError("NOT_FOUND");
        }
        const text = canonical({ v: 1, ok: true, result });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
      } catch (error) {
        const code =
          error instanceof CollaborationError &&
          /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)
            ? error.code
            : "INTERNAL_ERROR";
        const text = canonical({ v: 1, ok: false, error: code });
        if (!response.headersSent)
          response.writeHead(400, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(text)),
          });
        response.end(text);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("INVALID_RELAY_ADDRESS");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-final-review-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("organization backup authorization", () => {
  it("allows the ordinary owner and denies an organization owner who lacks read on one workspace", () => {
    const h = makeHarness();
    try {
      expect(h.authority.backup(h.token, h.orgId).format).toBe(BACKUP_FORMAT);
      h.authority.createWorkspace(h.token, h.orgId, "ws3", "Third");
      const invite = h.authority.invite(h.token, h.orgId, "bob");
      const bob = h.authority.acceptInvite(invite, "device-bob");
      h.authority.grant(h.token, h.scope, "bob", "owner");
      h.authority.handoff(h.token, h.orgId, "bob", [h.workspaceId]);

      const bobAuth = h.authority.session(bob.token, h.orgId);
      expect(
        h.authority.organization.overview(bobAuth, h.orgId).isAdministrator,
      ).toBe(true);
      expectCode(() => h.authority.backup(bob.token, h.orgId), "FORBIDDEN");

      const ws3Scope: Scope = {
        orgId: h.orgId,
        workspaceId: "ws3",
        documentId: "doc3",
        incarnationId: "inc3",
      };
      h.authority.grant(h.token, ws3Scope, "bob", "owner");
      expect(h.authority.backup(bob.token, h.orgId).format).toBe(BACKUP_FORMAT);
    } finally {
      h.cleanup();
    }
  });
});

describe("retention facade revocation", () => {
  it("rejects a facade created before the device was revoked", () => {
    const h = makeHarness();
    const destination = new RuntimeStore(tempDirectory());
    try {
      const cut = h.authority.head();
      const facade = h.authority.retention(h.token, h.orgId);
      expect(facade.inspect().eventRows).toBeGreaterThan(0);

      const invite = h.authority.invite(h.token, h.orgId, h.userId);
      const joined = h.authority.join(invite, h.orgId, "device-new");
      h.authority.revokeDevice(joined.token, h.orgId, h.auth.deviceId);

      expectCode(() => facade.inspect(), "TOKEN_INVALID");
      expectCode(
        () => facade.verifyBackup(cut, destination, "epoch_late"),
        "TOKEN_INVALID",
      );
      expect(
        h.authority.retention(joined.token, h.orgId).inspect().eventRows,
      ).toBeGreaterThan(0);
    } finally {
      destination.close();
      h.cleanup();
    }
  });
});

describe("UNKNOWN pending attempts block both write clients", () => {
  it("keeps the main client UNKNOWN and refuses the next submit without resending", async () => {
    const f = await makeHttpFixture();
    const client = new SharedRuntimeClient(
      join(f.dir, "client-main"),
      new FaultProvider(new HttpSharedProvider(f.url, f.token), "after-once"),
      f.scope,
      f.auth.writerId,
    );
    try {
      await client.open();
      const before = f.authority.head();
      await expect(
        client.submit(textCommand("?", "Hello")),
      ).rejects.toMatchObject({
        code: "LOST_RESPONSE",
      });
      expect(client.entries()[0].state).toBe("UNKNOWN");
      await expect(
        client.submit(textCommand("!", "Hello")),
      ).rejects.toMatchObject({
        code: "PENDING_INTENT_BLOCKS_WRITE",
      });
      expect(f.authority.head().seq).toBe(before.seq + 1);
      expect(client.canWrite()).toBe(false);
    } finally {
      client.close();
      await f.cleanupAll();
    }
  });

  it("keeps the resource client UNKNOWN and refuses the next resource write", async () => {
    const f = await makeHttpFixture();
    const client = new SharedResourceClient(
      join(f.dir, "client-resource"),
      new FaultProvider(new HttpSharedProvider(f.url, f.token), "after-once"),
      f.auth.writerId,
    );
    try {
      const before = f.authority.head();
      const first: ResourceCommand = {
        kind: "resource",
        action: "db.create",
        payload: {
          databaseId: "db-first",
          revision: 0,
          properties: PROPERTIES,
        },
      };
      await expect(
        client.execute(f.scope, first, before),
      ).rejects.toMatchObject({ code: "LOST_RESPONSE" });
      expect(client.entries()[0].state).toBe("UNKNOWN");
      expect(client.hasPending()).toBe(true);

      const second: ResourceCommand = {
        kind: "resource",
        action: "db.create",
        payload: {
          databaseId: "db-second",
          revision: 0,
          properties: PROPERTIES,
        },
      };
      await expect(
        client.execute(f.scope, second, f.authority.head()),
      ).rejects.toMatchObject({ code: "PENDING_INTENT_BLOCKS_WRITE" });
      expect(f.authority.head().seq).toBe(before.seq + 1);
    } finally {
      client.close();
      await f.cleanupAll();
    }
  });
});

describe("authorized backup restore and recovery reset", () => {
  it("restores into a fresh epoch, invalidates old tokens, and binds a new operator with a fresh key", () => {
    const h = makeHarness();
    const destinationDirectory = tempDirectory();
    let restored: SharedAuthority | null = null;
    try {
      const backup = h.authority.backup(h.token, h.orgId);
      expect(backup.format).toBe(BACKUP_FORMAT);
      expect(validateRuntimeBackup(backup).hash).toBe(backup.hash);
      const rawBackup = canonical(backup);
      expect(rawBackup).not.toContain(h.token);
      expect(rawBackup).not.toContain(h.recoveryKey);

      const result = (() => {
        const destination = new RuntimeStore(destinationDirectory);
        try {
          return h.authority.restoreInto(
            h.token,
            h.orgId,
            backup,
            destination,
            "epoch_restored",
          );
        } finally {
          destination.close();
        }
      })();
      expect(result.requiresReauthorization).toBe(true);
      expect(result.bootstrapOwner).toBe(h.userId);
      expect(result.newCut.epoch).toBe("epoch_restored");
      expect(result.recoveryKey).not.toBe(h.recoveryKey);

      const restoredAuthority = new SharedAuthority(destinationDirectory);
      restored = restoredAuthority;
      expect(restoredAuthority.head().epoch).toBe("epoch_restored");
      expectCode(
        () => restoredAuthority.snapshot(h.token, h.scope),
        "TOKEN_INVALID",
      );
      expectCode(
        () =>
          restoredAuthority.recover(h.orgId, h.recoveryKey, "device-old-key"),
        "RECOVERY_INVALID",
      );

      const recovered = restoredAuthority.recover(
        h.orgId,
        result.recoveryKey,
        "device-new-key",
      );
      expect(recovered.recoveryKey).not.toBe(result.recoveryKey);
      expect(
        textOf(
          restoredAuthority.snapshot(recovered.token, h.scope).state.document,
        ),
      ).toBe("Hello");
      expect(
        restoredAuthority.organization.overview(recovered.auth, h.orgId)
          .isAdministrator,
      ).toBe(true);
      expect(
        restoredAuthority.recoveryStatus(recovered.token, h.orgId).configured,
      ).toBe(true);
      const recoveredText = JSON.stringify(recovered);
      expect(recoveredText).not.toContain(h.token);
      expect(recoveredText).not.toContain(h.recoveryKey);
    } finally {
      restored?.close();
      h.cleanup();
    }
  });

  it("rejects malformed backups, stale epochs, and non-empty destinations without mutation", () => {
    const h = makeHarness();
    const occupied = new RuntimeStore(tempDirectory());
    const empty = new RuntimeStore(tempDirectory());
    try {
      const backup = h.authority.backup(h.token, h.orgId);
      expectCode(
        () => validateRuntimeBackup({ ...backup, extra: 1 }),
        "INVALID_BACKUP",
      );
      expectCode(
        () => validateRuntimeBackup({ ...backup, hash: "0".repeat(64) }),
        "BACKUP_HASH_MISMATCH",
      );
      const record = backup.records[0];
      expect(record).toBeDefined();
      expectCode(
        () => validateRuntimeBackup({ ...backup, records: [record, record] }),
        "DUPLICATE_RECORD",
      );

      occupied.transaction(() => occupied.set("meta", "role", "occupied"));
      expectCode(
        () => restoreBackup(backup, occupied, "epoch_occupied"),
        "DESTINATION_NOT_EMPTY",
      );
      expect(occupied.get("meta", "role")).toBe("occupied");

      expectCode(
        () => restoreBackup(backup, empty, backup.head.epoch),
        "EPOCH_NOT_FRESH",
      );
      expect(empty.get("meta", "head")).toBeNull();
    } finally {
      occupied.close();
      empty.close();
      h.cleanup();
    }
  });
});

describe("backup HTTP endpoint", () => {
  it("returns only canonical POST backups and rejects transport, auth, and body abuse", async () => {
    const h = makeHarness();
    const server = createServer((request, response) => {
      void handleSharedBackupRequest(
        {
          backup: (token, orgId) => h.authority.backup(token, orgId),
        },
        request,
        response,
        { token: null },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("INVALID_BACKUP_SERVER_ADDRESS");
    const url = `http://127.0.0.1:${address.port}/v1/backup`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      rawHttp(
        url,
        "POST",
        {
          authorization: `Bearer ${h.token}`,
          "content-type": "application/json",
          ...headers,
        },
        canonical(body),
      );

    try {
      const ok = await post({ orgId: h.orgId });
      expect(ok.status).toBe(200);
      const backup = JSON.parse(ok.body) as { format: string; hash: string };
      expect(backup.format).toBe(BACKUP_FORMAT);
      const hashHeader = ok.headers[BACKUP_HASH_HEADER];
      expect(Array.isArray(hashHeader) ? hashHeader[0] : hashHeader).toBe(
        backup.hash,
      );

      expect((await rawHttp(url, "GET", {})).status).toBe(405);
      expect(
        (await post({ orgId: h.orgId }, { "content-type": "text/plain" }))
          .status,
      ).toBe(415);
      expect(
        (await post({ orgId: h.orgId }, { origin: "https://evil.example" }))
          .status,
      ).toBe(403);
      expect((await post({ orgId: h.orgId }, { cookie: "a=b" })).status).toBe(
        400,
      );
      expect((await post({ orgId: h.orgId, extra: true })).status).toBe(400);

      const queried = await rawHttp(
        `${url}?x=1`,
        "POST",
        {
          authorization: `Bearer ${h.token}`,
          "content-type": "application/json",
        },
        JSON.stringify({ orgId: h.orgId }),
      );
      expect(queried.status).toBe(400);

      const badToken = await post(
        { orgId: h.orgId },
        { authorization: "Bearer not-a-real-token" },
      );
      expect(badToken.status).toBe(401);
      expect(badToken.body).not.toContain("not-a-real-token");

      const invite = h.authority.invite(h.token, h.orgId, "bob");
      const bob = h.authority.acceptInvite(invite, "device-bob");
      const forbidden = await post(
        { orgId: h.orgId },
        { authorization: `Bearer ${bob.token}` },
      );
      expect(forbidden.status).toBe(403);
    } finally {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
      h.cleanup();
    }
  });
});

describe("undo witness authorization", () => {
  it("requires the original writer, an unmodified sealed template, and a single use", () => {
    const h = makeHarness(tableDocument());
    try {
      const invite = h.authority.invite(h.token, h.orgId, "bob");
      const bob = h.authority.acceptInvite(invite, "device-bob");
      h.authority.grant(h.token, h.scope, "bob", "editor");

      const beforeDelete = h.authority.snapshot(h.token, h.scope);
      const tableBefore = beforeDelete.state.document.content!.find(
        (node) => node.type === "table",
      )!;
      const sourceRow = tableBefore.content!.find(
        (row) => row.attrs?.id === "r2",
      )!;
      const metadataBefore = beforeDelete.state.tables.find(
        (table) => table.tableId === "t1",
      )!;
      const deleted = submitCommand(h.authority, h.token, h.scope, {
        kind: "table.row.delete",
        tableId: "t1",
        rowId: "r2",
      });
      expect(deleted.receipt.status).toBe("SERVER_ACCEPTED");
      const afterDelete = h.authority.snapshot(h.token, h.scope);
      expect(
        afterDelete.state.tables.find((table) => table.tableId === "t1")
          ?.rowIds,
      ).toEqual(["r1"]);
      const restore = {
        kind: "table.row.restore" as const,
        tableId: "t1",
        undoOf: deleted.attempt.intent.intentId,
        newRowId: "r2b",
        beforeId: null,
        sourceRow,
        columnIds: metadataBefore.columnIds,
      };

      const crossWriter = submitCommand(
        h.authority,
        bob.token,
        h.scope,
        restore,
      );
      expect(crossWriter.receipt.status).toBe("REJECTED");
      expect(crossWriter.receipt.code).toBe("UNDO_PROOF_MISSING");

      const witnessKey =
        scopeKey(h.scope) + ":" + h.auth.writerId + ":" + restore.undoOf;
      const witness = h.authority.store.get("authority.undo", witnessKey) as {
        userId: string;
        writerId: string;
        template: typeof restore;
        cut: Cut | null;
        usedBy: string | null;
      };
      expect(witness.cut).not.toBeNull();
      const tampered = JSON.parse(JSON.stringify(witness)) as typeof witness;
      tampered.template.sourceRow = documentWith("p9", "tampered");
      h.authority.store.transaction(() =>
        h.authority.store.set("authority.undo", witnessKey, tampered),
      );
      const tamperedResult = submitCommand(
        h.authority,
        h.token,
        h.scope,
        restore,
      );
      expect(tamperedResult.receipt.status).toBe("REJECTED");
      expect(tamperedResult.receipt.code).toBe("UNDO_SOURCE_MISMATCH");
      h.authority.store.transaction(() =>
        h.authority.store.set("authority.undo", witnessKey, witness),
      );

      const accepted = submitCommand(h.authority, h.token, h.scope, restore);
      expect(accepted.receipt.status).toBe("SERVER_ACCEPTED");
      const restored = h.authority.snapshot(h.token, h.scope);
      expect(
        restored.state.tables.find((table) => table.tableId === "t1")?.rowIds,
      ).toEqual(["r1", "r2b"]);

      const replay = submitCommand(h.authority, h.token, h.scope, {
        ...restore,
        newRowId: "r2c",
      });
      expect(replay.receipt.status).toBe("REJECTED");
      expect(replay.receipt.code).toBe("UNDO_ALREADY_USED");
    } finally {
      h.cleanup();
    }
  });
});

describe("state root tamper detection", () => {
  it("binds authoritative records, detects record tamper, and keeps genesis checks separate", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    try {
      store.transaction(() => {
        store.set("meta", "role", "authority");
        store.set("organization", "org1", {
          orgId: "org1",
          ownerIds: ["alice"],
          memberIds: ["alice"],
          version: 1,
        });
      });
      const head = store.transaction(() =>
        createRuntimeGenesis(store, "epoch_root", null),
      );
      expect(store.get("meta", "head")).toEqual(head);
      expect(() => assertRuntimeGenesis(store)).not.toThrow();
      const root = authorityStateRoot(store);
      expect(() => assertRuntimeStateRoot(store)).not.toThrow();
      expectCode(
        () => assertRuntimeStateRoot(store, "0".repeat(64)),
        "STATE_ROOT_MISMATCH",
      );
      expectCode(
        () =>
          store.transaction(() => createRuntimeGenesis(store, "other", null)),
        "GENESIS_CONFLICT",
      );

      store.transaction(() =>
        store.set("organization", "org1", {
          orgId: "org1",
          ownerIds: ["alice"],
          memberIds: ["alice"],
          version: 2,
        }),
      );
      expect(authorityStateRoot(store)).not.toBe(root);
      expectCode(() => assertRuntimeStateRoot(store), "STATE_ROOT_MISMATCH");
      expect(() => assertRuntimeGenesis(store)).not.toThrow();

      const genesis = store.get("meta", "genesis") as Record<string, unknown>;
      store.transaction(() =>
        store.set("meta", "genesis", {
          ...genesis,
          sourceHash: "f".repeat(64),
        }),
      );
      expectCode(() => assertRuntimeGenesis(store), "GENESIS_HASH_MISMATCH");
    } finally {
      store.close();
    }
  });
});

describe("IPC-visible recovery output", () => {
  it("does not expose the live token, recovery key, or sealed credential material", async () => {
    const f = await makeHttpFixture();
    const service = new SharedRuntimeService(
      join(f.dir, "service-recover"),
      new CredentialProvider(new FakeAsyncSafeStorage(), "darwin"),
    );
    try {
      const connected = await service.handle({
        type: "connect",
        url: f.url,
        token: f.token,
        orgId: f.orgId,
        remember: true,
      });
      const opened = (await service.handle({
        type: "open",
        scope: f.scope,
      })) as { generation: number };
      const connections = await service.handle({ type: "connections" });
      const recovered = await service.handle({
        type: "recover",
        generation: opened.generation,
      });
      const listed = await service.handle({ type: "list" });
      expect(typeof recovered).toBe("string");
      for (const value of [connected, opened, connections, recovered, listed]) {
        const text = JSON.stringify(value);
        expect(text).not.toContain(f.token);
        expect(text).not.toContain(f.recoveryKey);
        expect(text).not.toContain("sealed");
      }
    } finally {
      service.close();
      await f.cleanupAll();
    }
  });
});

describe("service network-await fencing", () => {
  it("does not keep a connection when IPC sender authorization is lost during connect", async () => {
    const h = makeHarness();
    const relay = await startRelay(h.authority, {
      session: 80,
      workspaces: 80,
    });
    const service = new SharedRuntimeService(join(h.dir, "service-sender"));
    try {
      let authorized = true;
      const pending = service.handle(
        {
          type: "connect",
          url: relay.url,
          token: h.token,
          orgId: h.orgId,
        },
        () => authorized,
      );
      await wait(15);
      authorized = false;
      await expect(pending).rejects.toMatchObject({
        code: "UNAUTHORIZED_IPC_SENDER",
      });
      await expect(
        service.handle({ type: "list" }, () => true),
      ).rejects.toMatchObject({ code: "SHARED_NOT_CONFIGURED" });
    } finally {
      service.close();
      await relay.close();
      h.cleanup();
    }
  });

  it("does not activate a client generation after close wins the snapshot await", async () => {
    const h = makeHarness();
    const relay = await startRelay(h.authority, { snapshot: 80 });
    const service = new SharedRuntimeService(join(h.dir, "service-generation"));
    try {
      await service.handle({
        type: "connect",
        url: relay.url,
        token: h.token,
        orgId: h.orgId,
      });
      const pending = service.handle({ type: "open", scope: h.scope });
      await wait(15);
      service.close();
      await expect(pending).rejects.toBeInstanceOf(Error);
    } finally {
      service.close();
      await relay.close();
      h.cleanup();
    }
  });
});
