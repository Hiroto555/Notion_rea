// Node protocol + semantic checks for the packaged-Mac MT11/MT12 session
// helpers. These exercise the pure contract surface only (schema, strict
// seq, bounded wx, envelope handling, comparison logic); they are NOT proof
// that any real app, window, or human action ever happened.
import {describe, expect, it} from "vitest";
import type {ElectronApplication} from "@playwright/test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  GROWTH_LIMITS_SETTINGS_KEY,
  INTERRUPT_LATEST_BODY,
  INTERRUPT_LATEST_TITLE,
  MANUAL_ACTIONS,
  MANUAL_COMMAND_MAX_BYTES,
  MANUAL_COMMAND_SCHEMA,
  MANUAL_COMMAND_TTL_MS,
  MANUAL_MODE_ENV,
  MANUAL_MODES,
  MANUAL_READY_SCHEMA,
  MANUAL_SEGMENT_WAIT_MS,
  MANUAL_TEST_TIMEOUT_MS,
  PHYSICAL_BODY_LINE_1,
  PHYSICAL_BODY_LINE_2,
  PLANNED_ACTIVE_PAGE_BODY,
  PLANNED_RECORD_BODY,
  PLANNED_RECORD_NOTE,
  ackAppliedEvents,
  ackSnapshotMatchesGoal,
  awaitManualCommand,
  closeOwnedApp,
  commandBasename,
  docOrderedPlainParagraphs,
  docPlainParagraphText,
  fixtureAssetProblems,
  fixtureComparisonProblems,
  isCommandBasename,
  isDiagnosticEnvelope,
  issueManualCommand,
  jsonEqual,
  limitsStorageProblems,
  manualMode,
  parseManualMode,
  publishManualReady,
  readManualCommandFile,
  receiptStatus,
  validateManualCommand,
  validateManualReady,
  verifyExportFile,
  writeImmutableEvidence,
} from "./e2e/mac-trial-packaged-session";
import {seedMacTrial, type MacTrialManifest} from "../scripts/mac-trial-seed";
import {Store} from "../src/persistence/store";
import {WorkspaceLimitSettings} from "../src/persistence/workspace-limit-settings";
import type {Doc} from "../src/shared/types";

const HASH64 = "a".repeat(64);
const binding = {
  runId: "run-test-1",
  nonce: "nonce-test-1",
  sourceCandidate: HASH64,
  artifactSha256: HASH64,
  fixtureSha256: HASH64,
};

function fakeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-manual-")));
  const evidenceDir = join(root, "evidence");
  const data = join(root, "workspace");
  const vault = join(root, "workspace-credentials");
  mkdirSync(evidenceDir, {mode: 0o700});
  mkdirSync(data, {mode: 0o700});
  mkdirSync(vault, {mode: 0o700});
  return {root, evidenceDir, data, vault};
}

describe("manual mode selection", () => {
  it("accepts exactly the two bounded scenarios", () => {
    expect(MANUAL_MODES).toEqual(["physical", "quit-interrupt"]);
    expect(parseManualMode("physical")).toBe("physical");
    expect(parseManualMode("quit-interrupt")).toBe("quit-interrupt");
    expect(() => parseManualMode("auto")).toThrowError(/MANUAL_MODE/);
    expect(() => parseManualMode(1)).toThrowError(/MANUAL_MODE/);
    expect(manualMode({})).toBeNull();
    expect(manualMode({[MANUAL_MODE_ENV]: "physical"})).toBe("physical");
    expect(() => manualMode({[MANUAL_MODE_ENV]: "bogus"})).toThrowError();
  });

  it("keeps the manual bounds inside the existing monitor envelope", () => {
    expect(MANUAL_TEST_TIMEOUT_MS).toBeLessThanOrEqual(210000);
    expect(MANUAL_SEGMENT_WAIT_MS).toBeLessThanOrEqual(180000);
    expect(MANUAL_SEGMENT_WAIT_MS).toBeLessThan(MANUAL_TEST_TIMEOUT_MS);
    expect(MANUAL_TEST_TIMEOUT_MS).toBeLessThan(240000);
    expect(MANUAL_COMMAND_TTL_MS).toBeLessThanOrEqual(MANUAL_SEGMENT_WAIT_MS);
    expect(MANUAL_ACTIONS).toEqual(["sample", "interrupt", "cancel"]);
  });
});

