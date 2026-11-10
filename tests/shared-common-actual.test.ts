import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import {
  COMMON_ACCEPTANCE_MARKER,
  runCommonAcceptance,
  verifyPhysicalPlan,
  type CommonClient,
} from "../src/collaboration/runtime/common-acceptance";
import type {
  Attempt,
  AuthContext,
  Command,
  Cut,
  Receipt,
  Scope,
} from "../src/collaboration/runtime/contract";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import type { SharedAuthorityEndpoint } from "../src/collaboration/runtime/provider-port";
import type { Doc } from "../src/shared/types";

const DOC: Doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "block-a" },
      content: [{ type: "text", text: "Alpha" }],
    },
    {
      type: "paragraph",
      attrs: { id: "block-b" },
      content: [{ type: "text", text: "Beta" }],
    },
    {
      type: "table",
      attrs: { id: "table-1" },
      content: [
        {
          type: "tableRow",
          attrs: { id: "row-h" },
          content: [
            {
              type: "tableHeader",
              attrs: { id: "cell-h1" },
              content: [{ type: "paragraph", attrs: { id: "p-h1" } }],
            },
            {
              type: "tableHeader",
              attrs: { id: "cell-h2" },
              content: [{ type: "paragraph", attrs: { id: "p-h2" } }],
            },
          ],
        },
        {
          type: "tableRow",
          attrs: { id: "row-1" },
          content: [
            {
              type: "tableCell",
              attrs: { id: "cell-11" },
              content: [{ type: "paragraph", attrs: { id: "p-11" } }],
            },
            {
              type: "tableCell",
              attrs: { id: "cell-12" },
              content: [{ type: "paragraph", attrs: { id: "p-12" } }],
            },
          ],
        },
      ],
    },
  ],
};

type Harness = Readonly<{
  root: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  scope: Scope;
  tokenA: string;
  tokenB: string;
  authA: AuthContext;
  authB: AuthContext;
  providerA: HttpSharedProvider;
  providerB: HttpSharedProvider;
  clientA: SharedRuntimeClient;
  clientB: SharedRuntimeClient;
  cleanup: () => Promise<void>;
}>;

function findNode(node: Doc, id: string): Doc | null {
  if (node.attrs?.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function inlineText(node: Doc): string {
  let text = "";
  for (const child of node.content ?? []) {
    if (child.type === "text") text += child.text ?? "";
    else if (child.type === "hardBreak") text += "\n";
  }
  return text;
}

function firstParagraph(node: Doc): Doc | null {
  if (node.type === "paragraph" && typeof node.attrs?.id === "string")
    return node;
  for (const child of node.content ?? []) {
    const found = firstParagraph(child);
    if (found) return found;
  }
  return null;
}

function appendTextCommand(
  document: Doc,
  blockId: string,
  text: string,
): Command {
  const block = findNode(document, blockId);
  if (!block || block.type !== "paragraph")
    throw new Error(`paragraph missing: ${blockId}`);
  const before = inlineText(block);
  return {
    kind: "text",
    blockId,
    from: before.length,
    to: before.length,
    text,
    before,
  };
}

function lossyEndpoint(authority: SharedAuthority): SharedAuthorityEndpoint {
  return {
    session: (token, orgId) => authority.session(token, orgId),
    snapshot: (token, scope, after) => authority.snapshot(token, scope, after),
    submit: (token, attempt) => {
      authority.submit(token, attempt);
      throw new Error("SIMULATED_RECEIPT_LOSS");
    },
    receipt: (token, attempt) => authority.receipt(token, attempt),
    invalidate: (token, attempt) => authority.invalidate(token, attempt),
    proof: (token, scope, seq) => authority.proof(token, scope, seq),
    workspaces: (token, orgId) => authority.workspaces(token, orgId),
  };
}

async function createHarness(lossy = false): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "folio-common-real-"));
  const authority = new SharedAuthority(join(root, "authority"));
  const boot = authority.bootstrap({
    orgId: "org-common",
    userId: "user-a",
    deviceId: "device-a",
    workspaceId: "workspace-common",
    documentId: "document-common",
    document: DOC,
  });
  const invite = authority.invite(
    boot.token,
    boot.scope.orgId,
    "user-b",
    3_600_000,
  );
  const accepted = authority.acceptInvite(invite, "device-b");
  authority.grant(boot.token, boot.scope, "user-b", "editor");
  const server = createSharedHttpServer(
    lossy ? lossyEndpoint(authority) : authority,
  );
  const { url } = await server.listen();
  const providerA = new HttpSharedProvider(url, boot.token);
  const providerB = new HttpSharedProvider(url, accepted.token);
  const clientA = new SharedRuntimeClient(
    join(root, "client-a"),
    providerA,
    boot.scope,
    boot.auth.writerId,
  );
  const clientB = new SharedRuntimeClient(
    join(root, "client-b"),
    providerB,
    boot.scope,
    accepted.auth.writerId,
  );
  await clientA.open();
  await clientB.open();
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clientA.close();
    clientB.close();
    await server.close();
    authority.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    authority,
    server,
    url,
    scope: boot.scope,
    tokenA: boot.token,
    tokenB: accepted.token,
    authA: boot.auth,
    authB: accepted.auth,
    providerA,
    providerB,
    clientA,
    clientB,
    cleanup,
  };
}

