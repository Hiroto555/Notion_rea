import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/persistence/store";
import type { CrashRecoverySnapshot } from "../../src/shared/crash-recovery";
import {
  addR5Record,
  createR5Database,
  disposeR5,
  openR5Database,
  openR5Record,
  r5Data,
  r5Database,
  r5Saved,
  r5Settings,
  r5SettingsSaved,
  r5Snapshot,
  type R5Data,
} from "./r5-fixture";

const recoveryDialog = (window: Page) =>
  window.getByRole("dialog", { name: "前回の入力を復旧", exact: true });
const journalPath = (data: R5Data) => join(data.root, "crash-recovery.json");
type Journal = {
  format: string;
  generation: number;
  snapshot: CrashRecoverySnapshot;
};
const journal = (data: R5Data) =>
  JSON.parse(readFileSync(journalPath(data), "utf8")) as Journal;
const noInput = (snapshot: CrashRecoverySnapshot) =>
  [
    snapshot.pages,
    snapshot.records,
    snapshot.databases,
    snapshot.creations,
    snapshot.rawDrafts,
    snapshot.externalOperations,
    snapshot.unverifiedInputs ?? [],
  ].every((entries) => entries.length === 0);

/** Kill only the child created by this test, after its durable checkpoint ACK. */
async function killOwned(app: ElectronApplication) {
  const child = app.process();
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  await new Promise<void>((done, reject) => {
    child.once("exit", () => done());
    if (!child.kill("SIGKILL"))
      reject(new Error("Could not kill test-owned Electron"));
  });
  expect(child.signalCode).toBe("SIGKILL");
}

/** Startup recovery deliberately renders no page-title until the user chooses. */
async function launchRecovery(data: R5Data, pending = false) {
  const app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: data.root },
  });
  try {
    const window = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      data.root,
    );
    expect(await app.evaluate(({ app }) => app.getPath("sessionData"))).toBe(
      join(data.root, "session"),
    );
    if (pending) await expect(recoveryDialog(window)).toBeVisible();
    else {
      await expect(window.locator(".page-title")).toBeVisible();
      await r5Saved(window);
    }
    return { app, window };
  } catch (error) {
    if (app.process().exitCode === null && app.process().signalCode === null)
      await killOwned(app);
    throw error;
  }
}

async function durable(
  window: Page,
  data: R5Data,
  match: (snapshot: CrashRecoverySnapshot) => boolean,
) {
  await expect
    .poll(
      async () => {
        if (
          (await window
            .locator(".r6-recovery-status")
            .getAttribute("data-recovery-state")) !== "saved"
        )
          return false;
        try {
          return match(journal(data).snapshot);
        } catch {
          return false;
        }
      },
      {
        message:
          "latest captured input must be durably acknowledged before SIGKILL",
      },
    )
    .toBe(true);
  const disk = journal(data);
  expect(disk.format).toBe("folio-crash-recovery-v1");
  const read = await window.evaluate(() =>
    globalThis.window.folio.request<any>({ type: "recovery:read" }),
  );
  expect(read).toEqual({
    status: "ready",
    generation: disk.generation,
    snapshot: disk.snapshot,
  });
  return disk;
}
async function settled(window: Page, data: R5Data) {
  await r5Saved(window);
  await expect(window.locator(".r6-recovery-status")).toHaveAttribute(
    "data-recovery-state",
    "saved",
  );
  // A fresh workspace with no edits has no journal yet. After any checkpoint,
  // absence is not used as a substitute for inspecting its empty snapshot.
  const read = await window.evaluate(() =>
    globalThis.window.folio.request<any>({ type: "recovery:read" }),
  );
  if (read.status === "empty") {
    expect(existsSync(journalPath(data))).toBe(false);
    return;
  }
  await durable(window, data, noInput);
}

