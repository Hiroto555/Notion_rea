import {
  _electron as electron,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fixtureElectronOptions } from "./fixture-isolation";

let serial = 0;
const evidence = new WeakMap<ElectronApplication, () => Promise<void>>();

export async function launchFixture(directory: string) {
  const app = await electron.launch(fixtureElectronOptions(directory));
  if (process.env.FOLIO_LINUX_GUI_CI !== "1") return app;
  const info = test.info(),
    name = `electron-${++serial}`;
  const events: unknown[] = [];
  const record = (stage: string, detail?: unknown) => {
    events.push({ stage, time: Date.now(), detail });
    writeFileSync(
      info.outputPath(`${name}-diagnostics.json`),
      JSON.stringify(events, null, 2),
    );
  };
  const child = app.process();
  record("launched", { pid: child.pid, data: "isolated RUNNER_TEMP fixture" });
  child.stderr?.on("data", (bytes) => record("stderr", String(bytes)));
  child.once("exit", (code, signal) => record("exit", { code, signal }));
  try {
    await app
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    const window = await app.firstWindow();
    window.on("pageerror", (error) => record("pageerror", error.message));
    window.on("crash", () => record("renderer-crash"));
    let captured = false;
    evidence.set(app, async () => {
      if (captured) return;
      captured = true;
      record("capture", { status: info.status, retry: info.retry });
      await window
        .screenshot({ path: info.outputPath(`${name}.png`), timeout: 1000 })
        .catch((error) => record("screenshot-error", String(error)));
      await app
        .evaluate(() => {
          const g = globalThis as any;
          return JSON.parse(
            JSON.stringify(
              Object.fromEntries(
                [
                  "r4Restore",
                  "r4PageAck",
                  "r4PreventedUnload",
                  "r6RecoveryGate",
                  "r7SaveGate",
                  "guardedUpdates",
                ]
                  .filter((key) => g[key] !== undefined)
                  .map((key) => [key, g[key]]),
              ),
            ),
          );
        })
        .then((journal) =>
          writeFileSync(
            info.outputPath(`${name}-ipc.json`),
            JSON.stringify(journal, null, 2),
          ),
        )
        .catch((error) => record("ipc-evidence-error", String(error)));
      await app
        .context()
        .tracing.stop({ path: info.outputPath(`${name}-trace.zip`) })
        .catch((error) => record("trace-error", String(error)));
    });
    return app;
  } catch (error) {
    record("startup-error", String(error));
    child.kill("SIGKILL");
    throw error;
  }
}

// Called before terminating only this fixture's child. Fault tests still kill
// with SIGKILL after their own durable-checkpoint assertions.
export async function captureFixture(app?: ElectronApplication) {
  if (app) await evidence.get(app)?.();
}

export async function killFixture(app?: ElectronApplication) {
  if (!app) return;
  await captureFixture(app);
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null)
    await new Promise<void>((done, reject) => {
      child.once("exit", () => done());
      if (!child.kill("SIGKILL"))
        reject(new Error("Could not kill test-owned Electron"));
    });
}
