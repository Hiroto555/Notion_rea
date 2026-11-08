import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localGuiDataRoot } from "../scripts/local-gui-batch-policy.mjs";
import { fixtureRoot, fixtureElectronOptions } from "./e2e/fixture-isolation";

function isolated() {
  const root = mkdtempSync(join(tmpdir(), "folio-local-gui-policy-"));
  const env: NodeJS.ProcessEnv = {
    FOLIO_GUI_TEST_OPT_IN: "1",
    FOLIO_LOCAL_GUI_BATCH: "1",
    FOLIO_LOCAL_GUI_DATA_ROOT: root,
  };
  return {
    root,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

it("keeps ordinary Node imports inert when no local batch is requested", () => {
  expect(localGuiDataRoot({}, "darwin")).toBeUndefined();
});
it("requires both exact opt-ins and a temporary root for local Mac batches", () => {
  const t = isolated();
  try {
    expect(localGuiDataRoot(t.env, "darwin")).toBe(realpathSync(t.root));
    for (const key of Object.keys(t.env))
      for (const value of [undefined, "", "01", "true"])
        expect(() =>
          localGuiDataRoot({ ...t.env, [key]: value }, "darwin"),
        ).toThrow();
    expect(() => localGuiDataRoot(t.env, "linux")).toThrow();
  } finally {
    t.cleanup();
  }
});
it("refuses inherited CI, debug and dev routes", () => {
  const t = isolated();
  try {
    for (const key of [
      "GITHUB_ACTIONS",
      "FOLIO_LINUX_GUI_CI",
      "FOLIO_GUI_CI_DATA_ROOT",
      "PWDEBUG",
      "PWTEST_WATCH",
      "FOLIO_DEV_URL",
    ])
      expect(() =>
        localGuiDataRoot(
          { ...t.env, [key]: key === "GITHUB_ACTIONS" ? "true" : "1" },
          "darwin",
        ),
      ).toThrow();
  } finally {
    t.cleanup();
  }
});
it("creates unique fixture roots and vault paths inside the authorized temporary batch", () => {
  const t = isolated();
  try {
    const first = fixtureRoot("local-", t.env, "darwin"),
      second = fixtureRoot("local-", t.env, "darwin");
    expect(first).not.toBe(second);
    expect(first.startsWith(realpathSync(t.root) + "/")).toBe(true);
    const workspace = join(first, "workspace");
    mkdirSync(workspace);
    const options = fixtureElectronOptions(
      workspace,
      {
        ...t.env,
        FOLIO_DATA_DIR: "/original",
        FOLIO_CREDENTIAL_DIR: "/original-vault",
        FOLIO_SYNC_TOKEN: "synthetic",
      },
      "darwin",
    );
    expect(options.env.FOLIO_DATA_DIR).toBe(workspace);
    expect(options.env.FOLIO_CREDENTIAL_DIR).toBe(workspace + "-credentials");
    expect(options.env.FOLIO_SYNC_TOKEN).toBeUndefined();
    expect(options.args).not.toContain("--no-sandbox");
  } finally {
    t.cleanup();
  }
});
it("refuses a workspace outside the owned root and an escaping alias", () => {
  const t = isolated(),
    outside = isolated();
  try {
    expect(() =>
      fixtureElectronOptions(outside.root, t.env, "darwin"),
    ).toThrow();
    symlinkSync(outside.root, join(t.root, "escape"));
    expect(() =>
      fixtureElectronOptions(join(t.root, "escape"), t.env, "darwin"),
    ).toThrow();
    expect(() => fixtureRoot("../escape-", t.env, "darwin")).toThrow();
  } finally {
    t.cleanup();
    outside.cleanup();
  }
});
it("refuses a repository directory or a public temporary directory as batch root", () => {
  const t = isolated();
  try {
    expect(() =>
      localGuiDataRoot(
        { ...t.env, FOLIO_LOCAL_GUI_DATA_ROOT: process.cwd() },
        "darwin",
      ),
    ).toThrow();
    chmodSync(t.root, 0o755);
    expect(() => localGuiDataRoot(t.env, "darwin")).toThrow();
  } finally {
    t.cleanup();
  }
});
