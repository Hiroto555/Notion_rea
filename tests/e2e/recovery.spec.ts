import {
  test,
  expect,
  saveDialog,
  openDialog,
  saved,
} from "./next-round-fixture";
import { join } from "node:path";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { sizedRecovery } from "../recovery-fixture";
import { FILE_MAX_BYTES } from "../../src/shared/limits";
test("R1 legacy export file → recovery → restart preserves a 500 character title", async ({
  folio: s,
}) => {
  const original = await s.window.evaluate(() =>
    window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "題".repeat(500),
    }),
  );
  const value = {
    format: "folio-recovery",
    schemaVersion: 1,
    pages: [original],
    pendingPatches: [{ id: original.id, patch: { title: original.title } }],
  };
  const path = join(s.exportsDir, "legacy.json");
  await saveDialog(s, path);
  await s.window.evaluate(
    (content) =>
      window.folio.request({
        type: "export",
        name: "recovery",
        format: "json",
        content,
      }),
    JSON.stringify(value),
  );
  await openDialog(s, path);
  const [copy] = await s.window.evaluate(() =>
    window.folio.request<any[]>({ type: "recover" }),
  );
  expect(copy.title).toBe(original.title);
  expect(copy.id).not.toBe(original.id);
  await s.restart();
  const state = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "load" }),
  );
  expect(state.pages.find((p: any) => p.id === original.id)).toEqual(original);
  expect(state.pages.find((p: any) => p.id === copy.id).title).toBe(
    original.title,
  );
});
for (const delta of [-1, 0, 1])
  test(`R1 real IPC v2 byte boundary ${delta} with escaping → file → restart`, async ({
    folio: s,
  }) => {
    const original = await s.window.evaluate(() =>
      window.folio.request<any>({
        type: "create",
        parentId: null,
        kind: "page",
        title: "Aあ😀".repeat(125),
      }),
    );
    const content = sizedRecovery(original, FILE_MAX_BYTES + delta, "あ😀");
    const file = join(s.exportsDir, "boundary.json");
    await saveDialog(s, file);
    await openDialog(s, file);
    if (delta > 0) {
      await expect(
        s.window.evaluate(
          (content) =>
            window.folio.request({ type: "exportRecovery", content }),
          content,
        ),
      ).rejects.toThrow();
      return;
    }
    await s.window.evaluate(
      (content) => window.folio.request({ type: "exportRecovery", content }),
      content,
    );
    expect(statSync(file).size).toBe(FILE_MAX_BYTES + delta);
    const copies = await s.window.evaluate(() =>
      window.folio.request<any[]>({ type: "recover" }),
    );
    expect(copies[0].doc).toEqual(JSON.parse(content).pages[0].doc);
    await s.restart();
    const state = await s.window.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    expect(state.pages.find((p: any) => p.id === copies[0].id).doc).toEqual(
      copies[0].doc,
    );
    expect(state.pages.find((p: any) => p.id === original.id)).toEqual(
      original,
    );
  });
