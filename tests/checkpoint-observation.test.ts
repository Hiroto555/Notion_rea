import {afterEach, expect, it, vi} from "vitest";
import * as ts from "typescript";
import * as vm from "node:vm";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {RecoveryCheckpoint, type RecoveryWriteRequest} from "../src/renderer/recovery-checkpoint";
import {StorageFailureError} from "../src/renderer/private-request";
import {emptyCrashRecoverySnapshot, type CrashRecoveryRead} from "../src/shared/crash-recovery";
import {canonicalOperation} from "../src/shared/save-contract";
import * as observationShared from "../src/shared/checkpoint-observation";
import {
  CHECKPOINT_OBSERVATION_MAX_EVENTS,
  canonicalJson,
  checkpointObservationConfigFromEnv,
  parseCheckpointObservationBindingJson,
  validateCheckpointObservationRead,
  validateCheckpointObservationReport,
  type CheckpointObservationRead,
} from "../src/shared/checkpoint-observation";

// The real module is kept as the default; only utf8Length is wrapped so tests
// can inject a bookkeeping failure without touching the core validation path.
vi.mock("../src/shared/checkpoint-observation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/shared/checkpoint-observation")>();
  return {...original, utf8Length: vi.fn(original.utf8Length)};
});

const v1 = {testObservation: "v1" as const};
const snapshot = (value: string) => ({...emptyCrashRecoverySnapshot(), rawDrafts: [{scope: "record" as const, pageId: "page", key: "number", value}]});
const bigSnapshot = (entries: number, size: number) => ({...emptyCrashRecoverySnapshot(),
  rawDrafts: Array.from({length: entries}, (_, index) =>
    ({scope: "record" as const, pageId: "page", key: `k${index}`, value: "x".repeat(size)}))});
const ack = (request: RecoveryWriteRequest): CrashRecoveryRead => ({status: "ready", generation: request.expectedGeneration + 1, snapshot: structuredClone(request.snapshot)});
const barrier = () => {let release!: () => void; const promise = new Promise<void>((resolve) => {release = resolve;}); return {release, promise};};

const testBinding = (overrides: Record<string, unknown> = {}) => ({
  schema: "folio.checkpoint-observation-binding.v1",
  runId: "obs-run-1",
  nonce: "123e4567-e89b-42d3-a456-426614174000",
  sourceCandidate: "a".repeat(64),
  artifactSha256: "b".repeat(64),
  fixtureSha256: "c".repeat(64),
  dataDir: "/tmp/folio-observation-data",
  vaultDir: "/tmp/folio-observation-vault",
  ...overrides,
});
const testEnv = (binding: Record<string, unknown> = testBinding()) => ({
  FOLIO_GUI_TEST_OPT_IN: "1",
  FOLIO_CHECKPOINT_OBSERVATION_OPT_IN: "1",
  FOLIO_CHECKPOINT_OBSERVATION_BINDING: canonicalJson(binding),
  FOLIO_DATA_DIR: String(binding.dataDir),
  FOLIO_CREDENTIAL_DIR: String(binding.vaultDir),
});

// Isolated VM realm for renderer-port tests: the production module is
// transpiled to CommonJS and run in a fresh context whose globalThis belongs
// to the realm, so the nonconfigurable read port never lands on the real
// Node global and each realm proves a distinct renderer instance.
function observationRealm(globals: Record<string, unknown> = {}) {
  const transpiled = () => ts.transpileModule(
    readFileSync(fileURLToPath(new URL("../src/renderer/checkpoint-observation.ts", import.meta.url)), "utf8"),
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}},
  ).outputText;
  type Exports = {
    beginCheckpointObservation(
      getQueue: () => {getTestObservation(): unknown} | null,
    ): {testObservation: "v1"} | undefined;
  };
  const realmRequire = (specifier: string) => {
    if (specifier === "../shared/checkpoint-observation") return observationShared;
    throw new Error(`unexpected require: ${specifier}`);
  };
  const sandbox = vm.createContext({...globals});
  const latest = {exports: {} as Exports};
  const evaluate = () => {
    const module = {exports: {} as Exports};
    vm.runInContext(
      `(function (exports, require, module) {\n${transpiled()}\n})`,
      sandbox,
    )(module.exports, realmRequire, module);
    latest.exports = module.exports;
  };
  evaluate();
  return {
    sandbox: sandbox as Record<string, unknown>,
    get exports() {
      return latest.exports;
    },
    rerun: evaluate,
  };
}

