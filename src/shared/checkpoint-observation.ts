// Shared checkpoint observation contract: the env binding parser, event/report
// DTOs and the bounded validators used by the preload, the renderer read port
// and the host-side capture harness. Pure module — no Node builtins — because
// it is bundled into the sandboxed preload.

export const GUI_TEST_OPT_IN_ENV = "FOLIO_GUI_TEST_OPT_IN";
export const CHECKPOINT_OBSERVATION_OPT_IN_ENV = "FOLIO_CHECKPOINT_OBSERVATION_OPT_IN";
export const CHECKPOINT_OBSERVATION_BINDING_ENV = "FOLIO_CHECKPOINT_OBSERVATION_BINDING";
export const OBSERVATION_DATA_DIR_ENV = "FOLIO_DATA_DIR";
export const OBSERVATION_VAULT_DIR_ENV = "FOLIO_CREDENTIAL_DIR";

export const CHECKPOINT_OBSERVATION_BINDING_SCHEMA = "folio.checkpoint-observation-binding.v1";
export const CHECKPOINT_OBSERVATION_SCHEMA = "folio.checkpoint-observation.v1";
export const CHECKPOINT_OBSERVATION_READ_SCHEMA = "folio.checkpoint-observation-read.v1";

export const CHECKPOINT_OBSERVATION_MAX_EVENTS = 128;
export const CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
export const CHECKPOINT_OBSERVATION_MAX_BINDING_BYTES = 16 * 1024;

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DIR_LENGTH = 4096;

export type CheckpointObservationBinding = Readonly<{
  schema: typeof CHECKPOINT_OBSERVATION_BINDING_SCHEMA;
  runId: string;
  nonce: string;
  sourceCandidate: string;
  artifactSha256: string;
  fixtureSha256: string;
  dataDir: string;
  vaultDir: string;
}>;

export type CheckpointObservationEvent =
  | Readonly<{index: number; type: "INIT"; generation: number; snapshotJson: null}>
  | Readonly<{index: number; type: "OFFERED"; seq: number; snapshotJson: string}>
  | Readonly<{index: number; type: "ACK_APPLIED"; seq: number; generation: number; snapshotJson: string}>;

export type CheckpointObservationStatus = Readonly<{
  state: "saved" | "saving" | "error";
  generation: number;
  offeredSeq: number;
  savedSeq: number;
  error?: string;
  storageFailure?: unknown;
}>;

export type CheckpointObservationReport = Readonly<{
  schema: typeof CHECKPOINT_OBSERVATION_SCHEMA;
  events: CheckpointObservationEvent[];
  incomplete: boolean;
  captureStopped: boolean;
  status: CheckpointObservationStatus | null;
}>;

export type CheckpointObservationRead = Readonly<{
  schema: typeof CHECKPOINT_OBSERVATION_READ_SCHEMA;
  rendererInstanceId: string;
  queueEpoch: number;
  binding: CheckpointObservationBinding;
  observation: CheckpointObservationReport | null;
}>;

export type CheckpointObservationVerdict = "VALID" | "INCOMPLETE" | "INVALID";
export type CheckpointObservationValidation = Readonly<{verdict: CheckpointObservationVerdict; problems: string[]}>;

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Python json.dumps(value, sort_keys=True, separators=(",", ":")) equivalent
// for JSON-round-trip values; used for canonical binding/manifest bytes.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

const absoluteDir = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_DIR_LENGTH &&
  (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));

export function isCheckpointObservationBinding(value: unknown): value is CheckpointObservationBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["artifactSha256", "dataDir", "fixtureSha256", "nonce", "runId", "schema", "sourceCandidate", "vaultDir"];
  if (keys.length !== expected.length || !expected.every((key, index) => keys[index] === key)) return false;
  const binding = value as Record<string, unknown>;
  return binding.schema === CHECKPOINT_OBSERVATION_BINDING_SCHEMA &&
    typeof binding.runId === "string" && RUN_ID.test(binding.runId) &&
    typeof binding.nonce === "string" && UUID.test(binding.nonce) &&
    typeof binding.sourceCandidate === "string" && HASH.test(binding.sourceCandidate) &&
    typeof binding.artifactSha256 === "string" && HASH.test(binding.artifactSha256) &&
    typeof binding.fixtureSha256 === "string" && HASH.test(binding.fixtureSha256) &&
    absoluteDir(binding.dataDir) && absoluteDir(binding.vaultDir) &&
    binding.dataDir !== binding.vaultDir;
}

