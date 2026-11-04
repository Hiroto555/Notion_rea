import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  BackupPreview,
  BackupRestored,
  WorkspaceInventory,
} from "../src/shared/workspace-backup";
import {
  formatBackupBytes,
  formatBackupDate,
  runWorkspaceBackupAction,
  WorkspaceBackupView,
  type WorkspaceBackupViewProps,
} from "../src/renderer/workspace-backup/WorkspaceBackupDialog";

const inventory: WorkspaceInventory = {
  pages: 12,
  recordDatabases: 3,
  records: 48,
  versions: 21,
  settings: 4,
  saveReceipts: 30,
  registeredAssets: 6,
};

const preview: BackupPreview = {
  ticket: "ticket-1",
  directory: "/backups/source-snapshot",
  createdAt: "2026-11-04T03:00:00.000Z",
  inventory,
  bytes: 2048,
};

const restored: BackupRestored = {
  ...preview,
  directory: "/restored/new-folder",
  sourceDirectory: preview.directory,
};

const noopHandlers = {
  onCreate() {},
  onChoose() {},
  onRestore() {},
  onOpen() {},
  onClose() {},
};

function render(overrides: Partial<WorkspaceBackupViewProps> = {}) {
  return renderToStaticMarkup(
    createElement(WorkspaceBackupView, {busy:false, ...noopHandlers, ...overrides}),
  );
}

describe("WorkspaceBackupView", () => {
  it("starts with the heading, named actions and the saved/unposed scope wording", () => {
    const html = render();
    expect(html).toContain("バックアップと復元");
    expect(html).toContain("未保存の入力を復旧する機能ではありません");
    expect(html).toContain(
      "元のワークスペースと選択したバックアップは変更しません",
    );
    expect(html).toContain(
      "既存のフォルダーを上書きすることはありません",
    );
    expect(html).toContain(">バックアップを作成</button>");
    expect(html).toContain(">バックアップを選んで検証</button>");
    expect(html).toContain(">閉じる</button>");
    expect(html).not.toContain(">新しいフォルダーへ復元</button>");
    expect(html).not.toContain(">復元先を開く</button>");
  });

  it("marks the body busy, disables every action and announces progress", () => {
    const html = render({
      busy: true,
      busyMessage: "バックアップを作成しています…",
    });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("バックアップを作成しています…");
    expect(html).toContain('role="status"');
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });

  it("shows a created backup's date, source path, size and inventory", () => {
    const html = render({ preview, previewSource: "created" });
    expect(html).toContain("作成したバックアップ");
    expect(html).toContain(preview.directory);
    expect(html).toContain("2026年11月4日");
    expect(html).toContain("2 KB");
    expect(html).toContain("ページ");
    expect(html).toContain("12 件");
    expect(html).toContain("データベース");
    expect(html).toContain("3 件");
    expect(html).toContain("登録済みの添付ファイル");
    expect(html).toContain("6 件");
    expect(html).toContain(">新しいフォルダーへ復元</button>");
  });

  it("labels a chosen backup as verified rather than created", () => {
    const html = render({ preview, previewSource: "chosen" });
    expect(html).toContain("検証済みのバックアップ");
    expect(html).not.toContain("作成したバックアップ");
  });

  it("shows the completed destination separately from the source backup", () => {
    const html = render({ preview, restored });
    expect(html).toContain("復元が完了しました");
    expect(html).toContain(restored.directory);
    expect(html).not.toContain(preview.directory);
    expect(html).toContain(
      "元のワークスペースはそのまま残っています",
    );
    expect(html).toContain(">復元先を開く</button>");
    expect(html).not.toContain(">新しいフォルダーへ復元</button>");
  });

  it("keeps the selected preview and retry action visible after an error", () => {
    const html = render({
      preview,
      error: "操作を完了できませんでした。復元先を作成できません。",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("復元先を作成できません");
    expect(html).toContain(preview.directory);
    expect(html).toContain(">新しいフォルダーへ復元</button>");
  });

  it("formats byte sizes and invalid dates without throwing", () => {
    expect(formatBackupBytes(512)).toBe("512 バイト");
    expect(formatBackupBytes(2048)).toBe("2 KB");
    expect(formatBackupDate("not-a-date")).toBe("not-a-date");
  });
});

describe("runWorkspaceBackupAction", () => {
  it("returns a value and always notifies busy true then false", async () => {
    const busy: boolean[] = [];
    const values: string[] = [];
    const result = await runWorkspaceBackupAction(async () => "created", {
      onValue: (value) => values.push(value),
      onError: () => {},
      onBusyChange: (value) => busy.push(value),
    });
    expect(result).toBe("value");
    expect(values).toEqual(["created"]);
    expect(busy).toEqual([true, false]);
  });

  it("treats null as cancel without reporting a created value", async () => {
    const busy: boolean[] = [];
    const values: string[] = [];
    let cancelled = false;
    const result = await runWorkspaceBackupAction<string>(
      async () => null,
      {
        onValue: (value) => values.push(value),
        onError: () => {},
        onCancel: () => {
          cancelled = true;
        },
        onBusyChange: (value) => busy.push(value),
      },
    );
    expect(result).toBe("cancelled");
    expect(values).toEqual([]);
    expect(cancelled).toBe(true);
    expect(busy).toEqual([true, false]);
  });

  it("reports a retriable error and still clears busy", async () => {
    const busy: boolean[] = [];
    const errors: string[] = [];
    const result = await runWorkspaceBackupAction<string>(
      async () => {
        throw new Error("復元に失敗しました");
      },
      {
        onValue: () => {},
        onError: (message) => errors.push(message),
        onBusyChange: (value) => busy.push(value),
      },
    );
    expect(result).toBe("error");
    expect(errors[0]).toContain("復元に失敗しました");
    expect(busy).toEqual([true, false]);
  });

  it("still notifies false when the parent's busy callback throws", async () => {
    const busy: boolean[] = [];
    const result = await runWorkspaceBackupAction(async () => "opened", {
      onValue: () => {},
      onError: () => {},
      onBusyChange: (value) => {
        busy.push(value);
        if (value) throw new Error("parent busy handler");
      },
    });
    expect(result).toBe("value");
    expect(busy).toEqual([true, false]);
  });
});