type GateConfig = {
  type:
    "save:commit" | "database:commit" | "database:resolve" | "recovery:copy";
  pageId?: string;
  kind?: "createDatabase" | "createRecord" | "updateDatabase";
  mode?: "held" | "lost" | "unknown";
};
/** Mutation faults happen after COMMIT; a lookup fault hides only its first reply. */
async function gate(
  app: ElectronApplication,
  config: GateConfig | null = null,
) {
  await app.evaluate(({ ipcMain }, config) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    const trace: any = ((globalThis as any).r6RecoveryGate = {
      calls: [],
      injected: false,
    });
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      const call = { request, result };
      if (
        [
          "save:commit",
          "save:resolve",
          "database:commit",
          "database:resolve",
          "recovery:copy",
        ].includes(request.type)
      )
        trace.calls.push(call);
      if (
        config &&
        !trace.injected &&
        request.type === config.type &&
        (!config.pageId || request.operation?.pageId === config.pageId) &&
        (!config.kind || request.operation?.command?.kind === config.kind)
      ) {
        trace.injected = true;
        trace.selected = { request, result };
        if (config.mode === "unknown") {
          call.result = {
            status: "unknown",
            operationId: result.operationId,
            sessionId: result.sessionId,
            seq: result.seq,
            fingerprint: result.fingerprint,
            commandKind: result.commandKind,
            message: "R6 synthetic receipt temporarily unavailable",
          };
          return call.result;
        }
        if (config.mode === "lost")
          throw new Error("R6 synthetic post-COMMIT ACK loss");
        await new Promise<void>(() => {});
      }
      return result;
    });
  }, config);
}
async function trace(app: ElectronApplication): Promise<any> {
  return app.evaluate(() => (globalThis as any).r6RecoveryGate);
}
async function held(app: ElectronApplication) {
  await expect.poll(async () => (await trace(app)).injected).toBe(true);
  const selected = (await trace(app)).selected;
  expect(selected.result.status).toBe("applied");
  return selected;
}
async function resume(window: Page) {
  await recoveryDialog(window)
    .getByRole("button", { name: "入力を復元", exact: true })
    .click();
  await expect(recoveryDialog(window)).toBeHidden();
}
async function assertResolvedOnce(
  app: ElectronApplication,
  operation: any,
  family: "save" | "database",
) {
  const calls = (await trace(app)).calls;
  const resolved = calls.filter(
    (call: any) =>
      call.request.type === `${family}:resolve` &&
      call.request.operation.operationId === operation.operationId,
  );
  expect(resolved).toHaveLength(1);
  expect(resolved[0].request.operation).toEqual(operation);
  expect(resolved[0].result.status).toBe("applied");
  expect(
    calls.filter(
      (call: any) =>
        call.request.type === `${family}:commit` &&
        call.request.operation.operationId === operation.operationId,
    ),
  ).toHaveLength(0);
}
async function options(window: Page) {
  const details = r5Settings(window).locator("details");
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await details.locator("summary").click();
}