describe("manual command protocol", () => {
  it("formats strict command basenames only", () => {
    expect(commandBasename(1)).toBe("command-0001.json");
    expect(commandBasename(9999)).toBe("command-9999.json");
    expect(() => commandBasename(0)).toThrowError(/MANUAL_COMMAND/);
    expect(() => commandBasename(10000)).toThrowError(/MANUAL_COMMAND/);
    expect(() => commandBasename(1.5)).toThrowError(/MANUAL_COMMAND/);
    expect(isCommandBasename("command-0001.json")).toBe(true);
    expect(isCommandBasename("command-1.json")).toBe(false);
    expect(isCommandBasename("../command-0001.json")).toBe(false);
    expect(isCommandBasename("command-0001.json.bak")).toBe(false);
  });

  it("validates the frozen command schema exactly", () => {
    const valid = {
      v: 1,
      schema: MANUAL_COMMAND_SCHEMA,
      runId: binding.runId,
      nonce: binding.nonce,
      seq: 1,
      action: "sample",
      at: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z",
    };
    expect(() =>
      validateManualCommand(valid, {runId: binding.runId, nonce: binding.nonce, seq: 1}),
    ).not.toThrow();
    const bad: Array<[string, unknown]> = [
      ["extra key", {...valid, exec: "rm -rf /"}],
      ["missing key", (() => {const c = {...valid} as Record<string, unknown>; delete c.seq; return c;})()],
      ["wrong schema", {...valid, schema: "v2"}],
      ["wrong action", {...valid, action: "exec"}],
      ["seq mismatch", {...valid, seq: 2}],
      ["runId mismatch", {...valid, runId: "other"}],
      ["nonce mismatch", {...valid, nonce: "other"}],
      ["expiry not after at", {...valid, expiresAt: valid.at}],
      ["non-ISO at", {...valid, at: "soon"}],
    ];
    for (const [label, value] of bad)
      expect(
        () => validateManualCommand(value, {runId: binding.runId, nonce: binding.nonce, seq: 1}),
        label,
      ).toThrowError(/MANUAL_COMMAND/);
  });

  it("issues bounded wx commands, forbids overwrite/reset, and reads them back", () => {
    const fixture = fakeFixture();
    const issued = issueManualCommand(fixture, binding, {seq: 1, action: "sample"});
    expect(issued.path).toBe(join(fixture.evidenceDir, "command-0001.json"));
    const stat = lstatSync(issued.path);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBeLessThanOrEqual(MANUAL_COMMAND_MAX_BYTES);
    const roundtrip = readManualCommandFile(fixture, {
      runId: binding.runId,
      nonce: binding.nonce,
      seq: 1,
    });
    expect(roundtrip.action).toBe("sample");
    // wx: a second command with the same seq can never overwrite or reset.
    expect(() =>
      issueManualCommand(fixture, binding, {seq: 1, action: "cancel"}),
    ).toThrowError();
    const second = issueManualCommand(fixture, binding, {seq: 2, action: "interrupt"});
    expect(
      readManualCommandFile(fixture, {
        runId: binding.runId,
        nonce: binding.nonce,
        seq: 2,
      }).action,
    ).toBe("interrupt");
    // Producer-side ttl is bounded by the same contract the reader enforces.
    expect(() =>
      issueManualCommand(fixture, binding, {
        seq: 3,
        action: "sample",
        ttlMs: MANUAL_COMMAND_TTL_MS + 1,
      }),
    ).toThrowError(/MANUAL_COMMAND/);
  });

  it("rejects symlink/oversized/public/non-JSON/wrong-seq commands via the pinned reader", () => {
    const fixture = fakeFixture();
    const expect2 = {runId: binding.runId, nonce: binding.nonce};
    const issued = issueManualCommand(fixture, binding, {seq: 1, action: "sample"});
    const link = join(fixture.evidenceDir, "command-0002.json");
    symlinkSync(issued.path, link);
    expect(() =>
      readManualCommandFile(fixture, {...expect2, seq: 2}),
    ).toThrowError(/MANUAL_COMMAND/);
    const big = join(fixture.evidenceDir, "command-0003.json");
    writeFileSync(big, " ".repeat(MANUAL_COMMAND_MAX_BYTES + 1), {mode: 0o600});
    expect(() =>
      readManualCommandFile(fixture, {...expect2, seq: 3}),
    ).toThrowError(/MANUAL_COMMAND/);
    const notJson = join(fixture.evidenceDir, "command-0004.json");
    writeFileSync(notJson, "no", {mode: 0o600});
    expect(() =>
      readManualCommandFile(fixture, {...expect2, seq: 4}),
    ).toThrowError(/MANUAL_COMMAND/);
    const publicFile = join(fixture.evidenceDir, "command-0005.json");
    writeFileSync(publicFile, JSON.stringify({...issued.command, seq: 5}), {mode: 0o600});
    chmodSync(publicFile, 0o644);
    expect(() =>
      readManualCommandFile(fixture, {...expect2, seq: 5}),
    ).toThrowError(/MANUAL_COMMAND/);
    // Wrong seq: the basename for seq 6 simply does not exist.
    expect(() =>
      readManualCommandFile(fixture, {...expect2, seq: 6}),
    ).toThrowError();
    // Outside the owned fixture: the reader is pinned to its own root and
    // cannot address this fixture's command at all.
    const foreign = fakeFixture();
    expect(() =>
      readManualCommandFile(foreign, {...expect2, seq: 1}),
    ).toThrowError();
  });

  it("rejects symlinked control dirs and intermediate ancestors even when they resolve inside the root", () => {
    const fixture = fakeFixture();
    const expect1 = {runId: binding.runId, nonce: binding.nonce, seq: 1};
    // Declared evidenceDir IS a symlink into a real private descendant.
    const realDir = join(fixture.root, "real-evidence");
    mkdirSync(realDir, {mode: 0o700});
    issueManualCommand(
      {root: fixture.root, evidenceDir: realDir},
      binding,
      {seq: 1, action: "sample"},
    );
    const linkDir = join(fixture.root, "link-evidence");
    symlinkSync(realDir, linkDir, "dir");
    expect(() =>
      readManualCommandFile(
        {root: fixture.root, evidenceDir: linkDir},
        expect1,
      ),
    ).toThrowError(/MANUAL_COMMAND/);
    // An intermediate ancestor is a symlink into a real private descendant.
    const realA = join(fixture.root, "real-a");
    mkdirSync(join(realA, "evidence"), {mode: 0o700, recursive: true});
    issueManualCommand(
      {root: fixture.root, evidenceDir: join(realA, "evidence")},
      binding,
      {seq: 1, action: "sample"},
    );
    const mid = join(fixture.root, "mid");
    symlinkSync(realA, mid, "dir");
    expect(() =>
      readManualCommandFile(
        {root: fixture.root, evidenceDir: join(mid, "evidence")},
        expect1,
      ),
    ).toThrowError(/MANUAL_COMMAND/);
  });

  it("rejects expired, future-issued, overlong-ttl and out-of-set commands", () => {
    const fixture = fakeFixture();
    const expect1 = {runId: binding.runId, nonce: binding.nonce, seq: 1};
    const issued = issueManualCommand(fixture, binding, {seq: 1, action: "sample"});
    const at = Date.parse(issued.command.at);
    // Expired: an explicit clock past expiresAt (production uses Date.now()).
    expect(() =>
      readManualCommandFile(fixture, {
        ...expect1,
        now: Date.parse(issued.command.expiresAt) + 1,
      }),
    ).toThrowError(/MANUAL_COMMAND/);
    // Expired AT the boundary: now === expiresAt is already expired.
    expect(() =>
      readManualCommandFile(fixture, {
        ...expect1,
        now: Date.parse(issued.command.expiresAt),
      }),
    ).toThrowError(/MANUAL_COMMAND/);
    // One millisecond before expiry is still valid.
    expect(
      readManualCommandFile(fixture, {
        ...expect1,
        now: Date.parse(issued.command.expiresAt) - 1,
      }).action,
    ).toBe("sample");
    // Future-issued: an explicit clock before at.
    expect(() =>
      readManualCommandFile(fixture, {...expect1, now: at - 1000}),
    ).toThrowError(/MANUAL_COMMAND/);
    // Overlong ttl: hand-crafted (the issuer itself refuses this).
    const overlong = {
      ...issued.command,
      seq: 7,
      expiresAt: new Date(at + MANUAL_COMMAND_TTL_MS + 60000).toISOString(),
    };
    writeFileSync(
      join(fixture.evidenceDir, "command-0007.json"),
      JSON.stringify(overlong),
      {mode: 0o600},
    );
    expect(() =>
      readManualCommandFile(fixture, {...expect1, seq: 7}),
    ).toThrowError(/MANUAL_COMMAND/);
    // Action not in the accepted set for this wait.
    issueManualCommand(fixture, binding, {seq: 8, action: "interrupt"});
    expect(() =>
      readManualCommandFile(fixture, {
        ...expect1,
        seq: 8,
        actions: ["sample", "cancel"],
      }),
    ).toThrowError(/MANUAL_COMMAND/);
  });

  it("awaitManualCommand consumes only valid external commands", async () => {
    const fixture = fakeFixture();
    const miss = await awaitManualCommand(fixture, binding, {
      seq: 8,
      actions: ["sample", "cancel"],
      timeoutMs: 300,
      pollMs: 50,
    });
    expect(miss.kind).toBe("timeout");
    // The producer helper stands in for the ROOT's external write; specs
    // themselves never call it.
    issueManualCommand(fixture, binding, {seq: 8, action: "sample"});
    const hit = await awaitManualCommand(fixture, binding, {
      seq: 8,
      actions: ["sample", "cancel"],
      timeoutMs: 2000,
      pollMs: 50,
    });
    expect(hit.kind).toBe("received");
    if (hit.kind === "received") expect(hit.command.action).toBe("sample");
    writeFileSync(
      join(fixture.evidenceDir, "command-0009.json"),
      JSON.stringify({bogus: true}),
      {mode: 0o600},
    );
    const invalid = await awaitManualCommand(fixture, binding, {
      seq: 9,
      actions: ["sample"],
      timeoutMs: 2000,
      pollMs: 50,
    });
    expect(invalid.kind).toBe("invalid");
  });

  it("keeps evidence immutable: no overwrite of an existing basename", () => {
    const fixture = fakeFixture();
    writeImmutableEvidence(fixture, "note.json", {v: 1});
    expect(() =>
      writeImmutableEvidence(fixture, "note.json", {v: 2}),
    ).toThrowError();
    expect(() =>
      writeImmutableEvidence(fixture, "../escape.json", {v: 1}),
    ).toThrowError(/MANUAL_OUTPUT/);
  });
});

