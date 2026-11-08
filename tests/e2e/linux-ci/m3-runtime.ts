import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fixtureElectronOptions, fixtureRoot } from "../fixture-isolation";
import { killFixture, ownFixture } from "../recovery-ci-runtime";

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", resolve);});
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing isolated port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
/** All paths, credentials, listeners and windows belong to this disposable CI fixture. */
export class M3GuiFixture {
  readonly root = fixtureRoot("m3-gui-");
  readonly directory = join(this.root, "workspace");
  readonly vaultDirectory = join(this.root, "credentials");
  app?: ElectronApplication;
  window?: Page;
  private sequence = 0;
  constructor() {mkdirSync(this.directory, {mode: 0o700});}
  async start(extra: Record<string, string> = {}, passwordStore?: "basic" | "gnome-libsecret") {
    const options = fixtureElectronOptions(this.directory);
    let args = options.args;
    if (process.env.FOLIO_LINUX_GUI_CI === "1") {
      // Playwright's loader appends --password-store=basic after launch args.
      // This fixture-only entry restores the requested real backend before
      // loading product code. Production never gets a test storage override.
      const entry = join(this.root, "electron-entry.cjs");
      writeFileSync(entry, `require("electron").app.commandLine.appendSwitch("password-store", ${JSON.stringify(passwordStore ?? "gnome-libsecret")});\nrequire(${JSON.stringify(resolve("dist/main.cjs"))});\n`, {mode: 0o600});
      args = [...args.slice(0, -1), entry];
    }
    this.app = ownFixture(await electron.launch({args, env: {...options.env, FOLIO_CREDENTIAL_DIR: this.vaultDirectory, ...extra}}));
    this.sequence++;
    await this.app.context().tracing.start({screenshots: true, snapshots: true, sources: true});
    this.window = await this.app.firstWindow();
    await this.window.locator(".page-title").waitFor();
    return this.window;
  }
  async openSettings() {
    await this.window!.getByRole("button", {name: "同期設定", exact: true}).click();
    const dialog = this.window!.getByRole("dialog", {name: "同期設定と転送キャッシュ", exact: true});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", {name: "接続状態を更新"})).toBeEnabled();
    return dialog;
  }
  private async trace() {
    try {await this.app?.context().tracing.stop({path: test.info().outputPath(`m3-session-${this.sequence}.zip`)});} catch {}
  }
  async stop() {if (this.app) {await this.trace(); await killFixture(this.app); this.app = undefined; this.window = undefined;}}
  async quit() {
    const app = this.app; if (!app) return;
    await this.trace();
    const child = app.process();
    await app.evaluate(({app}) => app.quit()).catch(() => {});
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null, {timeout: 10_000}).toBe(true);
    this.app = undefined; this.window = undefined;
  }
  async dispose() {
    try {
      if (test.info().status !== test.info().expectedStatus)
        await this.window?.screenshot({path: test.info().outputPath("m3-failure.png")});
    } catch {}
    await this.stop(); rmSync(this.root, {recursive: true, force: true});
  }
}
