import {
  test,
  expect,
  maintenance,
  openPicker,
  savePicker,
  saved,
} from "./local-first-fixture";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("offline compiled desktop creates, edits, searches, exports and reopens persisted text", async ({
  local: s,
}) => {
  let w = s.window;
  expect(await w.evaluate(() => navigator.onLine)).toBe(false);
  expect(
    await w.evaluate(async () => {
      try {
        await fetch("https://example.invalid/offline-probe");
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await w
    .getByRole("button", { name: "新しいページ ⌘ N", exact: true })
    .click();
  await w.locator(".page-title").fill("Offline 日本語ノート");
  await w
    .locator(".folio-editor")
    .fill("ローカル検索固有語 local-first saved body");
  await saved(s);
  await w.keyboard.press("Meta+k");
  await w.getByLabel("検索キーワード").fill("ローカル検索固有語");
  await expect(w.locator(".search-results")).toContainText(
    "Offline 日本語ノート",
  );
  await w.keyboard.press("Enter");
  const target = join(s.external, "offline.md");
  await savePicker(s, target);
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await w
    .getByRole("button", { name: "Markdownを書き出す", exact: true })
    .click();
  await expect.poll(() => existsSync(target)).toBe(true);
  expect(readFileSync(target, "utf8")).toContain("ローカル検索固有語");
  await s.restart();
  w = s.window;
  expect(await w.evaluate(() => navigator.onLine)).toBe(false);
  await expect(w.locator(".page-title")).toHaveValue("Offline 日本語ノート");
  await expect(w.locator(".folio-editor")).toContainText(
    "local-first saved body",
  );
});

test("capacity display clears stale ready and reflects blocked, unknown and recovery without filling disk", async ({
  local: s,
}) => {
  await maintenance(s);
  const region = s.window.getByRole("region", {
    name: "保存先の空き容量",
    exact: true,
  });
  await region
    .getByRole("button", { name: "空き容量を確認", exact: true })
    .click();
  await expect(region).toContainText(
    "確認時点では、保存用の空き容量があります。",
  );
  s.pressure("blocked");
  await region.getByRole("button").click();
  await expect(region).toContainText(
    "空き容量が少ないため、新しい保存を停止しています。",
  );
  await expect(region).not.toContainText("確認時点では");
  s.pressure("unknown");
  await region.getByRole("button").click();
  await expect(region).toContainText(
    "空き容量を確認できないため、新しい保存を停止しています。",
  );
  s.pressure("real");
  await region.getByRole("button").click();
  await expect(region).toContainText(
    "確認時点では、保存用の空き容量があります。",
  );
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", (event: any, request: any) => {
      if (request.type === "storage:pressure")
        throw new Error("isolated IPC observation failure");
      return original(event, request);
    });
  });
  await region.getByRole("button").click();
  await expect(region).toContainText("空き容量を確認できませんでした。");
  await expect(region).not.toContainText("確認時点では");
});

test("successful duplication clears its durable recovery operation before a clean reopen", async ({
  local: s,
}) => {
  await s.window.getByLabel("ページメニュー", { exact: true }).click();
  await s.window.getByRole("button", { name: "複製", exact: true }).click();
  await expect(s.window.locator(".page-title")).toHaveValue(
    "ようこそ、Folioへ のコピー",
  );
  await saved(s);
  await expect
    .poll(
      () =>
        JSON.parse(
          readFileSync(join(s.directory, "crash-recovery.json"), "utf8"),
        ).snapshot.pageOperations?.length ?? 0,
    )
    .toBe(0);
  await s.restart();
  await expect(s.window.locator(".page-title")).toHaveValue(
    "ようこそ、Folioへ のコピー",
  );
  await expect(
    s.window.getByRole("dialog", { name: "前回の入力を復旧", exact: true }),
  ).toHaveCount(0);
});

