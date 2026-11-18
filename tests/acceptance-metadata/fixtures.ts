import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error executable ESM contract is exercised with untrusted JSON
import * as metadata from "../../scripts/mac-acceptance/validate.mjs";
const { digest, planDigest, summarizeCases } = metadata;

// All bytes/identities here are artificial. An 'observed' fixture tests the
// validator's branches; it is never a report of an actual Mac execution.
export function planFixture(): any {
  return {
    schemaVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    provenance: {
      productCommit: "bd65b73b492b95b8b9a2a1f73ad9a5e114c509dc",
      sourceTree: "a".repeat(40),
      buildInputsSha256: "b".repeat(64),
      artifactSha256: "c".repeat(64),
      harnessCommit: "d".repeat(40),
      harnessTreeSha256: "e".repeat(64),
      mergeRefCommit: "f".repeat(40),
      bundleId: "test.folio.fixture",
      signingIdentity: "unsigned-fixture",
      builder: "synthetic-builder",
    },
    host: {
      kind: "github-hosted-macos",
      hostHash: "1".repeat(64),
      machineClass: "vm",
      physicalMachineHash: null,
      platform: "darwin",
      arch: "arm64",
      runnerName: "synthetic-runner",
      osVersion: "fixture-os",
      imageVersion: "fixture-image",
    },
    caseIds: ["MAC-H1", "MAC-H2", "MAC-H3"],
    tempParent: tmpdir(),
    workers: 1,
    retries: 0,
    timeoutMs: 1000,
    graceMs: 100,
  };
}

export function evidenceFixture(
  origin: "synthetic" | "observed" = "synthetic",
) {
  const root = mkdtempSync(join(tmpdir(), "folio-mac-evidence-fixture-"));
  const plan = planFixture();
  const cases = plan.caseIds.map((id: string) => {
    const reference = (kind: string) => {
      const bytes = Buffer.from(
        kind === "watchdog"
          ? JSON.stringify({
              schemaVersion: 1,
              observationKind:
                origin === "synthetic" ? "NODE_SYNTHETIC" : "MAC_REMOTE",
              outcome: "COMPLETED",
              expired: false,
              cleanupConfirmed: true,
              exitCode: 0,
              exitSignal: null,
              signals: [],
              binding: {
                runId: plan.runId,
                caseId: id,
                hostHash: plan.host.hostHash,
                artifactSha256: plan.provenance.artifactSha256,
              },
            })
          : kind === "os-access"
            ? JSON.stringify({
                schemaVersion: 1,
                observationKind: "MAC_REMOTE",
                binding: {
                  runId: plan.runId,
                  caseId: id,
                  hostHash: plan.host.hostHash,
                  artifactSha256: plan.provenance.artifactSha256,
                },
                isolation: "private-temporary-keychain",
                expectedPathSha256: "4".repeat(64),
                accessedPathSha256: "4".repeat(64),
                itemIdentitySha256: "5".repeat(64),
                accessObserved: true,
                effectiveMockSwitch: false,
                argvMockSwitch: false,
                plaintextTokenObserved: false,
                controlObserved: true,
                samples: [
                  {
                    processLifetime: "cold",
                    pid: 101,
                    keyItemState: "present",
                    apiResult: id === "MAC-H2" ? "decrypted" : "unavailable",
                  },
                  {
                    processLifetime: "warm",
                    pid: 101,
                    keyItemState: "locked",
                    apiResult: id === "MAC-H2" ? "cached" : "unavailable",
                  },
                  {
                    processLifetime: "cold",
                    pid: 102,
                    keyItemState: "present",
                    apiResult: id === "MAC-H2" ? "decrypted" : "unavailable",
                  },
                ],
              })
            : "synthetic metadata fixture; no OS operation occurred",
      );
      const path = `${id}-${kind}.json`;
      writeFileSync(join(root, path), bytes, { flag: "wx", mode: 0o600 });
      return { kind, path, sha256: digest(bytes), bytes: bytes.length };
    };
    return {
      id,
      status: "PASS",
      executed: true,
      evidenceTier: origin === "synthetic" ? "E1" : "E2",
      physicalHostCount: 0,
      mockUsed: origin === "synthetic",
      skip: 0,
      retry: 0,
      flaky: 0,
      reason: null,
      observations: {
        startPid: 101,
        restartPid: 102,
        normalExit: true,
        revisionSha256: "2".repeat(64),
        contentSha256: "3".repeat(64),
        readbackSha256: "3".repeat(64),
        effectiveMockSwitchAbsent: true,
        privateKeychainAccess: true,
        independentDecrypt: true,
        keychainControlObserved: true,
        ciphertextPreserved: true,
        unavailableObserved: true,
        noPlaintextToken: true,
        watchdogExpired: false,
        processLifetime: "cold-and-warm",
      },
      references: [
        reference("observation"),
        reference("watchdog"),
        ...(id !== "MAC-H1" ? [reference("os-access")] : []),
      ],
    };
  });
  const report: any = {
    schemaVersion: 1,
    runId: plan.runId,
    planSha256: planDigest(plan),
    origin,
    provenance: structuredClone(plan.provenance),
    host: structuredClone(plan.host),
    status: "PASS",
    counts: summarizeCases(cases),
    cases,
  };
  return {
    root,
    plan,
    report,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
