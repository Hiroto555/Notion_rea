import { describe, expect, it, vi } from "vitest";
import { requestSchema } from "../src/shared/types";
import {
  DESKTOP_CAPABILITY_IDS,
  parseDesktopCapabilities,
} from "../src/shared/desktop-capabilities";
import { createDesktopCapabilities } from "../src/main/desktop-capabilities";
import { createReadDesktopCapabilities } from "../src/renderer/desktop-capabilities";

/** All host bindings present, as distinct sentinel references. The producer
 * must only read presence/type and never invoke any of them. */
function fullBindings() {
  return {
    fileDialogs: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    attachmentStore: { marker: "attachment-store" },
    externalLinkOpener: { marker: "external-link" },
    backupService: { marker: "backup" },
    sharedCredentialProvider: { marker: "shared-provider" },
    privateCredentialVault: { marker: "private-vault" },
    nativeFileSystem: { marker: "native-fs" },
    hostLifecycle: { marker: "lifecycle" },
    readOnly: false,
    platform: "darwin",
  };
}

/** A fresh mutable plain-object copy of a valid DTO for negative mutations. */
function baseDto(): any {
  return JSON.parse(JSON.stringify(createDesktopCapabilities(fullBindings())));
}

function row(dto: any, id: string) {
  return dto.features.find((f: any) => f.id === id);
}

