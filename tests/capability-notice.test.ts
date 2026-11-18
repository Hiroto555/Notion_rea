import { describe, expect, it } from "vitest";
import {
  fileExportNotice,
  rawSalvageNotice,
} from "../src/renderer/capability-notice";
import {
  parseDesktopCapabilities,
  type DesktopCapabilities,
} from "../src/shared/desktop-capabilities";

const ROW_ORDER = [
  "fileImport",
  "fileExport",
  "attachment",
  "externalLink",
  "backup",
  "sharedCredential",
  "privateCredential",
  "nativeFilesystem",
  "exit",
] as const;
const CONTRACT: Record<
  (typeof ROW_ORDER)[number],
  { result: string; operation: string }
> = {
  fileImport: { result: "UTF8_TEXT_OR_NULL", operation: "PROVIDED" },
  fileExport: { result: "DISPLAY_PATH_OR_NULL", operation: "PROVIDED" },
  attachment: { result: "UNSPECIFIED", operation: "PROVIDED" },
  externalLink: { result: "UNSPECIFIED", operation: "PROVIDED" },
  backup: { result: "UNSPECIFIED", operation: "PROVIDED" },
  sharedCredential: { result: "UNSPECIFIED", operation: "PROVIDED" },
  privateCredential: { result: "UNSPECIFIED", operation: "PROVIDED" },
  nativeFilesystem: { result: "UNSPECIFIED", operation: "PROVIDED" },
  exit: { result: "HOST_MANAGED", operation: "NOT_PROVIDED" },
};

/** A real wire DTO run through the strict parser — never a hand-typed
 * fixture passed around the validator. */
function realCapabilities(fileExportBinding: string): DesktopCapabilities {
  const dto = {
    version: 1,
    host: { kind: "desktop", platform: "darwin", mode: "read-only" },
    features: ROW_ORDER.map((id) => ({
      id,
      binding:
        id === "fileExport"
          ? fileExportBinding
          : id === "exit"
            ? "HOST_MANAGED"
            : "NOT_PROVIDED",
      operation: CONTRACT[id].operation,
      readiness: "UNPROBED",
      osVerification: "NOT_RUN",
      verified: false,
      result: CONTRACT[id].result,
    })),
  };
  const parsed = parseDesktopCapabilities(dto);
  expect(parsed).not.toBeNull();
  return parsed!;
}

const INTERNAL_MARKERS = [
  "PROVIDED",
  "NOT_PROVIDED",
  "HOST_MANAGED",
  "UNPROBED",
  "NOT_RUN",
  "verified",
  "fileExport",
  "binding",
  "operation",
  "Level",
  "Lv",
];

describe("fileExportNotice", () => {
  it("distinguishes the three states and infers nothing from a bound binding", () => {
    const missing = fileExportNotice(null);
    const unconnected = fileExportNotice(realCapabilities("NOT_PROVIDED"));
    const bound = fileExportNotice(realCapabilities("PROVIDED"));
    expect(missing).toBe("書き出し機能の情報を確認できません。");
    expect(unconnected).toBe("書き出し画面の機能が未接続です。");
    expect(bound).toBe("書き出しの利用条件は操作時に確認してください。");
    expect(new Set([missing, unconnected, bound]).size).toBe(3);
    // A bound binding is still not "available", "ready", "authorized" or
    // "succeeded": the notice only says conditions are confirmed at the
    // operation itself.
    for (const claim of [
      "利用できます",
      "利用可能",
      "準備完了",
      "確認できました",
      "成功",
      "許可",
      "認証",
    ])
      expect(bound).not.toContain(claim);
  });

  it("leaks no internal enum, row name or level wording", () => {
    for (const text of [
      fileExportNotice(null),
      fileExportNotice(realCapabilities("NOT_PROVIDED")),
      fileExportNotice(realCapabilities("PROVIDED")),
      rawSalvageNotice(),
    ])
      for (const marker of INTERNAL_MARKERS) expect(text).not.toContain(marker);
  });

  it("treats a missing or unbound fileExport row as unconnected", () => {
    const withoutRow = {
      ...realCapabilities("PROVIDED"),
      features: realCapabilities("PROVIDED").features.filter(
        (row) => row.id !== "fileExport",
      ),
    };
    expect(fileExportNotice(withoutRow)).toBe(
      "書き出し画面の機能が未接続です。",
    );
  });
});

describe("rawSalvageNotice", () => {
  it("is a fixed guidance only — it synthesizes no availability from other rows", () => {
    expect(rawSalvageNotice()).toBe(
      "救出の利用条件は操作時に確認してください。",
    );
    // Zero parameters: there is no capability row for the salvage to read
    // and nothing to compose a verdict from.
    expect(rawSalvageNotice).toHaveLength(0);
    for (const claim of ["利用できます", "利用可能", "不可", "成功"])
      expect(rawSalvageNotice()).not.toContain(claim);
  });
});
