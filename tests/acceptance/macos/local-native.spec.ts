import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot } from "../../e2e/fixture-isolation";
import { killFixture, launchFixture } from "../../e2e/recovery-ci-runtime";
import { localGuiDataRoot } from "../../../scripts/local-gui-batch-policy.mjs";

// Actual OS actions are supplied by the native controller while this single
// batch owns the Electron process. Control markers mean only "action sent";
// assertions below determine success. No remote MAC-P05 acceptance is claimed.
let app: ElectronApplication | undefined;
let window: Page;
let root: string;
let control: string;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test.beforeEach(async () => {
  const batch = localGuiDataRoot();
  if (!batch) throw new Error("Local native GUI batch is not authorized");
  control = join(batch, "native-control");
  mkdirSync(control, { recursive: true, mode: 0o700 });
  root = fixtureRoot("native-mac-");
  app = await launchFixture(root);
  window = await app.firstWindow();
  await expect(window.locator(".page-title")).toBeVisible();
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Mac native QA");
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  await expect.poll(() => active()).toBeTruthy();
});
test.afterEach(async () => {
  await killFixture(app);
  app = undefined;
});

async function native(phase: string, details: Record<string, unknown> = {}) {
  const nonce = randomUUID();
  const runtime = await app!.evaluate(({ app }) => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
  }));
  writeFileSync(
    join(control, "current.json"),
    JSON.stringify({
      nonce,
      phase,
      pid: app!.process().pid,
      root,
      runtime,
      ...details,
    }),
    { mode: 0o600 },
  );
  await expect
    .poll(
      () => {
        if (existsSync(join(control, "abort.json")))
          throw new Error("INFRA_BLOCKED: native controller unavailable");
        return existsSync(join(control, nonce + ".done"));
      },
      {
        timeout: 90000,
        intervals: [100, 250, 500],
        message: "Waiting for the authorized native OS action",
      },
    )
    .toBe(true);
}
async function saved() {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}
async function active() {
  return window.evaluate(async () => {
    const state = await globalThis.window.folio.request<any>({ type: "load" });
    const title = (document.querySelector(".page-title") as HTMLInputElement)
      .value;
    return state.pages.find((page: any) => page.title === title);
  });
}
async function exitedThenReopen(child: ChildProcess, expected: any) {
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, {
      timeout: 15000,
    })
    .toBe(true);
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
  app = undefined;
  const priorPid = child.pid;
  app = await launchFixture(root);
  window = await app.firstWindow();
  await expect(window.locator(".page-title")).toBeVisible();
  expect(app.process().pid).not.toBe(priorPid);
  const actual = await active();
  expect(actual.id).toBe(expected.id);
  expect(actual.revision).toBe(expected.revision);
  expect(hash(JSON.stringify(actual.doc))).toBe(
    hash(JSON.stringify(expected.doc)),
  );
  writeFileSync(
    test.info().outputPath("native-reopen.json"),
    JSON.stringify(
      {
        priorPid,
        nextPid: app.process().pid,
        id: actual.id,
        revision: actual.revision,
        contentSha256: hash(JSON.stringify(actual.doc)),
      },
      null,
      2,
    ),
  );
}

test("native Cmd+Q preserves pending input, then exits normally and reopens with a new PID", async () => {
  await window.evaluate(() => {
    (globalThis as any).nativeCloseAttempts = [];
    addEventListener("beforeunload", (event) => {
      queueMicrotask(() =>
        (globalThis as any).nativeCloseAttempts.push({
          prevented: event.defaultPrevented,
          trusted: event.isTrusted,
        }),
      );
    });
  });
  await app!.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    const gate: any = ((globalThis as any).nativeSaveGate = {
      hold: true,
      held: false,
    });
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      if (request.type === "save:commit" && gate.hold) {
        gate.held = true;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      const result = await original(event, request);
      if (request.type === "save:commit") gate.committed = true;
      return result;
    });
  });
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Mac native pending input");
  await expect
    .poll(() => app!.evaluate(() => (globalThis as any).nativeSaveGate.held))
    .toBe(true);
  const pid = app!.process().pid;
  await native("cmd-q-pending");
  await expect
    .poll(() => window.evaluate(() => (globalThis as any).nativeCloseAttempts))
    .toContainEqual({ prevented: true, trusted: true });
  expect(app!.process().pid).toBe(pid);
  expect(app!.process().exitCode).toBeNull();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Mac native pending input");
  await app!.evaluate(() => {
    const gate = (globalThis as any).nativeSaveGate;
    gate.hold = false;
    gate.release();
  });
  await expect
    .poll(() =>
      app!.evaluate(() => (globalThis as any).nativeSaveGate.committed),
    )
    .toBe(true);
  const lookup = window.getByRole("button", {
    name: "保存結果を確認",
    exact: true,
  });
  if (await lookup.isVisible()) await lookup.click();
  await saved();
  const expected = await active();
  const previous = app!.process();
  await native("cmd-q-clean");
  await exitedThenReopen(previous, expected);
});