describe("manual ready evidence", () => {
  const readySetup = () => {
    const fixture = fakeFixture();
    const readyCtx = {
      runId: binding.runId,
      nonce: binding.nonce,
      executablePath: "/x/Folio.app/Contents/MacOS/Folio",
      dataDir: fixture.data,
      vaultDir: fixture.vault,
      evidenceDir: fixture.evidenceDir,
      controlDirectory: fixture.evidenceDir,
      sourceCandidate: binding.sourceCandidate,
      artifactSha256: binding.artifactSha256,
      fixtureSha256: binding.fixtureSha256,
    };
    return {fixture, readyCtx};
  };

  it("publishes a schema-valid ready file inside the evidence dir", () => {
    const {fixture, readyCtx} = readySetup();
    const {path, ready} = publishManualReady(fixture, binding, {
      pid: 4321,
      executablePath: readyCtx.executablePath,
      windowTitle: `folio-manual-${binding.nonce}`,
      deadlineAt: new Date(Date.now() + 120000).toISOString(),
    });
    expect(path).toBe(join(fixture.evidenceDir, "manual-ready.json"));
    expect(ready.schema).toBe(MANUAL_READY_SCHEMA);
    expect(() => validateManualReady(ready, readyCtx)).not.toThrow();
  });

  it("rejects ready evidence that drifts from the frozen facts", () => {
    const {fixture, readyCtx} = readySetup();
    const {ready} = publishManualReady(fixture, binding, {
      pid: 4321,
      executablePath: readyCtx.executablePath,
      windowTitle: `folio-manual-${binding.nonce}`,
      deadlineAt: new Date(Date.now() + 120000).toISOString(),
      issuedAt: new Date().toISOString(),
    });
    const base = JSON.parse(JSON.stringify(ready)) as Record<string, unknown>;
    const cases: Array<[string, unknown, typeof readyCtx]> = [
      ["wrong pid", {...base, pid: 0}, readyCtx],
      ["wrong nonce", {...base, nonce: "x"}, readyCtx],
      ["non-unique title", {...base, windowTitle: "Folio"}, readyCtx],
      ["data drift", base, {...readyCtx, dataDir: "/elsewhere"}],
      ["exe drift", base, {...readyCtx, executablePath: "/other/Folio"}],
      [
        "deadline mismatch",
        {...base, remainingMs: (base.remainingMs as number) - 1},
        readyCtx,
      ],
      [
        "expectations drift",
        {...base, expectations: {...(base.expectations as object), fixtureSha256: "b".repeat(64)}},
        readyCtx,
      ],
      ["extra key", {...base, extra: true}, readyCtx],
    ];
    for (const [label, value, ctx] of cases)
      expect(() => validateManualReady(value, ctx), label).toThrowError(
        /MANUAL_READY/,
      );
  });
});