afterEach(() => {
  try {delete (globalThis as Record<string, unknown>).folioCheckpointObservationConfig;} catch { /* non-configurable ports stay */ }
  try {delete (globalThis as Record<string, unknown>).folioCheckpointObservation;} catch { /* non-configurable ports stay */ }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps no observation log by default and returns null", async () => {
  const writes: RecoveryWriteRequest[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {writes.push(request); return ack(request);}, 2);
  queue.offer(snapshot("one"));
  await queue.flush();
  expect(queue.getTestObservation()).toBeNull();
  expect(writes).toHaveLength(1);
});

it("records INIT, OFFERED and ACK_APPLIED with the accepted seq, generation and canonical snapshot", async () => {
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 4, undefined, v1);
  const seq = queue.offer(snapshot("alpha"));
  await queue.flush();
  const report = queue.getTestObservation()!;
  expect(report.incomplete).toBe(false);
  expect(report.captureStopped).toBe(false);
  expect(report.events).toHaveLength(3);
  expect(report.events[0]).toEqual({index: 0, type: "INIT", generation: 4, snapshotJson: null});
  expect(report.events[1]).toMatchObject({index: 1, type: "OFFERED", seq});
  expect(report.events[2]).toMatchObject({index: 2, type: "ACK_APPLIED", seq, generation: 5});
  const canonical = canonicalOperation(snapshot("alpha"));
  expect((report.events[1] as {snapshotJson: string}).snapshotJson).toBe(canonical);
  expect((report.events[2] as {snapshotJson: string}).snapshotJson).toBe(canonical);
  expect(report.status).toMatchObject({state: "saved", generation: 5, offeredSeq: 1, savedSeq: 1});
  expect(validateCheckpointObservationReport(report).verdict).toBe("VALID");
});

it("keeps each unsent offer while only the accepted attempt records an ACK", async () => {
  const held = barrier(), entered = barrier(), writes: RecoveryWriteRequest[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {writes.push(request); entered.release(); await held.promise; return ack(request);}, 0, undefined, v1);
  queue.offer(snapshot("first"));
  queue.offer(snapshot("coalesced"));
  const flush = queue.flush();
  await entered.promise;
  held.release();
  await flush;
  const report = queue.getTestObservation()!;
  expect(writes).toHaveLength(1);
  expect(report.events.map((event) => event.type)).toEqual(["INIT", "OFFERED", "OFFERED", "ACK_APPLIED"]);
  const ackEvent = report.events[3] as {seq: number; generation: number; snapshotJson: string};
  expect(ackEvent.seq).toBe(2);
  expect(ackEvent.generation).toBe(1);
  expect(ackEvent.snapshotJson).toBe(canonicalOperation(snapshot("coalesced")));
  expect(validateCheckpointObservationReport(report).verdict).toBe("VALID");
});

it("does not record an ACK for a mismatched or invalid response and keeps the latched error visible", async () => {
  const queue = new RecoveryCheckpoint(async (request) => ({...ack(request), generation: 99}), 3, undefined, v1);
  queue.offer(snapshot("retained"));
  await expect(queue.flush()).rejects.toThrow(/differs/);
  const report = queue.getTestObservation()!;
  expect(report.events.map((event) => event.type)).toEqual(["INIT", "OFFERED"]);
  expect(report.status).toMatchObject({state: "error", generation: 3, savedSeq: 0});
  expect(report.status?.error).toMatch(/differs/);
});

it("keeps the latched timeout error and records only the retry ACK that was actually applied", async () => {
  let attempt = 0;
  const queue = new RecoveryCheckpoint(async (request) =>
    ++attempt === 1 ? new Promise<CrashRecoveryRead>(() => {}) : ack(request),
    0, undefined, {timeoutMs: 5, ...v1});
  queue.offer(snapshot("held"));
  await expect(queue.flush()).rejects.toThrow(/timed out/);
  let report = queue.getTestObservation()!;
  expect(report.events.map((event) => event.type)).toEqual(["INIT", "OFFERED"]);
  expect(report.status?.state).toBe("error");
  await queue.retry();
  report = queue.getTestObservation()!;
  expect(report.events.map((event) => event.type)).toEqual(["INIT", "OFFERED", "ACK_APPLIED"]);
  expect(report.status).toMatchObject({state: "saved", generation: 1, savedSeq: 1});
});