export function parseCheckpointObservationBindingJson(text: unknown): CheckpointObservationBinding | null {
  if (typeof text !== "string" || text.length === 0 || text.length > CHECKPOINT_OBSERVATION_MAX_BINDING_BYTES)
    return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isCheckpointObservationBinding(value)) return null;
  const binding = value as CheckpointObservationBinding;
  return Object.freeze({
    schema: CHECKPOINT_OBSERVATION_BINDING_SCHEMA,
    runId: binding.runId,
    nonce: binding.nonce,
    sourceCandidate: binding.sourceCandidate,
    artifactSha256: binding.artifactSha256,
    fixtureSha256: binding.fixtureSha256,
    dataDir: binding.dataDir,
    vaultDir: binding.vaultDir,
  });
}

// Exact-match opt-ins plus a binding whose declared dirs equal the env dirs.
// Absent or malformed input disables observation only; this never throws.
export function checkpointObservationConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CheckpointObservationBinding | null {
  try {
    if (env[GUI_TEST_OPT_IN_ENV] !== "1" || env[CHECKPOINT_OBSERVATION_OPT_IN_ENV] !== "1") return null;
    const binding = parseCheckpointObservationBindingJson(env[CHECKPOINT_OBSERVATION_BINDING_ENV]);
    if (!binding) return null;
    if (env[OBSERVATION_DATA_DIR_ENV] !== binding.dataDir || env[OBSERVATION_VAULT_DIR_ENV] !== binding.vaultDir)
      return null;
    return binding;
  } catch {
    return null;
  }
}

const nonNegativeInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

// Structural validation of the passive log: INIT first with no snapshot, every
// ACK_APPLIED extending the accepted generation chain by exactly one and
// carrying the byte-identical canonical snapshot of its prior OFFERED. A
// sticky incomplete prefix is reported INCOMPLETE, never promoted to VALID.
export function validateCheckpointObservationReport(report: unknown): CheckpointObservationValidation {
  const problems: string[] = [];
  if (!report || typeof report !== "object" || Array.isArray(report))
    return {verdict: "INVALID", problems: ["report is not an object"]};
  const observed = report as Record<string, unknown>;
  const finish = (): CheckpointObservationValidation => {
    if (problems.length > 0) return {verdict: "INVALID", problems};
    if (observed.incomplete === true || observed.captureStopped === true) return {verdict: "INCOMPLETE", problems};
    return {verdict: "VALID", problems};
  };
  if (observed.schema !== CHECKPOINT_OBSERVATION_SCHEMA) problems.push("unexpected report schema");
  if (typeof observed.incomplete !== "boolean") problems.push("incomplete is not boolean");
  if (typeof observed.captureStopped !== "boolean") problems.push("captureStopped is not boolean");
  const events = observed.events;
  if (!Array.isArray(events) || events.length > CHECKPOINT_OBSERVATION_MAX_EVENTS)
    problems.push("events is not an array within the observation budget");
  const offered = new Map<number, string>();
  let lastOffered = 0;
  let lastAckSeq = 0;
  let generation: number | null = null;
  let initSeen = false;
  if (Array.isArray(events)) {
    for (let index = 0; index < events.length; index++) {
      const event = events[index] as Record<string, unknown> | null;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        problems.push(`event ${index} is not an object`);
        continue;
      }
      if (event.index !== index) problems.push(`event ${index} index mismatch`);
      if (event.type === "INIT") {
        if (index !== 0 || initSeen) problems.push("INIT is not the unique first event");
        initSeen = true;
        if (event.snapshotJson !== null) problems.push("INIT must not carry snapshot or ACK evidence");
        if (nonNegativeInt(event.generation)) generation = event.generation;
        else problems.push("INIT generation is not a non-negative integer");
      } else if (event.type === "OFFERED") {
        if (!initSeen) problems.push("OFFERED appears before INIT");
        if (!positiveInt(event.seq)) problems.push(`event ${index} OFFERED seq is not positive`);
        else {
          if (event.seq !== lastOffered + 1) problems.push(`event ${index} OFFERED seq is not the contiguous next offered seq`);
          if (offered.has(event.seq)) problems.push(`event ${index} OFFERED duplicates a seq`);
          if (typeof event.snapshotJson === "string" && event.snapshotJson.length > 0 &&
              utf8Length(event.snapshotJson) <= CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_BYTES)
            offered.set(event.seq, event.snapshotJson);
          else problems.push(`event ${index} OFFERED snapshot is missing or unbounded`);
          lastOffered = Math.max(lastOffered, event.seq);
        }
      } else if (event.type === "ACK_APPLIED") {
        if (positiveInt(event.seq)) {
          const prior = offered.get(event.seq);
          if (prior === undefined) problems.push(`event ${index} ACK has no matching prior OFFERED`);
          else if (prior !== event.snapshotJson)
            problems.push(`event ${index} ACK snapshot differs from the offered capture`);
          if (event.seq <= lastAckSeq) problems.push(`event ${index} ACK seq is not strictly increasing`);
          lastAckSeq = event.seq;
        } else problems.push(`event ${index} ACK seq is not positive`);
        if (positiveInt(event.generation)) {
          if (generation === null) problems.push(`event ${index} ACK has no initial generation to advance`);
          else if (event.generation !== generation + 1)
            problems.push(`event ${index} ACK generation does not extend the accepted chain`);
          else generation = event.generation;
        } else problems.push(`event ${index} ACK generation is not positive`);
      } else problems.push(`event ${index} has an unknown type`);
    }
  }
  if (!initSeen) problems.push("report has no INIT event");
  const status = observed.status;
  if (status === null || status === undefined) {
    problems.push("current status was not captured");
  } else if (typeof status !== "object" || Array.isArray(status)) {
    problems.push("current status is not an object");
  } else {
    const current = status as Record<string, unknown>;
    if (current.state !== "saved" && current.state !== "saving" && current.state !== "error")
      problems.push("current status state is unknown");
    if (!nonNegativeInt(current.generation)) problems.push("current status generation is invalid");
    if (!nonNegativeInt(current.offeredSeq)) problems.push("current status offeredSeq is invalid");
    if (!nonNegativeInt(current.savedSeq)) problems.push("current status savedSeq is invalid");
    if (current.state === "error" && typeof current.error !== "string")
      problems.push("current error status lacks the latched error message");
    if (nonNegativeInt(current.offeredSeq) && current.offeredSeq !== lastOffered)
      problems.push("current offeredSeq does not match the observed offers");
    if (nonNegativeInt(current.savedSeq) && current.savedSeq !== lastAckSeq)
      problems.push("current savedSeq does not match the applied ACKs");
    if (generation !== null && nonNegativeInt(current.generation) && current.generation !== generation)
      problems.push("current generation does not match the accepted chain");
    if (current.state === "saving" && nonNegativeInt(current.savedSeq) && nonNegativeInt(current.offeredSeq) &&
        current.savedSeq >= current.offeredSeq) problems.push("saving status has nothing outstanding");
    if (current.state === "saved" && nonNegativeInt(current.savedSeq) && nonNegativeInt(current.offeredSeq) &&
        current.savedSeq !== current.offeredSeq) problems.push("saved status still has unsaved offers");
  }
  return finish();
}

