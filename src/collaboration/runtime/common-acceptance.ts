import {
  sameScope,
  wellFormed,
  type Cut,
  type Receipt,
  type Scope,
} from "./contract";
import { canonical } from "./canonical";

export const COMMON_ACCEPTANCE_MARKER = "共同編集🙂";

export interface CommonClient {
  label: string;
  userId: string;
  deviceId: string;
  platform: string;
  writerId: string;
  read(): Promise<{ document: unknown; cut: Cut }>;
  insert(text: string): Promise<Receipt>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  resolve(intentId: string): Promise<Receipt | null>;
}

export interface CommonAcceptanceClock {
  sleep(ms: number): Promise<void>;
}

export interface CommonAcceptanceInput {
  a: CommonClient;
  b: CommonClient;
  sourceHash: string;
  artifactHash: string;
  serverIdentity: string;
  physicalEvidence?: unknown;
  clock?: CommonAcceptanceClock;
  intervalMs?: number;
  timeoutMs?: number;
}

export type CommonObservation = Readonly<{
  step: string;
  ok: boolean;
  code: string;
  detail: string;
}>;

export type CommonAcceptanceResult = Readonly<{
  commonResult: "PASS" | "FAIL";
  physical: "NOT_RUN";
  observations: readonly CommonObservation[];
  inputs: Readonly<{
    sourceHash: string;
    artifactHash: string;
    serverIdentity: string;
  }>;
  phase: "COMMON_ACCEPTANCE";
  limitedScope: Readonly<{
    phase: "COMMON_ACCEPTANCE";
    scope: "COMMON_ACCEPTANCE_ONLY";
    fullL4: false;
    fullL5: false;
    physical: "NOT_RUN";
  }>;
  physicalEvidence: "ABSENT" | "UNTRUSTED_IGNORED";
}>;

export type WindowsPortCompletion = Readonly<{
  hostId: string;
  portId: string;
  platform: "win32";
  complete: boolean;
  evidenceHash: string;
}>;

export type PhysicalAcceptancePlan = Readonly<{
  windowsPorts: readonly WindowsPortCompletion[];
  macGate?: unknown;
}>;

export type PhysicalPlanVerdict = Readonly<{
  ok: boolean;
  physical: "NOT_RUN";
  multiMachineAllowed: boolean;
  macGate: "UNCHANGED";
  blockers: readonly string[];
  windowsPorts: Readonly<{
    declared: number;
    complete: number;
    hosts: number;
  }>;
}>;

class AcceptanceFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly detail = "",
    public readonly step?: string,
  ) {
    super(code);
    this.name = "AcceptanceFailure";
  }
}

function fail(code: string, detail = "", step?: string): never {
  throw new AcceptanceFailure(code, detail, step);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommonClient(value: unknown): value is CommonClient {
  return (
    isObject(value) &&
    typeof value.label === "string" &&
    typeof value.userId === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.platform === "string" &&
    typeof value.writerId === "string" &&
    typeof value.read === "function" &&
    typeof value.insert === "function" &&
    typeof value.disconnect === "function" &&
    typeof value.reconnect === "function" &&
    typeof value.resolve === "function"
  );
}

function requiredText(value: unknown, code: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !wellFormed(value)
  )
    fail(code);
  return value;
}

function checkedCut(value: unknown, code: string): Cut {
  if (!isObject(value)) fail(code);
  const epoch = requiredText(value.epoch, code);
  const hash = requiredText(value.hash, code);
  if (
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0
  )
    fail(code);
  return { epoch, seq: value.seq, hash };
}

function checkedScope(value: unknown, code: string): Scope {
  if (!isObject(value)) fail(code);
  return {
    orgId: requiredText(value.orgId, code),
    workspaceId: requiredText(value.workspaceId, code),
    documentId: requiredText(value.documentId, code),
    incarnationId: requiredText(value.incarnationId, code),
  };
}

