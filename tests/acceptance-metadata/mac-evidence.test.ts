import {
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error executable ESM accepts untrusted JSON and never launches GUI
import * as metadata from "../../scripts/mac-acceptance/validate.mjs";
const {
  validateEvidence,
  planDigest,
  summarizeCases,
  aggregateStatus,
  digest,
} = metadata;
import { evidenceFixture } from "./fixtures";

describe("Mac PoC evidence consistency (all input is artificial)", () => {
  it("keeps valid synthetic PASS metadata separate from product acceptance", () => {
    const f = evidenceFixture();
    try {
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }),
      ).toEqual({
        valid: true,
        eligibleForReview: false,
        productResult: "NOT_RUN",
        errors: [],
      });
    } finally {
      f.cleanup();
    }
  });
  it("requires verified files before complete observed metadata is eligible for review", () => {
    const f = evidenceFixture("observed");
    try {
      expect(validateEvidence(f.plan, f.report)).toMatchObject({
        valid: true,
        eligibleForReview: false,
      });
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }),
      ).toMatchObject({
        valid: true,
        eligibleForReview: true,
        productResult: "NOT_RUN",
      });
    } finally {
      f.cleanup();
    }
  });
  it.each([
    ["missing case", (f: any) => f.report.cases.pop()],
    [
      "duplicate case",
      (f: any) => {
        f.report.cases[1] = f.report.cases[0];
      },
    ],
    [
      "unapproved selection",
      (f: any) => {
        f.report.cases = [f.report.cases[0]];
        f.report.counts = summarizeCases(f.report.cases);
      },
    ],
    ["counts", (f: any) => f.report.counts.executed++],
    [
      "empty selection",
      (f: any) => {
        f.plan.caseIds = [];
      },
    ],
    [
      "duplicate plan selection",
      (f: any) => {
        f.plan.caseIds[1] = f.plan.caseIds[0];
      },
    ],
    [
      "source changed",
      (f: any) => {
        f.report.provenance.productCommit = "0".repeat(40);
      },
    ],
    [
      "artifact changed",
      (f: any) => {
        f.report.provenance.artifactSha256 = "0".repeat(64);
      },
    ],
    [
      "harness changed",
      (f: any) => {
        f.report.provenance.harnessTreeSha256 = "0".repeat(64);
      },
    ],
    [
      "merge ref used as source",
      (f: any) => {
        f.report.provenance.productCommit = f.report.provenance.mergeRefCommit;
      },
    ],
    [
      "plan digest",
      (f: any) => {
        f.report.planSha256 = "0".repeat(64);
      },
    ],
    [
      "run binding",
      (f: any) => {
        f.report.runId = "00000000-0000-4000-8000-000000000002";
      },
    ],
    [
      "host binding",
      (f: any) => {
        f.report.host.hostHash = "0".repeat(64);
      },
    ],
    [
      "mocked E2",
      (f: any) => {
        f.report.cases[0].mockUsed = true;
      },
    ],
    [
      "mock switch only argv",
      (f: any) => {
        delete f.report.cases[1].observations.effectiveMockSwitchAbsent;
      },
    ],
    [
      "no actual Keychain access",
      (f: any) => {
        f.report.cases[1].observations.privateKeychainAccess = false;
      },
    ],
    [
      "same cached process",
      (f: any) => {
        f.report.cases[1].observations.restartPid = 101;
      },
    ],
    [
      "lock alone",
      (f: any) => {
        f.report.cases[2].observations.unavailableObserved = false;
      },
    ],
    [
      "lost ciphertext",
      (f: any) => {
        f.report.cases[2].observations.ciphertextPreserved = false;
      },
    ],
    [
      "warm only",
      (f: any) => {
        f.report.cases[2].observations.processLifetime = "warm";
      },
    ],
    [
      "secret hygiene absent",
      (f: any) => {
        delete f.report.cases[1].observations.noPlaintextToken;
      },
    ],
    [
      "same PID after normal exit",
      (f: any) => {
        f.report.cases[0].observations.restartPid = 101;
      },
    ],
    [
      "changed readback",
      (f: any) => {
        f.report.cases[0].observations.readbackSha256 = "4".repeat(64);
      },
    ],
    [
      "unknown timeout as PASS",
      (f: any) => {
        f.report.cases[0].observations.watchdogExpired = true;
      },
    ],
    [
      "retry hidden in PASS",
      (f: any) => {
        f.report.cases[0].retry = 1;
        f.report.counts.retry = 1;
      },
    ],
    [
      "skip hidden in PASS",
      (f: any) => {
        f.report.cases[0].skip = 1;
        f.report.counts.skip = 1;
      },
    ],
    [
      "flaky hidden in PASS",
      (f: any) => {
        f.report.cases[0].flaky = 1;
        f.report.counts.flaky = 1;
      },
    ],
    [
      "unexecuted PASS",
      (f: any) => {
        f.report.cases[0].executed = false;
        f.report.counts.executed--;
      },
    ],
    [
      "VM as physical Mac",
      (f: any) => {
        f.report.cases[0].physicalHostCount = 1;
      },
    ],
    [
      "VM/mock as two-Mac E3",
      (f: any) => {
        f.report.cases[0].evidenceTier = "E3";
        f.report.cases[0].physicalHostCount = 2;
      },
    ],
    [
      "unknown two-Mac claim",
      (f: any) => {
        f.report.physicalMacsAccepted = 2;
      },
    ],
    [
      "missing observation",
      (f: any) => {
        f.report.cases[0].references = [];
      },
    ],
    [
      "traversal",
      (f: any) => {
        f.report.cases[0].references[0].path = "../outside";
      },
    ],
    [
      "absolute path",
      (f: any) => {
        f.report.cases[0].references[0].path = "/tmp/evidence";
      },
    ],
    [
      "unknown/raw field",
      (f: any) => {
        f.report.cases[0].token = "synthetic-secret-must-not-be-echoed";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const f = evidenceFixture("observed");
    try {
      mutate(f);
      const result = validateEvidence(f.plan, f.report, {
        evidenceRoot: f.root,
      });
      expect(result.valid).toBe(false);
      expect(result.eligibleForReview).toBe(false);
      expect(JSON.stringify(result)).not.toContain(
        "synthetic-secret-must-not-be-echoed",
      );
    } finally {
      f.cleanup();
    }
  });
  it("records NOT_RUN, environmental block and unknown timeout without inventing PASS", () => {
    const f = evidenceFixture();
    try {
      for (const [index, status, reason] of [
        [0, "NOT_RUN", "NOT_RUN"],
        [1, "INFRA_BLOCKED", "ENVIRONMENT"],
        [2, "UNRESOLVED", "TIMEOUT_UNKNOWN"],
      ] as const) {
        const c = f.report.cases[index];
        c.status = status;
        c.reason = reason;
        c.observations =
          status === "UNRESOLVED" ? { watchdogExpired: true } : {};
        c.executed = status === "UNRESOLVED";
        c.references = [];
      }
      f.report.counts = summarizeCases(f.report.cases);
      f.report.status = aggregateStatus(f.report.cases);
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }),
      ).toMatchObject({ valid: true, eligibleForReview: false });
    } finally {
      f.cleanup();
    }
  });
  it.each([
    ["UNRESOLVED", "TIMEOUT_UNKNOWN"],
    ["INFRA_BLOCKED", "ENVIRONMENT"],
    ["FAIL", "PRODUCT"],
  ] as const)(
    "retains timeout evidence when classified as %s",
    (status, reason) => {
      const f = evidenceFixture("observed");
      try {
        const c = f.report.cases[2];
        c.status = status;
        c.reason = reason;
        c.observations.watchdogExpired = true;
        const ref = c.references.find((r: any) => r.kind === "watchdog");
        const path = join(f.root, ref.path);
        const receipt = JSON.parse(readFileSync(path, "utf8"));
        Object.assign(receipt, {
          outcome: "TIMED_OUT",
          expired: true,
          exitCode: null,
          exitSignal: "SIGKILL",
          signals: ["SIGTERM", "SIGKILL"],
        });
        const bytes = Buffer.from(JSON.stringify(receipt));
        writeFileSync(path, bytes);
        ref.sha256 = digest(bytes);
        ref.bytes = bytes.length;
        f.report.counts = summarizeCases(f.report.cases);
        f.report.status = aggregateStatus(f.report.cases);
        expect(
          validateEvidence(f.plan, f.report, { evidenceRoot: f.root }),
        ).toMatchObject({
          valid: true,
          eligibleForReview: false,
          productResult: "NOT_RUN",
        });
      } finally {
        f.cleanup();
      }
    },
  );
  it("rejects a timeout attributed to a case that never executed", () => {
    const f = evidenceFixture();
    try {
      const c = f.report.cases[2];
      c.status = "INFRA_BLOCKED";
      c.reason = "ENVIRONMENT";
      c.executed = false;
      c.observations.watchdogExpired = true;
      c.references = [];
      f.report.counts = summarizeCases(f.report.cases);
      f.report.status = aggregateStatus(f.report.cases);
      expect(validateEvidence(f.plan, f.report).valid).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it("uses canonical object-key hashing but preserves case selection order in the approved plan", () => {
    const f = evidenceFixture();
    try {
      expect(
        planDigest(Object.fromEntries(Object.entries(f.plan).reverse())),
      ).toBe(planDigest(f.plan));
      expect(
        planDigest({ ...f.plan, caseIds: [...f.plan.caseIds].reverse() }),
      ).not.toBe(planDigest(f.plan));
    } finally {
      f.cleanup();
    }
  });
  it.each([
    "missing",
    "tampered",
    "symlink",
    "hardlink",
    "oversized",
    "watchdog-timeout",
    "synthetic-watchdog",
  ])("rejects %s evidence files", (mode) => {
    const f = evidenceFixture("observed");
    try {
      const ref =
        f.report.cases[0].references[
          mode.startsWith("watchdog") || mode === "synthetic-watchdog" ? 1 : 0
        ];
      const path = join(f.root, ref.path);
      const original = readFileSync(path);
      rmSync(path);
      if (mode === "tampered") writeFileSync(path, "tampered");
      if (mode === "oversized")
        writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
      if (mode === "symlink" || mode === "hardlink") {
        const target = join(f.root, "aliased.json");
        writeFileSync(target, original);
        if (mode === "symlink") symlinkSync(target, path);
        else linkSync(target, path);
      }
      if (mode === "watchdog-timeout" || mode === "synthetic-watchdog") {
        const receipt = JSON.parse(original.toString());
        if (mode === "watchdog-timeout") {
          receipt.expired = true;
          receipt.outcome = "TIMED_OUT";
        } else receipt.observationKind = "NODE_SYNTHETIC";
        const bytes = Buffer.from(JSON.stringify(receipt));
        writeFileSync(path, bytes);
        ref.sha256 = digest(bytes);
        ref.bytes = bytes.length;
      }
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }).valid,
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it.each([
    [
      "effective mock switch",
      (r: any) => {
        r.effectiveMockSwitch = true;
      },
    ],
    [
      "argv mock switch",
      (r: any) => {
        r.argvMockSwitch = true;
      },
    ],
    [
      "unexpected Keychain",
      (r: any) => {
        r.accessedPathSha256 = "6".repeat(64);
      },
    ],
    [
      "missing item identity",
      (r: any) => {
        delete r.itemIdentitySha256;
      },
    ],
    [
      "different run",
      (r: any) => {
        r.binding.runId = "00000000-0000-4000-8000-000000000002";
      },
    ],
    [
      "no cold process",
      (r: any) => {
        for (const s of r.samples) s.processLifetime = "warm";
      },
    ],
    [
      "no warm process",
      (r: any) => {
        for (const s of r.samples) s.processLifetime = "cold";
      },
    ],
    [
      "cache only",
      (r: any) => {
        for (const s of r.samples) s.apiResult = "cached";
      },
    ],
    [
      "same process decryption",
      (r: any) => {
        for (const s of r.samples) s.pid = 101;
      },
    ],
    [
      "plaintext token seen",
      (r: any) => {
        r.plaintextTokenObserved = true;
      },
    ],
  ])("rejects a Keychain receipt with %s", (_name, mutate) => {
    const f = evidenceFixture("observed");
    try {
      const ref = f.report.cases[1].references[2];
      const path = join(f.root, ref.path);
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      mutate(receipt);
      const bytes = Buffer.from(JSON.stringify(receipt));
      writeFileSync(path, bytes);
      ref.sha256 = digest(bytes);
      ref.bytes = bytes.length;
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }).valid,
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it("rejects a locked Keychain whose API still uses a cached key", () => {
    const f = evidenceFixture("observed");
    try {
      const ref = f.report.cases[2].references[2],
        path = join(f.root, ref.path);
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      for (const s of receipt.samples) {
        s.keyItemState = "locked";
        s.apiResult = "cached";
      }
      const bytes = Buffer.from(JSON.stringify(receipt));
      writeFileSync(path, bytes);
      ref.sha256 = digest(bytes);
      ref.bytes = bytes.length;
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }).valid,
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it("allows observed warm cache continuation when a separate unavailable API path was actually checked", () => {
    const f = evidenceFixture("observed");
    try {
      const ref = f.report.cases[2].references[2],
        path = join(f.root, ref.path);
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      for (const s of receipt.samples)
        if (s.processLifetime === "warm") s.apiResult = "cached";
      const bytes = Buffer.from(JSON.stringify(receipt));
      writeFileSync(path, bytes);
      ref.sha256 = digest(bytes);
      ref.bytes = bytes.length;
      expect(
        validateEvidence(f.plan, f.report, { evidenceRoot: f.root }).valid,
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("offline CLI distinguishes invalid, synthetic and observed metadata without GUI", () => {
    const f = evidenceFixture("observed");
    try {
      const plan = join(f.root, "plan.json"),
        report = join(f.root, "report.json");
      writeFileSync(plan, JSON.stringify(f.plan));
      const run = () => {
        writeFileSync(report, JSON.stringify(f.report));
        return spawnSync(
          process.execPath,
          [
            resolve("scripts/mac-acceptance/validate.mjs"),
            plan,
            report,
            f.root,
          ],
          { env: {}, encoding: "utf8", timeout: 5000 },
        );
      };
      expect(run().status).toBe(0);
      f.report.cases[0].mockUsed = true;
      expect(run().status).toBe(1);
      f.report.origin = "synthetic";
      for (const c of f.report.cases) c.evidenceTier = "E1";
      expect(run().status).toBe(2);
    } finally {
      f.cleanup();
    }
  });
});
