import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Locator } from "@playwright/test";
import { BlobTransferJournal } from "../../../src/sync/blob-transfer-journal";
import { TransferMaintenanceService } from "../../../src/main/transfer-maintenance-service";
import { M3GuiFixture } from "./m3-runtime";

test.setTimeout(120_000);

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const syntheticScope = (label: string) => digest("synthetic-scope:" + label);
const syntheticJournal = (label: string) =>
  "download-" + digest("synthetic-journal:" + label);

type CacheJournal = {
  workspace: string;
  cacheRoot: string;
  scopeDir: string;
  path: string;
  scopeHash: string;
  journalName: string;
  journal: BlobTransferJournal;
};

type StoredRecord = {
  key: string;
  state: string;
  reason: string | null;
  offset: number;
  assetId: string;
};

function cacheJournal(
  workspace: string,
  scopeHash: string,
  journalName: string,
): CacheJournal {
  const cacheRoot = join(workspace, ".folio-sync-transfers");
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  const scopeDir = join(cacheRoot, scopeHash);
  mkdirSync(scopeDir, { mode: 0o700 });
  chmodSync(scopeDir, 0o700);
  const path = join(scopeDir, journalName);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  const journal = new BlobTransferJournal(path, { scopeHash });
  return { workspace, cacheRoot, scopeDir, path, scopeHash, journalName, journal };
}

function seedRecord(
  fixture: CacheJournal,
  assetId: string,
  content: string | null,
  bytes: number,
) {
  const record = fixture.journal.begin({
    direction: "download",
    assetId,
    sha256: digest("synthetic-asset:" + assetId),
    bytes,
  });
  if (content !== null)
    writeFileSync(join(fixture.path, record.partialName), content, {
      mode: 0o600,
    });
  return record;
}

function entryId(fixture: CacheJournal, record: { key: string }) {
  return `${fixture.scopeHash}/${fixture.journalName}/${record.key}`;
}

function readRecords(path: string): StoredRecord[] {
  const database = new DatabaseSync(join(path, "state.sqlite"), {
    readOnly: true,
  });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    return database
      .prepare("SELECT key,data FROM blob_transfers")
      .all()
      .map((row) => {
        const parsed = JSON.parse(String(row.data)) as StoredRecord;
        return {
          key: String(row.key),
          state: parsed.state,
          reason: parsed.reason,
          offset: parsed.offset,
          assetId: parsed.assetId,
        };
      });
  } finally {
    database.close();
  }
}

function diskBytes(workspace: string): number {
  let total = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) total += stat.size;
    }
  };
  for (const name of [".folio-sync-transfers", ".folio-sync-assets-staging"]) {
    const path = join(workspace, name);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
  }
  return total;
}

function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

function displayedBytes(text: string): number {
  const match = /^(\d+) バイト/.exec(text.trim());
  return match ? Number(match[1]) : -1;
}

function transferPanel(dialog: Locator) {
  return dialog.getByRole("region", { name: "転送メンテナンス" });
}

function transferRow(panel: Locator, id: string) {
  return panel.locator(`tr[data-entry-id="${id}"]`);
}

function topStats(dialog: Locator) {
  return dialog.locator(
    'section[aria-labelledby="transfer-maintenance-title"] > dl > div',
  );
}

async function installTransferReleaseReplyLoss(session: M3GuiFixture) {
  await session.app!.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any;
    const original = ipc._invokeHandlers.get("folio:request");
    (globalThis as any).__folioCiTransferReleaseReplyLoss = false;
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (
        request?.type === "sync:transferRelease" &&
        (globalThis as any).__folioCiTransferReleaseReplyLoss
      ) {
        (globalThis as any).__folioCiTransferReleaseReplyLoss = false;
        throw new Error("synthetic-transfer-release-reply-lost");
      }
      return result;
    });
  });
}

async function armTransferReleaseReplyLoss(session: M3GuiFixture) {
  await session.app!.evaluate(() => {
    (globalThis as any).__folioCiTransferReleaseReplyLoss = true;
  });
}