test("lost create ACK resolves from the durable receipt without creating a second page", async ({
  local: s,
}) => {
  const before = (
    await s.window.evaluate(() => window.folio.request<any>({ type: "load" }))
  ).pages.length;
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (request.type === "page:commit")
        throw new Error("isolated ACK loss after COMMIT");
      return result;
    });
  });
  await s.window
    .getByRole("button", { name: "新しいページ ⌘ N", exact: true })
    .click();
  await expect(
    s.window.getByRole("button", { name: "作成結果を確認", exact: true }),
  ).toBeVisible();
  await s.window
    .getByRole("button", { name: "作成結果を確認", exact: true })
    .click();
  await expect(s.window.locator(".page-title")).toHaveValue("無題");
  await saved(s);
  expect(
    (await s.window.evaluate(() => window.folio.request<any>({ type: "load" })))
      .pages,
  ).toHaveLength(before + 1);
  expect(
    await s.app.evaluate(
      () =>
        (globalThis as any).localFirstRequests.filter(
          (r: any) => r.type === "page:commit",
        ).length,
    ),
  ).toBe(1);
  await s.restart();
  await expect(s.window.locator(".page-title")).toHaveValue("無題");
});

test("rejected duplicate explains the conflict and recovery-copy preserves the external source through reopen", async ({
  local: s,
}) => {
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      if (
        request.type === "page:commit" &&
        request.operation.command.kind === "duplicatePage"
      ) {
        const id = request.operation.command.pageId;
        const page = (await original(event, { type: "load" })).pages.find(
          (p: any) => p.id === id,
        );
        await original(event, {
          type: "update",
          id,
          revision: page.revision,
          patch: { title: "External source preserved" },
        });
      }
      return original(event, request);
    });
  });
  await s.window.getByLabel("ページメニュー", { exact: true }).click();
  await s.window.getByRole("button", { name: "複製", exact: true }).click();
  await expect(
    s.window.getByRole("button", { name: "入力を別ページに保存", exact: true }),
  ).toBeVisible();
  await expect(
    s.window.getByRole("status").filter({ hasText: "入力は保持しています" }),
  ).toBeVisible();
  await s.window
    .getByRole("button", { name: "入力を別ページに保存", exact: true })
    .click();
  await expect(
    s.window.getByRole("button", { name: "入力を別ページに保存", exact: true }),
  ).toHaveCount(0);
  await saved(s);
  const pages = (
    await s.window.evaluate(() => window.folio.request<any>({ type: "load" }))
  ).pages;
  expect(pages.some((p: any) => p.title === "External source preserved")).toBe(
    true,
  );
  expect(pages.some((p: any) => p.title === "復旧したページ作成")).toBe(true);
  await s.restart();
  await expect(s.window.locator(".page-title")).toHaveValue(
    "External source preserved",
  );
});

test("usage deltas and limits survive reopen and reject stale configuration without silent overwrite", async ({
  local: s,
}) => {
  let panel = await maintenance(s);
  await panel
    .getByRole("button", { name: "使用量を集計", exact: true })
    .click();
  await expect(panel).toContainText("集計完了");
  await panel
    .getByRole("button", { name: "使用量を集計", exact: true })
    .click();
  await expect(panel).toContainText("前回比");
  await panel
    .getByRole("button", { name: "使用量の上限を設定", exact: true })
    .click();
  await panel.getByLabel("保存記録の上限（件）", { exact: true }).fill("300");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("上限を保存しました。");
  await s.restart();
  panel = await maintenance(s);
  await panel
    .getByRole("button", { name: "使用量の上限を設定", exact: true })
    .click();
  await expect(
    panel.getByLabel("保存記録の上限（件）", { exact: true }),
  ).toHaveValue("300");
  await s.window.evaluate(async () => {
    const v = await window.folio.request<any>({ type: "storage:readLimits" });
    await window.folio.request({
      type: "storage:applyLimits",
      expectedRevision: v.revision,
      configured: { maxReceiptRows: 400 },
    });
  });
  await panel.getByLabel("保存記録の上限（件）", { exact: true }).fill("500");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("再読込");
  expect(
    (
      await s.window.evaluate(() =>
        window.folio.request<any>({ type: "storage:readLimits" }),
      )
    ).configured.maxReceiptRows,
  ).toBe(400);
  await panel
    .getByRole("button", { name: "保存済みの上限を再読込", exact: true })
    .click();
  await expect(
    panel.getByLabel("保存記録の上限（件）", { exact: true }),
  ).toHaveValue("400");
  await panel.getByLabel("保存記録の上限（件）", { exact: true }).fill("");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("上限を保存しました。");
  await s.restart();
  panel = await maintenance(s);
  await panel
    .getByRole("button", { name: "使用量の上限を設定", exact: true })
    .click();
  await expect(
    panel.getByLabel("保存記録の上限（件）", { exact: true }),
  ).toHaveValue("");
});

