import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import type {
  Cut,
  Receipt,
  Scope,
} from "../src/collaboration/runtime/contract";
import {
  COMMON_ACCEPTANCE_MARKER,
  runCommonAcceptance,
  verifyPhysicalPlan,
  type CommonAcceptanceClock,
  type CommonClient,
  type CommonAcceptanceInput,
} from "../src/collaboration/runtime/common-acceptance";

const scope: Scope = {
  orgId: "org",
  workspaceId: "workspace",
  documentId: "document",
  incarnationId: "incarnation",
};

function initialDocument(): Doc {
  return {
    type: "doc",
    attrs: { id: "root" },
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "base" }],
      },
    ],
  };
}

function appendText(document: Doc, text: string): Doc {
  const cloned = structuredClone(document);
  const paragraph = cloned.content?.[0];
  if (!paragraph) throw new Error("test document has no paragraph");
  paragraph.content = [...(paragraph.content ?? []), { type: "text", text }];
  return cloned;
}

class FakeServer {
  document = initialDocument();
  seq = 0;
  readonly epoch = "epoch-1";
  readonly receipts = new Map<string, Receipt>();

  cut(): Cut {
    return { epoch: this.epoch, seq: this.seq, hash: `hash-${this.seq}` };
  }

  insert(writerId: string, text: string): Receipt {
    this.seq += 1;
    this.document = appendText(this.document, text);
    const receipt: Receipt = {
      v: 1,
      status: "SERVER_ACCEPTED",
      intentId: `intent-${this.seq}`,
      intentHash: `intent-hash-${this.seq}`,
      attemptId: `attempt-${this.seq}`,
      attemptHash: `attempt-hash-${this.seq}`,
      writerId,
      scope,
      cut: this.cut(),
      resultHash: `result-hash-${this.seq}`,
      code: null,
    };
    this.receipts.set(receipt.intentId, receipt);
    return structuredClone(receipt);
  }
}

type FakeBehavior = {
  staleAtStart?: boolean;
  readDocument?: (server: FakeServer) => Doc;
  resolve?: (server: FakeServer, intentId: string) => Receipt | null;
  failReadAfterReconnect?: boolean;
};

type FakeClientInit = {
  label: string;
  userId: string;
  deviceId: string;
  platform: string;
  writerId: string;
};

class FakeClient implements CommonClient {
  readonly label: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly platform: string;
  readonly writerId: string;
  private connected = true;
  private reconnected = false;
  private readonly initial: Doc;

  constructor(
    init: FakeClientInit,
    private readonly server: FakeServer,
    private readonly behavior: FakeBehavior = {},
  ) {
    this.label = init.label;
    this.userId = init.userId;
    this.deviceId = init.deviceId;
    this.platform = init.platform;
    this.writerId = init.writerId;
    this.initial = structuredClone(server.document);
  }

  async read(): Promise<{ document: unknown; cut: Cut }> {
    if (!this.connected) throw new Error(`${this.label} disconnected`);
    if (this.behavior.failReadAfterReconnect && this.reconnected)
      throw new Error(`${this.label} read failed after reconnect`);
    const document = this.behavior.staleAtStart
      ? structuredClone(this.initial)
      : this.behavior.readDocument
        ? this.behavior.readDocument(this.server)
        : structuredClone(this.server.document);
    return { document, cut: this.server.cut() };
  }