test("actual journal bytes and old scope survive preview and cancel unchanged", async () => {
  const session = new M3GuiFixture();
  try {
    const fixture = cacheJournal(
      session.directory,
      syntheticScope("preview"),
      syntheticJournal("preview"),
    );
    const record = seedRecord(fixture, "asset-preview", "row-bytes", 20);
    const id = entryId(fixture, record);
    const part = join(fixture.path, record.partialName);
    fixture.journal.close();
    const beforeFiles = readdirSync(fixture.path).sort();
    const beforeStat = lstatSync(part);
    const beforeBytes = readFileSync(part);

    await session.start();
    const dialog = await session.openSettings();
    const panel = transferPanel(dialog);
    const row = transferRow(panel, id);

    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-scope", "old");
    await expect(row).toHaveAttribute("data-state", "active");
    await expect(row).toContainText("9 バイト（9 B）");
    await expect(row).toContainText("古いスコープ");

    await row.getByRole("button", { name: /解放内容を確認$/ }).click();
    const confirm = dialog.getByRole("region", {
      name: "解放の確認（ドライラン）",
    });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(id);
    await expect(confirm).toContainText("asset-preview");
    await expect(confirm).toContainText("9 バイト（9 B）");
    await expect(confirm).toContainText("古いスコープ");
    await expect(confirm).toContainText(
      "不完全なキャッシュは再ダウンロードされます。",
    );

    expect(readdirSync(fixture.path).sort()).toEqual(beforeFiles);
    const afterStat = lstatSync(part);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(readFileSync(part)).toEqual(beforeBytes);
    expect(
      readRecords(fixture.path).find((stored) => stored.key === record.key),
    ).toMatchObject({ state: "active", offset: 0 });

    await confirm.getByRole("button", { name: "キャンセル" }).click();
    await expect(confirm).toHaveCount(0);
    expect(readdirSync(fixture.path).sort()).toEqual(beforeFiles);
    expect(readFileSync(part)).toEqual(beforeBytes);
    await expect(row).toHaveAttribute("data-state", "active");
  } finally {
    await session.dispose();
  }
});

test("explicit confirm releases only the pinned partial and keeps live data with a truthful counter", async () => {
  const session = new M3GuiFixture();
  try {
    const fixture = cacheJournal(
      session.directory,
      syntheticScope("confirm"),
      syntheticJournal("confirm"),
    );
    const record = seedRecord(fixture, "asset-pinned", "pinned-cache", 20);
    const id = entryId(fixture, record);
    const part = join(fixture.path, record.partialName);
    fixture.journal.close();

    const liveFiles: Array<[string, string, string]> = [
      ["assets", "live.bin", "live-asset-bytes"],
      [".folio-sync-assets-staging", "staged.bin", "staged-bytes"],
      ["backups", "backup.bin", "backup-bytes"],
    ];
    for (const [directory, name, content] of liveFiles) {
      const root = join(session.directory, directory);
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o700);
      writeFileSync(join(root, name), content, { mode: 0o600 });
    }
    const snapshot = () =>
      liveFiles.map(([directory, name]) => {
        const path = join(session.directory, directory, name);
        const stat = lstatSync(path);
        return `${directory}/${name}:${stat.ino}:${stat.size}:${stat.mode}:${readFileSync(path).toString("hex")}`;
      });
    const liveBefore = snapshot();

    await session.start();
    const dialog = await session.openSettings();
    const panel = transferPanel(dialog);
    const counter = topStats(dialog).nth(0).locator("dd");
    await expect(transferRow(panel, id)).toBeVisible();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    const initialBytes = diskBytes(session.directory);
    await expect(counter).toHaveText(
      `${initialBytes} バイト（${formatBytes(initialBytes)}）`,
    );

    await transferRow(panel, id)
      .getByRole("button", { name: /解放内容を確認$/ })
      .click();
    const confirm = dialog.getByRole("region", {
      name: "解放の確認（ドライラン）",
    });
    await expect(confirm).toContainText(id);
    const operationId = (
      await confirm
        .locator("p", { hasText: "不透明な操作 ID:" })
        .locator("code")
        .innerText()
    ).trim();
    await confirm.getByRole("button", { name: "解放を実行" }).click();
    await expect(
      dialog.getByText(new RegExp(`操作 ${operationId} で 12 バイト`)),
    ).toBeVisible();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(transferRow(panel, id)).toHaveCount(0);
    expect(existsSync(part)).toBe(false);
    expect(
      readRecords(fixture.path).some((stored) => stored.key === record.key),
    ).toBe(false);
    expect(existsSync(join(fixture.path, "state.sqlite"))).toBe(true);
    await expect(
      transferRow(panel, `${fixture.scopeHash}/${fixture.journalName}/!`),
    ).toHaveAttribute("data-state", "empty-scope");

    const releasedBytes = diskBytes(session.directory);
    expect(releasedBytes).not.toBe(initialBytes);
    await expect(counter).toHaveText(
      `${releasedBytes} バイト（${formatBytes(releasedBytes)}）`,
    );
    expect(snapshot()).toEqual(liveBefore);
  } finally {
    await session.dispose();
  }
});