test("quota refusal retains input, permits search and journal export, then retries the same operation", async ({
  local: s,
}) => {
  const panel = await maintenance(s),
    w = s.window;
  await panel
    .getByRole("button", { name: "使用量の上限を設定", exact: true })
    .click();
  await panel.getByLabel("保存記録の上限（件）", { exact: true }).fill("0");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("上限を保存しました。");
  await w.locator(".page-title").fill("容量停止中の入力を保全");
  await expect(w.getByRole("alert")).toContainText("workspace-limit-exceeded");
  await expect(w.locator(".page-title")).toHaveValue("容量停止中の入力を保全");
  const commits = await s.app.evaluate(() =>
    (globalThis as any).localFirstRequests.filter(
      (r: any) => r.type === "save:commit",
    ),
  );
  expect(commits).toHaveLength(1);
  await w.getByRole("button", { name: "検索 ⌘ K", exact: true }).click();
  await w.getByLabel("検索キーワード").fill("アイデア");
  await expect(w.locator(".search-results")).toContainText("アイデアノート");
  await w.keyboard.press("Escape");
  const journal = join(s.external, "pending.json");
  await savePicker(s, journal);
  await w
    .getByRole("button", {
      name: "未保存の変更を別ファイルに記録",
      exact: true,
    })
    .click();
  await expect.poll(() => existsSync(journal)).toBe(true);
  expect(readFileSync(journal, "utf8")).toContain("容量停止中の入力を保全");
  await panel.getByLabel("保存記録の上限（件）", { exact: true }).fill("");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("上限を保存しました。");
  await w.getByRole("button", { name: "保存を再試行", exact: true }).click();
  await saved(s);
  const retried = await s.app.evaluate(() =>
    (globalThis as any).localFirstRequests.filter(
      (r: any) => r.type === "save:commit",
    ),
  );
  expect(retried).toHaveLength(2);
  expect(retried[1].operation).toEqual(commits[0].operation);
  await s.restart();
  await expect(s.window.locator(".page-title")).toHaveValue(
    "容量停止中の入力を保全",
  );
});