it("detaches recorded snapshots from caller, transport and read-result mutation", async () => {
  const queue = new RecoveryCheckpoint(async (request) => {
    request.snapshot.rawDrafts[0].value = "transport mutation";
    return {...ack(request), snapshot: snapshot("original")};
  }, 0, undefined, v1);
  const input = snapshot("original");
  queue.offer(input);
  input.rawDrafts[0].value = "caller mutation";
  await queue.flush();
  const report = queue.getTestObservation()!;
  const offered = report.events[1] as {snapshotJson: string};
  const acked = report.events[2] as {snapshotJson: string};
  expect(offered.snapshotJson).toBe(canonicalOperation(snapshot("original")));
  expect(acked.snapshotJson).toBe(canonicalOperation(snapshot("original")));
  (offered as {snapshotJson: string}).snapshotJson = "tampered";
  (report.status as {state: string}).state = "tampered";
  const again = queue.getTestObservation()!;
  expect((again.events[1] as {snapshotJson: string}).snapshotJson).toBe(canonicalOperation(snapshot("original")));
  expect(again.status?.state).toBe("saved");
});

it("produces identical write dispatch, status and retry behavior with observation off and on", async () => {
  const run = async (options: {testObservation?: "v1"}) => {
    const writes: RecoveryWriteRequest[] = [];
    const states: string[] = [];
    let failures = 1;
    const queue = new RecoveryCheckpoint(async (request) => {
      writes.push(request);
      if (failures-- > 0) throw new Error("ACK lost");
      return ack(request);
    }, 0, (status) => states.push(status.state), options);
    queue.offer(snapshot("same"));
    queue.offer(snapshot("next"));
    await expect(queue.flush()).rejects.toThrow(/ACK lost/);
    await queue.retry();
    return {writes, states, status: queue.getStatus()};
  };
  const off = await run({});
  const on = await run(v1);
  expect(on.writes).toEqual(off.writes);
  expect(on.states).toEqual(off.states);
  expect(on.status).toEqual(off.status);
  expect(on.writes).toHaveLength(2);
});

it("marks observation incomplete at the event budget while saving continues", async () => {
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined, v1);
  for (let index = 0; index < 100; index++) {
    queue.offer(snapshot(`value-${index}`));
    await queue.flush();
  }
  const report = queue.getTestObservation()!;
  expect(report.events).toHaveLength(CHECKPOINT_OBSERVATION_MAX_EVENTS);
  expect(report.incomplete).toBe(true);
  expect(report.captureStopped).toBe(true);
  queue.offer(snapshot("still-saves"));
  await queue.flush();
  expect(queue.getStatus().state).toBe("saved");
});

it("marks observation incomplete when one snapshot exceeds its budget but the save still applies", async () => {
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined, v1);
  queue.offer(bigSnapshot(2000, 512));
  await queue.flush();
  const report = queue.getTestObservation()!;
  expect(report.incomplete).toBe(true);
  expect(report.captureStopped).toBe(true);
  expect(report.events.map((event) => event.type)).toEqual(["INIT"]);
  expect(report.status).toMatchObject({state: "saved", generation: 1, savedSeq: 1});
});

it("marks observation incomplete when total snapshot bytes exceed the shared budget", async () => {
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined, v1);
  for (let index = 0; index < 5; index++) {
    queue.offer(bigSnapshot(1400, 512 + index));
    await queue.flush();
  }
  const report = queue.getTestObservation()!;
  expect(report.incomplete).toBe(true);
  expect(report.captureStopped).toBe(true);
  expect(queue.getStatus().state).toBe("saved");
});

it("keeps an old ACK from hiding the current latched error", async () => {
  let fail = false;
  const queue = new RecoveryCheckpoint(async (request) => {
    if (fail) throw new Error("later failure");
    return ack(request);
  }, 7, undefined, v1);
  queue.offer(snapshot("accepted"));
  await queue.flush();
  fail = true;
  queue.offer(snapshot("rejected"));
  await expect(queue.flush()).rejects.toThrow(/later failure/);
  const report = queue.getTestObservation()!;
  expect(report.events.map((event) => event.type)).toEqual(["INIT", "OFFERED", "ACK_APPLIED", "OFFERED"]);
  expect(report.status).toMatchObject({state: "error", generation: 8, savedSeq: 1, offeredSeq: 2});
  expect(report.status?.error).toMatch(/later failure/);
});

