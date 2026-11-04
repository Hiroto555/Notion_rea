import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  disposeR7,
  launchR7,
  openR7Database,
  openR7ViewSettings,
  r7Data,
  r7Database,
  r7Saved,
  r7ViewSettingsButton,
} from "./r7-fixture";

test("compact view settings open accessibly and rename/type persistence survives restart", async () => {
  const data = r7Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR7(data);
    app = running.app;
    let window = running.window;
    await openR7Database(window);

    // Round 7 starts compact: the expanded filter/sort builders are not shown.
    await expect(
      window
        .getByRole("button", { name: /条件を追加/ })
        .filter({ visible: true }),
    ).toHaveCount(0);
    await expect(
      window
        .getByRole("button", { name: "並べ替えを追加", exact: true })
        .filter({ visible: true }),
    ).toHaveCount(0);

    await openR7ViewSettings(window);
    const viewName = window.getByLabel("ビュー名", { exact: true });
    const viewType = window.getByRole("combobox", { name: /表示形式/ });
    await expect(viewName).toBeVisible();
    await expect(viewType).toBeVisible();
    await expect(
      window
        .getByText("フィルター", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(
      window
        .getByText("並べ替え", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    const activeViewId = (await r7Database(window, data.owner.id)).settings
      .activeViewId;
    await viewName.fill("R7 Renamed View");
    await viewType.selectOption({ label: "テーブル" });
    await expect
      .poll(async () => {
        const projection = await r7Database(window, data.owner.id);
        return projection.settings.views.find(
          (view) => view.id === activeViewId,
        );
      })
      .toMatchObject({ name: "R7 Renamed View", type: "table" });
    await r7Saved(window);

    await app.close();
    app = undefined;
    running = await launchR7(data);
    app = running.app;
    window = running.window;
    await openR7Database(window);
    await openR7ViewSettings(window);
    await expect(
      window.getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("R7 Renamed View");
    await expect(
      window.getByRole("combobox", { name: /表示形式/ }),
    ).toHaveValue("table");
    await expect(
      window
        .getByText("フィルター", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(
      window
        .getByText("並べ替え", { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    const persisted = await r7Database(window, data.owner.id);
    expect(
      persisted.settings.views.find((view) => view.id === activeViewId),
    ).toMatchObject({ name: "R7 Renamed View", type: "table" });
    expect(
      await r7ViewSettingsButton(window).isVisible(),
    ).toBe(true);
  } finally {
    await disposeR7(data, app);
  }
});