test("low-capacity startup is read-only, exports raw files and rescues a bundle without checkpointing", async ({
  local: s,
}) => {
  await s.window.locator(".page-title").fill("Readonly saved page");
  await s.window.locator(".folio-editor").fill("readonly searchable body");
  await saved(s);
  await expect(s.window.locator(".r6-recovery-status")).toHaveAttribute(
    "data-recovery-state",
    "saved",
  );
  const journalPath = join(s.directory, "crash-recovery.json");
  const journalBefore = readFileSync(journalPath, "utf8");
  s.pressure("blocked");
  await s.restart({ readOnly: true });
  let w = s.window;
  await w
    .getByRole("button", { name: "Readonly saved page", exact: true })
    .click();
  await expect(w.locator("article")).toContainText("readonly searchable body");
  await expect(w.locator('[contenteditable="true"]')).toHaveCount(0);
  await w.getByLabel("ページを検索", { exact: true }).fill("searchable");
  await expect(
    w.getByRole("navigation", { name: "保存済みページ" }).getByRole("button"),
  ).toHaveCount(1);
  const output = join(s.external, "page.json");
  await savePicker(s, output);
  await w
    .getByRole("button", { name: "ページの原本JSONを書き出し", exact: true })
    .click();
  await expect.poll(() => existsSync(output)).toBe(true);
  expect(readFileSync(output, "utf8")).toContain("readonly searchable body");
  await openPicker(s, s.external);
  await w
    .getByRole("button", { name: "DB・添付・復旧記録を救出", exact: true })
    .click();
  await expect(w.getByRole("status")).toContainText("救出先");
  expect(
    readdirSync(s.external).some((name) =>
      existsSync(join(s.external, name, "salvage-manifest.json")),
    ),
  ).toBe(true);
  expect(readFileSync(journalPath, "utf8")).toBe(journalBefore);
  const rejected = await w.evaluate(async () => {
    try {
      await window.folio.request({
        type: "setting",
        key: "theme",
        value: "dark",
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  const calls = await s.app.evaluate(
    () => (globalThis as any).localFirstRequests,
  );
  expect(
    calls.some(
      (r: any) => r.type === "recovery:write" || r.type === "save:commit",
    ),
  ).toBe(false);
  s.pressure("real");
  await s.restart();
  w = s.window;
  await expect(w.locator(".page-title")).toHaveValue("Readonly saved page");
  await w.locator(".folio-editor").fill("editing is available again");
  await saved(s);
});

test("rich import keeps initial content in the atomic operation, checkpoint and prechange backup, including reopen", async ({
  local: s,
}) => {
  const input = join(s.external, "rich-import.md");
  writeFileSync(
    input,
    "# AtomicImportUnique\n\n**Bold persisted**\n\n| A | B |\n| --- | --- |\n| x | y |",
  );
  await openPicker(s, input);
  await s.window
    .getByRole("button", { name: "インポート", exact: true })
    .click();
  await expect(s.window.locator(".page-title")).toHaveValue("rich-import");
  await expect(s.window.locator(".folio-editor strong")).toHaveText(
    "Bold persisted",
  );
  await saved(s);
  const calls = await s.app.evaluate(
    () => (globalThis as any).localFirstRequests,
  );
  const commit = calls.find((r: any) => r.type === "page:commit");
  expect(JSON.stringify(commit.operation.command.doc)).toContain(
    "AtomicImportUnique",
  );
  const before = calls
    .slice(0, calls.indexOf(commit))
    .filter((r: any) => r.type === "recovery:write");
  expect(
    before.some((r: any) =>
      JSON.stringify(r.snapshot.pageOperations).includes("AtomicImportUnique"),
    ),
  ).toBe(true);
  expect(
    readdirSync(join(s.directory, "backups")).some((name) =>
      existsSync(join(s.directory, "backups", name, "manifest.json")),
    ),
  ).toBe(true);
  await s.restart();
  await expect(s.window.locator(".folio-editor strong")).toHaveText(
    "Bold persisted",
  );
  await s.window.keyboard.press("Meta+k");
  await s.window.getByLabel("検索キーワード").fill("AtomicImportUnique");
  await expect(s.window.locator(".search-results")).toContainText(
    "rich-import",
  );
});

test("pre-send checkpoint failure holds import input and explicit retry creates one page with its original operation", async ({
  local: s,
}) => {
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    (globalThis as any).denyCheckpoint = true;
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", (event: any, request: any) => {
      if (
        (globalThis as any).denyCheckpoint &&
        request.type === "recovery:write" &&
        request.snapshot.pageOperations?.length
      ) {
        (globalThis as any).deniedOperation = structuredClone(
          request.snapshot.pageOperations[0],
        );
        throw new Error("isolated checkpoint failure");
      }
      return original(event, request);
    });
  });
  const input = join(s.external, "checkpoint.md");
  writeFileSync(input, "# Input checkpoint unique\n\n**retained input**");
  await openPicker(s, input);
  await s.window
    .getByRole("button", { name: "インポート", exact: true })
    .click();
  await expect(
    s.window.getByRole("button", { name: "ページ作成を再試行", exact: true }),
  ).toBeVisible();
  const operation = await s.app.evaluate(
    () => (globalThis as any).deniedOperation,
  );
  expect(JSON.stringify(operation.command.doc)).toContain("retained input");
  expect(
    await s.app.evaluate(() =>
      (globalThis as any).localFirstRequests.some(
        (r: any) => r.type === "page:commit",
      ),
    ),
  ).toBe(false);
  expect(
    await s.window.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await s.app.evaluate(() => {
    (globalThis as any).denyCheckpoint = false;
  });
  await s.window
    .getByRole("button", { name: "ページ作成を再試行", exact: true })
    .dblclick();
  await expect(s.window.locator(".page-title")).toHaveValue("checkpoint");
  await saved(s);
  const commits = await s.app.evaluate(() =>
    (globalThis as any).localFirstRequests.filter(
      (r: any) => r.type === "page:commit",
    ),
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].operation).toEqual(operation);
  await s.restart();
  await expect(s.window.locator(".folio-editor strong")).toHaveText(
    "retained input",
  );
});

test("initial rich backup refusal creates no page and retains the original document for same-ID retry", async ({
  local: s,
}) => {
  const panel = await maintenance(s),
    w = s.window;
  await panel
    .getByRole("button", { name: "使用量の上限を設定", exact: true })
    .click();
  await panel
    .getByLabel("バックアップの上限（MiB）", { exact: true })
    .fill("0");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("上限を保存しました。");
  const input = join(s.external, "backup-refused.md");
  writeFileSync(
    input,
    "# InitialBackupRefusedUnique\n\n**keep exact rich input**\n\n| A | B |\n| --- | --- |\n| x | y |",
  );
  await openPicker(s, input);
  await w.getByRole("button", { name: "インポート", exact: true }).click();
  await expect(
    w.getByRole("button", { name: "同じ操作で再試行", exact: true }),
  ).toBeVisible();
  await expect(w.getByRole("alert")).toContainText("workspace-limit-exceeded");
  const after = await w.evaluate(() =>
    window.folio.request<any>({ type: "load" }),
  );
  expect(after.pages.some((p: any) => p.title === "backup-refused")).toBe(
    false,
  );
  const original = await s.app.evaluate(
    () =>
      (globalThis as any).localFirstRequests.find(
        (r: any) => r.type === "page:commit",
      ).operation,
  );
  expect(JSON.stringify(original.command.doc)).toContain(
    "keep exact rich input",
  );
  await panel.getByLabel("バックアップの上限（MiB）", { exact: true }).fill("");
  await panel.getByRole("button", { name: "上限を保存", exact: true }).click();
  await expect(panel).toContainText("上限を保存しました。");
  await w
    .getByRole("button", { name: "同じ操作で再試行", exact: true })
    .click();
  await expect(w.locator(".page-title")).toHaveValue("backup-refused");
  await saved(s);
  await expect(w.locator(".folio-editor strong")).toHaveText(
    "keep exact rich input",
  );
  const calls = await s.app.evaluate(() =>
    (globalThis as any).localFirstRequests.filter(
      (r: any) => r.type === "page:commit",
    ),
  );
  expect(calls).toHaveLength(2);
  expect(calls[1].operation).toEqual(original);
  await s.restart();
  await expect(s.window.locator(".folio-editor strong")).toHaveText(
    "keep exact rich input",
  );
});

test("safe auxiliary archive refuses addressable names, supports cancellation and moves only the confirmed file", async ({
  local: s,
}) => {
  const panel = await maintenance(s),
    assets = join(s.directory, "assets");
  const legacy = join(assets, "7a33eb42-67df-4a21-8ca6-3a64ff97bf1a.txt"),
    safe = join(assets, "scratch.tmp");
  writeFileSync(legacy, "keep legacy addressable");
  writeFileSync(safe, "only this auxiliary");
  await openPicker(s, legacy);
  await panel
    .getByRole("button", { name: "台帳外の補助ファイルを選択", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "UUIDで始まる名前は移動できません。",
  );
  expect(existsSync(legacy)).toBe(true);
  await openPicker(s, null);
  await panel
    .getByRole("button", { name: "台帳外の補助ファイルを選択", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "移動先を選んで退避", exact: true }),
  ).toHaveCount(0);
  await openPicker(s, safe);
  await panel
    .getByRole("button", { name: "台帳外の補助ファイルを選択", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "移動先を選んで退避", exact: true }),
  ).toBeVisible();
  await openPicker(s, null);
  await panel
    .getByRole("button", { name: "移動先を選んで退避", exact: true })
    .click();
  expect(existsSync(safe)).toBe(true);
  await openPicker(s, safe);
  await panel
    .getByRole("button", { name: "台帳外の補助ファイルを選択", exact: true })
    .click();
  await openPicker(s, s.external);
  await panel
    .getByRole("button", { name: "移動先を選んで退避", exact: true })
    .click();
  await expect(panel).toContainText("移動先:");
  expect(existsSync(safe)).toBe(false);
  expect(readFileSync(legacy, "utf8")).toBe("keep legacy addressable");
});