it("validates the strict bounded binding and the exact env opt-ins", () => {
  const parsed = parseCheckpointObservationBindingJson(canonicalJson(testBinding()));
  expect(parsed).toEqual(testBinding());
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(checkpointObservationConfigFromEnv(testEnv())).toEqual(parsed);
  expect(parseCheckpointObservationBindingJson("not json")).toBeNull();
  expect(parseCheckpointObservationBindingJson("{}")).toBeNull();
  expect(parseCheckpointObservationBindingJson("x".repeat(64 * 1024))).toBeNull();
  expect(parseCheckpointObservationBindingJson(canonicalJson({...testBinding(), extra: 1}))).toBeNull();
  expect(parseCheckpointObservationBindingJson(canonicalJson({...testBinding(), nonce: "not-a-uuid"}))).toBeNull();
  expect(parseCheckpointObservationBindingJson(canonicalJson({...testBinding(), artifactSha256: "g".repeat(64)}))).toBeNull();
  expect(parseCheckpointObservationBindingJson(canonicalJson({...testBinding(), dataDir: testBinding().vaultDir}))).toBeNull();
  expect(parseCheckpointObservationBindingJson(canonicalJson({...testBinding(), dataDir: "relative/dir"}))).toBeNull();
  const env = testEnv();
  expect(checkpointObservationConfigFromEnv({...env, FOLIO_GUI_TEST_OPT_IN: "0"})).toBeNull();
  expect(checkpointObservationConfigFromEnv({...env, FOLIO_CHECKPOINT_OBSERVATION_OPT_IN: "on"})).toBeNull();
  expect(checkpointObservationConfigFromEnv({...env, FOLIO_DATA_DIR: "/tmp/elsewhere"})).toBeNull();
  expect(checkpointObservationConfigFromEnv({...env, FOLIO_CREDENTIAL_DIR: env.FOLIO_DATA_DIR})).toBeNull();
  expect(checkpointObservationConfigFromEnv({FOLIO_GUI_TEST_OPT_IN: "1"})).toBeNull();
});

it("installs a frozen read-only port with a fresh renderer UUID and per-enableRecovery epoch", async () => {
  const realm = observationRealm({crypto: {randomUUID}, folioCheckpointObservationConfig: testBinding()});
  let queue: RecoveryCheckpoint | null = null;
  let failGetQueue = false;
  const first = realm.exports.beginCheckpointObservation(() => {
    if (failGetQueue) throw new Error("queue getter failed");
    return queue;
  });
  expect(first).toEqual({testObservation: "v1"});
  const port = realm.sandbox.folioCheckpointObservation as {read: () => CheckpointObservationRead};
  expect(Object.isFrozen(port)).toBe(true);
  expect(Object.keys(port)).toEqual(["read"]);
  const descriptor = Object.getOwnPropertyDescriptor(realm.sandbox, "folioCheckpointObservation");
  expect(descriptor?.writable).toBe(false);
  expect(descriptor?.configurable).toBe(false);
  queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined, first);
  queue.offer(snapshot("observed"));
  await queue.flush();
  const sample = port.read();
  expect(sample.schema).toBe("folio.checkpoint-observation-read.v1");
  expect(sample.queueEpoch).toBe(1);
  expect(sample.rendererInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(sample.binding).toEqual(testBinding());
  expect(sample.observation?.events.map((event) => event.type)).toEqual(["INIT", "OFFERED", "ACK_APPLIED"]);
  const binding = parseCheckpointObservationBindingJson(canonicalJson(testBinding()))!;
  expect(validateCheckpointObservationRead(sample, {binding}).verdict).toBe("VALID");
  (sample.observation!.events[1] as {snapshotJson: string}).snapshotJson = "tampered";
  expect((port.read().observation!.events[1] as {snapshotJson: string}).snapshotJson).toContain("observed");
  realm.exports.beginCheckpointObservation(() => {
    if (failGetQueue) throw new Error("queue getter failed");
    return queue;
  });
  expect(port.read().queueEpoch).toBe(2);
  // A contained read failure is unavailable evidence, never a crash.
  failGetQueue = true;
  const failedRead = port.read();
  expect(failedRead.observation).toBeNull();
  expect(validateCheckpointObservationRead(failedRead, {binding}).verdict).toBe("INCOMPLETE");
  failGetQueue = false;
  expect(port.read().observation?.status?.state).toBe("saved");
  // A second module instance in the same realm cannot replace the port.
  realm.rerun();
  expect(realm.exports.beginCheckpointObservation(() => queue)).toBeUndefined();
  expect(port.read().rendererInstanceId).toBe(sample.rendererInstanceId);
  // A different realm is a different renderer instance with its own UUID.
  const other = observationRealm({crypto: {randomUUID}, folioCheckpointObservationConfig: testBinding()});
  other.exports.beginCheckpointObservation(() => null);
  const otherPort = other.sandbox.folioCheckpointObservation as {read: () => CheckpointObservationRead};
  const otherId = otherPort.read().rendererInstanceId;
  expect(otherId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(otherId).not.toBe(sample.rendererInstanceId);
});

it("disables observation on invalid/absent config, a throwing getter or missing UUID", async () => {
  expect(observationRealm({crypto: {randomUUID}})
    .exports.beginCheckpointObservation(() => null)).toBeUndefined();
  expect(observationRealm({crypto: {randomUUID},
    folioCheckpointObservationConfig: {...testBinding(), nonce: "bad"}})
    .exports.beginCheckpointObservation(() => null)).toBeUndefined();
  const throwingGetter = observationRealm({crypto: {randomUUID}});
  Object.defineProperty(throwingGetter.sandbox, "folioCheckpointObservationConfig", {
    get: () => {throw new Error("config getter failed");},
    configurable: true,
  });
  expect(throwingGetter.exports.beginCheckpointObservation(() => null)).toBeUndefined();
  expect(observationRealm({crypto: {}, folioCheckpointObservationConfig: testBinding()})
    .exports.beginCheckpointObservation(() => null)).toBeUndefined();
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined, {});
  queue.offer(snapshot("still works"));
  await queue.flush();
  expect(queue.getStatus().state).toBe("saved");
});

