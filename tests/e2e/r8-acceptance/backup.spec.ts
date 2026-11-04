import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  assetHashes,
  backupAction,
  disposeR8,
  findBackupManifests,
  findLatestBackupCall,
  findWorkspaceRoots,
  installBackupRecorder,
  installNativeDialogStub,
  installRestoredLaunchHook,
  launchR8,
  launchTarget,
  openBackupSurface,
  openR8Page,
  readBackupCalls,
  readRestoredLaunchCalls,
  r8Data,
  r8Snapshot,
  setNativePaths,
  waitForNewBackup,
  waitForRestoredWorkspace,
  workspaceState,
} from "./r8-fixture";

const sameOrInside = (path: string, parent: string) => {
  const child = resolve(path);
  const base = resolve(parent);
  return child === base || child.startsWith(base + sep);
};

test("backup creates a verified folder, restores into a new folder, opens it through the launch hook, and never mutates source", async () => {
  const data = r8Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR8(data);
    app = running.app;
    const window = running.window;
    await installNativeDialogStub(app);
    await installBackupRecorder(app);

    const sourceBefore = await r8Snapshot(window);
    const assetsBefore = assetHashes(data.assetsDir);
    const backupsBefore = new Set(
      findBackupManifests(data.root).map((backup) => backup.root),
    );

    await openR8Page(window, data.home.title);
    await openBackupSurface(window);
    await setNativePaths(app, {
      save: data.backupTarget,
      open: data.backupTarget,
    });
    await (await backupAction(window, "バックアップを作成")).click();

    const created = await waitForNewBackup(data.root, backupsBefore);
    expect(created.manifest.format).toBe("folio-workspace-backup");
    expect(created.manifest.version).toBe(1);
    expect(existsSync(created.databasePath)).toBe(true);
    expect(created.manifest.inventory?.pages).toBeGreaterThanOrEqual(
      sourceBefore.pages.length,
    );
    const manifestAssets = (created.manifest.assets ?? []) as {
      path?: string;
    }[];
    expect(manifestAssets.length).toBeGreaterThanOrEqual(1);
    for (const asset of manifestAssets) {
      if (asset.path)
        expect(existsSync(resolve(created.root, asset.path))).toBe(true);
    }
    expect(existsSync(join(created.root, "assets"))).toBe(true);

    await setNativePaths(app, {
      save: created.root,
      open: created.root,
    });
    await (await backupAction(window, "バックアップを選んで検証")).click();
    const restore = await backupAction(window, "新しいフォルダーへ復元");
    await expect(restore).toBeEnabled({ timeout: 20000 });
    const verification = await findLatestBackupCall(app, "choose");
    if (verification?.result) {
      expect(resolve(verification.result.directory)).toBe(resolve(created.root));
      expect(typeof verification.result.ticket).toBe("string");
    }

    const workspacesBefore = new Set(findWorkspaceRoots(data.root));
    mkdirSync(data.restoreTarget);
    await setNativePaths(app, {
      save: data.restoreTarget,
      open: data.restoreTarget,
    });
    await restore.click();
    const restored = await waitForRestoredWorkspace(app, {
      root: data.root,
      sourceDir: data.dataDir,
      backupDir: created.root,
      target: data.restoreTarget,
      before: workspacesBefore,
    });
    expect(existsSync(join(restored, "workspace.sqlite"))).toBe(true);

    // The source workspace and attachment bytes are unchanged by backup,
    // verification and restore into a different folder.
    expect(await r8Snapshot(window)).toEqual(sourceBefore);
    expect(assetHashes(data.assetsDir)).toEqual(assetsBefore);

    await installRestoredLaunchHook(app);
    await setNativePaths(app, {
      save: restored,
      open: restored,
    });
    const openRestored = await backupAction(window, "復元先を開く");
    await expect(openRestored).toBeEnabled({ timeout: 20000 });
    await openRestored.click();
    await expect
      .poll(async () => (await readRestoredLaunchCalls(app!)).length)
      .toBeGreaterThan(0);
    const launchCalls = await readRestoredLaunchCalls(app!);
    expect((launchCalls[0] as {args: string[]}).args).toEqual([resolve("dist/main.cjs")]);
    const launched = launchCalls
      .map(launchTarget)
      .filter((target): target is string => !!target);
    const capturedRestoredPath =
      launched.some(
        (target) =>
          sameOrInside(target, restored) || sameOrInside(restored, target),
      ) ||
      launchCalls.some((call) => JSON.stringify(call).includes(restored));
    expect(capturedRestoredPath).toBe(true);

    // Identity, body/history, settings and attachment bytes survive the full
    // snapshot restore; title-only or row-only shortcuts cannot pass this.
    const restoredState = workspaceState(restored);
    const expectedPages = Object.fromEntries(
      [...sourceBefore.pages]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((page) => [page.id, page]),
    );
    expect(restoredState.pages).toEqual(expectedPages);
    expect(restoredState.settings).toEqual(sourceBefore.settings);
    expect(restoredState.assets).toEqual(assetsBefore);
    // The actual compiled app must start normally with the restored directory.
    const restoredRunning = await launchR8({...data, dataDir:restored});
    try {
      const reopened = await r8Snapshot(restoredRunning.window);
      expect(reopened.pages).toEqual(sourceBefore.pages);
      expect(reopened.settings).toEqual(sourceBefore.settings);
    } finally {await restoredRunning.app.close();}

  } finally {
    await disposeR8(data, app);
  }
});

test("a malformed backup is rejected visibly, offers no restore, and leaves source untouched", async () => {
  const data = r8Data();
  const malformed = join(data.root, "malformed-backup");
  mkdirSync(malformed);
  writeFileSync(
    join(malformed, "manifest.json"),
    JSON.stringify({
      format: "folio-workspace-backup",
      version: 1,
      database: { path: "workspace.sqlite" },
    }),
  );
  writeFileSync(join(malformed, "workspace.sqlite"), "not a sqlite database");
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR8(data);
    app = running.app;
    const window = running.window;
    await installNativeDialogStub(app);
    await installBackupRecorder(app);

    const sourceBefore = await r8Snapshot(window);
    const assetsBefore = assetHashes(data.assetsDir);
    await openR8Page(window, data.home.title);
    await openBackupSurface(window);
    await setNativePaths(app, { save: malformed, open: malformed });
    await (await backupAction(window, "バックアップを選んで検証")).click();

    const visibleError = window
      .locator('[role="alert"], [role="status"]')
      .filter({ visible: true })
      .filter({ hasText: /失敗|不正|壊れ|できません/ })
      .first();
    await expect(visibleError).toBeVisible({ timeout: 20000 });
    await expect(visibleError).toContainText(
      /失敗|不正|壊れ|できません|検証/,
    );

    await expect
      .poll(async () => {
        const restore = window.getByRole("button", {
          name: "新しいフォルダーへ復元",
          exact: true,
        });
        return (await restore.count()) === 0 || (await restore.isDisabled());
      })
      .toBe(true);
    const calls = await readBackupCalls(app);
    expect(calls.some((call) => /restore/i.test(call.type) && !call.error)).toBe(
      false,
    );
    expect(existsSync(data.restoreTarget)).toBe(false);
    expect(await r8Snapshot(window)).toEqual(sourceBefore);
    expect(assetHashes(data.assetsDir)).toEqual(assetsBefore);
  } finally {
    await disposeR8(data, app);
  }
});