test("restart recovery lists the retained page creation and retries the identical operation once", async ({
  local: s,
}) => {
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", (event: any, request: any) => {
      if (request.type === "page:commit") {
        (globalThis as any).heldOperation = structuredClone(request.operation);
        throw new Error("isolated disconnect before delivery");
      }
      return original(event, request);
    });
  });
  const input = join(s.external, "restart-input.md");
  writeFileSync(input, "# RestartCreateUnique\n\n**same operation input**");
  await openPicker(s, input);
  await s.window
    .getByRole("button", { name: "インポート", exact: true })
    .click();
  await expect(
    s.window.getByRole("button", { name: "同じ操作で再試行", exact: true }),
  ).toBeVisible();
  const operation = await s.app.evaluate(
    () => (globalThis as any).heldOperation,
  );
  await expect
    .poll(
      () =>
        JSON.parse(
          readFileSync(join(s.directory, "crash-recovery.json"), "utf8"),
        ).snapshot.pageOperations?.[0]?.operationId,
    )
    .toBe(operation.operationId);
  await s.restart({ recovery: true });
  const dialog = s.window.getByRole("dialog", {
    name: "前回の入力を復旧",
    exact: true,
  });
  await expect(dialog).toContainText("ページの作成・複製");
  await expect(dialog).toContainText("restart-input");
  expect(
    await s.app.evaluate(() =>
      (globalThis as any).localFirstRequests.some(
        (r: any) => r.type === "page:commit",
      ),
    ),
  ).toBe(false);
  await dialog
    .getByRole("button", { name: "同じ操作で再試行", exact: true })
    .dblclick();
  await expect(dialog).toHaveCount(0);
  await saved(s);
  const calls = await s.app.evaluate(() =>
    (globalThis as any).localFirstRequests.filter(
      (r: any) => r.type === "page:commit",
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].operation).toEqual(operation);
  const pages = (
    await s.window.evaluate(() => window.folio.request<any>({ type: "load" }))
  ).pages;
  expect(pages.filter((p: any) => p.title === "restart-input")).toHaveLength(1);
  await s.restart();
  const results = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "search", query: "RestartCreateUnique" }),
  );
  expect(JSON.stringify(results)).toContain("restart-input");
});

