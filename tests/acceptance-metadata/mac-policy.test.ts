import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error pure Node ESM policy; no GUI launch API
import * as policy from "../../scripts/mac-acceptance/policy/guard.mjs";
const {
  evaluateMacPolicy,
  assertMacExecution,
  allocateMacSandbox,
  runtimeIdentity,
  PROTECTED_HOST_HASH,
  assertPrivateTempDirectory,
  assertTemporaryParent,
} = policy;
import { planFixture } from "./fixtures";

const env = {
  FOLIO_GUI_TEST_OPT_IN: "1",
  FOLIO_MAC_ACCEPTANCE_OPT_IN: "1",
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "macOS",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_NAME: "synthetic-runner",
  RUNNER_TEMP: tmpdir(),
};
const runtime = { platform: "darwin", arch: "arm64", hostHash: "1".repeat(64) };
describe("Mac execution guard (pure policy and filesystem only)", () => {
  it("permits the registered hosted target only with both exact opt-ins", () => {
    expect(evaluateMacPolicy(planFixture(), runtime, env).caseIds).toHaveLength(
      3,
    );
    for (const key of Object.keys(env))
      for (const value of [undefined, "", "true ", "01"])
        expect(() =>
          evaluateMacPolicy(planFixture(), runtime, { ...env, [key]: value }),
        ).toThrow();
  });
  it("refuses the protected Mac even with spoofed CI, target and GUI opt-in", () => {
    const plan = planFixture();
    plan.host.hostHash = PROTECTED_HOST_HASH;
    expect(() =>
      evaluateMacPolicy(
        plan,
        { ...runtime, hostHash: PROTECTED_HOST_HASH },
        env,
      ),
    ).toThrow("Management Mac");
    // On this management Mac this also exercises the real identity wrapper.
    // Elsewhere the platform/registration mismatch still refuses the request.
    expect(() => assertMacExecution(plan, env)).toThrow();
    expect(runtimeIdentity().hostHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses unregistered, non-Mac, non-arm64 and debug/dev environments", () => {
    for (const change of [
      { platform: "linux" },
      { arch: "x64" },
      { hostHash: "2".repeat(64) },
    ])
      expect(() =>
        evaluateMacPolicy(planFixture(), { ...runtime, ...change }, env),
      ).toThrow();
    for (const key of ["PWDEBUG", "PWTEST_WATCH", "FOLIO_DEV_URL"])
      expect(() =>
        evaluateMacPolicy(planFixture(), runtime, { ...env, [key]: "1" }),
      ).toThrow();
  });
  it("requires a registered physical dedicated Mac, not a VM or unlabeled host", () => {
    const plan = planFixture();
    plan.host.kind = "dedicated-mac";
    const self = { ...env, RUNNER_ENVIRONMENT: "self-hosted" };
    expect(() => evaluateMacPolicy(plan, runtime, self)).toThrow();
    plan.host.machineClass = "physical";
    plan.host.physicalMachineHash = "a".repeat(64);
    expect(() => evaluateMacPolicy(plan, runtime, self)).not.toThrow();
    expect(() => evaluateMacPolicy(plan, runtime, env)).toThrow();
  });
  it("refuses allocation on the current Mac before touching the temporary directory", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-mac-refuse-fixture-"));
    try {
      const plan = planFixture();
      plan.tempParent = root;
      plan.host.hostHash = PROTECTED_HOST_HASH;
      expect(() =>
        allocateMacSandbox(plan, { ...env, RUNNER_TEMP: root }),
      ).toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("accepts private canonical children and rejects ancestors, siblings and escaping aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-mac-path-fixture-"));
    const outside = mkdtempSync(join(tmpdir(), "folio-mac-outside-fixture-"));
    try {
      const child = join(root, "child");
      mkdirSync(child, { mode: 0o700 });
      symlinkSync(child, join(root, "inside"));
      symlinkSync(outside, join(root, "escape"));
      expect(assertPrivateTempDirectory(join(root, "inside"), root)).toBe(
        assertPrivateTempDirectory(child, root),
      );
      for (const path of [
        root,
        tmpdir(),
        outside,
        join(root, "escape"),
        "relative",
      ])
        expect(() => assertPrivateTempDirectory(path, root)).toThrow();
      chmodSync(child, 0o755);
      expect(() => assertPrivateTempDirectory(child, root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("binds canonical temporary parents to runner temporary storage without launching anything", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-mac-parent-fixture-"));
    try {
      const owned = join(root, "owned");
      mkdirSync(owned, { mode: 0o700 });
      const alias = join(root, "alias");
      symlinkSync(owned, alias);
      const plan = planFixture();
      plan.tempParent = alias;
      const runner = { ...env, RUNNER_TEMP: owned };
      expect(assertTemporaryParent(plan, runner)).toBe(
        assertPrivateTempDirectory(owned, root),
      );
      plan.tempParent = root;
      expect(() => assertTemporaryParent(plan, runner)).toThrow();
      plan.host.kind = "dedicated-mac";
      plan.tempParent = alias;
      expect(assertTemporaryParent(plan, {}, owned)).toBe(
        assertPrivateTempDirectory(owned, root),
      );
      expect(() => assertTemporaryParent(plan, {}, root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
