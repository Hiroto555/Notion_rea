import { expect, test, type ElectronApplication } from "@playwright/test";
import { disposeR7, launchR7, r7Data } from "./r7-fixture";

async function openSearch(window: Awaited<ReturnType<typeof launchR7>>["window"]) {
  await window.keyboard.press("Meta+p");
  const dialog = window.getByRole("dialog", {
    name: "ワークスペース検索",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("search ranks title matches first and shows body and property context", async () => {
  const data = r7Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR7(data);
    app = running.app;
    const window = running.window;
    const dialog = await openSearch(window);
    await dialog.getByLabel("検索キーワード").fill("Needle");

    const results = dialog
      .getByRole("group", { name: "検索結果", exact: true })
      .getByRole("button");
    const bodyResult = results.filter({ hasText: "Zeta Body" }).first();
    const propertyResult = results
      .filter({ hasText: "Omega Property" })
      .first();
    await expect(results.first()).toContainText("Needle Title");
    await expect(bodyResult).toContainText("Needle appears in body context");
    await expect(propertyResult).toContainText("Needle context");

    const text = await results.evaluateAll((nodes) =>
      nodes.map((node) => node.textContent ?? ""),
    );
    const titleAt = text.findIndex((value) => value.includes("Needle Title"));
    const bodyAt = text.findIndex((value) => value.includes("Zeta Body"));
    const propertyAt = text.findIndex((value) =>
      value.includes("Omega Property"),
    );
    expect(titleAt).toBe(0);
    expect(bodyAt).toBeGreaterThan(titleAt);
    expect(propertyAt).toBeGreaterThan(titleAt);
  } finally {
    await disposeR7(data, app);
  }
});

test("a late search response cannot replace a newer query's results", async () => {
  const data = r7Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR7(data);
    app = running.app;
    const window = running.window;
    await app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as any;
      const original = ipc._invokeHandlers.get("folio:request");
      const gate: any = ((globalThis as any).r7SearchGate = {
        seen: [],
        held: false,
      });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (request.type === "search") gate.seen.push(request.query);
        if (
          request.type === "search" &&
          request.query === "stale first" &&
          !gate.held
        ) {
          gate.held = true;
          gate.result = result;
          await new Promise<void>((release) => {
            gate.release = release;
          });
        }
        return result;
      });
    });

    const dialog = await openSearch(window);
    const input = dialog.getByLabel("検索キーワード");
    const results = dialog
      .getByRole("group", { name: "検索結果", exact: true })
      .getByRole("button");
    await input.fill("stale first");
    await expect
      .poll(() =>
        app!.evaluate(() =>
          (globalThis as any).r7SearchGate.seen.includes("stale first"),
        ),
      )
      .toBe(true);

    await input.fill("stale second");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText("Stale Second Response");

    await app.evaluate(() => (globalThis as any).r7SearchGate.release());
    // Give the held IPC response time to reach and be ignored by the renderer.
    await window.waitForTimeout(150);
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText("Stale Second Response");
    await expect(results).not.toContainText("Stale First Response");
    await expect(input).toHaveValue("stale second");
  } finally {
    await disposeR7(data, app);
  }
});