class ActualCommonClient implements CommonClient {
  readonly label: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly platform: string;
  readonly writerId: string;
  private client: SharedRuntimeClient | null = null;

  private constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly directory: string,
    private readonly scope: Scope,
    private readonly attempts: Map<string, Attempt>,
    label: string,
    userId: string,
    deviceId: string,
    writerId: string,
  ) {
    this.label = label;
    this.userId = userId;
    this.deviceId = deviceId;
    this.platform = process.platform;
    this.writerId = writerId;
  }

  static adopt(
    url: string,
    token: string,
    client: SharedRuntimeClient,
    directory: string,
    scope: Scope,
    attempts: Map<string, Attempt>,
    label: string,
    userId: string,
    deviceId: string,
    writerId: string,
  ): ActualCommonClient {
    const adapter = new ActualCommonClient(
      url,
      token,
      directory,
      scope,
      attempts,
      label,
      userId,
      deviceId,
      writerId,
    );
    adapter.client = client;
    return adapter;
  }

  private async openClient(): Promise<SharedRuntimeClient> {
    const client = new SharedRuntimeClient(
      this.directory,
      new HttpSharedProvider(this.url, this.token),
      this.scope,
      this.writerId,
    );
    await client.open();
    return client;
  }

  private requireClient(): SharedRuntimeClient {
    if (!this.client) throw new Error("CLIENT_CLOSED");
    return this.client;
  }

  async read(): Promise<{ document: unknown; cut: Cut }> {
    const client = this.requireClient();
    await client.reconcile();
    const snapshot = client.snapshot();
    return { document: snapshot.state.document, cut: snapshot.cut };
  }

  async insert(text: string): Promise<Receipt> {
    const client = this.requireClient();
    const block = firstParagraph(client.snapshot().state.document);
    if (!block || typeof block.attrs?.id !== "string")
      throw new Error("NO_PARAGRAPH");
    const { receipt } = await client.submit(
      appendTextCommand(client.snapshot().state.document, block.attrs.id, text),
    );
    const entry = client
      .entries()
      .find((value) => value.intent.intentId === receipt.intentId);
    const attempt = entry?.attempts.find(
      (value) => value.attempt.attemptId === receipt.attemptId,
    )?.attempt;
    if (attempt) this.attempts.set(receipt.intentId, attempt);
    return receipt;
  }

  async disconnect(): Promise<void> {
    this.client?.close();
    this.client = null;
  }

  async reconnect(): Promise<void> {
    this.client = await this.openClient();
  }

  async resolve(intentId: string): Promise<Receipt | null> {
    const client = this.requireClient();
    const own = client
      .entries()
      .find((e) => e.intent.intentId === intentId)
      ?.attempts.at(-1)?.attempt;
    if (own) return client.provider.receipt(own);
    await client.open();
    return (
      client.snapshot().events.find((e) => e.intentId === intentId)?.receipt ??
      null
    );
  }
}

async function createAdapters(harness: Harness): Promise<{
  a: ActualCommonClient;
  b: ActualCommonClient;
}> {
  const attempts = new Map<string, Attempt>();
  const a = ActualCommonClient.adopt(
    harness.url,
    harness.tokenA,
    harness.clientA,
    join(harness.root, "client-a"),
    harness.scope,
    attempts,
    "A",
    harness.authA.userId,
    harness.authA.deviceId,
    harness.authA.writerId,
  );
  const b = ActualCommonClient.adopt(
    harness.url,
    harness.tokenB,
    harness.clientB,
    join(harness.root, "client-b"),
    harness.scope,
    attempts,
    "B",
    harness.authB.userId,
    harness.authB.deviceId,
    harness.authB.writerId,
  );
  return { a, b };
}

