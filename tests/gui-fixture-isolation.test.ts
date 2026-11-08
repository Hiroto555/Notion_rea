import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureElectronOptions, fixtureRoot } from "./e2e/fixture-isolation";

function isolated() {
  const runner = mkdtempSync(join(tmpdir(), "folio-fixture-policy-"));
  const root = join(runner, "gui");
  mkdirSync(root);
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    DISPLAY: ":99",
    RUNNER_TEMP: runner,
    FOLIO_GUI_CI_DATA_ROOT: root,
    FOLIO_LINUX_GUI_CI: "1",
  };
  return { runner, root, env };
}
it("creates fresh fixture directories only inside the CI root", () => {
  const t = isolated();
  try {
    const first = fixtureRoot("recovery-", t.env, "linux"),
      second = fixtureRoot("recovery-", t.env, "linux");
    expect(first.startsWith(realpathSync(t.root) + "/")).toBe(true);
    expect(first).not.toBe(second);
    expect(() => fixtureRoot("../escape-", t.env, "linux")).toThrow();
  } finally {
    rmSync(t.runner, { recursive: true, force: true });
  }
});
it("refuses CI fixture setup on macOS and rejects a workspace outside the root", () => {
  const t = isolated();
  try {
    expect(() => fixtureRoot("recovery-", t.env, "darwin")).toThrow(
      "local GUI execution is refused",
    );
    expect(() => fixtureElectronOptions(t.runner, t.env, "linux")).toThrow();
  } finally {
    rmSync(t.runner, { recursive: true, force: true });
  }
});
it("strips inherited sync/data/dev settings and confines no-sandbox to Linux CI", () => {
  const t = isolated();
  try {
    const dir = fixtureRoot("recovery-", t.env, "linux");
    const options = fixtureElectronOptions(
      dir,
      {
        ...t.env,
        FOLIO_SYNC_TOKEN: "synthetic",
        FOLIO_SYNC_ENABLED: "1",
        FOLIO_DATA_DIR: "/original",
        FOLIO_DEV_URL: "http://127.0.0.1:1",
      },
      "linux",
    );
    expect(options.args).toContain("--no-sandbox");
    expect(options.env.FOLIO_DATA_DIR).toBe(dir);
    expect(options.env.FOLIO_DEV_URL).toBeUndefined();
    expect(
      Object.keys(options.env).some((key) => key.startsWith("FOLIO_SYNC_")),
    ).toBe(false);
    expect(fixtureElectronOptions(dir, {}, "darwin").args).not.toContain(
      "--no-sandbox",
    );
  } finally {
    rmSync(t.runner, { recursive: true, force: true });
  }
});
