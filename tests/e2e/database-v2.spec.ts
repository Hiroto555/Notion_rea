import { test, expect, saved } from "./next-round-fixture";

test("DB 2.0 independent views, AND/OR filter, multiple sorts and grouping survive restart", async ({
  folio: s,
}) => {
  const w = s.window;
  await w
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await expect(w.locator("tbody tr")).toHaveCount(3);
  await w.getByLabel("ビュー名").fill("一覧");
  await expect(
    w.getByRole("button", { name: "ビュー: 一覧", exact: true }),
  ).toBeVisible();

  // Filter builder: two typed conditions combined with AND then OR.
  await w.getByRole("button", { name: /^フィルター/ }).click();
  await w.getByLabel("条件を追加 1").click();
  await w.getByLabel("フィルター対象 1.1").selectOption("status");
  await w.getByLabel("フィルター演算子 1.1").selectOption("equals");
  await w.getByLabel("フィルター値 1.1").selectOption("進行中");
  await expect(w.locator("tbody tr")).toHaveCount(1);
  await w.getByLabel("条件を追加 1").click();
  await w.getByLabel("フィルター対象 1.2").selectOption("status");
  await w.getByLabel("フィルター演算子 1.2").selectOption("equals");
  await w.getByLabel("フィルター値 1.2").selectOption("完了");
  await expect(w.locator("tbody tr")).toHaveCount(0);
  await w.getByLabel("フィルターの結合 1").selectOption("or");
  await expect(w.locator("tbody tr")).toHaveCount(2);
  await w.locator('[aria-label^="フィルター条件を削除"]').first().click();
  await w.locator('[aria-label^="フィルター条件を削除"]').first().click();
  await expect(w.getByLabel("データベースを絞り込む")).toHaveValue("");
  await w.getByRole("button", { name: /^フィルター/ }).click();

  // Persisted view configuration: free text, two sort keys and grouping.
  await w.getByLabel("データベースを絞り込む").fill("進行中");
  await w.getByLabel("並べ替え", { exact: true }).selectOption("title");
  await w.getByRole("button", { name: "複数並べ替えを追加" }).click();
  await expect(w.getByLabel("並べ替え対象 2")).toBeVisible();
  await w.getByLabel("並べ替え対象 2").selectOption("date");
  await w.getByLabel("並べ替え順 2").selectOption("desc");
  await w.getByLabel("グループ化").selectOption("status");
  await expect(w.locator(".db-group")).toHaveCount(1);
  await expect(w.locator("tbody tr")).toHaveCount(1);

  // A second view keeps its own filter while the table view is unchanged.
  await w.getByRole("button", { name: "ボード", exact: true }).click();
  await expect(w.locator(".board-column")).toHaveCount(4);
  await w.getByLabel("ビューを複製").click();
  await expect(w.getByLabel("ビュー名")).toHaveValue("ボード のコピー");
  await w.getByLabel("データベースを絞り込む").fill("完了");
  await expect(w.locator(".db-card")).toHaveCount(1);
  await w.getByRole("button", { name: "テーブル", exact: true }).click();
  await expect(w.getByLabel("ビュー名")).toHaveValue("一覧");
  await expect(w.getByLabel("データベースを絞り込む")).toHaveValue("進行中");
  await expect(w.locator("tbody tr")).toHaveCount(1);

  await saved(s);
  await s.restart();
  const r = s.window;
  await r
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await expect(r.getByLabel("ビュー名")).toHaveValue("一覧");
  await expect(r.getByLabel("データベースを絞り込む")).toHaveValue("進行中");
  await expect(r.getByLabel("グループ化")).toHaveValue("status");
  await expect(r.locator("tbody tr")).toHaveCount(1);
  await r
    .getByRole("button", { name: "ビュー: ボード のコピー", exact: true })
    .click();
  await expect(r.getByLabel("データベースを絞り込む")).toHaveValue("完了");
  await expect(r.locator(".db-card")).toHaveCount(1);
});
