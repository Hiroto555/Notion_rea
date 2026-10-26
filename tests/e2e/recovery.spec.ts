import {
  test,
  expect,
  saveDialog,
  openDialog,
  saved,
} from "./next-round-fixture";
import { join } from "node:path";
import { readFileSync, writeFileSync, statSync } from "node:fs";
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
  const path = join(s.folder, "legacy.json");
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
    const file = join(s.folder, "boundary.json");
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
  const attachment = join(s.folder, "source.txt");
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
  await saveDialog(s, null);
  await button.click();
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B local");
  await saveDialog(s, join(s.folder, "missing-parent", "recovery.json"));
  await button.click();
  await expect(s.window.getByRole("alert")).toContainText("ENOENT");
  const recovery = join(s.folder, "recovery.json");
  await saveDialog(s, recovery);
  // Inject a post-write load failure, preserving the unsaved queue until retry.
  await s.app.evaluate(({ ipcMain }) => {
    const m = ipcMain as any;
    const handler = m._invokeHandlers.get("folio:request");
    m.removeHandler("folio:request");
    m.handle("folio:request", async (e: any, r: any) => {
      if (r.type === "load") {
        m.removeHandler("folio:request");
        m.handle("folio:request", handler);
        throw Error("injected reload failure");
      }
      return handler(e, r);
    });
  });
  await button.click();
  await expect(s.window.getByRole("alert")).toContainText(
    "injected reload failure",
  );
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Recovery B local");
  await button.click();
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
  const downloaded = join(s.folder, "downloaded");
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
  const path = join(s.folder, "oversize.json");
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