test("native red close exits after save and preserves the page through a new PID", async () => {
  await window
    .locator(".folio-editor")
    .fill("Red close: 日本語 English preserved");
  await saved();
  const expected = await active();
  const previous = app!.process();
  await native("red-close");
  await exitedThenReopen(previous, expected);
});

test("native picker cancellation and file selection preserve source and import only synthetic content", async () => {
  const before = await active();
  const input = join(root, "native-import.md");
  writeFileSync(
    input,
    "# Native picker canary\n\n日本語 English native import\n",
    { mode: 0o600 },
  );
  await window.getByRole("button", { name: "インポート", exact: true }).click();
  await native("picker-cancel");
  expect((await active()).id).toBe(before.id);
  await window.getByRole("button", { name: "インポート", exact: true }).click();
  await native("picker-select", { input });
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("native-import");
  await expect(window.locator(".folio-editor h1")).toHaveText(
    "Native picker canary",
  );
  await saved();
  const source = await window.evaluate(
    async (id) =>
      (await globalThis.window.folio.request<any>({ type: "load" })).pages.find(
        (p: any) => p.id === id,
      ),
    before.id,
  );
  expect(source).toEqual(before);
});

test("native Cmd+C/V roundtrip uses a synthetic canary and restores the previous native clipboard", async () => {
  const canary = "Native clipboard 日本語 English canary";
  await app!.evaluate(async ({ clipboard, ClipboardItem }) => {
    (globalThis as any).nativeClipboardBackup = await Promise.all(
      (await clipboard.read())
        .filter((item) => item.types.length > 0)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(
                  item.types.map(async (type) => [
                    type,
                    await item.getType(type),
                  ]),
                ),
              ),
            ),
        ),
    );
  });
  try {
    await window.locator(".folio-editor").fill(canary);
    await saved();
    await window.locator(".folio-editor").click();
    await window.keyboard.press("Meta+A");
    await native("clipboard-copy");
    expect(
      await app!.evaluate(async ({ clipboard }, expected) => {
        for (const item of await clipboard.read())
          if (item.types.includes("text/plain"))
            return (
              (await (await item.getType("text/plain")).text()).trim() ===
              expected
            );
        return false;
      }, canary),
    ).toBe(true);
    await window.keyboard.press("ArrowRight");
    await native("clipboard-paste");
    await expect
      .poll(
        async () =>
          (await window.locator(".folio-editor").innerText()).split(canary)
            .length - 1,
      )
      .toBe(2);
    await saved();
  } finally {
    await app!.evaluate(async ({ clipboard }) => {
      const items = (globalThis as any).nativeClipboardBackup;
      if (items?.length) await clipboard.write(items);
      else clipboard.clear();
    });
  }
});

test("native Japanese IME emits trusted composition, commits text and survives reopen", async () => {
  await window.locator(".folio-editor").fill("");
  await saved();
  await window.locator(".folio-editor").click();
  await window.evaluate(() => {
    (globalThis as any).nativeImeEvents = [];
    for (const type of [
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ]) {
      addEventListener(type, (event) => {
        const e = event as CompositionEvent;
        (globalThis as any).nativeImeEvents.push({
          type,
          trusted: e.isTrusted,
          data: e.data,
        });
      });
    }
  });
  await native("ime-type");
  const events = await window.evaluate(
    () => (globalThis as any).nativeImeEvents,
  );
  writeFileSync(
    test.info().outputPath("native-ime-probe.json"),
    JSON.stringify(
      { events, text: await window.locator(".folio-editor").innerText() },
      null,
      2,
    ),
  );
  if (!events.some((e: any) => e.type === "compositionstart" && e.trusted))
    throw new Error(
      "INFRA_BLOCKED: a trusted Japanese IME composition route was not established; no product failure inferred",
    );
  await native("ime-commit");
  await expect
    .poll(() =>
      window.evaluate(() =>
        (globalThis as any).nativeImeEvents.some(
          (e: any) => e.type === "compositionend" && e.trusted,
        ),
      ),
    )
    .toBe(true);
  await expect(window.locator(".folio-editor")).toContainText(
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  );
  await saved();
  const expected = await active();
  const previous = app!.process();
  await app!.evaluate(({ app }) => app.quit()).catch(() => {});
  await exitedThenReopen(previous, expected);
});