it("contains a read-side serialization failure as unavailable observation while saving continues", async () => {
  const realm = observationRealm({crypto: {randomUUID}, folioCheckpointObservationConfig: testBinding()});
  const option = realm.exports.beginCheckpointObservation(() => ({
    getTestObservation: () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return circular;
    },
  }));
  expect(option).toEqual({testObservation: "v1"});
  const port = realm.sandbox.folioCheckpointObservation as {read: () => CheckpointObservationRead};
  const sample = port.read();
  expect(sample.observation).toBeNull();
  expect(sample.rendererInstanceId).toMatch(/^[0-9a-f-]{36}$/);
  const binding = parseCheckpointObservationBindingJson(canonicalJson(testBinding()))!;
  expect(validateCheckpointObservationRead(sample, {binding}).verdict).toBe("INCOMPLETE");
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined, option);
  queue.offer(snapshot("still-saves"));
  await queue.flush();
  expect(queue.getStatus().state).toBe("saved");
  expect(queue.getTestObservation()?.events.map((event) => event.type)).toEqual(["INIT", "OFFERED", "ACK_APPLIED"]);
});

it("rejects fake ACK evidence: initial-generation ACK, unoffered seq and snapshot mismatch", () => {
  const base = (events: unknown[], status: Record<string, unknown>) => ({
    schema: "folio.checkpoint-observation.v1",
    events,
    incomplete: false,
    captureStopped: false,
    status,
  });
  const canon = canonicalOperation(snapshot("v"));
  const okStatus = {state: "saved", generation: 1, offeredSeq: 1, savedSeq: 1};
  expect(validateCheckpointObservationReport(base([
    {index: 0, type: "INIT", generation: 0, snapshotJson: null},
    {index: 1, type: "OFFERED", seq: 1, snapshotJson: canon},
    {index: 2, type: "ACK_APPLIED", seq: 1, generation: 1, snapshotJson: canon},
  ], okStatus)).verdict).toBe("VALID");
  expect(validateCheckpointObservationReport(base([
    {index: 0, type: "INIT", generation: 0, snapshotJson: null},
    {index: 1, type: "OFFERED", seq: 1, snapshotJson: canon},
    {index: 2, type: "ACK_APPLIED", seq: 1, generation: 0, snapshotJson: canon},
  ], {state: "saved", generation: 0, offeredSeq: 1, savedSeq: 1})).verdict).toBe("INVALID");
  expect(validateCheckpointObservationReport(base([
    {index: 0, type: "INIT", generation: 0, snapshotJson: null},
    {index: 1, type: "ACK_APPLIED", seq: 7, generation: 1, snapshotJson: canon},
  ], {state: "saved", generation: 1, offeredSeq: 0, savedSeq: 7})).verdict).toBe("INVALID");
  expect(validateCheckpointObservationReport(base([
    {index: 0, type: "INIT", generation: 0, snapshotJson: null},
    {index: 1, type: "OFFERED", seq: 1, snapshotJson: canon},
    {index: 2, type: "ACK_APPLIED", seq: 1, generation: 1, snapshotJson: canonicalOperation(snapshot("other"))},
  ], okStatus)).verdict).toBe("INVALID");
  expect(validateCheckpointObservationReport({
    ...base([{index: 0, type: "INIT", generation: 0, snapshotJson: null}],
      {state: "saved", generation: 0, offeredSeq: 0, savedSeq: 0}),
    incomplete: true,
    captureStopped: true,
  }).verdict).toBe("INCOMPLETE");
});