for (const lane of ["page", "record"] as const) {
  test(`SIGKILL after ${lane} COMMIT and later input restores the latest title and body without applying the receipt twice`, async () => {
    const data = r5Data();
    let app: ElectronApplication | undefined;
    try {
      let running = await launchRecovery(data);
      app = running.app;
      let window = running.window;
      let pageId = data.home.id;
      if (lane === "record") {
        const owner = await createR5Database(window, "R6 recovery records");
        const record = await addR5Record(window, owner.id, "R6 initial record");
        pageId = record.pageId;
        await openR5Record(window, record.title);
      }
      await settled(window, data);
      const title = window.getByLabel(
        lane === "record" ? "レコードのタイトル" : "ページタイトル",
        { exact: true },
      );
      const body = window.locator(
        lane === "record" ? ".r3-record-page .folio-editor" : ".folio-editor",
      );
      await gate(app, { type: "save:commit", pageId });
      await title.fill(`R6 ${lane} committed before crash`);
      const committed = await held(app);
      await title.fill(`R6 ${lane} latest title`);
      await body.fill(`R6 ${lane} body entered after held ACK`);
      if (lane === "record")
        await window
          .locator(".r3-record-page")
          .getByLabel("メモ", { exact: true })
          .fill("later record property");
      await durable(window, data, (snapshot) => {
        const entry = (
          lane === "record" ? snapshot.records : snapshot.pages
        ).find((entry) => entry.base.id === pageId);
        return (
          !!entry &&
          entry.operation?.operationId ===
            committed.request.operation.operationId &&
          entry.intents.some(
            (intent) =>
              intent.seq > committed.request.operation.seq &&
              intent.patch.title === `R6 ${lane} latest title`,
          ) &&
          JSON.stringify(entry.intents).includes(
            `R6 ${lane} body entered after held ACK`,
          ) &&
          (lane !== "record" ||
            JSON.stringify(entry.intents).includes("later record property"))
        );
      });
      await killOwned(app);
      app = undefined;
      running = await launchRecovery(data, true);
      app = running.app;
      window = running.window;
      await gate(app);
      await resume(window);
      await settled(window, data);
      await expect(
        window.getByLabel(
          lane === "record" ? "レコードのタイトル" : "ページタイトル",
          { exact: true },
        ),
      ).toHaveValue(`R6 ${lane} latest title`);
      await expect(
        window.locator(
          lane === "record" ? ".r3-record-page .folio-editor" : ".folio-editor",
        ),
      ).toContainText(`R6 ${lane} body entered after held ACK`);
      const state = await r5Snapshot(window),
        saved = state.pages.find((page) => page.id === pageId)!;
      expect(saved.title).toBe(`R6 ${lane} latest title`);
      expect(JSON.stringify(saved.doc)).toContain(
        `R6 ${lane} body entered after held ACK`,
      );
      if (lane === "record")
        expect(
          state.records?.find((record) => record.pageId === pageId)?.values
            .note,
        ).toBe("later record property");
      await assertResolvedOnce(app, committed.request.operation, "save");
      await killOwned(app);
      app = undefined;
      running = await launchRecovery(data);
      app = running.app;
      window = running.window;
      await expect(recoveryDialog(window)).toHaveCount(0);
      expect(
        (await r5Snapshot(window)).pages.find((page) => page.id === pageId),
      ).toEqual(saved);
    } finally {
      await disposeR5(data, app);
    }
  });
}

test("SIGKILL after database creation COMMIT retains an unknown lookup and resolves the same operation later without resending or duplicating it", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchRecovery(data);
    app = running.app;
    let window = running.window;
    await gate(app, { type: "database:commit", kind: "createDatabase" });
    await window
      .getByRole("button", { name: "新しいデータベース", exact: true })
      .click();
    const dialog = window.getByRole("dialog", {
      name: "新しいデータベース",
      exact: true,
    });
    await dialog
      .getByLabel("データベース名", { exact: true })
      .fill("R6 once-only database");
    await dialog.getByRole("button", { name: "作成", exact: true }).click();
    const committed = await held(app);
    await durable(
      window,
      data,
      (snapshot) =>
        snapshot.creations.length === 1 &&
        snapshot.creations[0].operationId ===
          committed.request.operation.operationId,
    );
    const captured = readFileSync(journalPath(data), "utf8");
    await killOwned(app);
    app = undefined;
    running = await launchRecovery(data, true);
    app = running.app;
    window = running.window;
    await gate(app, {
      type: "database:resolve",
      kind: "createDatabase",
      mode: "unknown",
    });
    await recoveryDialog(window)
      .getByRole("button", { name: "入力を復元", exact: true })
      .click();
    await expect(recoveryDialog(window).getByRole("alert")).toContainText(
      "R6 synthetic receipt temporarily unavailable",
    );
    await expect(recoveryDialog(window)).toBeVisible();
    expect(readFileSync(journalPath(data), "utf8")).toBe(captured);
    expect(
      (await trace(app)).calls.filter(
        (call: any) => call.request.type === "database:commit",
      ),
    ).toHaveLength(0);
    await resume(window);
    await settled(window, data);
    await openR5Database(window, "R6 once-only database");
    const created = (await r5Snapshot(window)).pages.filter(
      (page) => page.title === "R6 once-only database",
    );
    expect(created).toEqual([committed.result.page]);
    expect((await r5Database(window, created[0].id)).records).toEqual([]);
    const calls = (await trace(app)).calls;
    const lookups = calls.filter(
      (call: any) => call.request.type === "database:resolve",
    );
    expect(lookups).toHaveLength(2);
    expect(lookups.map((call: any) => call.request.operation)).toEqual([
      committed.request.operation,
      committed.request.operation,
    ]);
    expect(lookups.map((call: any) => call.result.status)).toEqual([
      "unknown",
      "applied",
    ]);
    expect(
      calls.filter((call: any) => call.request.type === "database:commit"),
    ).toHaveLength(0);
  } finally {
    await disposeR5(data, app);
  }
});