test("backup maintenance protects pinned/newest generations and restores the archived older generation", async ({
  local: s,
}) => {
  const w = s.window;
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await w
    .getByRole("button", { name: "バックアップと復元", exact: true })
    .click();
  const dialog = w.getByRole("dialog", {
    name: "バックアップと復元",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "バックアップを作成", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "新しいフォルダーへ復元", exact: true }),
  ).toBeEnabled();
  const list = () =>
    readdirSync(join(s.directory, "backups"))
      .filter((name) =>
        existsSync(join(s.directory, "backups", name, "manifest.json")),
      )
      .map((name) => join(s.directory, "backups", name));
  const old = list()[0];
  expect(old).toBeTruthy();
  await expect(
    w.getByRole("button", { name: "閉じる", exact: true }).last(),
  ).toBeEnabled();
  // Pinned safety is checked through the real service while its modal owns
  // the ticket. The modal correctly makes the maintenance controls inert.
  await openPicker(s, old);
  const pinned = await w.evaluate(async () => {
    try {
      await window.folio.request({ type: "storage:archivePlan" });
      return "unexpected success";
    } catch (e) {
      return String(e);
    }
  });
  expect(pinned).toContain("使用中");
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await w.locator(".page-title").fill("Newer backup state");
  await saved(s);
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await w
    .getByRole("button", { name: "バックアップと復元", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "バックアップを作成", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "新しいフォルダーへ復元", exact: true }),
  ).toBeEnabled();
  const latest = list().find((path) => path !== old)!;
  expect(latest).toBeTruthy();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const panel = await maintenance(s);
  await openPicker(s, latest);
  await panel
    .getByRole("button", {
      name: "退避する古いバックアップを選択",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("最新");
  expect(existsSync(latest)).toBe(true);
  await openPicker(s, old);
  await panel
    .getByRole("button", {
      name: "退避する古いバックアップを選択",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("button", { name: "移動先を選んで退避", exact: true }),
  ).toBeVisible();
  const archive = join(s.external, "archive");
  mkdirSync(archive);
  await openPicker(s, archive);
  await panel
    .getByRole("button", { name: "移動先を選んで退避", exact: true })
    .click();
  await expect(panel).toContainText("移動先:");
  expect(existsSync(old)).toBe(false);
  expect(existsSync(latest)).toBe(true);
  const moved = (
    await panel.getByRole("status").filter({ hasText: "移動先:" }).innerText()
  )
    .replace(/^移動先:\s*/, "")
    .trim();
  expect(existsSync(join(moved, "manifest.json"))).toBe(true);
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await w
    .getByRole("button", { name: "バックアップと復元", exact: true })
    .click();
  await openPicker(s, moved);
  await dialog
    .getByRole("button", { name: "バックアップを選んで検証", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "新しいフォルダーへ復元", exact: true }),
  ).toBeEnabled();
  const restore = join(s.external, "restore");
  mkdirSync(restore);
  await openPicker(s, restore);
  await dialog
    .getByRole("button", { name: "新しいフォルダーへ復元", exact: true })
    .click();
  await expect(dialog).toContainText("復元が完了しました");
  const restored = readdirSync(restore)
    .map((name) => join(restore, name))
    .find((path) => existsSync(join(path, "workspace.sqlite")))!;
  expect(restored).toBeTruthy();
  const db = new DatabaseSync(join(restored, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      db
        .prepare("select data from pages")
        .all()
        .some((r: any) => JSON.parse(r.data).title === "Newer backup state"),
    ).toBe(false);
  } finally {
    db.close();
  }
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(w.locator(".page-title")).toHaveValue("Newer backup state");
});