function checkedReceipt(value: unknown, code: string): Receipt {
  if (!isObject(value)) fail(code);
  if (value.v !== 1) fail(code);
  const status: Receipt["status"] =
    value.status === "SERVER_ACCEPTED" ||
    value.status === "REJECTED" ||
    value.status === "INVALIDATED"
      ? value.status
      : fail(code);
  if (value.code !== null && typeof value.code !== "string") fail(code);
  const receiptCode =
    typeof value.code === "string" ? requiredText(value.code, code) : null;
  return {
    v: 1,
    status,
    intentId: requiredText(value.intentId, code),
    intentHash: requiredText(value.intentHash, code),
    attemptId: requiredText(value.attemptId, code),
    attemptHash: requiredText(value.attemptHash, code),
    writerId: requiredText(value.writerId, code),
    scope: checkedScope(value.scope, code),
    cut: checkedCut(value.cut, code),
    resultHash: requiredText(value.resultHash, code),
    code: receiptCode,
  };
}

type ReadSnapshot = Readonly<{ document: unknown; cut: Cut }>;

function checkedRead(value: unknown, label: string): ReadSnapshot {
  const code = `READ_${label}_INVALID`;
  if (!isObject(value)) fail(code);
  if (!isObject(value.document)) fail(code);
  return {
    document: value.document,
    cut: checkedCut(value.cut, `CUT_${label}_INVALID`),
  };
}

function errorText(error: unknown): string {
  if (error instanceof AcceptanceFailure)
    return [error.code, error.detail].filter(Boolean).join(": ");
  if (error instanceof Error)
    return `${error.name}: ${error.message.slice(0, 300)}`;
  return typeof error === "string" ? error.slice(0, 300) : "non-error";
}

function markerCount(value: unknown, marker: string): number {
  let count = 0;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      if (key === "text" && typeof child === "string") {
        let index = 0;
        while ((index = child.indexOf(marker, index)) !== -1) {
          count += 1;
          index += marker.length;
        }
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return count;
}

function documentKey(value: unknown): string {
  try {
    return canonical(value);
  } catch (error) {
    fail("DOCUMENT_INVALID", errorText(error));
  }
}

function sameCut(a: Cut, b: Cut): boolean {
  return a.epoch === b.epoch && a.seq === b.seq && a.hash === b.hash;
}

function sameReceipt(a: Receipt, b: Receipt): boolean {
  return (
    a.v === b.v &&
    a.status === b.status &&
    a.intentId === b.intentId &&
    a.intentHash === b.intentHash &&
    a.attemptId === b.attemptId &&
    a.attemptHash === b.attemptHash &&
    a.writerId === b.writerId &&
    sameScope(a.scope, b.scope) &&
    sameCut(a.cut, b.cut) &&
    a.resultHash === b.resultHash &&
    a.code === b.code
  );
}

function assertSameReceipt(
  actual: Receipt,
  expected: Receipt,
  label: string,
): void {
  if (!sameReceipt(actual, expected))
    fail(`RECEIPT_MISMATCH_${label}`, "resolved receipt differs");
}

function addObservation(
  observations: CommonObservation[],
  step: string,
  code = "OK",
  detail = "",
): void {
  observations.push({ step, ok: true, code, detail });
}

async function action<T>(
  observations: CommonObservation[],
  step: string,
  code: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    const value = await work();
    addObservation(observations, step);
    return value;
  } catch (error) {
    if (error instanceof AcceptanceFailure)
      throw new AcceptanceFailure(error.code, error.detail, error.step ?? step);
    throw new AcceptanceFailure(code, errorText(error), step);
  }
}

type PollResult = Readonly<{ snapshot: ReadSnapshot; attempts: number }>;