test("SIGKILL after row creation COMMIT restores later owner input and retains exactly the original row", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchRecovery(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window, "R6 row owner");
    await settled(window, data);
    await gate(app, { type: "database:commit", kind: "createRecord" });
    await window.getByRole("button", { name: "新規行", exact: true }).click();
    const committed = await held(app);
    await window
      .getByLabel("ページタイトル", { exact: true })
      .fill("R6 owner edited after row ACK");
    await durable(window, data, (snapshot) =>
      snapshot.databases.some(
        (entry) =>
          entry.base.id === owner.id &&
          entry.operation?.operationId ===
            committed.request.operation.operationId &&
          entry.intents.some(
            (intent) =>
              intent.kind === "page" &&
              intent.seq > committed.request.operation.seq &&
              intent.patch.title === "R6 owner edited after row ACK",
          ),
      ),
    );
    await killOwned(app);
    app = undefined;
    running = await launchRecovery(data, true);
    app = running.app;
    window = running.window;
    await gate(app);
    await resume(window);
    await settled(window, data);
    await expect(window.locator(".page-title")).toHaveValue(
      "R6 owner edited after row ACK",
    );
    expect((await r5Database(window, owner.id)).records).toEqual([
      committed.result.record,
    ]);
    await expect(
      window.locator(`tr[data-record-id="${committed.result.record.pageId}"]`),
    ).toHaveCount(1);
    await assertResolvedOnce(app, committed.request.operation, "database");
  } finally {
    await disposeR5(data, app);
  }
});

test("SIGKILL after settings COMMIT preserves later view input without replaying the acknowledged owner revision", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchRecovery(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window, "R6 settings owner");
    await settled(window, data);
    await gate(app, { type: "database:commit", kind: "updateDatabase" });
    await r5Settings(window)
      .getByLabel("ビュー名", { exact: true })
      .fill("R6 committed view");
    const committed = await held(app);
    await r5Settings(window)
      .getByLabel("ビュー名", { exact: true })
      .fill("R6 latest view");
    await r5Settings(window)
      .getByLabel("ビュー内検索", { exact: true })
      .fill("R6 later search");
    await durable(window, data, (snapshot) =>
      snapshot.databases.some(
        (entry) =>
          entry.base.id === owner.id &&
          entry.operation?.operationId ===
            committed.request.operation.operationId &&
          JSON.stringify(
            entry.intents.filter(
              (intent) => intent.seq > committed.request.operation.seq,
            ),
          ).includes("R6 latest view") &&
          JSON.stringify(entry.intents).includes("R6 later search"),
      ),
    );
    await killOwned(app);
    app = undefined;
    running = await launchRecovery(data, true);
    app = running.app;
    window = running.window;
    await gate(app);
    await resume(window);
    await settled(window, data);
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("R6 latest view");
    await expect(
      r5Settings(window).getByLabel("ビュー内検索", { exact: true }),
    ).toHaveValue("R6 later search");
    const saved = await r5Database(window, owner.id);
    expect(saved.settings.views[0]).toMatchObject({
      name: "R6 latest view",
      filterText: "R6 later search",
    });
    expect(saved.revision).toBeGreaterThan(committed.result.database.revision);
    await assertResolvedOnce(app, committed.request.operation, "database");
  } finally {
    await disposeR5(data, app);
  }
});

