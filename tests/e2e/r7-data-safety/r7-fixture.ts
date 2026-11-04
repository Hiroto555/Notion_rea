import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { openR7Settings } from "../r5-fixture";

/**
 * Small R7-only helper around the existing R4/R5 fixtures. The fault is
 * injected after the real save handler has returned, so a held or lost ACK
 * never skips the actual SQLite commit or receipt write.
 */
export async function gateR7Save(
  app: ElectronApplication,
  pageId: string,
  mode: "held" | "lost",
) {
  await app.evaluate(
    ({ ipcMain }, config) => {
      const ipc = ipcMain as any;
      const original = ipc._invokeHandlers.get("folio:request");
      const gate: any = ((globalThis as any).r7SaveGate = {
        commits: [],
        resolves: [],
        results: [],
        injected: false,
      });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (request.type === "save:resolve")
          gate.resolves.push(structuredClone(request.operation));
        if (
          request.type === "save:commit" &&
          request.operation.pageId === config.pageId
        ) {
          gate.commits.push(structuredClone(request.operation));
          gate.results.push(result);
          if (!gate.injected) {
            gate.injected = true;
            gate.operation = structuredClone(request.operation);
            gate.result = result;
            if (config.mode === "lost")
              throw new Error("R7 synthetic post-COMMIT ACK loss");
            await new Promise<void>((release) => {
              gate.release = release;
            });
          }
        }
        return result;
      });
    },
    { pageId, mode },
  );
}

export async function readR7SaveGate(app: ElectronApplication) {
  return app.evaluate(() => {
    const gate = (globalThis as any).r7SaveGate;
    return {
      commits: gate.commits,
      resolves: gate.resolves,
      results: gate.results,
      injected: gate.injected,
      operation: gate.operation,
      result: gate.result,
    };
  });
}

export async function r7OpenOptions(window: Page) {
  await openR7Settings(window, "filter");
}

export async function r7WaitForHeldSave(app: ElectronApplication) {
  await expect
    .poll(() =>
      app.evaluate(() => typeof (globalThis as any).r7SaveGate.release),
    )
    .toBe("function");
}
