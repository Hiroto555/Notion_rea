import { describe, expect, it } from "vitest";
import {
  assessNativeObservation,
  NATIVE_SCENARIOS,
} from "../../scripts/mac-acceptance/native-observations.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const ime = (overrides: Record<string, unknown> = {}) => ({
  scenario: "IME",
  executed: true,
  synthetic: false,
  trusted: true,
  routeEstablished: true,
  events: [
    { kind: "start", trusted: true },
    { kind: "update", trusted: true },
    { kind: "end", trusted: true },
  ],
  committedText: "こんにちは世界",
  committedSha256: HASH_A,
  persistedSha256: HASH_A,
  ...overrides,
});

const reopen = (overrides: Record<string, unknown> = {}) => ({
  scenario: "REOPEN",
  executed: true,
  synthetic: false,
  trusted: true,
  trustedAction: true,
  beforePid: 4100,
  afterPid: 4200,
  exitCode: 0,
  exitSignal: null,
  before: {
    documentId: "doc-1",
    revisionSha256: HASH_B,
    contentSha256: HASH_C,
  },
  after: {
    documentId: "doc-1",
    revisionSha256: HASH_B,
    contentSha256: HASH_C,
  },
  ...overrides,
});

const reservation = (overrides: Record<string, unknown> = {}) => ({
  scenario: "RESERVATION_REDISPLAY",
  executed: true,
  synthetic: false,
  trusted: true,
  trustedClose: true,
  commitAttempted: true,
  commitSucceeded: false,
  beforePid: 4300,
  afterPid: 4300,
  inputPreserved: true,
  reservationPreserved: true,
  ...overrides,
});

const willNotPass = (input: unknown) => {
  const result = assessNativeObservation(input);
  expect(result.status).not.toBe("PASS");
  expect(result.productResult).toBe("NOT_RUN");
  return result;
};