it("correlates the read sample with the declared binding and rejects drift", () => {
  const binding = parseCheckpointObservationBindingJson(canonicalJson(testBinding()))!;
  const sample = {
    schema: "folio.checkpoint-observation-read.v1",
    rendererInstanceId: "123e4567-e89b-42d3-a456-426614174000",
    queueEpoch: 1,
    binding: testBinding(),
    observation: {
      schema: "folio.checkpoint-observation.v1",
      events: [{index: 0, type: "INIT", generation: 0, snapshotJson: null}],
      incomplete: false,
      captureStopped: false,
      status: {state: "saved", generation: 0, offeredSeq: 0, savedSeq: 0},
    },
  };
  expect(validateCheckpointObservationRead(sample, {binding}).verdict).toBe("VALID");
  expect(validateCheckpointObservationRead(
    {...sample, binding: {...testBinding(), nonce: "123e4567-e89b-42d3-a456-426614174001"}},
    {binding}).verdict).toBe("INVALID");
  expect(validateCheckpointObservationRead({...sample, rendererInstanceId: "not-a-uuid"}, {binding}).verdict).toBe("INVALID");
  expect(validateCheckpointObservationRead({...sample, observation: null}, {binding}).verdict).toBe("INCOMPLETE");
});

it("disables only observation for a non-literal option value", async () => {
  const queue = new RecoveryCheckpoint(async (request) => ack(request), 0, undefined,
    {testObservation: "later" as "v1"});
  queue.offer(snapshot("fine"));
  await queue.flush();
  expect(queue.getStatus().state).toBe("saved");
  expect(queue.getTestObservation()).toBeNull();
});

it("isolates observation bookkeeping failures from saving and the ACK check", async () => {
  vi.mocked(observationShared.utf8Length).mockImplementationOnce(() => {
    throw new Error("encoder failed");
  });
  const writes: RecoveryWriteRequest[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {writes.push(request); return ack(request);}, 0, undefined, v1);
  queue.offer(snapshot("payload"));
  await queue.flush();
  expect(queue.getStatus().state).toBe("saved");
  expect(writes).toHaveLength(1);
  const report = queue.getTestObservation()!;
  expect(report.events.map((event) => event.type)).toEqual(["INIT"]);
  expect(report.incomplete).toBe(true);
  expect(report.captureStopped).toBe(true);
});

it("keeps a v1 held failure and late-ACK suppression identical with observation on and off", async () => {
  const run = async (options: {testObservation?: "v1"}) => {
    const writes: RecoveryWriteRequest[] = [];
    let releaseFirst: (read: CrashRecoveryRead) => void = () => {};
    const queue = new RecoveryCheckpoint(async (request) => {
      writes.push(request);
      if (writes.length === 1) return new Promise<CrashRecoveryRead>((resolve) => {releaseFirst = resolve;});
      return ack(request);
    }, 0, undefined, {diagnostics: "v1", ...options});
    queue.offer(snapshot("held"));
    const flush = queue.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(1);
    queue.captureFailure(new Error("independent latch"));
    await expect(flush).rejects.toBeInstanceOf(StorageFailureError);
    releaseFirst(ack(writes[0]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(queue.retry()).rejects.toBeInstanceOf(StorageFailureError);
    expect(writes).toHaveLength(1);
    return {status: queue.getStatus(), report: queue.getTestObservation()};
  };
  const off = await run({});
  const on = await run(v1);
  expect(on.status).toEqual(off.status);
  expect(on.status.state).toBe("error");
  expect(on.report!.events.map((event) => event.type)).toEqual(["INIT", "OFFERED"]);
});