async function pollMarker(
  client: CommonClient,
  label: string,
  marker: string,
  clock: CommonAcceptanceClock,
  intervalMs: number,
  timeoutMs: number,
  step: string,
): Promise<PollResult> {
  const attempts = Math.max(
    1,
    Math.min(1000, Math.ceil(timeoutMs / intervalMs)),
  );
  let lastCount = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let raw: unknown;
    try {
      raw = await client.read();
    } catch (error) {
      throw new AcceptanceFailure(
        `READ_${label}_FAILED`,
        errorText(error),
        step,
      );
    }
    const snapshot = checkedRead(raw, label);
    lastCount = markerCount(snapshot.document, marker);
    if (lastCount > 1) fail("MARKER_DUPLICATED", `count=${lastCount}`, step);
    if (lastCount === 1) return { snapshot, attempts: attempt };
    if (attempt < attempts) await clock.sleep(intervalMs);
  }
  fail("MARKER_NOT_OBSERVED", `count=${lastCount} attempts=${attempts}`, step);
}

function boundedPollOption(
  value: unknown,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximum
  )
    fail("POLL_OPTION_INVALID", name);
  return value;
}

const systemClock: CommonAcceptanceClock = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

type VerifiedIdentity = Readonly<{
  userId: string;
  deviceId: string;
  platform: string;
  writerId: string;
}>;

function verifiedIdentity(
  client: CommonClient,
  label: string,
): VerifiedIdentity {
  requiredText(client.label, `CLIENT_${label}_LABEL_INVALID`, 128);
  return {
    userId: requiredText(client.userId, `CLIENT_${label}_USER_INVALID`, 128),
    deviceId: requiredText(
      client.deviceId,
      `CLIENT_${label}_DEVICE_INVALID`,
      128,
    ),
    platform: requiredText(
      client.platform,
      `CLIENT_${label}_PLATFORM_INVALID`,
      128,
    ),
    writerId: requiredText(
      client.writerId,
      `CLIENT_${label}_WRITER_INVALID`,
      128,
    ),
  };
}

function physicalPortText(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    wellFormed(value)
  );
}