describe("diagnostic envelope + receipt semantics", () => {
  it("reads status from the diagnostic envelope and the legacy direct result", () => {
    const envelope = {
      tag: "folio-request-result",
      version: 1,
      ok: true,
      valueSlot: {
        present: true,
        value: {status: "applied", operationId: "op-1"},
      },
    };
    expect(isDiagnosticEnvelope(envelope)).toBe(true);
    expect(receiptStatus(envelope)).toBe("applied");
    const unknownEnvelope = {
      tag: "folio-request-result",
      version: 1,
      ok: true,
      valueSlot: {present: true, value: {status: "unknown"}},
    };
    expect(isDiagnosticEnvelope(unknownEnvelope)).toBe(true);
    expect(receiptStatus(unknownEnvelope)).toBe("unknown");
    // An incomplete envelope without tag/version/ok is rejected outright —
    // never unwrapped as if it were a legacy direct result.
    const incomplete = {valueSlot: {value: {status: "unknown"}}};
    expect(isDiagnosticEnvelope(incomplete)).toBe(false);
    expect(receiptStatus(incomplete)).toBeUndefined();
    expect(isDiagnosticEnvelope({status: "applied"})).toBe(false);
    expect(receiptStatus({status: "applied"})).toBe("applied");
    expect(receiptStatus(null)).toBeUndefined();
  });
});

