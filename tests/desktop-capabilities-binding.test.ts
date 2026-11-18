import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestSchema } from "../src/shared/types";
import {
  assertRequestStorage,
  storageActionForRequest,
} from "../src/main/storage-write-policy";
import { assertReadOnlyRequest } from "../src/main/read-only-workspace";
import { parseDesktopCapabilities } from "../src/shared/desktop-capabilities";
import { createDesktopCapabilities } from "../src/main/desktop-capabilities";

const ROOT = join(__dirname, "..");
const indexSource = readFileSync(join(ROOT, "src", "main", "index.ts"), "utf8");
const policySource = readFileSync(
  join(ROOT, "src", "main", "storage-write-policy.ts"),
  "utf8",
);
const readOnlySource = readFileSync(
  join(ROOT, "src", "main", "read-only-workspace.ts"),
  "utf8",
);

describe("desktop:capabilities storage and read-only policy", () => {
  it("classifies the query as read and never probes capacity", () => {
    expect(storageActionForRequest("desktop:capabilities")).toBe("read");
    let calls = 0;
    assertRequestStorage(requestSchema.parse({ type: "desktop:capabilities" }), {
      assertWritable: () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
  });

  it("admits the query in a read-only workspace but still refuses writes", () => {
    expect(() =>
      assertReadOnlyRequest(requestSchema.parse({ type: "desktop:capabilities" })),
    ).not.toThrow();
    expect(() =>
      assertReadOnlyRequest(requestSchema.parse({ type: "attach" })),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest(requestSchema.parse({ type: "backup" })),
    ).toThrow();
  });
});

describe("Main wiring and dependency injection (source contract)", () => {
  it("routes the query through the existing common request dispatch once", () => {
    expect(indexSource).toContain(
      'import { createDesktopCapabilities } from "./desktop-capabilities"',
    );
    const branchAt = indexSource.indexOf('req.type === "desktop:capabilities"');
    expect(branchAt).toBeGreaterThan(-1);
    // It sits inside the shared dispatch handle, after the read-only gate and
    // before the storage utility/admission path — a pure read with no side effects.
    const readOnlyAt = indexSource.indexOf("if (readOnly) assertReadOnlyRequest(req)");
    const utilityAt = indexSource.indexOf("storage.handleUtility(req, isAuthorized)");
    expect(readOnlyAt).toBeGreaterThan(-1);
    expect(utilityAt).toBeGreaterThan(-1);
    expect(branchAt).toBeGreaterThan(readOnlyAt);
    expect(branchAt).toBeLessThan(utilityAt);
    expect(indexSource.indexOf("createDesktopCapabilities({", branchAt)).toBeGreaterThan(branchAt);
  });

  it("injects the actual bound Main references, not a static table", () => {
    const branchAt = indexSource.indexOf('req.type === "desktop:capabilities"');
    const branch = indexSource.slice(branchAt, branchAt + 1200);
    for (const binding of [
      "fileDialogs: dialog",
      "attachmentStore: store",
      "externalLinkOpener: shell",
      "backupService: workspaceBackups",
      "sharedCredentialProvider",
      "privateCredentialVault: vault",
      "nativeFileSystem: productNative?.privateFilesystem",
      "hostLifecycle: app",
      "readOnly",
      "platform: process.platform",
    ])
      expect(branch, binding).toContain(binding);
  });

  it("names the existing inline CredentialProvider without a second instance", () => {
    expect(indexSource).toContain("const sharedCredentialProvider = new CredentialProvider({");
    expect(indexSource).toContain(
      'new SharedRuntimeService(dataDir+"-shared-runtime", sharedCredentialProvider,',
    );
    // Exactly one provider construction remains; the capability query reuses it.
    const constructions = indexSource.match(/new CredentialProvider\(/g) ?? [];
    expect(constructions).toHaveLength(1);
  });

  it("adds no new IPC channel, preload bridge, codec or fallback", () => {
    const handles = indexSource.match(/ipcMain\.handle\("folio:[^"]+"/g) ?? [];
    expect(handles).toHaveLength(3);
    expect(handles).toEqual(
      expect.arrayContaining([
        'ipcMain.handle("folio:shared"',
        'ipcMain.handle("folio:request"',
        'ipcMain.handle("folio:request:diagnostic-v1"',
      ]),
    );
    expect(indexSource).not.toContain("folio:capabilities");
    expect(indexSource).not.toContain("folio:desktop");
  });
});

describe("producer output is a valid DTO bound to real references", () => {
  it("the injected Main binding set yields a schema-valid table", () => {
    // Mirror the exact keys the Main dispatch passes, with sentinel references.
    const dto = createDesktopCapabilities({
      fileDialogs: { showOpenDialog: () => {}, showSaveDialog: () => {} },
      attachmentStore: {},
      externalLinkOpener: {},
      backupService: {},
      sharedCredentialProvider: {},
      privateCredentialVault: {},
      nativeFileSystem: {},
      hostLifecycle: {},
      readOnly: false,
      platform: "darwin",
    });
    const parsed = parseDesktopCapabilities(dto);
    expect(parsed).not.toBeNull();
    expect(parsed!.features.find((f) => f.id === "exit")!.binding).toBe("HOST_MANAGED");
  });
});
