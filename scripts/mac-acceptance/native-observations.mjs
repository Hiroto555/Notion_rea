import { z } from "zod";

export const NATIVE_SCENARIOS = ["IME", "REOPEN", "RESERVATION_REDISPLAY"];

const SHA256 = /^[a-f0-9]{64}$/;
const JAPANESE =
  /[\u3005\u3006\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
const sha256 = z.string().regex(SHA256);
const pid = z.number().int().positive().max(2147483647);
const documentId = z.string().min(1).max(200);
const common = {
  executed: z.boolean(),
  synthetic: z.boolean(),
  trusted: z.boolean(),
};

const imeEventSchema = z
  .object({
    kind: z.enum(["start", "update", "end"]),
    trusted: z.boolean(),
  })
  .strict();

const imeSchema = z
  .object({
    scenario: z.literal("IME"),
    ...common,
    routeEstablished: z.boolean(),
    events: z.array(imeEventSchema).max(256).optional(),
    committedText: z.string().max(10000).optional(),
    committedSha256: sha256.optional(),
    persistedSha256: sha256.optional(),
  })
  .strict();

const snapshotSchema = z
  .object({
    documentId,
    revisionSha256: sha256,
    contentSha256: sha256,
  })
  .strict();

const reopenSchema = z
  .object({
    scenario: z.literal("REOPEN"),
    ...common,
    trustedAction: z.boolean().optional(),
    beforePid: pid.optional(),
    afterPid: pid.optional(),
    exitCode: z.number().int().min(0).max(255).nullable().optional(),
    exitSignal: z.string().max(32).nullable().optional(),
    before: snapshotSchema.optional(),
    after: snapshotSchema.optional(),
  })
  .strict();

const reservationSchema = z
  .object({
    scenario: z.literal("RESERVATION_REDISPLAY"),
    ...common,
    trustedClose: z.boolean().optional(),
    commitAttempted: z.boolean(),
    commitSucceeded: z.boolean(),
    beforePid: pid.optional(),
    afterPid: pid.optional(),
    inputPreserved: z.boolean().optional(),
    reservationPreserved: z.boolean().optional(),
  })
  .strict();

const observationSchema = z.discriminatedUnion("scenario", [
  imeSchema,
  reopenSchema,
  reservationSchema,
]);

const result = (status, reason) => ({
  status,
  reason,
  productResult: "NOT_RUN",
});
const pass = () => result("PASS", "OBSERVED_PASS");
const fail = (reason) => result("FAIL", reason);
const blocked = (reason) => result("INFRA_BLOCKED", reason);
const notRun = (reason) => result("NOT_RUN", reason);

const isJapaneseText = (value) =>
  typeof value === "string" && value.length > 0 && JAPANESE.test(value);

const isCompleteReopen = (o) =>
  !!o.before &&
  !!o.after &&
  o.beforePid != null &&
  o.afterPid != null &&
  o.exitCode !== undefined &&
  o.exitSignal !== undefined;

const assessIme = (o) => {
  if (o.routeEstablished !== true) return blocked("INPUT_ROUTE_MISSING");
  if (
    o.events === undefined ||
    o.committedText === undefined ||
    o.committedSha256 === undefined ||
    o.persistedSha256 === undefined
  )
    return notRun("OBSERVATION_INCOMPLETE");
  const events = o.events;
  if (events.some((event) => event.trusted !== true))
    return blocked("UNTRUSTED_INPUT_EVENTS");
  const ordered =
    events.length >= 3 &&
    events[0].kind === "start" &&
    events[events.length - 1].kind === "end" &&
    events.slice(1, -1).every((event) => event.kind === "update");
  if (!ordered) return fail("INPUT_LOST");
  if (!isJapaneseText(o.committedText)) {
    if (typeof o.committedText === "string" && o.committedText.length > 0)
      return fail("CONTENT_NOT_JAPANESE");
    return fail("INPUT_LOST");
  }
  if (o.committedSha256 !== o.persistedSha256)
    return fail("PERSISTENCE_MISMATCH");
  return pass();
};

const assessReopen = (o) => {
  if (o.trustedAction !== true) return blocked("UNTRUSTED_ACTION");
  if (!isCompleteReopen(o)) return notRun("OBSERVATION_INCOMPLETE");
  if (o.beforePid === o.afterPid) return fail("SAME_PID");
  if (o.exitCode !== 0 || o.exitSignal !== null) return fail("NONZERO_EXIT");
  if (o.before.documentId !== o.after.documentId)
    return fail("DOCUMENT_ID_MISMATCH");
  if (o.before.revisionSha256 !== o.after.revisionSha256)
    return fail("REVISION_MISMATCH");
  if (o.before.contentSha256 !== o.after.contentSha256)
    return fail("CONTENT_MISMATCH");
  return pass();
};

const assessReservation = (o) => {
  if (o.trustedClose !== true) return blocked("UNTRUSTED_CLOSE");
  if (o.commitAttempted !== true) return notRun("COMMIT_NOT_ATTEMPTED");
  if (o.commitSucceeded !== false) return fail("COMMIT_UNEXPECTEDLY_SUCCEEDED");
  if (
    o.beforePid == null ||
    o.afterPid == null ||
    o.inputPreserved === undefined ||
    o.reservationPreserved === undefined
  )
    return notRun("OBSERVATION_INCOMPLETE");
  if (o.beforePid !== o.afterPid) return fail("PID_CHANGED");
  if (o.inputPreserved !== true) return fail("INPUT_NOT_PRESERVED");
  if (o.reservationPreserved !== true) return fail("RESERVATION_NOT_PRESERVED");
  return pass();
};

export function assessNativeObservation(input) {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) return notRun("INVALID_OBSERVATION");
  const observation = parsed.data;
  if (observation.executed !== true) return notRun("NOT_EXECUTED");
  if (observation.synthetic !== false) return notRun("SYNTHETIC_NOT_EXECUTED");
  if (observation.trusted !== true) return blocked("UNTRUSTED_HARNESS");
  switch (observation.scenario) {
    case "IME":
      return assessIme(observation);
    case "REOPEN":
      return assessReopen(observation);
    case "RESERVATION_REDISPLAY":
      return assessReservation(observation);
    default:
      return notRun("INVALID_OBSERVATION");
  }
}