describe("semantic document + ack checks", () => {
  const para = (text: string) => ({
    type: "doc",
    content: [{type: "paragraph", content: [{type: "text", text}]}],
  });
  const doc = (text: string): Doc => ({
    type: "doc",
    content: [{type: "paragraph", content: [{type: "text", text}]}],
  });

  it("accepts only the exact intended single plain paragraph", () => {
    expect(docPlainParagraphText(para(PLANNED_ACTIVE_PAGE_BODY))).toBe(
      PLANNED_ACTIVE_PAGE_BODY,
    );
    expect(
      docPlainParagraphText({
        type: "doc",
        content: [
          {type: "paragraph", content: [{type: "text", text: "a"}]},
          {type: "paragraph", content: [{type: "text", text: "b"}]},
        ],
      }),
    ).toBeNull();
    expect(
      docPlainParagraphText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{type: "text", text: "a", marks: [{type: "bold"}]}],
          },
        ],
      }),
    ).toBeNull();
    expect(docPlainParagraphText(null)).toBeNull();
    expect(docPlainParagraphText({type: "paragraph"})).toBeNull();
  });

  it("matches ACK goals by typed seq-ordered merge, never by substring", () => {
    const snapshotJson = JSON.stringify({
      pages: [
        {
          base: {id: "p1", title: "old", doc: doc("before")},
          operation: {
            operationId: "op-9",
            seq: 2,
            patch: {title: INTERRUPT_LATEST_TITLE},
          },
          intents: [{seq: 3, patch: {doc: doc(INTERRUPT_LATEST_BODY)}}],
        },
        {
          base: {id: "p2", title: "other", doc: doc("else")},
          operation: {operationId: "op-other", seq: 1, patch: {}},
          intents: [],
        },
      ],
    });
    const goal = {
      pageId: "p1",
      operationId: "op-9",
      title: INTERRUPT_LATEST_TITLE,
      bodyTexts: [INTERRUPT_LATEST_BODY],
    };
    expect(ackSnapshotMatchesGoal(snapshotJson, goal)).toBe(true);
    // Whole frozen operation deep-exact when provided.
    expect(
      ackSnapshotMatchesGoal(snapshotJson, {
        ...goal,
        operation: {
          operationId: "op-9",
          seq: 2,
          patch: {title: INTERRUPT_LATEST_TITLE},
        },
      }),
    ).toBe(true);
    expect(
      ackSnapshotMatchesGoal(snapshotJson, {
        ...goal,
        operation: {operationId: "op-9", seq: 2, patch: {title: "different"}},
      }),
    ).toBe(false);
    // A later intent overrides an older value that merely matched the goal.
    const overridden = JSON.stringify({
      pages: [
        {
          base: {id: "p1", title: "t", doc: doc("a")},
          operation: {
            operationId: "op-9",
            seq: 2,
            patch: {title: INTERRUPT_LATEST_TITLE},
          },
          intents: [{seq: 3, patch: {title: "C later"}}],
        },
      ],
    });
    expect(
      ackSnapshotMatchesGoal(overridden, {
        pageId: "p1",
        operationId: "op-9",
        title: INTERRUPT_LATEST_TITLE,
      }),
    ).toBe(false);
    // The operationId string only inside an unrelated field must not match.
    const unrelated = JSON.stringify({
      pages: [
        {
          base: {id: "p1", title: "t", doc: doc("a")},
          intents: [{seq: 1, patch: {title: "mentions op-9"}}],
          debug: "op-9",
        },
      ],
    });
    expect(
      ackSnapshotMatchesGoal(unrelated, {pageId: "p1", operationId: "op-9"}),
    ).toBe(false);
    // Wrong page / wrong body / non-JSON all fail.
    expect(ackSnapshotMatchesGoal(snapshotJson, {...goal, pageId: "p2"})).toBe(false);
    expect(
      ackSnapshotMatchesGoal(snapshotJson, {...goal, bodyTexts: ["different"]}),
    ).toBe(false);
    expect(ackSnapshotMatchesGoal("not json", goal)).toBe(false);
    const sample = {
      observation: {
        events: [
          {type: "OFFERED", index: 0, seq: 1, generation: 0, snapshotJson: "{}"},
          {type: "ACK_APPLIED", index: 1, seq: 2, generation: 1, snapshotJson},
        ],
      },
    };
    const acks = ackAppliedEvents(sample);
    expect(acks).toHaveLength(1);
    expect(acks[0].generation).toBe(1);
  });

  it("requires bodyTexts to be exactly the ordered top-level plain paragraphs", () => {
    const text = (value: string, marks?: unknown[]) => ({
      type: "text",
      text: value,
      ...(marks === undefined ? {} : {marks}),
    });
    const snap = (value: unknown) =>
      JSON.stringify({
        pages: [{base: {id: "p1", title: "t", doc: value}, intents: []}],
      });
    const goal = {
      pageId: "p1",
      bodyTexts: [PHYSICAL_BODY_LINE_1, PHYSICAL_BODY_LINE_2],
    };
    // Adjacent unmarked text runs concatenate into the paragraph text.
    expect(
      docOrderedPlainParagraphs(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [text("日本語の"), text("入力確認。")],
            },
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_2)]},
          ],
        },
        goal.bodyTexts,
      ),
    ).toBe(true);
    // Generated block attrs are tolerated inside a full ACK snapshot.
    expect(
      ackSnapshotMatchesGoal(
        snap({
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: {id: "generated-1"},
              content: [text(PHYSICAL_BODY_LINE_1)],
            },
            {
              type: "paragraph",
              attrs: {id: "generated-2"},
              content: [text(PHYSICAL_BODY_LINE_2)],
            },
          ],
        }),
        goal,
      ),
    ).toBe(true);
    // Empty paragraph: a missing content key and an empty array both count.
    expect(
      docOrderedPlainParagraphs(
        {type: "doc", content: [{type: "paragraph"}]},
        [""],
      ),
    ).toBe(true);
    expect(
      docOrderedPlainParagraphs(
        {type: "doc", content: [{type: "paragraph", content: []}]},
        [""],
      ),
    ).toBe(true);
    // Reversed paragraphs fail.
    expect(
      ackSnapshotMatchesGoal(
        snap({
          type: "doc",
          content: [
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_2)]},
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_1)]},
          ],
        }),
        goal,
      ),
    ).toBe(false);
    // An extra paragraph fails.
    expect(
      ackSnapshotMatchesGoal(
        snap({
          type: "doc",
          content: [
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_1)]},
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_2)]},
            {type: "paragraph", content: [text("extra")]},
          ],
        }),
        goal,
      ),
    ).toBe(false);
    // A paragraph nested inside a top-level paragraph fails.
    expect(
      ackSnapshotMatchesGoal(
        snap({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                text(PHYSICAL_BODY_LINE_1),
                {type: "paragraph", content: [text("nested")]},
              ],
            },
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_2)]},
          ],
        }),
        goal,
      ),
    ).toBe(false);
    // Marked text fails even when the raw string matches.
    expect(
      ackSnapshotMatchesGoal(
        snap({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [text(PHYSICAL_BODY_LINE_1, [{type: "bold"}])],
            },
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_2)]},
          ],
        }),
        goal,
      ),
    ).toBe(false);
    // A missing paragraph fails.
    expect(
      ackSnapshotMatchesGoal(
        snap({
          type: "doc",
          content: [
            {type: "paragraph", content: [text(PHYSICAL_BODY_LINE_1)]},
          ],
        }),
        goal,
      ),
    ).toBe(false);
  });

  it("keeps the planned Japanese strings byte-exact", () => {
    expect(PLANNED_ACTIVE_PAGE_BODY).toBe("配布物の本文確認。");
    expect(PLANNED_RECORD_BODY).toBe("配布物の行本文確認。");
    expect(PLANNED_RECORD_NOTE).toBe("配布物のメモ確認。");
    expect(PHYSICAL_BODY_LINE_1).toBe("日本語の入力確認。");
    expect(PHYSICAL_BODY_LINE_2).toBe("二行目。");
  });
});

