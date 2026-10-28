import { test, expect } from "./next-round-fixture";

/**
 * Regression for the legacy Database screen still mounted by App.tsx until
 * Core connects DatabasePresentationProps. It used to force
 * `groupBy.direction = "asc"` for the board regardless of the saved direction.
 * The new presentation surface has its own harness test; this covers the
 * currently mounted path so the fix is observable in the actual app.
 */
test("legacy board keeps a saved descending group direction", async ({
  folio: session,
}) => {
  const app = session.window;
  const saved = await app.evaluate(async () => {
    const state = await window.folio.request<any>({ type: "load" });
    const page = state.pages.find(
      (candidate: any) =>
        candidate.kind === "database" && candidate.title === "プロジェクト",
    );
    if (!page) throw new Error("シードのデータベースが見つかりません");
    const database = page.database;
    const views = database.views.map((view: any) =>
      view.id === database.activeViewId
        ? {
            ...view,
            groupBy: { propertyId: "status", direction: "desc" },
          }
        : view,
    );
    const updated = await window.folio.request<any>({
      type: "update",
      id: page.id,
      revision: page.revision,
      patch: { database: { ...database, views } },
    });
    const active = updated.database.views.find(
      (view: any) => view.id === updated.database.activeViewId,
    );
    return active?.groupBy ?? null;
  });
  expect(saved).toEqual({ propertyId: "status", direction: "desc" });

  await session.restart();
  const reopened = session.window;
  await reopened
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await reopened.getByRole("button", { name: "ボード", exact: true }).click();
  const labels = async () =>
    (await reopened.locator(".board-column h4").allTextContents()).map((text) =>
      text.replace(/\s*\d+\s*$/, "").trim(),
    );
  await expect.poll(labels).toEqual(["完了", "進行中", "未着手", "未設定"]);
});