test("a missing partial clears only its record while a part edited after preview holds", async () => {
  const session = new M3GuiFixture();
  try {
    const missing = cacheJournal(
      session.directory,
      syntheticScope("missing"),
      syntheticJournal("missing"),
    );
    const missingRecord = seedRecord(missing, "asset-missing", null, 7);
    const missingId = entryId(missing, missingRecord);
    const stale = cacheJournal(
      session.directory,
      syntheticScope("stale"),
      syntheticJournal("stale"),
    );
    const staleRecord = seedRecord(stale, "asset-stale", "abc", 10);
    const staleId = entryId(stale, staleRecord);
    const stalePart = join(stale.path, staleRecord.partialName);
    missing.journal.close();
    stale.journal.close();

    await session.start();
    const dialog = await session.openSettings();
    const panel = transferPanel(dialog);

    await expect(transferRow(panel, missingId)).toBeVisible();
    await expect(transferRow(panel, missingId)).toContainText(
      "0 バイト（0 B）",
    );
    await transferRow(panel, missingId)
      .getByRole("button", { name: /解放内容を確認$/ })
      .click();
    const missingConfirm = dialog.getByRole("region", {
      name: "解放の確認（ドライラン）",
    });
    const missingOperationId = (
      await missingConfirm
        .locator("p", { hasText: "不透明な操作 ID:" })
        .locator("code")
        .innerText()
    ).trim();
    await missingConfirm.getByRole("button", { name: "解放を実行" }).click();
    await expect(
      dialog.getByText(new RegExp(`操作 ${missingOperationId} で 0 バイト`)),
    ).toBeVisible();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(transferRow(panel, missingId)).toHaveCount(0);
    await expect(
      transferRow(
        panel,
        `${missing.scopeHash}/${missing.journalName}/!`,
      ),
    ).toHaveAttribute("data-state", "empty-scope");
    expect(existsSync(join(missing.path, "state.sqlite"))).toBe(true);
    expect(readRecords(missing.path)).toHaveLength(0);

    await expect(transferRow(panel, staleId)).toHaveAttribute(
      "data-state",
      "active",
    );
    await transferRow(panel, staleId)
      .getByRole("button", { name: /解放内容を確認$/ })
      .click();
    const staleConfirm = dialog.getByRole("region", {
      name: "解放の確認（ドライラン）",
    });
    await expect(staleConfirm).toBeVisible();
    writeFileSync(stalePart, "abcdef", { mode: 0o600 });
    await staleConfirm.getByRole("button", { name: "解放を実行" }).click();
    const held = dialog.getByRole("alert").filter({ hasText: "保留されました" });
    await expect(held).toBeVisible();
    await expect(held).toContainText("cache-release-stale");
    expect(readFileSync(stalePart, "utf8")).toBe("abcdef");
    expect(
      readRecords(stale.path).find(
        (stored) => stored.key === staleRecord.key,
      ),
    ).toMatchObject({ state: "active", offset: 0 });

    await panel.getByRole("button", { name: "更新", exact: true }).click();
    await expect(transferRow(panel, staleId)).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(transferRow(panel, staleId)).toContainText(
      "6 バイト（6 B）",
    );
  } finally {
    await session.dispose();
  }
});