describe("fixture comparison against the original manifest", () => {
  const doc = (text: string) => ({
    type: "doc",
    content: [{type: "paragraph", content: [{type: "text", text}]}],
  });
  const manifest = {
    activePage: "p1",
    database: {
      id: "db1",
      title: "DB",
      settings: {
        schemaVersion: 2,
        properties: [{id: "note", name: "メモ", type: "text"}],
        rows: [],
        views: [{id: "v1", name: "Table", type: "table"}],
        activeViewId: "v1",
        view: "table",
        filter: "",
        sort: "",
      },
      properties: [{id: "note", name: "メモ", type: "text"}],
      views: [{id: "v1", name: "Table", type: "table"}],
    },
    pages: [{id: "p1", title: "P1", parentId: null, doc: doc("one")}],
    records: [{id: "r1", title: "R1", values: {note: "x"}, doc: doc("rec")}],
    expected: {
      totalPages: 3,
      ordinaryPages: 1,
      databases: 1,
      records: 1,
      assets: 0,
      emptyParagraphs: 0,
      internalLinks: 0,
    },
    limits: {
      kind: "trial",
      note: "",
      revision: "rev-1",
      configured: {maxDatabaseBytes: 100},
      effective: {maxDatabaseBytes: 100},
    },
  } as unknown as MacTrialManifest;
  const projection = {
    settings: {
      schemaVersion: 2,
      properties: [{id: "note", name: "メモ", type: "text"}],
      views: [{id: "v1", name: "Table", type: "table"}],
      activeViewId: "v1",
      view: "table",
      filter: "",
      sort: "",
    },
    records: [],
    revision: 1,
  };
  const snapshot = {
    pages: [
      {id: "p1", title: "P1", parentId: null, doc: doc("one"), kind: "page"},
      {id: "db1", title: "DB", parentId: null, kind: "database"},
      {id: "r1", title: "R1", parentId: "db1", doc: doc("rec"), kind: "page"},
    ],
    settings: {activePage: "p1"},
    records: [
      {
        pageId: "r1",
        databasePageId: "db1",
        title: "R1",
        values: {note: "x"},
        deletedAt: null,
        revision: 1,
        icon: "",
      },
    ],
  };
  const recordReads = new Map([
    ["r1", {doc: doc("rec"), values: {note: "x"}}],
  ]);

  it("passes a fully matching live triple", () => {
    expect(
      fixtureComparisonProblems({
        manifest,
        snapshot: snapshot as never,
        database: projection as never,
        recordReads: recordReads as never,
      }),
    ).toEqual([]);
  });

  it("flags drift in untouched pages, records, values and settings", () => {
    const drifted = JSON.parse(JSON.stringify(snapshot));
    drifted.pages[0].title = "changed";
    drifted.records[0].values.note = "changed";
    const problems = fixtureComparisonProblems({
      manifest,
      snapshot: drifted,
      database: projection as never,
      recordReads: recordReads as never,
    });
    expect(problems.join("\n")).toContain("title differs");
    expect(problems.join("\n")).toContain("values differ");
  });

  it("honours per-id overrides only for the deliberately edited ids", () => {
    const edited = JSON.parse(JSON.stringify(snapshot));
    edited.pages[0].doc = doc("edited");
    // Coherent post-state: the record page doc AND the projection values
    // both carry the planned edits.
    edited.pages[2].doc = doc("edited rec");
    edited.records[0].values = {note: "y"};
    const reads = new Map([
      ["r1", {doc: doc("edited rec"), values: {note: "y"}}],
    ]);
    const problems = fixtureComparisonProblems({
      manifest,
      snapshot: edited,
      database: projection as never,
      recordReads: reads as never,
      overrides: {
        docs: new Map([
          ["p1", doc("edited")],
          ["r1", doc("edited rec")],
        ]),
        values: new Map([["r1", {note: "y"}]]),
      },
    });
    expect(problems).toEqual([]);
    // Without the override the same live state must be flagged.
    expect(
      fixtureComparisonProblems({
        manifest,
        snapshot: edited,
        database: projection as never,
        recordReads: reads as never,
      }),
    ).not.toEqual([]);
  });

  it("checks the exact growth-limits storage contract", () => {
    const good = {
      [GROWTH_LIMITS_SETTINGS_KEY]: JSON.stringify({
        version: 1,
        revision: "rev-1",
        limits: {maxDatabaseBytes: 100},
      }),
    };
    expect(limitsStorageProblems(good, manifest.limits)).toEqual([]);
    expect(limitsStorageProblems({}, manifest.limits)).toHaveLength(1);
    expect(
      limitsStorageProblems(
        {
          [GROWTH_LIMITS_SETTINGS_KEY]: JSON.stringify({
            version: 1,
            revision: "rev-1",
            limits: {maxDatabaseBytes: 200},
          }),
        },
        manifest.limits,
      ),
    ).toHaveLength(1);
    expect(
      limitsStorageProblems(
        {
          [GROWTH_LIMITS_SETTINGS_KEY]: JSON.stringify({
            version: 1,
            revision: "rev-2",
            limits: {maxDatabaseBytes: 100},
          }),
        },
        manifest.limits,
      ),
    ).toHaveLength(1);
  });

  it("compares JSON semantically, not by key order", () => {
    expect(jsonEqual({a: 1, b: {c: [1, 2], d: "x"}}, {b: {d: "x", c: [1, 2]}, a: 1})).toBe(
      true,
    );
    expect(jsonEqual({a: 1}, {a: 2})).toBe(false);
  });
});