test("SIGKILL retains incomplete record and numeric-filter '-' as raw input without converting either to a saved number", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchRecovery(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window, "R6 raw owner");
    const record = await addR5Record(window, owner.id, "R6 raw record");
    const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row.getByLabel("見積 R6 raw record", { exact: true }).fill("7");
    await r5Saved(window);
    await options(window);
    await r5Settings(window)
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    await r5Settings(window)
      .getByLabel("フィルター対象 1.1", { exact: true })
      .selectOption({ label: "見積" });
    await r5Settings(window)
      .getByLabel("フィルター値 1.1", { exact: true })
      .fill("7");
    await r5SettingsSaved(window);
    await settled(window, data);
    const baseline = await r5Database(window, owner.id);
    await row.getByLabel("見積 R6 raw record", { exact: true }).fill("-");
    await r5Settings(window)
      .getByLabel("フィルター値 1.1", { exact: true })
      .fill("-");
    await durable(
      window,
      data,
      (snapshot) =>
        snapshot.rawDrafts.length === 2 &&
        snapshot.rawDrafts.some(
          (draft) =>
            draft.scope === "record" &&
            draft.pageId === record.pageId &&
            draft.value === "-",
        ) &&
        snapshot.rawDrafts.some(
          (draft) =>
            draft.scope === "database" &&
            draft.pageId === owner.id &&
            draft.value === "-",
        ),
    );
    expect(await r5Database(window, owner.id)).toEqual(baseline);
    await killOwned(app);
    app = undefined;
    running = await launchRecovery(data, true);
    app = running.app;
    window = running.window;
    await resume(window);
    await options(window);
    await expect(
      r5Settings(window).getByLabel("フィルター値 1.1", { exact: true }),
    ).toHaveValue("-");
    await expect(
      window
        .locator(`tr[data-record-id="${record.pageId}"]`)
        .getByLabel("見積 R6 raw record", { exact: true }),
    ).toHaveValue("-");
    expect(await r5Database(window, owner.id)).toEqual(baseline);
    await durable(
      window,
      data,
      (snapshot) =>
        snapshot.rawDrafts.length === 2 &&
        snapshot.rawDrafts.every((draft) => draft.value === "-"),
    );
    await window.getByTitle("R5 Home", { exact: true }).click();
    await openR5Database(window, "R6 raw owner");
    await options(window);
    await expect(
      r5Settings(window).getByLabel("フィルター値 1.1", { exact: true }),
    ).toHaveValue("-");
    await r5Settings(window)
      .getByLabel("フィルター条件を削除 1.1", { exact: true })
      .click();
    await openR5Record(window, "R6 raw record");
    await expect(
      window.locator(".r3-record-page").getByLabel("見積", { exact: true }),
    ).toHaveValue("-");
    await window
      .locator(".r3-record-page")
      .getByLabel("見積", { exact: true })
      .fill("9");
    await settled(window, data);
    expect(
      (await r5Database(window, owner.id)).records[0].values.estimate,
    ).toBe(9);
  } finally {
    await disposeR5(data, app);
  }
});