describe("shared common acceptance against actual runtime", () => {
  it("runs the common suite through actual authority, HTTP provider and clients", async () => {
    const harness = await createHarness();
    const adapters = await createAdapters(harness);
    try {
      const result = await runCommonAcceptance({
        a: adapters.a,
        b: adapters.b,
        sourceHash: "1".repeat(64),
        artifactHash: "2".repeat(64),
        serverIdentity: "node-http-loopback-127.0.0.1",
        physicalEvidence: { host: "untrusted-claim" },
        intervalMs: 10,
        timeoutMs: 2_000,
      });
      expect(result.commonResult, JSON.stringify(result)).toBe("PASS");
      expect(result.physical).toBe("NOT_RUN");
      expect(result.physicalEvidence).toBe("UNTRUSTED_IGNORED");
      expect(result.limitedScope.fullL4).toBe(false);
      expect(result.limitedScope.fullL5).toBe(false);
      expect(
        result.observations.some(
          (value) =>
            value.step === "physical-evidence" &&
            value.code === "UNTRUSTED_IGNORED",
        ),
      ).toBe(true);
      expect(
        result.observations.some(
          (value) => value.step === "receipt-after-reconnect" && value.ok,
        ),
      ).toBe(true);
      const after = await adapters.a.read();
      expect(JSON.stringify(after.document)).toContain(
        COMMON_ACCEPTANCE_MARKER,
      );
    } finally {
      await adapters.a.disconnect();
      await adapters.b.disconnect();
      await harness.cleanup();
    }
  }, 30_000);

  it("keeps block identity on a legal move and accepts row and column insert", async () => {
    const harness = await createHarness();
    try {
      const moved = await harness.clientA.submit({
        kind: "block.move",
        blockId: "block-a",
        parentId: null,
        beforeId: null,
      });
      expect(moved.receipt.status).toBe("SERVER_ACCEPTED");
      expect(moved.receipt.writerId).toBe(harness.authA.writerId);
      expect(moved.snapshot.state.document.content?.at(-1)?.attrs?.id).toBe(
        "block-a",
      );
      const movedBlock = findNode(moved.snapshot.state.document, "block-a");
      expect(movedBlock?.type).toBe("paragraph");
      expect(inlineText(movedBlock as Doc)).toBe("Alpha");

      const row = await harness.clientA.submit({
        kind: "table.row.insert",
        tableId: "table-1",
        rowId: "row-new",
        beforeId: null,
      });
      expect(row.receipt.status).toBe("SERVER_ACCEPTED");
      const rowMetadata = row.snapshot.state.tables.find(
        (value) => value.tableId === "table-1",
      );
      expect(rowMetadata?.rowIds).toContain("row-new");

      const column = await harness.clientA.submit({
        kind: "table.column.insert",
        tableId: "table-1",
        columnId: "column-new",
        beforeId: null,
      });
      expect(column.receipt.status).toBe("SERVER_ACCEPTED");
      const columnMetadata = column.snapshot.state.tables.find(
        (value) => value.tableId === "table-1",
      );
      expect(columnMetadata?.columnIds).toContain("column-new");
      const table = findNode(column.snapshot.state.document, "table-1");
      expect(table?.content?.length).toBe(3);
      for (const tableRow of table?.content ?? [])
        expect(tableRow.content?.length).toBe(3);

      await harness.clientB.reconcile();
      const head = harness.authority.head();
      const evidence = {
        physical: "NOT_RUN" as const,
        platform: process.platform,
        processes: [
          {
            label: "A",
            userId: harness.authA.userId,
            deviceId: harness.authA.deviceId,
            directory: harness.clientA.store.path,
            epoch: harness.clientA.snapshot().cut.epoch,
            headHash: harness.clientA.snapshot().cut.hash,
          },
          {
            label: "B",
            userId: harness.authB.userId,
            deviceId: harness.authB.deviceId,
            directory: harness.clientB.store.path,
            epoch: harness.clientB.snapshot().cut.epoch,
            headHash: harness.clientB.snapshot().cut.hash,
          },
        ],
        server: {
          directory: harness.authority.store.path,
          epoch: head.epoch,
          headHash: head.hash,
        },
      };
      expect(evidence.processes[0].directory).not.toBe(
        evidence.processes[1].directory,
      );
      expect(evidence.processes[0].epoch).toBe(evidence.server.epoch);
      expect(evidence.processes[1].epoch).toBe(evidence.server.epoch);
      expect(evidence.processes[0].headHash).toBe(evidence.server.headHash);
      expect(evidence.processes[1].headHash).toBe(evidence.server.headHash);
      expect(evidence.physical).toBe("NOT_RUN");
      console.info("[COMMON_REAL_EVIDENCE]", JSON.stringify(evidence));
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  it("recovers a committed change after the HTTP receipt response is lost and the client reopens", async () => {
    const harness = await createHarness(true);
    try {
      const marker = "受領証消失🙂";
      const command = appendTextCommand(
        harness.clientA.snapshot().state.document,
        "block-b",
        marker,
      );
      await expect(harness.clientA.submit(command)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      const beforeReopen = harness.clientA.entries();
      expect(beforeReopen).toHaveLength(1);
      expect(beforeReopen[0].state).toBe("UNKNOWN");
      harness.clientA.close();

      const reopened = new SharedRuntimeClient(
        join(harness.root, "client-a"),
        new HttpSharedProvider(harness.url, harness.tokenA),
        harness.scope,
        harness.authA.writerId,
      );
      await reopened.open();
      const unknown = reopened
        .entries()
        .find((value) => value.state === "UNKNOWN");
      expect(unknown).toBeDefined();
      await reopened.reconcile();
      const confirmed = reopened
        .entries()
        .find((value) => value.intent.intentId === unknown?.intent.intentId);
      expect(confirmed?.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(confirmed?.attempts[0]?.receipt?.status).toBe("SERVER_ACCEPTED");
      const block = findNode(reopened.snapshot().state.document, "block-b");
      expect(inlineText(block as Doc)).toBe(`Beta${marker}`);
      reopened.close();
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  it("refuses revoked member reads and writes while the owner continues", async () => {
    const harness = await createHarness();
    try {
      harness.authority.revokeMember(
        harness.tokenA,
        harness.scope.orgId,
        harness.authB.userId,
      );
      await expect(
        harness.providerB.snapshot(harness.scope),
      ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
      const after = await harness.clientA.submit(
        appendTextCommand(
          harness.clientA.snapshot().state.document,
          "block-a",
          "owner-still-writes",
        ),
      );
      expect(after.receipt.status).toBe("SERVER_ACCEPTED");
      expect(
        inlineText(findNode(after.snapshot.state.document, "block-a") as Doc),
      ).toBe("Alphaowner-still-writes");
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  it("rejects duplicate identity in the common contract before any host claim", async () => {
    const harness = await createHarness();
    const adapters = await createAdapters(harness);
    try {
      const sameUser: CommonClient = {
        label: adapters.b.label,
        userId: adapters.a.userId,
        deviceId: adapters.b.deviceId,
        platform: adapters.b.platform,
        writerId: adapters.b.writerId,
        read: () => adapters.b.read(),
        insert: (text) => adapters.b.insert(text),
        disconnect: () => adapters.b.disconnect(),
        reconnect: () => adapters.b.reconnect(),
        resolve: (intentId) => adapters.b.resolve(intentId),
      };
      const result = await runCommonAcceptance({
        a: adapters.a,
        b: sameUser,
        sourceHash: "3".repeat(64),
        artifactHash: "4".repeat(64),
        serverIdentity: "node-http-loopback-127.0.0.1",
        intervalMs: 10,
        timeoutMs: 500,
      });
      expect(result.commonResult).toBe("FAIL");
      expect(result.physical).toBe("NOT_RUN");
      expect(
        result.observations.some(
          (value) => !value.ok && value.code === "USER_NOT_DISTINCT",
        ),
      ).toBe(true);
    } finally {
      await adapters.a.disconnect();
      await adapters.b.disconnect();
      await harness.cleanup();
    }
  }, 30_000);

  it("does not treat Mac processes or Windows declarations as physical proof", () => {
    const macPlan = verifyPhysicalPlan({
      windowsPorts: [
        {
          hostId: "mac-host-a",
          portId: "client-a",
          platform: "darwin",
          complete: true,
          evidenceHash: "a".repeat(64),
        },
        {
          hostId: "mac-host-b",
          portId: "client-b",
          platform: "darwin",
          complete: true,
          evidenceHash: "b".repeat(64),
        },
      ],
    });
    expect(macPlan.ok).toBe(false);
    expect(macPlan.physical).toBe("NOT_RUN");
    expect(macPlan.multiMachineAllowed).toBe(false);

    const windowsPlan = verifyPhysicalPlan({
      windowsPorts: [
        {
          hostId: "windows-host-a",
          portId: "client-a",
          platform: "win32",
          complete: true,
          evidenceHash: "c".repeat(64),
        },
        {
          hostId: "windows-host-b",
          portId: "client-b",
          platform: "win32",
          complete: true,
          evidenceHash: "d".repeat(64),
        },
      ],
    });
    expect(windowsPlan.ok).toBe(true);
    expect(windowsPlan.physical).toBe("NOT_RUN");
  });
});
