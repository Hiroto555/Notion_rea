import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { fixtureElectronOptions, fixtureRoot } from "../fixture-isolation";
import { killFixture } from "../recovery-ci-runtime";

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
  constructor() {mkdirSync(this.directory, {mode: 0o700});}
  async start(extra: Record<string, string> = {}, passwordStore?: "basic" | "gnome-libsecret") {
    const options = fixtureElectronOptions(this.directory);
    let args = options.args;
    if (passwordStore) args = [...args.slice(0,-1).filter(arg => !arg.startsWith("--password-store=")), "--password-store=" + passwordStore, args.at(-1)!];
    this.app = await electron.launch({args, env: {...options.env, FOLIO_CREDENTIAL_DIR: this.vaultDirectory, ...extra}});
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
  async stop() {if (this.app) {await killFixture(this.app); this.app = undefined; this.window = undefined;}}
  async quit() {
    const app = this.app; if (!app) return;
    const child = app.process();
    await app.evaluate(({app}) => app.quit()).catch(() => {});
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null, {timeout: 10_000}).toBe(true);
    this.app = undefined; this.window = undefined;
  }
  async dispose() {await this.stop(); rmSync(this.root, {recursive: true, force: true});}
}