describe("native observation assessment (pure metadata, no OS access)", () => {
  it("exports the three residual scenarios", () => {
    expect(NATIVE_SCENARIOS).toEqual([
      "IME",
      "REOPEN",
      "RESERVATION_REDISPLAY",
    ]);
  });

  it("accepts complete observed records without claiming product acceptance", () => {
    for (const input of [ime(), reopen(), reservation()])
      expect(assessNativeObservation(input)).toEqual({
        status: "PASS",
        reason: "OBSERVED_PASS",
        productResult: "NOT_RUN",
      });
  });

  it("never lets an unexecuted, synthetic or untrusted record claim execution", () => {
    for (const input of [
      ime({ executed: false }),
      ime({ synthetic: true }),
      reopen({ synthetic: true }),
      reservation({ synthetic: true }),
      ime({ trusted: false }),
      reopen({ trusted: false }),
    ])
      expect(willNotPass(input).status).not.toBe("PASS");
  });

  it("returns NOT_RUN when execution was not declared", () => {
    expect(willNotPass(ime({ executed: false }))).toMatchObject({
      status: "NOT_RUN",
      reason: "NOT_EXECUTED",
    });
    expect(willNotPass(reopen({ executed: false }))).toMatchObject({
      status: "NOT_RUN",
      reason: "NOT_EXECUTED",
    });
    expect(willNotPass(reservation({ executed: false }))).toMatchObject({
      status: "NOT_RUN",
      reason: "NOT_EXECUTED",
    });
  });

  it("treats synthetic input and unknown fields as NOT_RUN, never acceptance", () => {
    expect(willNotPass(ime({ synthetic: true }))).toMatchObject({
      status: "NOT_RUN",
      reason: "SYNTHETIC_NOT_EXECUTED",
    });
    expect(willNotPass({ ...ime(), extra: "marker" })).toMatchObject({
      status: "NOT_RUN",
      reason: "INVALID_OBSERVATION",
    });
    expect(
      willNotPass(
        ime({
          events: [
            { kind: "start", trusted: true, synthesized: true },
            { kind: "update", trusted: true },
            { kind: "end", trusted: true },
          ],
        }),
      ),
    ).toMatchObject({ status: "NOT_RUN", reason: "INVALID_OBSERVATION" });
    expect(willNotPass({ ...ime(), scenario: "UNKNOWN" })).toMatchObject({
      status: "NOT_RUN",
      reason: "INVALID_OBSERVATION",
    });
    expect(willNotPass(null)).toMatchObject({
      status: "NOT_RUN",
      reason: "INVALID_OBSERVATION",
    });
    expect(willNotPass("synthetic")).toMatchObject({
      status: "NOT_RUN",
      reason: "INVALID_OBSERVATION",
    });
  });

  it("separates a missing IME route (infrastructure) from lost input (product)", () => {
    expect(willNotPass(ime({ routeEstablished: false }))).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "INPUT_ROUTE_MISSING",
    });
    expect(
      willNotPass(ime({ routeEstablished: false, events: [] })),
    ).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "INPUT_ROUTE_MISSING",
    });
    expect(willNotPass(ime({ committedText: "" }))).toMatchObject({
      status: "FAIL",
      reason: "INPUT_LOST",
    });
    expect(willNotPass(ime({ events: [] }))).toMatchObject({
      status: "FAIL",
      reason: "INPUT_LOST",
    });
  });

  it("rejects an established IME route that lost or corrupted its input", () => {
    expect(
      willNotPass(
        ime({
          events: [
            { kind: "start", trusted: true },
            { kind: "end", trusted: true },
            { kind: "update", trusted: true },
          ],
        }),
      ),
    ).toMatchObject({ status: "FAIL", reason: "INPUT_LOST" });
    expect(willNotPass(ime({ committedText: "hello world" }))).toMatchObject({
      status: "FAIL",
      reason: "CONTENT_NOT_JAPANESE",
    });
    expect(willNotPass(ime({ committedText: "1234" }))).toMatchObject({
      status: "FAIL",
      reason: "CONTENT_NOT_JAPANESE",
    });
    expect(willNotPass(ime({ persistedSha256: HASH_B }))).toMatchObject({
      status: "FAIL",
      reason: "PERSISTENCE_MISMATCH",
    });
    expect(willNotPass(ime({ persistedSha256: undefined }))).toMatchObject({
      status: "NOT_RUN",
      reason: "OBSERVATION_INCOMPLETE",
    });
  });

  it("does not infer a trusted IME route from untrusted event markers", () => {
    expect(
      willNotPass(
        ime({
          events: [
            { kind: "start", trusted: true },
            { kind: "update", trusted: false },
            { kind: "end", trusted: true },
          ],
        }),
      ),
    ).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "UNTRUSTED_INPUT_EVENTS",
    });
    expect(
      willNotPass(
        ime({
          events: [
            { kind: "start", trusted: true },
            { kind: "update", trusted: true },
            { kind: "end", trusted: true },
          ],
          trusted: false,
        }),
      ),
    ).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "UNTRUSTED_HARNESS",
    });
  });

  it("requires a reopen to prove a new process, zero exit and matching document state", () => {
    expect(willNotPass(reopen({ afterPid: 4100 }))).toMatchObject({
      status: "FAIL",
      reason: "SAME_PID",
    });
    expect(willNotPass(reopen({ exitCode: 1 }))).toMatchObject({
      status: "FAIL",
      reason: "NONZERO_EXIT",
    });
    expect(willNotPass(reopen({ exitSignal: "SIGTERM" }))).toMatchObject({
      status: "FAIL",
      reason: "NONZERO_EXIT",
    });
    expect(
      willNotPass(
        reopen({
          after: {
            documentId: "doc-2",
            revisionSha256: HASH_B,
            contentSha256: HASH_C,
          },
        }),
      ),
    ).toMatchObject({ status: "FAIL", reason: "DOCUMENT_ID_MISMATCH" });
    expect(
      willNotPass(
        reopen({
          after: {
            documentId: "doc-1",
            revisionSha256: HASH_A,
            contentSha256: HASH_C,
          },
        }),
      ),
    ).toMatchObject({ status: "FAIL", reason: "REVISION_MISMATCH" });
    expect(
      willNotPass(
        reopen({
          after: {
            documentId: "doc-1",
            revisionSha256: HASH_B,
            contentSha256: HASH_A,
          },
        }),
      ),
    ).toMatchObject({ status: "FAIL", reason: "CONTENT_MISMATCH" });
  });

  it("refuses to treat a reopen marker alone as an observation", () => {
    expect(
      willNotPass({
        scenario: "REOPEN",
        executed: true,
        synthetic: false,
        trusted: true,
        trustedAction: true,
      }),
    ).toMatchObject({
      status: "NOT_RUN",
      reason: "OBSERVATION_INCOMPLETE",
    });
    expect(willNotPass(reopen({ trustedAction: false }))).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "UNTRUSTED_ACTION",
    });
  });

  it("requires reservation redisplay to keep the same process and preserve both inputs", () => {
    expect(willNotPass(reservation({ trustedClose: false }))).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "UNTRUSTED_CLOSE",
    });
    expect(willNotPass(reservation({ commitAttempted: false }))).toMatchObject({
      status: "NOT_RUN",
      reason: "COMMIT_NOT_ATTEMPTED",
    });
    expect(willNotPass(reservation({ commitSucceeded: true }))).toMatchObject({
      status: "FAIL",
      reason: "COMMIT_UNEXPECTEDLY_SUCCEEDED",
    });
    expect(willNotPass(reservation({ afterPid: 4301 }))).toMatchObject({
      status: "FAIL",
      reason: "PID_CHANGED",
    });
    expect(willNotPass(reservation({ inputPreserved: false }))).toMatchObject({
      status: "FAIL",
      reason: "INPUT_NOT_PRESERVED",
    });
    expect(
      willNotPass(reservation({ reservationPreserved: false })),
    ).toMatchObject({ status: "FAIL", reason: "RESERVATION_NOT_PRESERVED" });
  });

  it("returns NOT_RUN for an incomplete reservation redisplay rather than a false PASS", () => {
    for (const input of [
      reservation({ beforePid: undefined }),
      reservation({ afterPid: undefined }),
      reservation({ inputPreserved: undefined }),
      reservation({ reservationPreserved: undefined }),
    ])
      expect(willNotPass(input)).toMatchObject({
        status: "NOT_RUN",
        reason: "OBSERVATION_INCOMPLETE",
      });
  });

  it("rejects unknown fields on reopen and reservation records", () => {
    expect(
      willNotPass({ ...reopen(), trustedActionMarker: true }),
    ).toMatchObject({ status: "NOT_RUN", reason: "INVALID_OBSERVATION" });
    expect(
      willNotPass({
        ...reservation(),
        before: { documentId: "doc-1" },
      }),
    ).toMatchObject({ status: "NOT_RUN", reason: "INVALID_OBSERVATION" });
  });

  it("never reports a PASS for an unexecuted or synthetic reservation", () => {
    expect(willNotPass(reservation({ synthetic: true })).status).toBe(
      "NOT_RUN",
    );
    expect(willNotPass(reservation({ executed: false })).status).toBe(
      "NOT_RUN",
    );
    expect(willNotPass(reservation({ trusted: false }))).toMatchObject({
      status: "INFRA_BLOCKED",
      reason: "UNTRUSTED_HARNESS",
    });
  });

  it("accepts multiple trusted updates in one composition and keeps missing observations untested", () => {
    expect(
      assessNativeObservation(
        ime({
          events: [
            { kind: "start", trusted: true },
            { kind: "update", trusted: true },
            { kind: "update", trusted: true },
            { kind: "end", trusted: true },
          ],
        }),
      ).status,
    ).toBe("PASS");
    for (const input of [
      ime({ events: undefined }),
      ime({ committedText: undefined }),
      ime({ persistedSha256: undefined }),
    ])
      expect(assessNativeObservation(input).status).toBe("NOT_RUN");
  });
});
