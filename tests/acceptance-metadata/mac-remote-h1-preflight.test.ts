import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error pure Node ESM policy; no GUI launch API
import { PROTECTED_HOST_HASH } from "../../scripts/mac-acceptance/policy/guard.mjs";
import {
  assertRemoteH1Selection,
  canonicalWorkspaceRoot,
  prepareRemoteH1,
  remoteH1Environment,
  validateRemoteH1Artifact,
} from "../../scripts/mac-acceptance/preflight/remote-h1.mjs";
import { planFixture } from "./fixtures";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const tempRoot = (prefix: string) =>
  mkdtempSync(join(realpathSync(tmpdir()), prefix));

describe("remote MAC-H1 preflight preparation", () => {
  it("imports as inert preparation code with no CLI entry or launch path", () => {
    expect(typeof prepareRemoteH1).toBe("function");
    expect(Object.keys(globalThis)).not.toContain("prepareRemoteH1");
  });

  it("cannot enable this management Mac by copying CI, runner and GUI opt-in variables", () => {
    const root = tempRoot("folio-remote-h1-refuse-");
    try {
      const plan = planFixture();
      plan.host.hostHash = PROTECTED_HOST_HASH;
      plan.tempParent = root;
      const env = {
        FOLIO_GUI_TEST_OPT_IN: "1",
        FOLIO_MAC_ACCEPTANCE_OPT_IN: "1",
        CI: "true",
        GITHUB_ACTIONS: "true",
        RUNNER_OS: "macOS",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_NAME: plan.host.runnerName,
        RUNNER_TEMP: root,
        FOLIO_SYNC_ENABLED: "1",
        FOLIO_SYNC_TOKEN: "synthetic-not-a-real-token",
      };

      expect(() => prepareRemoteH1(plan, { env, workspaceRoot: root })).toThrow(
        /Management Mac|Host is not the registered/,
      );
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires exactly the single MAC-H1 case", () => {
    const plan = planFixture();
    plan.caseIds = ["MAC-H1"];
    expect(() => assertRemoteH1Selection(plan)).not.toThrow();
    for (const caseIds of [
      [],
      ["MAC-H2"],
      ["MAC-H1", "MAC-H2"],
      ["MAC-H1", "MAC-H1"],
    ]) {
      plan.caseIds = caseIds;
      expect(() => assertRemoteH1Selection(plan)).toThrow(/MAC-H1/);
    }
  });

  it("requires an absolute existing workspace root and returns its canonical path", () => {
    const root = tempRoot("folio-remote-h1-root-");
    try {
      expect(() => canonicalWorkspaceRoot("relative/workspace")).toThrow(
        /absolute/,
      );
      expect(canonicalWorkspaceRoot(root)).toBe(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only an owned, unlinked dist/main.cjs whose sha256 matches provenance", () => {
    const root = tempRoot("folio-remote-h1-artifact-");
    try {
      const workspace = join(root, "workspace");
      mkdirSync(join(workspace, "dist"), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from("synthetic main build fixture\n");
      const artifactPath = join(workspace, "dist", "main.cjs");
      writeFileSync(artifactPath, bytes, { mode: 0o600 });

      expect(validateRemoteH1Artifact(workspace, digest(bytes))).toEqual({
        artifactPath: join(realpathSync(workspace), "dist", "main.cjs"),
        sha256: digest(bytes),
      });
      expect(() => validateRemoteH1Artifact(workspace, "0".repeat(64))).toThrow(
        /artifact hash/,
      );
      expect(() => validateRemoteH1Artifact(workspace, "not-a-sha256")).toThrow(
        /sha256/,
      );

      const empty = join(root, "empty-workspace");
      mkdirSync(join(empty, "dist"), { recursive: true, mode: 0o700 });
      expect(() => validateRemoteH1Artifact(empty, digest(bytes))).toThrow(
        /artifact build is missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinked and hardlinked artifact files", () => {
    const root = tempRoot("folio-remote-h1-links-");
    try {
      const bytes = Buffer.from("synthetic link target\n");
      const target = join(root, "target.cjs");
      writeFileSync(target, bytes, { mode: 0o600 });

      const linked = join(root, "linked");
      mkdirSync(join(linked, "dist"), { recursive: true, mode: 0o700 });
      symlinkSync(target, join(linked, "dist", "main.cjs"));
      expect(() => validateRemoteH1Artifact(linked, digest(bytes))).toThrow(
        /non-linked regular file/,
      );

      const hardlinked = join(root, "hardlinked");
      mkdirSync(join(hardlinked, "dist"), { recursive: true, mode: 0o700 });
      linkSync(target, join(hardlinked, "dist", "main.cjs"));
      expect(() => validateRemoteH1Artifact(hardlinked, digest(bytes))).toThrow(
        /non-linked regular file/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an oversized artifact before accepting its content hash", () => {
    const root = tempRoot("folio-remote-h1-bounded-");
    try {
      mkdirSync(join(root, "dist"));
      const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 120);
      writeFileSync(join(root, "dist", "main.cjs"), bytes, { mode: 0o600 });
      expect(() => validateRemoteH1Artifact(root, digest(bytes))).toThrow(
        /bounded size limit/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps only the isolated data and credential vault while dropping inherited modes and secrets", () => {
    const env = {
      PATH: "/synthetic/bin",
      FOLIO_GUI_TEST_OPT_IN: "1",
      FOLIO_MAC_ACCEPTANCE_OPT_IN: "1",
      FOLIO_SYNC_ENABLED: "1",
      FOLIO_SYNC_URL: "http://127.0.0.1:1",
      FOLIO_SYNC_TOKEN: "synthetic-not-a-real-token",
      FOLIO_DEV_URL: "http://127.0.0.1:2",
      FOLIO_TEST_FORCE_READY_FAILURE: "1",
      FOLIO_EMPTY_WORKSPACE: "1",
      PWDEBUG: "1",
      PWTEST_WATCH: "1",
      FOLIO_LOCAL_GUI_BATCH: "1",
      FOLIO_LOCAL_GUI_DATA_ROOT: "/synthetic/local",
      FOLIO_LINUX_GUI_CI: "1",
      FOLIO_GUI_CI_DATA_ROOT: "/synthetic/ci",
      FOLIO_GUI_CI_KEYRING: "1",
    };
    const child = remoteH1Environment(env, {
      root: "/synthetic/root",
      data: "/synthetic/root/data",
      vault: "/synthetic/root/vault",
      evidence: "/synthetic/root/evidence",
    });

    expect(child.PATH).toBe("/synthetic/bin");
    expect(child.FOLIO_GUI_TEST_OPT_IN).toBe("1");
    expect(child.FOLIO_MAC_ACCEPTANCE_OPT_IN).toBe("1");
    expect(child.FOLIO_DATA_DIR).toBe("/synthetic/root/data");
    expect(child.FOLIO_CREDENTIAL_DIR).toBe("/synthetic/root/vault");
    expect(
      Object.keys(child).some((key) => key.startsWith("FOLIO_SYNC_")),
    ).toBe(false);
    for (const key of [
      "FOLIO_DEV_URL",
      "FOLIO_TEST_FORCE_READY_FAILURE",
      "FOLIO_EMPTY_WORKSPACE",
      "PWDEBUG",
      "PWTEST_WATCH",
      "FOLIO_LOCAL_GUI_BATCH",
      "FOLIO_LOCAL_GUI_DATA_ROOT",
      "FOLIO_LINUX_GUI_CI",
      "FOLIO_GUI_CI_DATA_ROOT",
      "FOLIO_GUI_CI_KEYRING",
    ])
      expect(child).not.toHaveProperty(key);
  });
});