test("unknown files, orphan journals, and symlinked parts stay held and untouched", async () => {
  const session = new M3GuiFixture();
  try {
    const symlinked = cacheJournal(
      session.directory,
      syntheticScope("symlink"),
      syntheticJournal("symlink"),
    );
    const symlinkRecord = seedRecord(
      symlinked,
      "asset-symlink",
      null,
      4,
    );
    const target = join(session.directory, "outside-target.bin");
    writeFileSync(target, "secret-target", { mode: 0o600 });
    const symlinkPart = join(symlinked.path, symlinkRecord.partialName);
    symlinkSync(target, symlinkPart);
    const orphan = join(symlinked.path, "orphan.bin");
    writeFileSync(orphan, "keep-me", { mode: 0o600 });
    symlinked.journal.close();

    const unknown = cacheJournal(
      session.directory,
      syntheticScope("unknown"),
      syntheticJournal("unknown"),
    );
    const unknownOrphan = join(unknown.path, "orphan-only.bin");
    writeFileSync(unknownOrphan, "keep-this", { mode: 0o600 });
    unknown.journal.close();

    await session.start();
    const dialog = await session.openSettings();
    const panel = transferPanel(dialog);
    await expect(topStats(dialog).nth(2).locator("dd")).toHaveText(
      "unsafe-cache-entry",
    );

    const symlinkRow = transferRow(
      panel,
      entryId(symlinked, symlinkRecord),
    );
    await expect(symlinkRow).toBeVisible();
    await expect(symlinkRow).toHaveAttribute("data-state", "active");
    await expect(symlinkRow).toContainText("unsafe-partial");
    await expect(symlinkRow).toContainText(
      "このエントリは保持されます。解放できません。",
    );

    const unknownRow = transferRow(
      panel,
      `${unknown.scopeHash}/${unknown.journalName}/~`,
    );
    await expect(unknownRow).toBeVisible();
    await expect(unknownRow).toHaveAttribute("data-state", "unknown");
    await expect(unknownRow).toContainText("unknown-cache-files");
    await expect(
      panel.getByRole("button", { name: /解放内容を確認$/ }),
    ).toHaveCount(0);

    expect(lstatSync(symlinkPart).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("secret-target");
    expect(readFileSync(orphan, "utf8")).toBe("keep-me");
    expect(readFileSync(unknownOrphan, "utf8")).toBe("keep-this");
    expect(
      readRecords(symlinked.path).find(
        (stored) => stored.key === symlinkRecord.key,
      ),
    ).toMatchObject({ state: "active" });
    expect(existsSync(join(symlinked.path, "state.sqlite"))).toBe(true);
    expect(existsSync(join(unknown.path, "state.sqlite"))).toBe(true);
  } finally {
    await session.dispose();
  }
});

test("interrupted releases resume with the same ID and a lost release reply keeps the UI uncertain", async () => {
  const session = new M3GuiFixture();
  try {
    const fixture = cacheJournal(
      session.directory,
      syntheticScope("interrupted"),
      syntheticJournal("interrupted"),
    );
    const resumeRecord = seedRecord(
      fixture,
      "asset-resume",
      "resume-me",
      20,
    );
    const lostRecord = seedRecord(fixture, "asset-lost", "lost-reply", 20);
    const spareRecord = seedRecord(fixture, "asset-spare", "spare", 5);
    const resumeId = entryId(fixture, resumeRecord);
    const lostId = entryId(fixture, lostRecord);
    const spareId = entryId(fixture, spareRecord);
    fixture.journal.close();

    const maintenance = new TransferMaintenanceService(
      session.directory,
      () => null,
      (phase) => {
        if (phase === "releasing")
          throw new Error("synthetic-after-marking");
      },
    );
    const interruptedPlan = await maintenance.plan(resumeId);
    const interrupted = await maintenance.release(
      interruptedPlan.operationId,
    );
    expect(interrupted).toMatchObject({
      operationId: interruptedPlan.operationId,
      outcome: "outcome-unknown",
    });
    expect(
      readRecords(fixture.path).find(
        (stored) => stored.key === resumeRecord.key,
      ),
    ).toMatchObject({
      state: "releasing",
      reason: interruptedPlan.operationId,
    });
    expect(
      readRecords(fixture.path)
        .filter((stored) => stored.key !== resumeRecord.key)
        .every((stored) => stored.state === "active"),
    ).toBe(true);

    await session.start();
    await installTransferReleaseReplyLoss(session);
    const dialog = await session.openSettings();
    const panel = transferPanel(dialog);
    const pending = dialog.getByRole("region", {
      name: "保留中の解放操作",
    });
    await expect(pending).toBeVisible();
    await expect(pending).toContainText(interruptedPlan.operationId);
    await expect(
      pending.locator(
        `li[data-operation-id="${interruptedPlan.operationId}"]`,
      ),
    ).toBeVisible();
    await expect(transferRow(panel, resumeId)).toHaveAttribute(
      "data-state",
      "releasing",
    );
    await expect(transferRow(panel, resumeId)).toContainText("解放処理中");
    await expect(
      transferRow(panel, lostId).getByRole("button", {
        name: /解放内容を確認$/,
      }),
    ).toBeDisabled();

    await pending.getByRole("button", { name: "結果を照会" }).click();
    const pendingUnknown = dialog
      .getByRole("alert")
      .filter({ hasText: interruptedPlan.operationId });
    await expect(pendingUnknown).toBeVisible();
    await expect(pendingUnknown).toContainText("確認できません");
    await expect(pending).toBeVisible();

    await pending.getByRole("button", { name: "解放を再開" }).click();
    const resume = dialog.getByRole("region", {
      name: "解放の再開確認",
    });
    await expect(resume).toContainText(interruptedPlan.operationId);
    await expect(resume).toContainText(
      "新しい解放チケットは作成しません",
    );
    await resume
      .getByRole("button", { name: "同じ操作 ID で解放を再開" })
      .click();
    await expect(
      dialog.getByText(
        new RegExp(`操作 ${interruptedPlan.operationId} で 9 バイト`),
      ),
    ).toBeVisible();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(pending).toHaveCount(0);
    expect(
      existsSync(join(fixture.path, resumeRecord.partialName)),
    ).toBe(false);
    expect(
      readRecords(fixture.path).some(
        (stored) => stored.key === resumeRecord.key,
      ),
    ).toBe(false);
    await expect(
      transferRow(panel, lostId).getByRole("button", {
        name: /解放内容を確認$/,
      }),
    ).toBeEnabled();

    await transferRow(panel, lostId)
      .getByRole("button", { name: /解放内容を確認$/ })
      .click();
    const lostConfirm = dialog.getByRole("region", {
      name: "解放の確認（ドライラン）",
    });
    const lostOperationId = (
      await lostConfirm
        .locator("p", { hasText: "不透明な操作 ID:" })
        .locator("code")
        .innerText()
    ).trim();
    expect(lostOperationId).not.toBe(interruptedPlan.operationId);

    await armTransferReleaseReplyLoss(session);
    await lostConfirm.getByRole("button", { name: "解放を実行" }).click();
    const lostUnknown = dialog.getByRole("region", {
      name: "解放結果を確認できません",
    });
    await expect(lostUnknown).toBeVisible();
    await expect(lostUnknown).toContainText(lostOperationId);
    await expect(
      dialog.getByRole("alert").filter({ hasText: lostOperationId }),
    ).toContainText("確認できません");
    expect(
      existsSync(join(fixture.path, lostRecord.partialName)),
    ).toBe(false);
    expect(
      readRecords(fixture.path).some(
        (stored) => stored.key === lostRecord.key,
      ),
    ).toBe(false);
    await expect(
      transferRow(panel, spareId).getByRole("button", {
        name: /解放内容を確認$/,
      }),
    ).toBeDisabled();

    await lostUnknown.getByRole("button", { name: "結果を照会" }).click();
    await expect(lostUnknown).toHaveCount(0);
    await expect(
      dialog.getByText(new RegExp(`操作 ${lostOperationId} で 10 バイト`)),
    ).toBeVisible();
    await expect(
      transferRow(panel, spareId).getByRole("button", {
        name: /解放内容を確認$/,
      }),
    ).toBeEnabled();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    expect(
      readRecords(fixture.path).find(
        (stored) => stored.key === spareRecord.key,
      ),
    ).toMatchObject({ state: "active" });
    expect(
      readFileSync(join(fixture.path, spareRecord.partialName), "utf8"),
    ).toBe("spare");
  } finally {
    await session.dispose();
  }
});
