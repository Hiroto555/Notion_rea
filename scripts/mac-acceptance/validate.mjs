import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceSchema,
  planSchema,
  keychainReceiptSchema,
} from "./policy/schema.mjs";
import { isStrictChild, PROTECTED_HOST_HASH } from "./policy/guard.mjs";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const planDigest = (plan) =>
  digest(JSON.stringify(canonical(planSchema.parse(plan))));
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Read a bounded ordinary file through one descriptor. No symlink or hardlink
// is allowed for submitted metadata. Diagnostics never echo submitted values.
export function readMetadataFile(path) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024)
      throw new Error("Expected a bounded ordinary metadata file");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let used = 0;
    while (used < buffer.length) {
      const n = readSync(fd, buffer, used, buffer.length - used, null);
      if (n === 0) break;
      used += n;
    }
    const bytes = buffer.subarray(0, used);
    const after = fstatSync(fd);
    if (
      bytes.length > 1024 * 1024 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error("Metadata changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function summarizeCases(cases) {
  const sum = (key) => cases.reduce((n, c) => n + c[key], 0);
  const n = (status) => cases.filter((c) => c.status === status).length;
  return {
    expected: cases.length,
    executed: cases.filter((c) => c.executed).length,
    passed: n("PASS"),
    failed: n("FAIL"),
    notRun: n("NOT_RUN"),
    blocked: n("INFRA_BLOCKED"),
    unresolved: n("UNRESOLVED"),
    skip: sum("skip"),
    retry: sum("retry"),
    flaky: sum("flaky"),
  };
}
export function aggregateStatus(cases) {
  for (const status of ["FAIL", "UNRESOLVED", "INFRA_BLOCKED", "NOT_RUN"])
    if (cases.some((c) => c.status === status)) return status;
  return "PASS";
}

export function validateEvidence(
  planInput,
  reportInput,
  { evidenceRoot } = {},
) {
  const errors = [];
  const planResult = planSchema.safeParse(planInput);
  const reportResult = evidenceSchema.safeParse(reportInput);
  for (const [name, result] of [
    ["plan", planResult],
    ["report", reportResult],
  ])
    if (!result.success)
      for (const issue of result.error.issues)
        errors.push(`${name}.${issue.path.join(".")}: ${issue.code}`);
  const invalid = () => ({
    valid: false,
    eligibleForReview: false,
    productResult: "NOT_RUN",
    errors,
  });
  if (errors.length) return invalid();
  const plan = planResult.data;
  const report = reportResult.data;
  const check = (ok, message) => {
    if (!ok) errors.push(message);
  };
  check(
    report.runId === plan.runId && report.planSha256 === planDigest(plan),
    "Report is not bound to the approved plan",
  );
  check(
    same(report.provenance, plan.provenance),
    "Source/artifact/harness provenance mismatch",
  );
  check(same(report.host, plan.host), "Host registration mismatch");
  check(
    report.host.hostHash !== PROTECTED_HOST_HASH,
    "Management Mac cannot supply Mac acceptance evidence",
  );
  check(
    same([...report.cases.map((c) => c.id)].sort(), [...plan.caseIds].sort()),
    "Missing, extra or duplicate selected cases",
  );
  check(
    same(report.counts, summarizeCases(report.cases)),
    "Counts do not match individual cases",
  );
  check(
    report.status === aggregateStatus(report.cases),
    "Aggregate status mismatch",
  );
  let root;
  if (evidenceRoot) {
    try {
      root = realpathSync(evidenceRoot);
      const stat = lstatSync(root);
      check(
        stat.isDirectory() &&
          stat.uid === process.getuid() &&
          (stat.mode & 0o077) === 0,
        "Evidence root must be private and owned",
      );
    } catch {
      errors.push("Evidence root unavailable");
    }
  }
  for (const c of report.cases) {
    const o = c.observations;
    const physicalCount = report.host.machineClass === "physical" ? 1 : 0;
    check(
      c.physicalHostCount === (c.evidenceTier === "E2" ? physicalCount : 0),
      `${c.id}: physical evidence count mismatch`,
    );
    if (report.origin === "synthetic")
      check(
        c.evidenceTier === "E1",
        `${c.id}: synthetic evidence cannot be E2`,
      );
    if (c.status === "NOT_RUN") {
      check(
        !c.executed &&
          c.reason === "NOT_RUN" &&
          c.references.length === 0 &&
          Object.keys(o).length === 0,
        `${c.id}: NOT_RUN contains execution claims`,
      );
    } else if (
      c.status === "PASS" ||
      c.status === "FAIL" ||
      c.status === "UNRESOLVED"
    ) {
      check(c.executed, `${c.id}: result requires execution`);
    }
    const reasons = {
      PASS: [null],
      FAIL: ["PRODUCT"],
      NOT_RUN: ["NOT_RUN"],
      INFRA_BLOCKED: ["ENVIRONMENT"],
      UNRESOLVED: ["TIMEOUT_UNKNOWN", "INTERRUPTED"],
    };
    check(
      reasons[c.status].includes(c.reason),
      `${c.id}: result/reason mismatch`,
    );
    if (o.watchdogExpired)
      check(
        c.executed &&
          ((c.status === "UNRESOLVED" && c.reason === "TIMEOUT_UNKNOWN") ||
            (c.status === "INFRA_BLOCKED" && c.reason === "ENVIRONMENT") ||
            (c.status === "FAIL" && c.reason === "PRODUCT")),
        `${c.id}: timeout requires execution and an explicit non-PASS classification`,
      );
    if (c.status === "PASS") {
      check(
        c.skip === 0 && c.retry === 0 && c.flaky === 0,
        `${c.id}: PASS requires zero skip/retry/flaky`,
      );
      if (report.origin === "observed")
        check(
          c.evidenceTier === "E2" && !c.mockUsed,
          `${c.id}: observed Mac PoC requires unmocked E2 evidence`,
        );
      check(
        o.watchdogExpired === false,
        `${c.id}: PASS needs an observed non-expired watchdog`,
      );
      const kinds = c.references.map((r) => r.kind);
      check(
        new Set(kinds).size === kinds.length,
        `${c.id}: duplicate reference kinds`,
      );
      check(
        kinds.includes("observation") && kinds.includes("watchdog"),
        `${c.id}: observation and watchdog references required`,
      );
      if (c.id === "MAC-H1") {
        check(
          !!o.startPid &&
            !!o.restartPid &&
            o.startPid !== o.restartPid &&
            o.normalExit === true &&
            !!o.revisionSha256 &&
            !!o.contentSha256 &&
            o.contentSha256 === o.readbackSha256,
          `${c.id}: require normal exit, new PID and saved/readback hashes`,
        );
      } else {
        check(
          kinds.includes("os-access") &&
            o.effectiveMockSwitchAbsent === true &&
            o.privateKeychainAccess === true &&
            o.noPlaintextToken === true &&
            o.keychainControlObserved === true,
          `${c.id}: effective switches, private Keychain access, control and secret hygiene required`,
        );
        if (c.id === "MAC-H2")
          check(
            o.independentDecrypt === true &&
              o.startPid > 0 &&
              o.restartPid > 0 &&
              o.startPid !== o.restartPid &&
              o.processLifetime === "cold-and-warm",
            `${c.id}: independent process decryption and cold/warm observations required`,
          );
        else
          check(
            o.unavailableObserved === true &&
              o.ciphertextPreserved === true &&
              o.processLifetime === "cold-and-warm",
            `${c.id}: unavailable API, preserved ciphertext and cold/warm observations required`,
          );
      }
    }
    for (const ref of c.references) {
      if (!root) continue;
      try {
        const path = join(root, ref.path);
        if (!isStrictChild(root, realpathSync(path))) throw new Error("escape");
        const bytes = readMetadataFile(path);
        check(
          bytes.length === ref.bytes && digest(bytes) === ref.sha256,
          `${c.id}: evidence digest/size mismatch`,
        );
        if (ref.kind === "watchdog") {
          const receipt = JSON.parse(bytes.toString("utf8"));
          check(
            receipt.schemaVersion === 1 && typeof receipt.expired === "boolean",
            `${c.id}: invalid watchdog receipt`,
          );
          check(
            o.watchdogExpired === receipt.expired,
            `${c.id}: watchdog observation mismatch`,
          );
          if (c.status === "PASS")
            check(
              receipt.outcome === "COMPLETED" &&
                receipt.cleanupConfirmed === true &&
                receipt.exitCode === 0 &&
                receipt.exitSignal === null &&
                Array.isArray(receipt.signals) &&
                receipt.signals.length === 0,
              `${c.id}: watchdog did not complete cleanly`,
            );
          if (report.origin === "observed")
            check(
              receipt.observationKind === "MAC_REMOTE" &&
                same(receipt.binding, {
                  runId: plan.runId,
                  caseId: c.id,
                  hostHash: plan.host.hostHash,
                  artifactSha256: plan.provenance.artifactSha256,
                }),
              `${c.id}: watchdog origin/binding mismatch`,
            );
        }
        if (ref.kind === "os-access" && report.origin === "observed") {
          const access = keychainReceiptSchema.parse(
            JSON.parse(bytes.toString("utf8")),
          );
          check(
            same(access.binding, {
              runId: plan.runId,
              caseId: c.id,
              hostHash: plan.host.hostHash,
              artifactSha256: plan.provenance.artifactSha256,
            }),
            `${c.id}: Keychain receipt binding mismatch`,
          );
          check(
            access.expectedPathSha256 === access.accessedPathSha256,
            `${c.id}: access was not to the expected private Keychain`,
          );
          const cold = access.samples.filter(
            (s) => s.processLifetime === "cold",
          );
          const warm = access.samples.filter(
            (s) => s.processLifetime === "warm",
          );
          check(
            cold.length > 0 && warm.length > 0,
            `${c.id}: missing cold/warm Keychain samples`,
          );
          if (c.status === "PASS" && c.id === "MAC-H2")
            check(
              access.samples.some(
                (s) => s.pid === o.startPid && s.apiResult === "decrypted",
              ) &&
                cold.some(
                  (s) => s.pid === o.restartPid && s.apiResult === "decrypted",
                ),
              `${c.id}: no independent cold process decryption receipt`,
            );
          if (c.status === "PASS" && c.id === "MAC-H3")
            check(
              access.samples.some((s) => s.apiResult === "unavailable"),
              `${c.id}: key lock/cache is not evidence of API unavailability`,
            );
        }
      } catch {
        errors.push(`${c.id}: evidence file unavailable or invalid`);
      }
    }
  }
  if (errors.length) return invalid();
  return {
    valid: true,
    eligibleForReview:
      !!root && report.origin === "observed" && report.status === "PASS",
    // This is a consistency validator, not the L4 decision or OS attestation.
    productResult: "NOT_RUN",
    errors,
  };
}

// Offline only. Exit 0: complete observed evidence ready for human review;
// 1: invalid; 2: valid but synthetic/incomplete/unverified. No launcher exists.
export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 3)
      throw new Error(
        "Usage: node scripts/mac-acceptance/validate.mjs PLAN REPORT EVIDENCE_ROOT",
      );
    const result = validateEvidence(
      JSON.parse(readMetadataFile(argv[0])),
      JSON.parse(readMetadataFile(argv[1])),
      { evidenceRoot: argv[2] },
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = !result.valid ? 1 : result.eligibleForReview ? 0 : 2;
  } catch {
    process.stderr.write(
      "Mac evidence validation failed: invalid arguments or metadata files.\n",
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main();