  async insert(text: string): Promise<Receipt> {
    if (!this.connected) throw new Error(`${this.label} disconnected`);
    return this.server.insert(this.writerId, text);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async reconnect(): Promise<void> {
    this.connected = true;
    this.reconnected = true;
  }

  async resolve(intentId: string): Promise<Receipt | null> {
    if (!this.connected) throw new Error(`${this.label} disconnected`);
    if (this.behavior.resolve)
      return this.behavior.resolve(this.server, intentId);
    const receipt = this.server.receipts.get(intentId);
    return receipt ? structuredClone(receipt) : null;
  }
}

function port(
  server: FakeServer,
  label: string,
  overrides: Partial<FakeClientInit> = {},
  behavior: FakeBehavior = {},
): FakeClient {
  return new FakeClient(
    {
      label,
      userId: `user-${label}`,
      deviceId: `device-${label}`,
      platform: "darwin",
      writerId: `writer-${label}`,
      ...overrides,
    },
    server,
    behavior,
  );
}

function input(
  a: CommonClient,
  b: CommonClient,
  overrides: Partial<CommonAcceptanceInput> = {},
): CommonAcceptanceInput {
  return {
    a,
    b,
    sourceHash: "source-hash-v1",
    artifactHash: "artifact-hash-v1",
    serverIdentity: "server-identity-v1",
    ...overrides,
  };
}

class CountingClock implements CommonAcceptanceClock {
  sleeps = 0;
  async sleep(): Promise<void> {
    this.sleeps += 1;
  }
}

const evidenceHash = "a".repeat(64);

describe("shared common acceptance contract (NOT PRODUCT; deterministic fake ports)", () => {
  it("passes only from actual read-back, receipt, disconnect and reconnect evidence", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(server, "b", { platform: "win32" });
    const result = await runCommonAcceptance(input(a, b));

    expect(result.commonResult).toBe("PASS");
    expect(result.physical).toBe("NOT_RUN");
    expect(result.phase).toBe("COMMON_ACCEPTANCE");
    expect(result.limitedScope.fullL4).toBe(false);
    expect(result.limitedScope.fullL5).toBe(false);
    expect(result.limitedScope.physical).toBe("NOT_RUN");
    expect(result.physicalEvidence).toBe("ABSENT");
    expect(result.observations.every((entry) => entry.ok)).toBe(true);
    expect(result.observations.map((entry) => entry.step)).toEqual(
      expect.arrayContaining([
        "read-initial",
        "insert",
        "propagate",
        "receipt",
        "disconnect",
        "reconnect",
        "read-after-reconnect",
        "receipt-after-reconnect",
      ]),
    );
    expect(server.seq).toBe(1);
    expect(server.receipts.size).toBe(1);
    expect(
      JSON.stringify(server.document).split(COMMON_ACCEPTANCE_MARKER).length -
        1,
    ).toBe(1);
  });

  it("does not turn optional physical metadata into physical PASS", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(server, "b");
    const result = await runCommonAcceptance(
      input(a, b, {
        physicalEvidence: {
          windowsPorts: [
            {
              hostId: "win-a",
              portId: "p",
              platform: "win32",
              complete: true,
              evidenceHash,
            },
          ],
        },
      }),
    );

    expect(result.commonResult).toBe("PASS");
    expect(result.physical).toBe("NOT_RUN");
    expect(result.physicalEvidence).toBe("UNTRUSTED_IGNORED");
    expect(
      result.observations.find((entry) => entry.step === "physical-evidence")
        ?.code,
    ).toBe("UNTRUSTED_IGNORED");
  });

  it.each([
    ["userId", "USER_NOT_DISTINCT"],
    ["deviceId", "DEVICE_NOT_DISTINCT"],
    ["writerId", "WRITER_NOT_DISTINCT"],
  ] as const)(
    "rejects duplicate %s before touching the server",
    async (field, code) => {
      const server = new FakeServer();
      const a = port(server, "a");
      const duplicate: Partial<FakeClientInit> =
        field === "userId"
          ? { userId: a.userId }
          : field === "deviceId"
            ? { deviceId: a.deviceId }
            : { writerId: a.writerId };
      const b = port(server, "b", duplicate);
      const request = input(a, b);
      const result = await runCommonAcceptance(request);

      expect(result.commonResult).toBe("FAIL");
      expect(result.physical).toBe("NOT_RUN");
      expect(result.observations.find((entry) => !entry.ok)?.code).toBe(code);
      expect(server.seq).toBe(0);
      expect(server.receipts.size).toBe(0);
      expect(request.a).toBe(a);
      expect(request.b).toBe(b);
      expect(a.writerId).toBe("writer-a");
    },
  );

  it("fails bounded polling when the peer never observes the inserted marker", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(server, "b", {}, { staleAtStart: true });
    const clock = new CountingClock();
    const result = await runCommonAcceptance(
      input(a, b, { clock, intervalMs: 10, timeoutMs: 50 }),
    );

    expect(result.commonResult).toBe("FAIL");
    expect(result.physical).toBe("NOT_RUN");
    expect(clock.sleeps).toBe(4);
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "MARKER_NOT_OBSERVED",
    );
    expect(server.seq).toBe(1);
  });

  it("fails when the marker is observed more than once", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(
      server,
      "b",
      {},
      {
        readDocument: (current) =>
          current.seq === 0
            ? structuredClone(current.document)
            : appendText(current.document, COMMON_ACCEPTANCE_MARKER),
      },
    );
    const result = await runCommonAcceptance(input(a, b));

    expect(result.commonResult).toBe("FAIL");
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "MARKER_DUPLICATED",
    );
  });

  it("fails when a successful connection method hides a lost post-reconnect state", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(server, "b", {}, { failReadAfterReconnect: true });
    const result = await runCommonAcceptance(input(a, b));

    expect(result.commonResult).toBe("FAIL");
    expect(result.physical).toBe("NOT_RUN");
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "READ_B_FAILED",
    );
    expect(
      result.observations.find((entry) => entry.step === "reconnect")?.ok,
    ).toBe(true);
  });

  it("fails when the peer cannot resolve the accepted receipt", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(server, "b", {}, { resolve: () => null });
    const result = await runCommonAcceptance(input(a, b));

    expect(result.commonResult).toBe("FAIL");
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "RECEIPT_MISSING",
    );
  });

  it("fails when a resolved receipt has different identity fields", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(
      server,
      "b",
      {},
      {
        resolve: (current, intentId) => {
          const receipt = current.receipts.get(intentId);
          if (!receipt) return null;
          return { ...structuredClone(receipt), writerId: "other-writer" };
        },
      },
    );
    const result = await runCommonAcceptance(input(a, b));

    expect(result.commonResult).toBe("FAIL");
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "RECEIPT_MISMATCH_B",
    );
  });

  it("rejects mismatched current peer documents before inserting anything", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(
      server,
      "b",
      {},
      { readDocument: () => appendText(initialDocument(), "other") },
    );
    const result = await runCommonAcceptance(input(a, b));

    expect(result.commonResult).toBe("FAIL");
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "INITIAL_DOCUMENT_MISMATCH",
    );
    expect(server.seq).toBe(0);
  });

  it("fails before server mutation when required hash metadata is invalid", async () => {
    const server = new FakeServer();
    const a = port(server, "a");
    const b = port(server, "b");
    const result = await runCommonAcceptance(input(a, b, { sourceHash: "" }));

    expect(result.commonResult).toBe("FAIL");
    expect(result.observations.find((entry) => !entry.ok)?.code).toBe(
      "SOURCE_HASH_INVALID",
    );
    expect(server.seq).toBe(0);
  });
});

