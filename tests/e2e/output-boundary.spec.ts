import { test, expect, openDialog, saveDialog } from "./next-round-fixture";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("S1 real IPC protects workspace outputs and permits external namesake", async ({ folio: s }) => {
  const input = join(s.inputsDir, "workspace.sqlite");
  const bytes = Buffer.from([0, 12, 255, 42]);
  writeFileSync(input, bytes);
  await openDialog(s, input);
  const file = await s.window.evaluate(() => window.folio.request<any>({ type: "attach" }));
  const page = await s.window.evaluate(async () => (await window.folio.request<any>({ type: "load" })).pages[0]);
  const content = JSON.stringify({ format: "folio-recovery", schemaVersion: 2, pages: [page] });
  const backupDir = join(s.folder, "backups"); mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, "sentinel"); writeFileSync(backup, "backup");
  const asset = join(s.folder, "assets", readdirSync(join(s.folder, "assets"))[0]);
  const alias = join(s.exportsDir, "alias"); symlinkSync(s.folder, alias);
  const targets = ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm"].map(n => join(s.folder, n)).concat([asset, backup, join(alias, "workspace.sqlite")]);
  const requests = [
    { type: "downloadAttachment", url: file.url },
    { type: "export", name: "x", format: "md", content: "contents" },
    { type: "exportRecovery", content },
  ];
  for (const target of targets) {
    const before = existsSync(target) ? readFileSync(target) : null;
    for (const request of requests) {
      await saveDialog(s, target);
      await expect(s.window.evaluate(req => window.folio.request(req as any), request)).rejects.toThrow();
      if (before) expect(readFileSync(target)).toEqual(before);
      else expect(existsSync(target)).toBe(false);
    }
  }
  await s.app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (async (_win: any, options: any) => {
      (globalThis as any).outputDefault = options.defaultPath;
      return { canceled: true, filePath: "" };
    }) as unknown as typeof dialog.showSaveDialog;
  });
  expect(await s.window.evaluate(url => window.folio.request({ type: "downloadAttachment", url }), file.url)).toBeNull();
  const defaultPath = await s.app.evaluate(() => (globalThis as any).outputDefault);
  expect(defaultPath).not.toBe(join(s.folder, "workspace.sqlite"));
  const out = join(s.exportsDir, "download", "workspace.sqlite"); mkdirSync(join(s.exportsDir, "download"));
  await saveDialog(s, out);
  await s.window.evaluate(url => window.folio.request({ type: "downloadAttachment", url }), file.url);
  expect(readFileSync(out)).toEqual(bytes);
});