describe("export scope checks", () => {
  const expectedDoc = {
    type: "doc",
    content: [
      {type: "paragraph", content: [{type: "text", text: "配布物の本文確認。"}]},
    ],
  };
  const expectedPage = {id: "p1", doc: expectedDoc};

  it("accepts only the exact single exported page and rejects wrong/workspace/mixed exports", () => {
    const fixture = fakeFixture();
    const goodJson = join(fixture.evidenceDir, "good.json");
    writeFileSync(
      goodJson,
      JSON.stringify({id: "p1", title: "T1", kind: "page", doc: expectedDoc}),
    );
    expect(
      verifyExportFile({
        format: "json",
        path: goodJson,
        title: "T1",
        mustContain: [],
        expectedPage: expectedPage as never,
      }).problems,
    ).toEqual([]);

    const wrongPage = join(fixture.evidenceDir, "wrong.json");
    writeFileSync(
      wrongPage,
      JSON.stringify({id: "p2", title: "T1", kind: "page", doc: expectedDoc}),
    );
    expect(
      verifyExportFile({
        format: "json",
        path: wrongPage,
        title: "T1",
        mustContain: [],
        expectedPage: expectedPage as never,
      }).problems.join(),
    ).toContain("page id");

    const workspace = join(fixture.evidenceDir, "workspace.json");
    writeFileSync(
      workspace,
      JSON.stringify({pages: [{id: "p1", title: "T1", doc: expectedDoc}]}),
    );
    expect(
      verifyExportFile({
        format: "json",
        path: workspace,
        title: "T1",
        mustContain: [],
        expectedPage: expectedPage as never,
      }).problems.join(),
    ).toContain("single expected page");

    const md = join(fixture.evidenceDir, "page.md");
    writeFileSync(
      md,
      "<!-- folio:markdown:v1 title=\"T1\" -->\n# T1\n配布物の本文確認。\n別のページ本文",
    );
    expect(
      verifyExportFile({
        format: "md",
        path: md,
        title: "T1",
        mustContain: ["配布物の本文確認。"],
      }).problems,
    ).toEqual([]);
    expect(
      verifyExportFile({
        format: "md",
        path: md,
        title: "T1",
        mustContain: ["配布物の本文確認。"],
        mustNotContain: ["別のページ本文"],
      }).problems.join(),
    ).toContain("out-of-scope");
  });

  it("compares md/html exports semantically for the fixed plain-paragraph profile", () => {
    const fixture = fakeFixture();
    const body = "配布物の本文確認。";
    const exactMd = join(fixture.evidenceDir, "exact.md");
    writeFileSync(
      exactMd,
      `<!-- folio:markdown:v1 title=T1 -->\n# T1\n\n${body}\n`,
    );
    expect(
      verifyExportFile({
        format: "md",
        path: exactMd,
        title: "T1",
        mustContain: [body],
        expectedBody: body,
      }).problems,
    ).toEqual([]);
    // Body-only foreign content (no foreign title anywhere) must fail.
    const foreignBody = join(fixture.evidenceDir, "foreign.md");
    writeFileSync(
      foreignBody,
      `<!-- folio:markdown:v1 title=T1 -->\n# T1\n\nこれは別レコードの本文だけ\n`,
    );
    expect(
      verifyExportFile({
        format: "md",
        path: foreignBody,
        title: "T1",
        mustContain: [body],
        expectedBody: body,
      }).problems.join(),
    ).toContain("not exactly");
    // An extra paragraph after the right one must fail.
    const extraPara = join(fixture.evidenceDir, "extra.md");
    writeFileSync(
      extraPara,
      `<!-- folio:markdown:v1 title=T1 -->\n# T1\n\n${body}\n\n余計な段落\n`,
    );
    expect(
      verifyExportFile({
        format: "md",
        path: extraPara,
        title: "T1",
        mustContain: [body],
        expectedBody: body,
      }).problems.join(),
    ).toContain("not exactly");
    // HTML: exactly one <p> node with the planned body; attrs tolerated.
    const goodHtml = join(fixture.evidenceDir, "good.html");
    writeFileSync(
      goodHtml,
      `<!doctype html><html lang="ja"><meta charset="utf-8"><title>T1</title><body><p data-bid="x">${body}</p></body></html>`,
    );
    expect(
      verifyExportFile({
        format: "html",
        path: goodHtml,
        title: "T1",
        mustContain: [body],
        expectedBody: body,
      }).problems,
    ).toEqual([]);
    const extraHtml = join(fixture.evidenceDir, "extra.html");
    writeFileSync(
      extraHtml,
      `<!doctype html><html><title>T1</title><body><p>${body}</p><p>余計</p></body></html>`,
    );
    expect(
      verifyExportFile({
        format: "html",
        path: extraHtml,
        title: "T1",
        mustContain: [body],
        expectedBody: body,
      }).problems.join(),
    ).toContain("not exactly");
    const wrongHeading = join(fixture.evidenceDir, "heading.html");
    writeFileSync(
      wrongHeading,
      `<!doctype html><html><title>WRONG</title><body><p>${body}</p></body></html>`,
    );
    expect(
      verifyExportFile({
        format: "html",
        path: wrongHeading,
        title: "T1",
        mustContain: [body],
        expectedBody: body,
      }).problems.join(),
    ).toContain("not exactly");
  });
});