export function verifyPhysicalPlan(plan: unknown): PhysicalPlanVerdict {
  const blockers: string[] = [];
  const hosts = new Set<string>();
  const portKeys = new Set<string>();
  let declared = 0;
  let complete = 0;

  const verdict = (): PhysicalPlanVerdict => {
    const ok =
      blockers.length === 0 &&
      declared >= 2 &&
      complete >= 2 &&
      hosts.size >= 2;
    return {
      ok,
      physical: "NOT_RUN",
      multiMachineAllowed: ok,
      macGate: "UNCHANGED",
      blockers,
      windowsPorts: { declared, complete, hosts: hosts.size },
    };
  };

  if (!isObject(plan)) {
    blockers.push("PLAN_INVALID");
    return verdict();
  }
  for (const key of Object.keys(plan)) {
    if (key !== "windowsPorts" && key !== "macGate")
      blockers.push(`PLAN_UNKNOWN_FIELD:${key}`);
  }
  const ports = plan.windowsPorts;
  if (!Array.isArray(ports)) {
    blockers.push("WINDOWS_PORTS_MISSING");
    return verdict();
  }
  declared = ports.length;
  if (ports.length < 2) blockers.push("WINDOWS_PORTS_INSUFFICIENT");
  ports.forEach((entry, index) => {
    if (!isObject(entry)) {
      blockers.push(`WINDOWS_PORT_INVALID:${index}`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (
        key !== "hostId" &&
        key !== "portId" &&
        key !== "platform" &&
        key !== "complete" &&
        key !== "evidenceHash"
      )
        blockers.push(`WINDOWS_PORT_UNKNOWN_FIELD:${index}:${key}`);
    }
    const validHost = physicalPortText(entry.hostId);
    const validPort = physicalPortText(entry.portId);
    const validEvidence =
      typeof entry.evidenceHash === "string" &&
      /^[0-9a-fA-F]{64}$/.test(entry.evidenceHash);
    if (entry.platform !== "win32")
      blockers.push(`WINDOWS_PORT_PLATFORM:${index}`);
    if (!validHost) blockers.push(`WINDOWS_PORT_HOST:${index}`);
    if (!validPort) blockers.push(`WINDOWS_PORT_ID:${index}`);
    if (entry.complete !== true)
      blockers.push(`WINDOWS_PORT_INCOMPLETE:${index}`);
    else complete += 1;
    if (!validEvidence) blockers.push(`WINDOWS_PORT_EVIDENCE:${index}`);
    if (validHost && validPort) {
      const key = `${entry.hostId}\u0000${entry.portId}`;
      if (portKeys.has(key)) blockers.push(`WINDOWS_PORT_DUPLICATE:${index}`);
      portKeys.add(key);
      hosts.add(String(entry.hostId));
    }
  });
  if (hosts.size < 2) blockers.push("WINDOWS_HOSTS_NOT_SEPARATE");
  return verdict();
}

export async function runCommonAcceptance(
  input: CommonAcceptanceInput,
): Promise<CommonAcceptanceResult> {
  const observations: CommonObservation[] = [];
  let sourceHash = "";
  let artifactHash = "";
  let serverIdentity = "";
  let physicalEvidence: "ABSENT" | "UNTRUSTED_IGNORED" = "ABSENT";
  const makeResult = (
    commonResult: "PASS" | "FAIL",
  ): CommonAcceptanceResult => ({
    commonResult,
    physical: "NOT_RUN",
    observations: [...observations],
    inputs: { sourceHash, artifactHash, serverIdentity },
    phase: "COMMON_ACCEPTANCE",
    limitedScope: {
      phase: "COMMON_ACCEPTANCE",
      scope: "COMMON_ACCEPTANCE_ONLY",
      fullL4: false,
      fullL5: false,
      physical: "NOT_RUN",
    },
    physicalEvidence,
  });

  try {
    if (!isObject(input)) fail("INPUT_INVALID");
    const a = input.a;
    const b = input.b;
    if (!isCommonClient(a)) fail("CLIENT_A_INVALID");
    if (!isCommonClient(b)) fail("CLIENT_B_INVALID");
    sourceHash = requiredText(input.sourceHash, "SOURCE_HASH_INVALID");
    artifactHash = requiredText(input.artifactHash, "ARTIFACT_HASH_INVALID");
    serverIdentity = requiredText(
      input.serverIdentity,
      "SERVER_IDENTITY_INVALID",
    );
    physicalEvidence =
      input.physicalEvidence === undefined ? "ABSENT" : "UNTRUSTED_IGNORED";
    const intervalMs = boundedPollOption(
      input.intervalMs,
      25,
      60_000,
      "intervalMs",
    );
    const timeoutMs = boundedPollOption(
      input.timeoutMs,
      1_500,
      120_000,
      "timeoutMs",
    );
    const clock = input.clock ?? systemClock;
    if (
      !isObject(clock) ||
      typeof (clock as Partial<CommonAcceptanceClock>).sleep !== "function"
    )
      fail("CLOCK_INVALID");

    const identityA = verifiedIdentity(a, "A");
    const identityB = verifiedIdentity(b, "B");
    if (identityA.userId === identityB.userId) fail("USER_NOT_DISTINCT");
    if (identityA.deviceId === identityB.deviceId) fail("DEVICE_NOT_DISTINCT");
    if (identityA.writerId === identityB.writerId) fail("WRITER_NOT_DISTINCT");
    addObservation(
      observations,
      "identity",
      "OK",
      "users/devices/writers distinct",
    );

    const initialA = await action(
      observations,
      "read-initial-a",
      "READ_A_FAILED",
      async () => checkedRead(await a.read(), "A"),
    );
    const initialB = await action(
      observations,
      "read-initial-b",
      "READ_B_FAILED",
      async () => checkedRead(await b.read(), "B"),
    );
    if (documentKey(initialA.document) !== documentKey(initialB.document))
      fail("INITIAL_DOCUMENT_MISMATCH");
    if (initialA.cut.epoch !== initialB.cut.epoch)
      fail("INITIAL_EPOCH_MISMATCH");
    if (
      markerCount(initialA.document, COMMON_ACCEPTANCE_MARKER) !== 0 ||
      markerCount(initialB.document, COMMON_ACCEPTANCE_MARKER) !== 0
    )
      fail("MARKER_PREEXISTS");
    addObservation(
      observations,
      "read-initial",
      "OK",
      `seqA=${initialA.cut.seq} seqB=${initialB.cut.seq}`,
    );

    const inserted = await action(
      observations,
      "insert",
      "INSERT_FAILED",
      async () => {
        const value = checkedReceipt(
          await a.insert(COMMON_ACCEPTANCE_MARKER),
          "INSERT_RECEIPT_INVALID",
        );
        if (value.status !== "SERVER_ACCEPTED")
          fail("INSERT_NOT_ACCEPTED", value.status);
        if (value.writerId !== identityA.writerId)
          fail("INSERT_WRITER_MISMATCH");
        if (value.cut.epoch !== initialA.cut.epoch)
          fail("INSERT_EPOCH_MISMATCH");
        return value;
      },
    );

    const propagated = await pollMarker(
      b,
      "B",
      COMMON_ACCEPTANCE_MARKER,
      clock,
      intervalMs,
      timeoutMs,
      "propagate",
    );
    if (propagated.snapshot.cut.epoch !== inserted.cut.epoch)
      fail("CUT_EPOCH_MISMATCH");
    if (propagated.snapshot.cut.seq < inserted.cut.seq)
      fail("CUT_BEHIND_RECEIPT");
    addObservation(
      observations,
      "propagate",
      "OK",
      `attempts=${propagated.attempts} seq=${propagated.snapshot.cut.seq}`,
    );

    await action(observations, "receipt", "RECEIPT_QUERY_FAILED", async () => {
      const fromA = await a.resolve(inserted.intentId);
      const fromB = await b.resolve(inserted.intentId);
      if (fromA === null || fromB === null) fail("RECEIPT_MISSING");
      const receiptA = checkedReceipt(fromA, "RECEIPT_A_INVALID");
      const receiptB = checkedReceipt(fromB, "RECEIPT_B_INVALID");
      assertSameReceipt(receiptA, inserted, "A");
      assertSameReceipt(receiptB, inserted, "B");
    });

    await action(observations, "disconnect", "DISCONNECT_FAILED", async () => {
      await b.disconnect();
    });
    await action(observations, "reconnect", "RECONNECT_FAILED", async () => {
      await b.reconnect();
    });

    const afterReconnect = await pollMarker(
      b,
      "B",
      COMMON_ACCEPTANCE_MARKER,
      clock,
      intervalMs,
      timeoutMs,
      "read-after-reconnect",
    );
    if (afterReconnect.snapshot.cut.epoch !== inserted.cut.epoch)
      fail("CUT_EPOCH_MISMATCH_AFTER_RECONNECT");
    if (afterReconnect.snapshot.cut.seq < inserted.cut.seq)
      fail("CUT_BEHIND_RECEIPT_AFTER_RECONNECT");
    addObservation(
      observations,
      "read-after-reconnect",
      "OK",
      `attempts=${afterReconnect.attempts} seq=${afterReconnect.snapshot.cut.seq}`,
    );

    await action(
      observations,
      "receipt-after-reconnect",
      "RECEIPT_QUERY_FAILED",
      async () => {
        const value = await b.resolve(inserted.intentId);
        if (value === null) fail("RECEIPT_MISSING_AFTER_RECONNECT");
        assertSameReceipt(
          checkedReceipt(value, "RECEIPT_AFTER_RECONNECT_INVALID"),
          inserted,
          "AFTER_RECONNECT",
        );
      },
    );

    addObservation(
      observations,
      "physical-evidence",
      physicalEvidence,
      physicalEvidence === "ABSENT"
        ? "no physical evidence supplied"
        : "physical metadata is untrusted and ignored",
    );
    addObservation(
      observations,
      "limited-scope",
      "DECLARED",
      "common-only; full L4/L5 and physical certification are not produced",
    );
    return makeResult("PASS");
  } catch (error) {
    const failure =
      error instanceof AcceptanceFailure
        ? error
        : new AcceptanceFailure("UNEXPECTED", errorText(error));
    observations.push({
      step: failure.step ?? "acceptance",
      ok: false,
      code: failure.code,
      detail: failure.detail,
    });
    return makeResult("FAIL");
  }
}