// Validation of one read() sample: read schema, renderer UUID, positive queue
// epoch, valid binding and — when an expected binding is supplied — canonical
// equality with the declared observation binding. observation:null stays
// INCOMPLETE rather than being promoted or counted as evidence.
export function validateCheckpointObservationRead(
  read: unknown,
  expected: {binding?: CheckpointObservationBinding} = {},
): CheckpointObservationValidation {
  const problems: string[] = [];
  if (!read || typeof read !== "object" || Array.isArray(read))
    return {verdict: "INVALID", problems: ["read result is not an object"]};
  const sample = read as Record<string, unknown>;
  if (sample.schema !== CHECKPOINT_OBSERVATION_READ_SCHEMA) problems.push("unexpected read schema");
  if (typeof sample.rendererInstanceId !== "string" || !UUID.test(sample.rendererInstanceId))
    problems.push("rendererInstanceId is not a UUID");
  if (!positiveInt(sample.queueEpoch)) problems.push("queueEpoch is not a positive integer");
  if (!isCheckpointObservationBinding(sample.binding)) problems.push("read binding is not a valid observation binding");
  else if (expected.binding !== undefined && canonicalJson(sample.binding) !== canonicalJson(expected.binding))
    problems.push("read binding does not match the declared observation binding");
  if (sample.observation === null || sample.observation === undefined)
    return {verdict: problems.length > 0 ? "INVALID" : "INCOMPLETE", problems};
  const report = validateCheckpointObservationReport(sample.observation);
  problems.push(...report.problems);
  if (problems.length > 0) return {verdict: "INVALID", problems};
  return {verdict: report.verdict, problems};
}