test("malformed page remains untouched while a healthy page edits and diagnostic rescue stays distinct from full backup", async ({
  local: s,
}) => {
  const snapshot = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "load" }),
  );
  const broken = snapshot.pages.find((p: any) => p.title === "アイデアノート");
  expect(broken).toBeTruthy();
  let db = new DatabaseSync(join(s.directory, "workspace.sqlite"));
  db.prepare("UPDATE pages SET data=? WHERE id=?").run(
    "{broken-local-first",
    broken.id,
  );
  db.close();
  await s.restart();
  await s.window.locator(".folio-editor").fill("healthy page can still save");
  await saved(s);
  const panel = await maintenance(s);
  await openPicker(s, s.external);
  await panel
    .getByRole("button", { name: "診断用の原本を救出", exact: true })
    .click();
  await expect(panel).toContainText("救出先:");
  const salvage = readdirSync(s.external)
    .map((name) => join(s.external, name))
    .find((path) => existsSync(join(path, "salvage-manifest.json")))!;
  expect(salvage).toBeTruthy();
  expect(
    JSON.parse(readFileSync(join(salvage, "salvage-manifest.json"), "utf8"))
      .restorable,
  ).toBe(false);
  expect(existsSync(join(salvage, "manifest.json"))).toBe(false);
  db = new DatabaseSync(join(salvage, "workspace.raw.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      db.prepare("SELECT data FROM pages WHERE id=?").get(broken.id)?.data,
    ).toBe("{broken-local-first");
  } finally {
    db.close();
  }
  await s.window.getByLabel("ページメニュー", { exact: true }).click();
  await s.window
    .getByRole("button", { name: "バックアップと復元", exact: true })
    .click();
  const dialog = s.window.getByRole("dialog", {
    name: "バックアップと復元",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "バックアップを作成", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "新しいフォルダーへ復元", exact: true }),
  ).toHaveCount(0);
  db = new DatabaseSync(join(s.directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      db.prepare("SELECT data FROM pages WHERE id=?").get(broken.id)?.data,
    ).toBe("{broken-local-first");
  } finally {
    db.close();
  }
});
