import { canonical } from "../src/collaboration/runtime/canonical";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import { SharedResourceClient } from "../src/collaboration/runtime/resource-client";
import {
  CollaborationError,
  type Attempt,
  type AuthContext,
  type Receipt,
  type Scope,
  type Snapshot,
} from "../src/collaboration/runtime/contract";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import type { SharedProvider } from "../src/collaboration/runtime/provider-port";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { CredentialProvider } from "../src/platform/credential-provider";
import { createSharedRuntimeBridge } from "../src/preload/shared-runtime-queue";
import { SharedDraftLane } from "../src/shared/shared-draft-lane";
import type { Doc } from "../src/shared/types";

const TEST_TIMEOUT = 30_000;

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

function inlineText(doc: Doc, id = "p1"): string {
  const block = doc.content?.find((node) => node.attrs?.id === id);
  return (block?.content ?? []).map((node) => node.text ?? "").join("");
}

function codeOf(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof CollaborationError ? error.code : String(error);
  }
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class FaultProvider implements SharedProvider {
  submits = 0;
  receipts = 0;
  private mode: "before" | "after-once" | "none";

  constructor(
    private readonly inner: HttpSharedProvider,
    mode: "before" | "after-once",
  ) {
    this.mode = mode;
  }

  async snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    return this.inner.snapshot(scope, after);
  }

  async submit(attempt: Attempt): Promise<Receipt> {
    this.submits++;
    if (this.mode === "before") throw new CollaborationError("LOST_RESPONSE");
    const receipt = await this.inner.submit(attempt);
    if (this.mode === "after-once") {
      this.mode = "none";
      throw new CollaborationError("LOST_RESPONSE");
    }
    return receipt;
  }

  async receipt(attempt: Attempt): Promise<Receipt | null> {
    this.receipts++;
    return this.inner.receipt(attempt);
  }

  async invalidate(attempt: Attempt): Promise<Receipt> {
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

class CountingAsyncSafeStorage {
  encryptions = 0;

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true;
  }

  async encryptStringAsync(text: string): Promise<Uint8Array> {
    this.encryptions++;
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

type Fixture = {
  tmp: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  ownerToken: string;
  ownerAuth: AuthContext;
  editorToken: string;
  editorAuth: AuthContext;
  scope: Scope;
  clients: SharedRuntimeClient[];
  resourceClients: SharedResourceClient[];
  services: SharedRuntimeService[];
  cleanup(): Promise<void>;
};

async function setup(): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), "folio-main-actual-"));
  const authority = new SharedAuthority(join(tmp, "authority"));
  const boot = authority.bootstrap({
    orgId: "org1",
    userId: "owner",
    deviceId: "owner-device",
    workspaceId: "ws1",
    documentId: "doc1",
    document: documentWith("p1", "Hello"),
  });
  const invite = authority.invite(boot.token, "org1", "editor", 600_000);
  const accepted = authority.acceptInvite(invite, "editor-device");
  authority.grant(boot.token, boot.scope, "editor", "editor");
  const server = createSharedHttpServer(authority);
  const { url } = await server.listen();
  const clients: SharedRuntimeClient[] = [];
  const resourceClients: SharedResourceClient[] = [];
  const services: SharedRuntimeService[] = [];
  return {
    tmp,
    authority,
    server,
    url,
    ownerToken: boot.token,
    ownerAuth: boot.auth,
    editorToken: accepted.token,
    editorAuth: accepted.auth,
    scope: boot.scope,
    clients,
    resourceClients,
    services,
    async cleanup() {
      for (const client of clients) {
        try {
          client.close();
        } catch {}
      }
      for (const client of resourceClients) {
        try {
          client.close();
        } catch {}
      }
      for (const service of services) {
        try {
          service.close();
        } catch {}
      }
      await server.close();
      authority.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("shared runtime main service actual integration", () => {
  let activeCleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await activeCleanup?.();
    activeCleanup = null;
  });

  async function fixture(): Promise<Fixture> {
    const value = await setup();
    activeCleanup = value.cleanup;
    return value;
  }

  it(
    "coalesces five editor drafts to the latest raw without an authoritative event, then accepts one document cut",
    async () => {
      const f = await fixture();
      const service = new SharedRuntimeService(join(f.tmp, "service-drafts"));
      f.services.push(service);
      const bridge = createSharedRuntimeBridge((input) =>
        service.handle(input),
      );

      await bridge.request({
        type: "connect",
        url: f.url,
        token: f.ownerToken,
        orgId: "org1",
      });
      const opened = (await bridge.request({
        type: "open",
        scope: f.scope,
      })) as { generation: number; snapshot: Snapshot };
      const before = f.authority.head();

      const raws = Array.from({ length: 5 }, (_, index) =>
        JSON.stringify(documentWith("p1", `Draft ${index + 1}`)),
      );
      const lane = new SharedDraftLane((draft) => bridge.request(draft));
      const flushes = raws.map((raw) => lane.retain(opened.generation, raw));
      await flushes[flushes.length - 1];

      expect(f.authority.head()).toEqual(before);

      const recover = (await bridge.request({
        type: "recover",
        generation: opened.generation,
      })) as unknown as string;
      expect(typeof recover).toBe("string");
      expect(recover.length).toBeLessThan(160_000_000);
      expect(recover).not.toContain(f.ownerToken);
      const recovered = JSON.parse(recover) as {
        document: { editing: { key: string; value: { raw: string } }[] };
      };
      expect(recovered.document.editing).toHaveLength(1);
      expect(recovered.document.editing[0].value.raw).toBe(raws[4]);

      const changed = (await bridge.request({
        type: "document",
        generation: opened.generation,
        base: opened.snapshot.cut,
        document: documentWith("p1", "Final draft"),
      })) as {
        snapshot: Snapshot;
        view: { state: string; pending: number };
      };
      expect(changed.view.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(changed.view.pending).toBe(0);
      expect(inlineText(changed.snapshot.state.document)).toBe("Final draft");

      const after = f.authority.head();
      expect(after.epoch).toBe(before.epoch);
      expect(after.seq).toBe(before.seq + 1);
      const events = f.authority
        .snapshot(f.ownerToken, f.scope)
        .events.filter((event) => event.seq > before.seq);
      expect(events).toHaveLength(1);
      expect(events[0].receipt.status).toBe("SERVER_ACCEPTED");
      const eventState = events[0].state;
      expect(eventState).not.toBeNull();
      expect(inlineText(eventState!.document)).toBe("Final draft");
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps bridge FIFO order and continues after a rejected request",
    async () => {
      const f = await fixture();
      const service = new SharedRuntimeService(join(f.tmp, "service-fifo"));
      f.services.push(service);
      const order: string[] = [];
      const bridge = createSharedRuntimeBridge((input) => {
        order.push(input.type);
        return service.handle(input);
      });

      await bridge.request({
        type: "connect",
        url: f.url,
        token: f.ownerToken,
        orgId: "org1",
      });
      const opened = (await bridge.request({
        type: "open",
        scope: f.scope,
      })) as { generation: number };
      const stale = opened.generation - 1;
      expect(stale).toBeGreaterThanOrEqual(0);

      const rejected = bridge.request({ type: "refresh", generation: stale });
      const listed = bridge.request({ type: "list" });
      const connections = bridge.request({ type: "connections" });
      const settled = await Promise.allSettled([rejected, listed, connections]);

      expect(order.slice(-3)).toEqual(["refresh", "list", "connections"]);
      expect(settled[0].status).toBe("rejected");
      if (settled[0].status === "rejected")
        expect(settled[0].reason).toMatchObject({
          code: "STALE_SHARED_SESSION",
        });
      expect(settled[1].status).toBe("fulfilled");
      expect(settled[2].status).toBe("fulfilled");
      const workspaces = (
        settled[1] as unknown as PromiseFulfilledResult<{
          workspaces: { workspaceId: string }[];
        }>
      ).value.workspaces;
      expect(workspaces[0].workspaceId).toBe("ws1");
      expect(
        (settled[2] as unknown as PromiseFulfilledResult<unknown[]>).value,
      ).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "executes real database and record resources on a fresh scope and serializes the next document on the same bridge",
    async () => {
      const f = await fixture();
      const service = new SharedRuntimeService(join(f.tmp, "service-resource"));
      f.services.push(service);
      const order: string[] = [];
      const bridge = createSharedRuntimeBridge((input) => {
        order.push(input.type);
        return service.handle(input);
      });

      await bridge.request({
        type: "connect",
        url: f.url,
        token: f.ownerToken,
        orgId: "org1",
      });
      const opened = (await bridge.request({
        type: "open",
        scope: f.scope,
      })) as { generation: number; snapshot: Snapshot };
      const before = f.authority.head();
      const fresh: Scope = {
        orgId: "org1",
        workspaceId: "ws1",
        documentId: "doc-record",
        incarnationId: "inc-record",
      };

      const database = bridge.request({
        type: "resource",
        generation: opened.generation,
        scope: f.scope,
        command: {
          kind: "resource",
          action: "db.create",
          payload: { databaseId: "db1", revision: 0, properties: [] },
        },
      });
      const record = bridge.request({
        type: "resource",
        generation: opened.generation,
        scope: fresh,
        command: {
          kind: "resource",
          action: "record.create",
          payload: {
            databaseId: "db1",
            revision: 0,
            title: "Record one",
            values: {},
            document: JSON.parse(canonical(documentWith("r1", "Record body"))),
          },
        },
      });
      const document = bridge.request({
        type: "document",
        generation: opened.generation,
        base: opened.snapshot.cut,
        document: documentWith("p1", "Hello!"),
      });
      const results = (await Promise.all([
        database,
        record,
        document,
      ])) as unknown as [
        Receipt,
        Receipt,
        { snapshot: Snapshot; view: { state: string } },
      ];

      expect(order.slice(-3)).toEqual(["resource", "resource", "document"]);
      expect(results[0].status).toBe("SERVER_ACCEPTED");
      expect(results[1].status).toBe("SERVER_ACCEPTED");
      expect(results[2].view.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(inlineText(results[2].snapshot.state.document)).toBe("Hello!");

      const databases = f.authority.records(
        f.ownerToken,
        f.scope,
      ) as unknown as {
        databases: { id: string }[];
      };
      expect(databases.databases.map((entry) => entry.id)).toContain("db1");
      const records = f.authority.records(f.ownerToken, fresh) as unknown as {
        records: { id: string; databaseId: string; title: string }[];
        document: { document: Doc } | null;
      };
      expect(records.records).toEqual([
        expect.objectContaining({
          id: fresh.documentId,
          databaseId: "db1",
          title: "Record one",
        }),
      ]);
      expect(records.document).not.toBeNull();
      expect(inlineText(records.document!.document, "r1")).toBe("Record body");
      expect(f.authority.head().seq).toBe(before.seq + 3);
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps a resource lost ACK UNKNOWN, reconciles the real commit, then invalidates and archives before the next document",
    async () => {
      const f = await fixture();
      const directory = join(f.tmp, "resource-lost");

      const lostAfter = new FaultProvider(
        new HttpSharedProvider(f.url, f.ownerToken),
        "after-once",
      );
      const first = new SharedResourceClient(
        directory,
        lostAfter,
        f.ownerAuth.writerId,
      );
      f.resourceClients.push(first);
      const before = f.authority.head();
      await expect(
        first.execute(
          f.scope,
          {
            kind: "resource",
            action: "db.create",
            payload: { databaseId: "db_after", revision: 0, properties: [] },
          },
          before,
        ),
      ).rejects.toMatchObject({ code: "LOST_RESPONSE" });

      expect(lostAfter.submits).toBe(1);
      expect(first.entries()).toHaveLength(1);
      expect(first.entries()[0].state).toBe("UNKNOWN");
      expect(first.entries()[0].attempts[0].state).toBe("UNKNOWN");
      const attempt = first.entries()[0].attempts[0].attempt;
      const committed = f.authority.head();
      expect(committed.seq).toBe(before.seq + 1);

      const query = new HttpSharedProvider(f.url, f.ownerToken);
      try {
        expect((await query.receipt(attempt))?.status).toBe("SERVER_ACCEPTED");
      } finally {
        query.close();
      }
      first.close();
      f.resourceClients.splice(f.resourceClients.indexOf(first), 1);

      const second = new SharedResourceClient(
        directory,
        new HttpSharedProvider(f.url, f.ownerToken),
        f.ownerAuth.writerId,
      );
      f.resourceClients.push(second);
      await second.reconcile();
      expect(second.entries()[0].state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(second.entries()[0].attempts[0].state).toBe("ACCEPTED");
      expect(second.entries()[0].attempts[0].receipt?.status).toBe(
        "SERVER_ACCEPTED",
      );
      expect(f.authority.head()).toEqual(committed);
      second.close();
      f.resourceClients.splice(f.resourceClients.indexOf(second), 1);

      const lostBefore = new FaultProvider(
        new HttpSharedProvider(f.url, f.ownerToken),
        "before",
      );
      const third = new SharedResourceClient(
        directory,
        lostBefore,
        f.ownerAuth.writerId,
      );
      f.resourceClients.push(third);
      const unchanged = f.authority.head();
      await expect(
        third.execute(
          f.scope,
          {
            kind: "resource",
            action: "db.create",
            payload: { databaseId: "db_before", revision: 0, properties: [] },
          },
          unchanged,
        ),
      ).rejects.toMatchObject({ code: "LOST_RESPONSE" });
      expect(f.authority.head()).toEqual(unchanged);
      await third.reconcile();
      await third.reconcile();
      const unknownEntry = third
        .entries()
        .find((entry) =>
          entry.attempts.some((item) => item.state === "UNKNOWN"),
        );
      expect(unknownEntry).toBeDefined();
      const intentId = unknownEntry!.intent.intentId;
      expect(
        third.entries().find((e) => e.intent.intentId === intentId)?.state,
      ).toBe("UNKNOWN");
      expect(codeOf(() => third.archive(f.scope, intentId))).toBe(
        "NOT_PROVEN_UNAPPLIED",
      );
      const invalidated = await third.invalidate(f.scope, intentId);
      expect(invalidated.status).toBe("INVALIDATED");
      expect(
        third.entries().find((e) => e.intent.intentId === intentId)?.state,
      ).toBe("REJECTED");
      third.archive(f.scope, intentId);
      expect(third.activeEntries()).toHaveLength(0);
      expect(third.hasPending()).toBe(false);

      const next = new SharedRuntimeClient(
        join(f.tmp, "client-after-resource"),
        new HttpSharedProvider(f.url, f.ownerToken),
        f.scope,
        f.ownerAuth.writerId,
      );
      f.clients.push(next);
      await next.open();
      const submitted = await next.submit({
        kind: "text",
        blockId: "p1",
        from: 5,
        to: 5,
        text: "!",
        before: "Hello",
      });
      expect(submitted.receipt.status).toBe("SERVER_ACCEPTED");
      expect(
        inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
      ).toBe("Hello!");
    },
    TEST_TIMEOUT,
  );

  it(
    "exports a bounded backup without raw tokens, cancels cleanly, and refuses to write when the sender is revoked during the async picker",
    async () => {
      const f = await fixture();
      const realTmp = realpathSync(f.tmp);
      const exportDir = mkdtempSync(join(realTmp, "folio-export-"));
      const destination = join(exportDir, "shared-backup.json");
      const revokedDestination = join(exportDir, "revoked-backup.json");
      const gate = deferred();
      let picker: () => Promise<string | null> = async () => destination;
      const service = new SharedRuntimeService(
        join(f.tmp, "service-backup"),
        undefined,
        { pickBackup: () => picker() },
      );
      f.services.push(service);

      await service.handle({
        type: "connect",
        url: f.url,
        token: f.ownerToken,
        orgId: "org1",
      });

      const exported = (await service.handle({
        type: "backupExport",
        orgId: "org1",
      })) as { state: string; path: string; head: unknown; hash: string };
      expect(exported.state).toBe("EXPORTED");
      expect(exported.path).toBe(destination);
      expect(existsSync(destination)).toBe(true);
      expect(JSON.stringify(exported)).not.toContain(f.ownerToken);
      const raw = readFileSync(destination, "utf8");
      expect(raw.length).toBeLessThanOrEqual(256 * 1024 * 1024);
      expect(raw).not.toContain(f.ownerToken);
      expect(raw).not.toContain(f.editorToken);
      const parsed = JSON.parse(raw) as {
        format: string;
        head: unknown;
        records: { namespace: string; value: unknown }[];
      };
      expect(parsed.format).toBe("folio-shared-runtime-backup/1");
      expect(parsed.head).toEqual(exported.head);

      picker = async () => null;
      const cancelled = (await service.handle({
        type: "backupExport",
        orgId: "org1",
      })) as { state: string };
      expect(cancelled.state).toBe("CANCELLED");
      expect(readdirSync(exportDir)).toEqual(["shared-backup.json"]);

      let pickerStarted = false;
      picker = async () => {
        pickerStarted = true;
        await gate.promise;
        return revokedDestination;
      };
      let authorized = true;
      const pending = service.handle(
        { type: "backupExport", orgId: "org1" },
        () => authorized,
      );
      for (let attempt = 0; attempt < 200 && !pickerStarted; attempt++)
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(pickerStarted).toBe(true);
      authorized = false;
      gate.release();
      await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(existsSync(revokedDestination)).toBe(false);
      expect(readdirSync(exportDir)).toEqual(["shared-backup.json"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "does not activate a connection or persist a sealed token when authorization is revoked across awaited provider or seal work",
    async () => {
      const f = await fixture();

      const noRememberStorage = new CountingAsyncSafeStorage();
      const noRemember = new SharedRuntimeService(
        join(f.tmp, "service-revoke-provider"),
        new CredentialProvider(noRememberStorage, "darwin"),
      );
      f.services.push(noRemember);
      let providerCalls = 0;
      await expect(
        noRemember.handle(
          {
            type: "connect",
            url: f.url,
            token: f.ownerToken,
            orgId: "org1",
          },
          () => ++providerCalls <= 1,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED_IPC_SENDER" });
      expect(providerCalls).toBe(2);
      expect(noRememberStorage.encryptions).toBe(0);
      expect(await noRemember.handle({ type: "connections" })).toEqual([]);
      await expect(noRemember.handle({ type: "list" })).rejects.toMatchObject({
        code: "SHARED_NOT_CONFIGURED",
      });

      const revokedDuringSealStorage = new CountingAsyncSafeStorage();
      const revokedDuringSeal = new SharedRuntimeService(
        join(f.tmp, "service-revoke-seal"),
        new CredentialProvider(revokedDuringSealStorage, "darwin"),
      );
      f.services.push(revokedDuringSeal);
      let sealCalls = 0;
      await expect(
        revokedDuringSeal.handle(
          {
            type: "connect",
            url: f.url,
            token: f.ownerToken,
            orgId: "org1",
            remember: true,
          },
          () => ++sealCalls <= 2,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED_IPC_SENDER" });
      expect(sealCalls).toBe(3);
      expect(revokedDuringSealStorage.encryptions).toBe(1);
      expect(await revokedDuringSeal.handle({ type: "connections" })).toEqual(
        [],
      );
      await expect(
        revokedDuringSeal.handle({ type: "list" }),
      ).rejects.toMatchObject({ code: "SHARED_NOT_CONFIGURED" });
    },
    TEST_TIMEOUT,
  );

  it(
    "fences stale navigation generations and scopes while the current generation can execute a real resource",
    async () => {
      const f = await fixture();
      const service = new SharedRuntimeService(join(f.tmp, "service-fence"));
      f.services.push(service);
      await service.handle({
        type: "connect",
        url: f.url,
        token: f.ownerToken,
        orgId: "org1",
      });
      const first = (await service.handle({
        type: "open",
        scope: f.scope,
      })) as { generation: number; snapshot: Snapshot };
      const current = (await service.handle({
        type: "open",
        scope: f.scope,
      })) as { generation: number; snapshot: Snapshot };
      expect(current.generation).toBeGreaterThan(first.generation);

      const makeResource = (generation: number, workspaceId: string) => ({
        type: "resource" as const,
        generation,
        scope: { ...f.scope, workspaceId },
        command: {
          kind: "resource" as const,
          action: "db.create",
          payload: { databaseId: "db_fence", revision: 0, properties: [] },
        },
      });

      await expect(
        service.handle(makeResource(first.generation, "ws1")),
      ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });
      await expect(
        service.handle(makeResource(current.generation, "other-ws")),
      ).rejects.toMatchObject({ code: "AUTH_SCOPE_MISMATCH" });
      await expect(
        service.handle({
          type: "resourceArchive",
          generation: first.generation,
          scope: f.scope,
          intentId: "missing-intent",
        }),
      ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });

      const accepted = (await service.handle(
        makeResource(current.generation, "ws1"),
      )) as Receipt;
      expect(accepted.status).toBe("SERVER_ACCEPTED");

      const disconnected = (await service.handle({
        type: "disconnect",
      })) as { generation: number };
      await expect(
        service.handle(makeResource(disconnected.generation, "ws1")),
      ).rejects.toMatchObject({ code: "SHARED_NOT_CONFIGURED" });
    },
    TEST_TIMEOUT,
  );
});
