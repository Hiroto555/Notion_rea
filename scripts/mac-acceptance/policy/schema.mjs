import { z } from "zod";

// Single executable schema, shared by the guard and offline validator. No OS
// probes, process launch, Keychain access or file writes occur on import.
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const label = z.string().min(1).max(200);
const count = z.number().int().nonnegative().max(10000);
export const caseId = z.enum(["MAC-H1", "MAC-H2", "MAC-H3"]);
export const status = z.enum([
  "PASS",
  "FAIL",
  "NOT_RUN",
  "INFRA_BLOCKED",
  "UNRESOLVED",
]);
export const bindingSchema = z
  .object({
    runId: z.string().uuid(),
    caseId,
    hostHash: sha256,
    artifactSha256: sha256,
  })
  .strict();
// OS observation metadata, never the Keychain item value or token. Producers
// must collect both the effective main switches and actual private-item access.
export const keychainReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationKind: z.literal("MAC_REMOTE"),
    binding: bindingSchema,
    isolation: z.literal("private-temporary-keychain"),
    expectedPathSha256: sha256,
    accessedPathSha256: sha256,
    itemIdentitySha256: sha256,
    accessObserved: z.literal(true),
    effectiveMockSwitch: z.literal(false),
    argvMockSwitch: z.literal(false),
    plaintextTokenObserved: z.literal(false),
    controlObserved: z.literal(true),
    samples: z
      .array(
        z
          .object({
            processLifetime: z.enum(["cold", "warm"]),
            pid: z.number().int().positive(),
            keyItemState: z.enum(["present", "missing", "locked", "denied"]),
            apiResult: z.enum([
              "decrypted",
              "unavailable",
              "cached",
              "unknown",
            ]),
          })
          .strict(),
      )
      .min(2)
      .max(8),
  })
  .strict();
export const provenanceSchema = z
  .object({
    productCommit: commit,
    sourceTree: commit,
    buildInputsSha256: sha256,
    artifactSha256: sha256,
    harnessCommit: commit,
    harnessTreeSha256: sha256,
    mergeRefCommit: commit.nullable(),
    bundleId: label,
    signingIdentity: label,
    builder: label,
  })
  .strict();
export const hostSchema = z
  .object({
    kind: z.enum(["github-hosted-macos", "dedicated-mac"]),
    hostHash: sha256,
    machineClass: z.enum(["vm", "physical", "unknown"]),
    physicalMachineHash: sha256.nullable(),
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    runnerName: label,
    osVersion: label,
    imageVersion: label,
  })
  .strict();
export const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    provenance: provenanceSchema,
    host: hostSchema,
    caseIds: z.array(caseId).min(1).max(3),
    tempParent: z.string().min(1).max(4096),
    workers: z.literal(1),
    retries: z.literal(0),
    timeoutMs: z.number().int().min(100).max(900000),
    graceMs: z.number().int().min(10).max(10000),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (new Set(plan.caseIds).size !== plan.caseIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["caseIds"],
        message: "Duplicate selection",
      });
    const physical = plan.host.machineClass === "physical";
    if (physical !== (plan.host.physicalMachineHash !== null))
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Physical identity/class mismatch",
      });
    if (plan.host.kind === "dedicated-mac" && !physical)
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Dedicated Mac needs a registered physical identity",
      });
  });

const reference = z
  .object({
    kind: z.enum(["observation", "watchdog", "os-access"]),
    path: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          /^[a-zA-Z0-9_./-]+$/.test(value) &&
          !value.startsWith("/") &&
          value
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
        "Evidence path must be a relative file without traversal",
      ),
    sha256,
    bytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();
const observations = z
  .object({
    startPid: z.number().int().positive().optional(),
    restartPid: z.number().int().positive().optional(),
    normalExit: z.boolean().optional(),
    revisionSha256: sha256.optional(),
    contentSha256: sha256.optional(),
    readbackSha256: sha256.optional(),
    effectiveMockSwitchAbsent: z.boolean().optional(),
    privateKeychainAccess: z.boolean().optional(),
    independentDecrypt: z.boolean().optional(),
    keychainControlObserved: z.boolean().optional(),
    ciphertextPreserved: z.boolean().optional(),
    unavailableObserved: z.boolean().optional(),
    noPlaintextToken: z.boolean().optional(),
    watchdogExpired: z.boolean().optional(),
    processLifetime: z
      .enum(["cold", "warm", "cold-and-warm", "not-observed"])
      .optional(),
  })
  .strict();
export const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    planSha256: sha256,
    origin: z.enum(["synthetic", "observed"]),
    provenance: provenanceSchema,
    host: hostSchema,
    status,
    counts: z
      .object({
        expected: count,
        executed: count,
        passed: count,
        failed: count,
        notRun: count,
        blocked: count,
        unresolved: count,
        skip: count,
        retry: count,
        flaky: count,
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            id: caseId,
            status,
            executed: z.boolean(),
            // This PoC supports one host only. E3/physical two-Mac acceptance needs a
            // separate contract; it cannot be obtained by editing a count or tier here.
            evidenceTier: z.enum(["E1", "E2"]),
            physicalHostCount: z.number().int().min(0).max(1),
            mockUsed: z.boolean(),
            skip: count,
            retry: count,
            flaky: count,
            reason: z
              .enum([
                "TIMEOUT_UNKNOWN",
                "ENVIRONMENT",
                "PRODUCT",
                "INTERRUPTED",
                "NOT_RUN",
              ])
              .nullable(),
            observations,
            references: z.array(reference).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
