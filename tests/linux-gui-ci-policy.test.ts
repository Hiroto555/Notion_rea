import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  assertLinuxGuiCi,
  assertCiDataRoot,
  isolatedGuiEnv,
} from "../scripts/linux-gui-ci-policy.mjs";

const allowed = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "Linux",
  RUNNER_TEMP: "/tmp/runner",
  DISPLAY: ":99",
};
it("refuses every macOS invocation, even with inherited opt-in and Actions variables", () => {
  expect(() =>
    assertLinuxGuiCi({
      platform: "darwin",
      env: { ...allowed, FOLIO_GUI_TEST_OPT_IN: "1" },
    }),
  ).toThrow("local GUI execution is refused");
});
it("requires the Linux Actions environment and isolated display before spawning", () => {
  expect(() =>
    assertLinuxGuiCi({ platform: "linux", env: allowed }),
  ).not.toThrow();
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "DISPLAY",
  ])
    expect(() =>
      assertLinuxGuiCi({ platform: "linux", env: { ...allowed, [key]: "" } }),
    ).toThrow();
  for (const key of ["PWDEBUG", "PWTEST_WATCH"])
    expect(() =>
      assertLinuxGuiCi({ platform: "linux", env: { ...allowed, [key]: "1" } }),
    ).toThrow();
});
it("rejects missing, relative, ancestor and sibling data roots", () => {
  expect(() =>
    assertCiDataRoot("/tmp/runner/new", "/tmp/runner"),
  ).not.toThrow();
  for (const root of [
    undefined,
    "relative",
    "/tmp/runner",
    "/tmp",
    "/tmp/runner-other/new",
  ])
    expect(() => assertCiDataRoot(root, "/tmp/runner")).toThrow();
});
it("does not forward sync identity, a real data path or a dev URL to GUI children", () => {
  const result = isolatedGuiEnv(
    {
      ...allowed,
      FOLIO_SYNC_TOKEN: "synthetic",
      FOLIO_SYNC_ENABLED: "1",
      FOLIO_DATA_DIR: "/original",
      FOLIO_DEV_URL: "http://127.0.0.1:1",
      FOLIO_TEST_FORCE_READY_FAILURE: "1",
    },
    "/tmp/runner/new",
  );
  expect(result.FOLIO_GUI_CI_DATA_ROOT).toBe("/tmp/runner/new");
  expect(result.FOLIO_LINUX_GUI_CI).toBe("1");
  expect(Object.keys(result).some((key) => key.startsWith("FOLIO_SYNC_"))).toBe(
    false,
  );
  expect(result.FOLIO_DATA_DIR).toBeUndefined();
  expect(result.FOLIO_DEV_URL).toBeUndefined();
});
it("the CLI refuses outside Actions before npm, Electron or a display command can be spawned", () => {
  const root = mkdtempSync(join(tmpdir(), "folio-gui-refusal-"));
  try {
    const child = spawnSync(
      process.execPath,
      [resolve("scripts/run-linux-gui-ci.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          FOLIO_GUI_TEST_OPT_IN: "1",
        },
        encoding: "utf8",
      },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("local GUI execution is refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