test("R1 multiple pending pages survive cancel/write/reload failures; copies retain original and attachment", async ({
  folio: s,
}) => {
  const attachment = join(s.inputsDir, "source.txt");
  writeFileSync(attachment, "attachment bytes");
  await openDialog(s, attachment);
  const file = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "attach" }),
  );
  const originals = await s.window.evaluate(async (url) => {
    const a = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Recovery A",
    });
    const b = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "database",
      title: "Recovery B",
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "不動産 A😀",
              marks: [{ type: "bold" }, { type: "link", attrs: { href: url } }],
            },
          ],
        },
      ],
    };
    const aa = await window.folio.request<any>({
      type: "update",
      id: a.id,
      revision: 0,
      patch: { doc },
    });
    const bb = await window.folio.request<any>({
      type: "update",
      id: b.id,
      revision: 0,
      patch: {
        database: {
          ...b.database,
          rows: [
            {
              id: "row-id",
              title: "Record A",
              values: { status: "未着手", cost: 123 },
            },
          ],
        },
      },
    });
    return [aa, bb];
  }, file.url);
  await s.window.reload();
  await s.window.waitForSelector(".page-title");
  for (const p of originals) {
    await s.window
      .locator(".page-tree-label")
      .filter({ hasText: p.title })
      .click();
    await s.window.evaluate(async (p) => {
      await window.folio.request({
        type: "update",
        id: p.id,
        revision: p.revision,
        patch: { title: p.title + " competing" },
      });
    }, p);
    await s.window
      .getByLabel("ページタイトル", { exact: true })
      .fill(p.title + " local");
    await expect(s.window.getByRole("alert")).toContainText("競合");
  }
  const button = s.window.getByRole("button", {
    name: "退避して再読込",
    exact: true,
  });
  // Record every real exportRecovery attempt on both IPC lanes so each click
  // is awaited on its own completion; an identical alert left over from the
  // previous failure can never satisfy the next attempt's checks.
  await s.app.evaluate(({ ipcMain }) => {
    const m = ipcMain as any;
    const state: any = ((globalThis as any).r1Rescue = {
      attempts: [] as any[],
      loads: 0,
      faultRequested: false,
      armed: false,
      injected: 0,
    });
    const unwrap = (result: any) =>
      result &&
      result.tag === "folio-request-result" &&
      result.ok === true &&
      result.valueSlot &&
      result.valueSlot.present === true
        ? result.valueSlot.value
        : result;
    for (const channel of [
      "folio:request",
      "folio:request:diagnostic-v1",
    ]) {
      const handler = m._invokeHandlers.get(channel);
      if (!handler) continue;
      m.removeHandler(channel);
      m.handle(channel, async (e: any, r: any) => {
        if (r.type === "exportRecovery") {
          const record: any = {
            channel,
            done: false,
            failed: false,
            path: null,
          };
          state.attempts.push(record);
          try {
            const result = await handler(e, r);
            record.done = true;
            record.failed = !!(
              result &&
              result.tag === "folio-request-result" &&
              result.ok === false
            );
            const path = record.failed ? null : unwrap(result);
            record.path = typeof path === "string" ? path : null;
            if (state.faultRequested && record.path) state.armed = true;
            return result;
          } catch (error) {
            record.done = true;
            record.failed = true;
            throw error;
          }
        }
        if (r.type === "load") {
          state.loads++;
          if (state.armed && state.injected === 0) {
            state.injected++;
            throw Error("injected reload failure");
          }
        }
        return handler(e, r);
      });
    }
  });
  const r1Rescue = () =>
    s.app.evaluate(() => (globalThis as any).r1Rescue);
  const completedExports = async () =>
    (await r1Rescue()).attempts.filter((a: any) => a.done).length;
  await saveDialog(s, null);
  await button.click();
  await expect.poll(completedExports).toBe(1);
  expect((await r1Rescue()).attempts[0]).toMatchObject({
    done: true,
    failed: false,
    path: null,
  });
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B local");
  const sqliteTarget = join(s.folder, "workspace.sqlite");
  await saveDialog(s, sqliteTarget);
  const sqliteBefore = readFileSync(sqliteTarget);
  await button.click();
  await expect.poll(completedExports).toBe(2);
  expect((await r1Rescue()).attempts[1]).toMatchObject({
    done: true,
    failed: true,
    path: null,
  });
  await expect(s.window.getByRole("alert")).toContainText(
    "安全に分類できないため結果は未確認として停止しました。",
  );
  expect(readFileSync(sqliteTarget)).toEqual(sqliteBefore);
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B local");
  const missingTarget = join(s.exportsDir, "missing-parent", "recovery.json");
  await saveDialog(s, missingTarget);
  await button.click();
  await expect.poll(completedExports).toBe(3);
  expect((await r1Rescue()).attempts[2]).toMatchObject({
    done: true,
    failed: true,
    path: null,
  });
  await expect(s.window.getByRole("alert")).toContainText(
    "安全に分類できないため結果は未確認として停止しました。",
  );
  expect(existsSync(missingTarget)).toBe(false);
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B local");
  const recovery = join(s.exportsDir, "recovery.json");
  await saveDialog(s, recovery);
  // Inject a post-write load failure, preserving the unsaved queue until retry.
  // The fault arms only after the real exportRecovery reply returns a path so
  // the pre-export membership load still succeeds, then fails the next actual
  // load once on whichever registered channel the renderer really uses.
  const loadsBeforeFault = (await r1Rescue()).loads;
  await s.app.evaluate(() => {
    (globalThis as any).r1Rescue.faultRequested = true;
  });
  await button.click();
  await expect.poll(completedExports).toBe(4);
  expect((await r1Rescue()).attempts[3]).toMatchObject({
    done: true,
    failed: false,
    path: recovery,
  });
  await expect
    .poll(async () => (await r1Rescue()).injected)
    .toBe(1);
  const fault = await r1Rescue();
  expect(fault.armed).toBe(true);
  expect(fault.loads).toBeGreaterThanOrEqual(loadsBeforeFault + 2);
  await expect(s.window.getByRole("alert")).toContainText(
    "安全に分類できないため結果は未確認として停止しました。",
  );
  const written = JSON.parse(readFileSync(recovery, "utf8"));
  expect(written.pages.map((p: any) => p.title)).toEqual([
    "Recovery A local",
    "Recovery B local",
  ]);
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B local");
  await button.click();
  await expect.poll(completedExports).toBe(5);
  expect((await r1Rescue()).attempts[4]).toMatchObject({
    done: true,
    failed: false,
    path: recovery,
  });
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B competing");
  const value = JSON.parse(readFileSync(recovery, "utf8"));
  expect(value.pages).toHaveLength(2);
  expect(value.pages.map((p: any) => p.title)).toEqual([
    "Recovery A local",
    "Recovery B local",
  ]);
  await openDialog(s, null);
  expect(
    await s.window.evaluate(() => window.folio.request({ type: "recover" })),
  ).toBeNull();
  await openDialog(s, recovery);
  const copies = await s.window.evaluate(() =>
    window.folio.request<any[]>({ type: "recover" }),
  );
  await s.restart();
  const state = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "load" }),
  );
  for (let i = 0; i < 2; i++) {
    const copy = state.pages.find((p: any) => p.id === copies[i].id);
    expect(copy.title).toBe(originals[i].title + " local");
    expect(copy.doc).toEqual(originals[i].doc);
    expect(copy.database).toEqual(originals[i].database);
    const source = state.pages.find((p: any) => p.id === originals[i].id);
    expect(source).toEqual({
      ...originals[i],
      title: originals[i].title + " competing",
      revision: originals[i].revision + 1,
      updatedAt: source.updatedAt,
    });
  }
  const downloaded = join(s.exportsDir, "downloaded");
  await saveDialog(s, downloaded);
  await s.window.evaluate(
    (url) => window.folio.request({ type: "downloadAttachment", url }),
    file.url,
  );
  expect(readFileSync(downloaded, "utf8")).toBe("attachment bytes");
});
test("R1 real IPC rejects the 30.3MB Japanese export previously accepted", async ({
  folio: s,
}) => {
  const path = join(s.exportsDir, "oversize.json");
  await saveDialog(s, path);
  await openDialog(s, path);
  const result = await s.window.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "原本",
    });
    p.doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "あ".repeat(5_050_000) }],
        },
      ],
    };
    const content = JSON.stringify({
      format: "folio-recovery",
      schemaVersion: 1,
      pages: [{ ...p, title: "未保存" }],
      persistedPages: [p],
      pendingPatches: [{ id: p.id, patch: { title: "未保存" } }],
    });
    try {
      await window.folio.request({
        type: "export",
        name: "recovery",
        format: "json",
        content,
      });
    } catch {
      return { export: "rejected", recover: "not-written" };
    }
    try {
      await window.folio.request({ type: "recover" });
      return { export: "accepted", recover: "accepted" };
    } catch {
      return { export: "accepted", recover: "rejected" };
    }
  });
  expect(result).toEqual({ export: "rejected", recover: "not-written" });
});