describe("desktop:capabilities request schema", () => {
  it("accepts the empty strict request and rejects extra keys", () => {
    expect(requestSchema.safeParse({ type: "desktop:capabilities" }).success).toBe(true);
    expect(
      requestSchema.safeParse({ type: "desktop:capabilities", extra: 1 }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({ type: "desktop:capabilities", path: "/tmp/x" }).success,
    ).toBe(false);
  });
});

describe("parseDesktopCapabilities strict validator", () => {
  it("round-trips a producer-built DTO", () => {
    const dto = createDesktopCapabilities(fullBindings());
    const parsed = parseDesktopCapabilities(dto);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(1);
    expect(parsed!.host.kind).toBe("desktop");
    expect(parsed!.features).toHaveLength(DESKTOP_CAPABILITY_IDS.length);
  });

  it("rejects non-objects, arrays and wrong versions", () => {
    const v2 = baseDto();
    v2.version = 2;
    for (const bad of [null, undefined, 0, "x", [], v2])
      expect(parseDesktopCapabilities(bad)).toBeNull();
    const strVersion = baseDto();
    strVersion.version = "1";
    expect(parseDesktopCapabilities(strVersion)).toBeNull();
  });

  it("rejects unknown/extra/missing keys at every level", () => {
    expect(parseDesktopCapabilities({ ...baseDto(), surprise: 1 })).toBeNull();
    const noHost = baseDto();
    delete noHost.host;
    expect(parseDesktopCapabilities(noHost)).toBeNull();
    expect(parseDesktopCapabilities({ ...baseDto(), host: { ...baseDto().host, x: 1 } })).toBeNull();
    const badRow = baseDto();
    badRow.features[0] = { ...badRow.features[0], leak: true };
    expect(parseDesktopCapabilities(badRow)).toBeNull();
    const shortRow = baseDto();
    delete shortRow.features[0].result;
    expect(parseDesktopCapabilities(shortRow)).toBeNull();
  });

  it("rejects invalid host fields and oversized/path platform tokens", () => {
    for (const platform of ["/etc/passwd", "../x", "C:\\win", "a".repeat(49), "Has Space", "UPPER", ".."])
      expect(parseDesktopCapabilities({ ...baseDto(), host: { ...baseDto().host, platform } })).toBeNull();
    expect(parseDesktopCapabilities({ ...baseDto(), host: { ...baseDto().host, kind: "web" } })).toBeNull();
    expect(parseDesktopCapabilities({ ...baseDto(), host: { ...baseDto().host, mode: "admin" } })).toBeNull();
  });

  it("rejects wrong feature count, order, id and forged enums", () => {
    const dto = baseDto();
    expect(parseDesktopCapabilities({ ...dto, features: dto.features.slice(0, 8) })).toBeNull();
    expect(parseDesktopCapabilities({ ...dto, features: [...dto.features, dto.features[0]] })).toBeNull();
    const swapped = baseDto();
    [swapped.features[0], swapped.features[1]] = [swapped.features[1], swapped.features[0]];
    expect(parseDesktopCapabilities(swapped)).toBeNull();
    const unknown = baseDto();
    unknown.features[0] = { ...unknown.features[0], id: "rootShell" };
    expect(parseDesktopCapabilities(unknown)).toBeNull();
  });

  it("rejects forged readiness/verification/binding/operation/result claims", () => {
    const cases: Array<(r: any) => void> = [
      (r) => (r.readiness = "PROBED"),
      (r) => (r.osVerification = "PASSED"),
      (r) => (r.verified = true),
      (r) => (r.binding = "AVAILABLE"),
      (r) => (r.operation = "SUCCESS"),
      (r) => (r.result = "RAW_BYTES"),
    ];
    for (const mutate of cases) {
      const dto = baseDto();
      mutate(dto.features[0]);
      expect(parseDesktopCapabilities(dto)).toBeNull();
    }
    // exit must stay host-managed/not-provided; non-exit must not be host-managed.
    const exitProvided = baseDto();
    exitProvided.features[8].binding = "PROVIDED";
    expect(parseDesktopCapabilities(exitProvided)).toBeNull();
    const nonExitHost = baseDto();
    nonExitHost.features[0].binding = "HOST_MANAGED";
    expect(parseDesktopCapabilities(nonExitHost)).toBeNull();
    // result/operation are pinned per feature id.
    const wrongResult = baseDto();
    wrongResult.features[1].result = "UTF8_TEXT_OR_NULL";
    expect(parseDesktopCapabilities(wrongResult)).toBeNull();
    const exitOp = baseDto();
    exitOp.features[8].operation = "PROVIDED";
    expect(parseDesktopCapabilities(exitOp)).toBeNull();
  });

  it("rejects accessors, symbol keys, non-plain objects and cycles", () => {
    const accessor = baseDto();
    Object.defineProperty(accessor.host, "platform", {
      get: () => "darwin",
      enumerable: true,
      configurable: true,
    });
    expect(parseDesktopCapabilities(accessor)).toBeNull();

    const sym = baseDto();
    (sym as any)[Symbol("x")] = 1;
    expect(parseDesktopCapabilities(sym)).toBeNull();

    class Box {
      constructor(public v: any) {}
    }
    expect(parseDesktopCapabilities(new Box(baseDto()))).toBeNull();
    const customProto = baseDto();
    Object.setPrototypeOf(customProto.host, { injected: true });
    expect(parseDesktopCapabilities(customProto)).toBeNull();

    const cyclic: any = baseDto();
    cyclic.features[0].self = cyclic;
    expect(parseDesktopCapabilities(cyclic)).toBeNull();
    const selfRef = baseDto();
    selfRef.features = selfRef;
    expect(parseDesktopCapabilities(selfRef)).toBeNull();
  });
});

describe("createDesktopCapabilities producer", () => {
  it("reports every binding PROVIDED with exit HOST_MANAGED and never verifies", () => {
    const bindings = fullBindings();
    const dto = createDesktopCapabilities(bindings);
    expect(dto.version).toBe(1);
    expect(dto.host).toEqual({ kind: "desktop", platform: "darwin", mode: "writable" });
    expect(dto.features.map((f) => f.id)).toEqual([...DESKTOP_CAPABILITY_IDS]);
    for (const f of dto.features) {
      expect(f.readiness).toBe("UNPROBED");
      expect(f.osVerification).toBe("NOT_RUN");
      expect(f.verified).toBe(false);
    }
    expect(row(dto, "fileImport")).toMatchObject({
      binding: "PROVIDED",
      operation: "PROVIDED",
      result: "UTF8_TEXT_OR_NULL",
    });
    expect(row(dto, "fileExport")).toMatchObject({
      binding: "PROVIDED",
      result: "DISPLAY_PATH_OR_NULL",
    });
    expect(row(dto, "exit")).toMatchObject({
      binding: "HOST_MANAGED",
      operation: "NOT_PROVIDED",
      result: "HOST_MANAGED",
    });
    // The producer output must itself pass the strict validator.
    expect(parseDesktopCapabilities(dto)).not.toBeNull();
  });

  it("performs zero calls/probes on the injected bindings", () => {
    const bindings = fullBindings();
    const showOpen = bindings.fileDialogs.showOpenDialog as ReturnType<typeof vi.fn>;
    const showSave = bindings.fileDialogs.showSaveDialog as ReturnType<typeof vi.fn>;
    createDesktopCapabilities(bindings);
    expect(showOpen).not.toHaveBeenCalled();
    expect(showSave).not.toHaveBeenCalled();
  });

  it("describes missing optional bindings as NOT_PROVIDED", () => {
    const dto = createDesktopCapabilities({});
    expect(dto.host.platform).toBe("unknown");
    expect(dto.host.mode).toBe("writable");
    for (const f of dto.features) {
      if (f.id === "exit") expect(f.binding).toBe("NOT_PROVIDED");
      else expect(f.binding).toBe("NOT_PROVIDED");
      expect(f.operation).toBe(f.id === "exit" ? "NOT_PROVIDED" : "PROVIDED");
    }
    expect(parseDesktopCapabilities(dto)).not.toBeNull();
  });

  it("keeps shared and private credentials as distinct rows", () => {
    const sharedOnly = createDesktopCapabilities({
      sharedCredentialProvider: {},
      platform: "linux",
    });
    expect(row(sharedOnly, "sharedCredential")!.binding).toBe("PROVIDED");
    expect(row(sharedOnly, "privateCredential")!.binding).toBe("NOT_PROVIDED");
    const privateOnly = createDesktopCapabilities({
      privateCredentialVault: {},
      platform: "linux",
    });
    expect(row(privateOnly, "sharedCredential")!.binding).toBe("NOT_PROVIDED");
    expect(row(privateOnly, "privateCredential")!.binding).toBe("PROVIDED");
  });

  it("reflects read-only mode without changing binding facts", () => {
    const dto = createDesktopCapabilities({ ...fullBindings(), readOnly: true });
    expect(dto.host.mode).toBe("read-only");
    expect(row(dto, "fileImport")!.binding).toBe("PROVIDED");
    expect(row(dto, "exit")!.binding).toBe("HOST_MANAGED");
  });

  it("describes native filesystem by binding presence, never by OS name", () => {
    const posix = createDesktopCapabilities({ platform: "linux" });
    expect(row(posix, "nativeFilesystem")!.binding).toBe("NOT_PROVIDED");
    const winNative = createDesktopCapabilities({
      platform: "win32",
      nativeFileSystem: {},
    });
    expect(row(winNative, "nativeFilesystem")!.binding).toBe("PROVIDED");
    const winMissing = createDesktopCapabilities({ platform: "win32" });
    expect(row(winMissing, "nativeFilesystem")!.binding).toBe("NOT_PROVIDED");
    for (const dto of [posix, winNative, winMissing])
      expect(row(dto, "nativeFilesystem")!.verified).toBe(false);
  });

  it("requires both picker and store for attachment", () => {
    const pickerOnly = createDesktopCapabilities({
      fileDialogs: { showOpenDialog: () => {} },
    });
    expect(row(pickerOnly, "attachment")!.binding).toBe("NOT_PROVIDED");
    const both = createDesktopCapabilities({
      fileDialogs: { showOpenDialog: () => {} },
      attachmentStore: {},
    });
    expect(row(both, "attachment")!.binding).toBe("PROVIDED");
  });
});

describe("createReadDesktopCapabilities renderer binding", () => {
  const successReply = (value: unknown) => ({
    tag: "folio-request-result",
    version: 1,
    ok: true,
    valueSlot: { present: true, value },
  });

  it("returns the validated DTO after exactly one diagnostic invoke", async () => {
    const dto = createDesktopCapabilities(fullBindings());
    const invoke = vi.fn(async () => successReply(dto));
    const read = createReadDesktopCapabilities(invoke);
    const result = await read();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({ type: "desktop:capabilities" });
    expect(result).not.toBeNull();
    expect(result!.features).toHaveLength(DESKTOP_CAPABILITY_IDS.length);
  });

  it("returns null on missing API, transport rejection and bad envelopes", async () => {
    const dto = createDesktopCapabilities(fullBindings());
    const cases: unknown[] = [
      undefined,
      "not-a-function",
      vi.fn(async () => {
        throw new Error("ipc down");
      }),
      vi.fn(async () => ({ tag: "wrong", version: 1, ok: true, valueSlot: { present: true, value: dto } })),
      vi.fn(async () => ({ tag: "folio-request-result", version: 2, ok: true, valueSlot: { present: true, value: dto } })),
      vi.fn(async () => successReply({ bogus: true })),
    ];
    for (const invoke of cases) {
      const read = createReadDesktopCapabilities(invoke);
      await expect(read()).resolves.toBeNull();
    }
  });

  it("returns null when the success value is not a valid DTO", async () => {
    const invoke = vi.fn(async () => successReply({ version: 1, host: {}, features: [] }));
    const read = createReadDesktopCapabilities(invoke);
    await expect(read()).resolves.toBeNull();
  });

  it("never reports all-features-provided on failure", async () => {
    const read = createReadDesktopCapabilities(undefined);
    const result = await read();
    expect(result).toBeNull();
    expect(result === null || result.features.every((f) => f.binding !== "PROVIDED")).toBe(true);
  });
});
