import { test, expect, saved } from "../e2e/next-round-fixture";
test("development renderer startup, save acknowledgement and restart", async ({ folio: s }) => {
  const w = s.window;
  expect(new URL(w.url()).origin).toBe(new URL(process.env.FOLIO_DEV_URL!).origin);
  const initial = await w.evaluate(() => window.folio.request<any>({ type: "load" }));
  expect(initial.pages.length).toBeGreaterThan(0);
  await w.getByLabel("ページタイトル", { exact: true }).fill("Cold start synthetic page");
  await w.locator(".folio-editor").fill("起動検証 saved text");
  await saved(s);
  const stored = await w.evaluate(async () => (await window.folio.request<any>({ type: "load" })).pages.find((p: any) => p.title === "Cold start synthetic page"));
  expect(JSON.stringify(stored.doc)).toContain("起動検証 saved text");
  await s.restart();
  await expect(s.window.getByLabel("ページタイトル", { exact: true })).toHaveValue("Cold start synthetic page");
  await expect(s.window.locator(".folio-editor")).toContainText("起動検証 saved text");
});