test("external revision after SIGKILL blocks resume; copy ACK loss retries once without changing the original or duplicating the recovery page", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchRecovery(data);
    app = running.app;
    let window = running.window;
    await gate(app, { type: "save:commit", pageId: data.home.id });
    await window
      .getByLabel("ページタイトル", { exact: true })
      .fill("R6 committed before external edit");
    const committed = await held(app);
    await window
      .locator(".folio-editor")
      .fill("R6 local body retained for recovery copy");
    await durable(window, data, (snapshot) =>
      snapshot.pages.some(
        (entry) =>
          entry.operation?.operationId ===
            committed.request.operation.operationId &&
          JSON.stringify(entry.intents).includes(
            "R6 local body retained for recovery copy",
          ),
      ),
    );
    const captured = readFileSync(journalPath(data), "utf8");
    await killOwned(app);
    app = undefined;
    const store = new Store(join(data.root, "workspace.sqlite"));
    let external;
    try {
      const current = store.get(data.home.id);
      external = store.update(current.id, current.revision, {
        title: "R6 externally changed source",
      });
    } finally {
      store.close();
    }
    running = await launchRecovery(data, true);
    app = running.app;
    window = running.window;
    await gate(app, { type: "recovery:copy", mode: "lost" });
    const dialog = recoveryDialog(window);
    await dialog
      .getByRole("button", { name: "入力を復元", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "保存元が復旧入力の版から変更されています",
    );
    await expect(dialog).toBeVisible();
    expect(readFileSync(journalPath(data), "utf8")).toBe(captured);
    expect(
      (await r5Snapshot(window)).pages.find((page) => page.id === data.home.id),
    ).toEqual(external);
    await dialog
      .getByRole("button", { name: "別ページに復旧", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "R6 synthetic post-COMMIT ACK loss",
    );
    expect(readFileSync(journalPath(data), "utf8")).toBe(captured);
    const firstCopy = (await r5Snapshot(window)).pages.filter(
      (page) => page.title === "復旧した入力",
    );
    expect(firstCopy).toHaveLength(1);
    expect(JSON.stringify(firstCopy[0].doc)).toContain(
      "R6 local body retained for recovery copy",
    );
    expect(JSON.stringify(firstCopy[0].doc)).toContain(
      committed.request.operation.operationId,
    );
    await dialog
      .getByRole("button", { name: "別ページに復旧", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await settled(window, data);
    const final = await r5Snapshot(window);
    expect(final.pages.find((page) => page.id === data.home.id)).toEqual(
      external,
    );
    expect(final.pages.filter((page) => page.title === "復旧した入力")).toEqual(
      firstCopy,
    );
    const copies = (await trace(app)).calls.filter(
      (call: any) => call.request.type === "recovery:copy",
    );
    expect(copies).toHaveLength(2);
    expect(copies[0].request).toEqual(copies[1].request);
    expect(copies[0].result.id).toBe(copies[1].result.id);
    await assertResolvedOnce(app, committed.request.operation, "save");
  } finally {
    await disposeR5(data, app);
  }
});

test("a corrupt recovery journal stays byte-for-byte intact and blocks resume, copy, and dialog dismissal", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  const corrupt =
    '{"format":"folio-crash-recovery-v1","snapshot": interrupted synthetic bytes';
  try {
    writeFileSync(journalPath(data), corrupt, "utf8");
    let running = await launchRecovery(data, true);
    app = running.app;
    let window = running.window;
    const dialog = recoveryDialog(window);
    await expect(dialog.getByRole("alert")).toContainText("原本を保持");
    await expect(
      dialog.getByRole("button", { name: "入力を復元", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "別ページに復旧", exact: true }),
    ).toBeDisabled();
    await window.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(window.locator(".page-title")).toHaveCount(0);
    expect(readFileSync(journalPath(data), "utf8")).toBe(corrupt);
    await killOwned(app);
    app = undefined;
    running = await launchRecovery(data, true);
    app = running.app;
    window = running.window;
    await expect(
      recoveryDialog(window).getByRole("button", {
        name: "別ページに復旧",
        exact: true,
      }),
    ).toBeDisabled();
    expect(readFileSync(journalPath(data), "utf8")).toBe(corrupt);
    const state = await r5Snapshot(window);
    expect(state.pages.some((page) => page.title === "復旧した入力")).toBe(
      false,
    );
    expect(state.pages.find((page) => page.id === data.home.id)?.title).toBe(
      "R5 Home",
    );
  } finally {
    await disposeR5(data, app);
  }
});