describe("real seeded mac-trial workspace (synthetic only, no GUI)", () => {
  const emptyParagraphs = (node: {type?: string; content?: unknown[]}): number => {
    let count = 0;
    const walk = (value: any): void => {
      if (!value || typeof value !== "object") return;
      if (
        value.type === "paragraph" &&
        (!Array.isArray(value.content) ||
          value.content.length === 0 ||
          value.content.every((c: any) => c?.type === "text" && !c.text))
      )
        count += 1;
      if (Array.isArray(value.content)) value.content.forEach(walk);
    };
    walk(node);
    return count;
  };

  it("matches Store.load + record reads of a fresh seed exactly", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "folio-seed-")));
    const manifest = seedMacTrial(join(base, "workspace"));
    // Store constructor mirrors tests/mac-trial-seed.test.ts usage; if its
    // signature differs the owning test is NEED_SOURCE.
    const store = new Store(manifest.databaseFile);
    try {
      const snapshot = store.load();
      expect(snapshot.pages).toHaveLength(manifest.expected.totalPages);
      expect(snapshot.pages).toHaveLength(31);
      const owner = store.get(manifest.database.id);
      const {rows: _rows, ...settings} = owner.database as Record<string, unknown>;
      const database = {
        settings,
        records: snapshot.records ?? [],
        revision: owner.revision,
      };
      const projections = new Map(
        (snapshot.records ?? []).map((record) => [record.pageId, record]),
      );
      const recordReads = new Map(
        manifest.records.map((record) => [
          record.id,
          {
            doc: store.get(record.id).doc,
            values: {...projections.get(record.id)!.values},
          },
        ]),
      );
      expect(
        fixtureComparisonProblems({
          manifest,
          snapshot,
          database: database as never,
          recordReads: recordReads as never,
        }),
      ).toEqual([]);
      // Original invariants preserved: 2 assets, 5 empty paragraphs, exact
      // growth-limit row, all 31 ids — the live workspace is never promoted
      // to a new oracle.
      expect(manifest.assets).toHaveLength(2);
      expect(
        fixtureAssetProblems(
          manifest.databaseFile,
          manifest.workspaceDirectory,
          manifest,
        ),
      ).toEqual([]);
      expect(limitsStorageProblems(snapshot.settings, manifest.limits)).toEqual([]);
      const stored = new WorkspaceLimitSettings(store.db, {}).read();
      expect(stored.revision).toBe(manifest.limits.revision);
      expect(stored.configured).toEqual(manifest.limits.configured);
      const empties =
        manifest.pages.reduce((total, page) => total + emptyParagraphs(page.doc), 0) +
        manifest.records.reduce(
          (total, record) => total + emptyParagraphs(record.doc),
          0,
        );
      expect(empties).toBe(5);
    } finally {
      store.db.close();
    }
  });
});

describe("closeOwnedApp original-child facts", () => {
  // app.process() legitimately throws once the Playwright handle has
  // disconnected after a real close; the cleanup must therefore read every
  // exit/signal/pid fact from the child captured BEFORE app.close().
  const fakeChild = () => ({
    pid: 34488,
    exitCode: null as number | null,
    signalCode: null as string | null,
    once: () => {
      throw new Error("once must not run: the close already landed");
    },
    kill: () => {
      throw new Error("kill must not run: the close already landed");
    },
  });
  const fakeApp = (
    child: ReturnType<typeof fakeChild> | null,
    onClose: () => void = () => {},
  ) => {
    let closed = false;
    return {
      process: () => {
        if (closed) throw new Error("process() unavailable after close");
        return child;
      },
      close: async () => {
        closed = true;
        onClose();
      },
    };
  };

  it("reads a normal close from the original child after app.process() is gone", async () => {
    const child = fakeChild();
    const app = fakeApp(child, () => {
      child.exitCode = 0;
    });
    const result = await closeOwnedApp(
      app as unknown as ElectronApplication,
      50,
    );
    expect(result.method).toBe("app.close");
    expect(result.normal).toBe(true);
    expect(result.pid).toBe(34488);
    expect(result.exitCode).toBe(0);
    expect(result.signalCode).toBeNull();
  });

  it("never reports a nonzero exit or a signal as a normal close", async () => {
    const exited = fakeChild();
    const badExit = await closeOwnedApp(
      fakeApp(exited, () => {
        exited.exitCode = 1;
      }) as unknown as ElectronApplication,
      50,
    );
    expect(badExit.method).toBe("app.close");
    expect(badExit.normal).toBe(false);
    expect(badExit.exitCode).toBe(1);

    const signalled = fakeChild();
    const killed = await closeOwnedApp(
      fakeApp(signalled, () => {
        signalled.signalCode = "SIGTERM";
      }) as unknown as ElectronApplication,
      50,
    );
    expect(killed.method).toBe("app.close");
    expect(killed.normal).toBe(false);
    expect(killed.signalCode).toBe("SIGTERM");
  });
});