describe("physical plan gate (NOT PRODUCT; deterministic contract cases)", () => {
  const completeWindowsPort = (hostId: string, portId: string) => ({
    hostId,
    portId,
    platform: "win32" as const,
    complete: true,
    evidenceHash,
  });

  it("allows multi-machine execution only after two separate Windows hosts complete", () => {
    const verdict = verifyPhysicalPlan({
      windowsPorts: [
        completeWindowsPort("win-a", "ordinary"),
        completeWindowsPort("win-b", "ordinary"),
      ],
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.multiMachineAllowed).toBe(true);
    expect(verdict.physical).toBe("NOT_RUN");
    expect(verdict.macGate).toBe("UNCHANGED");
    expect(verdict.blockers).toEqual([]);
    expect(verdict.windowsPorts).toEqual({
      declared: 2,
      complete: 2,
      hosts: 2,
    });
  });

  it("does not let a Mac gate or caller-supplied metadata substitute for Windows ports", () => {
    const verdict = verifyPhysicalPlan({
      windowsPorts: [completeWindowsPort("win-a", "ordinary")],
      macGate: "PASS",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.multiMachineAllowed).toBe(false);
    expect(verdict.physical).toBe("NOT_RUN");
    expect(verdict.macGate).toBe("UNCHANGED");
    expect(verdict.blockers).toContain("WINDOWS_PORTS_INSUFFICIENT");
    expect(verdict.blockers).toContain("WINDOWS_HOSTS_NOT_SEPARATE");
  });

  it("rejects incomplete, wrong-platform and malformed evidence", () => {
    const verdict = verifyPhysicalPlan({
      windowsPorts: [
        { ...completeWindowsPort("win-a", "one"), complete: false },
        completeWindowsPort("win-a", "two"),
        { ...completeWindowsPort("win-b", "three"), platform: "darwin" },
        { ...completeWindowsPort("win-c", "four"), evidenceHash: "not-a-hash" },
      ],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.physical).toBe("NOT_RUN");
    expect(verdict.blockers).toContain("WINDOWS_PORT_INCOMPLETE:0");
    expect(verdict.blockers).toContain("WINDOWS_PORT_PLATFORM:2");
    expect(verdict.blockers).toContain("WINDOWS_PORT_EVIDENCE:3");
    expect(verdict.windowsPorts).toEqual({
      declared: 4,
      complete: 3,
      hosts: 3,
    });
  });

  it("rejects unknown fields and non-plan input without claiming physical execution", () => {
    const unknown = verifyPhysicalPlan({
      windowsPorts: [
        completeWindowsPort("win-a", "one"),
        completeWindowsPort("win-b", "two"),
      ],
      claimedPass: true,
    });
    const invalid = verifyPhysicalPlan(null);

    expect(unknown.ok).toBe(false);
    expect(unknown.blockers).toEqual(["PLAN_UNKNOWN_FIELD:claimedPass"]);
    expect(unknown.physical).toBe("NOT_RUN");
    expect(invalid.ok).toBe(false);
    expect(invalid.blockers).toEqual(["PLAN_INVALID"]);
    expect(invalid.physical).toBe("NOT_RUN");
  });

  it("rejects duplicate Windows port evidence on the same host", () => {
    const verdict = verifyPhysicalPlan({
      windowsPorts: [
        completeWindowsPort("win-a", "same-port"),
        completeWindowsPort("win-a", "same-port"),
        completeWindowsPort("win-b", "other-port"),
      ],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.blockers).toContain("WINDOWS_PORT_DUPLICATE:1");
    expect(verdict.macGate).toBe("UNCHANGED");
  });
});
