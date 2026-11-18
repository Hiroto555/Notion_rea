import { describe, expect, it } from "vitest";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { StorageFailureError } from "../src/renderer/private-request";
import { parseDesktopCapabilities } from "../src/shared/desktop-capabilities";
import type { FolioAPI, Request } from "../src/shared/types";

const roundtrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const okReply = (
  valueSlot: { present: false } | { present: true; value: unknown },
): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: true, valueSlot });
const failureReply = (failure: unknown): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: false, failure });
const rejected = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("unexpected resolve");
    },
    (error: unknown) => error,
  );

/** The real preload pair: the production v1 adapter over a fake invoke, plus
 * a legacy channel that only counts calls so any fallback would be seen. */
function rootBridge(
  invoke: (request: Request) => unknown | Promise<unknown>,
) {
  const sent: Request[] = [];
  let legacyCalls = 0;
  const preload = createPrivateRequestPreload(async (request) => {
    sent.push(request);
    return invoke(request);
  });
  const bridge: Pick<FolioAPI, "requestDiagnostic" | "shared"> & {
    request: FolioAPI["request"];
  } = {
    requestDiagnostic: preload.requestDiagnostic,
    request: async <T>(request: Request): Promise<T> => {
      legacyCalls += 1;
      return request as unknown as T;
    },
  };
  return { bridge, sent, legacyCalls: () => legacyCalls };
}

const expectSafeE = async (
  promise: Promise<unknown>,
  requestType: string,
): Promise<void> => {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(StorageFailureError);
  expect((error as StorageFailureError).storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType,
    retryAuthority: "NONE",
    preserve: true,
  });
};

const CAP_ROW_ORDER = [
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
const CAP_CONTRACT: Record<
  (typeof CAP_ROW_ORDER)[number],
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
const capabilitiesDto = (fileExportBinding: string) => ({
  version: 1,
  host: { kind: "desktop", platform: "darwin", mode: "read-only" },
  features: CAP_ROW_ORDER.map((id) => ({
    id,
    binding:
      id === "fileExport"
        ? fileExportBinding
        : id === "exit"
          ? "HOST_MANAGED"
          : "NOT_PROVIDED",
    operation: CAP_CONTRACT[id].operation,
    readiness: "UNPROBED",
    osVerification: "NOT_RUN",
    verified: false,
    result: CAP_CONTRACT[id].result,
  })),
});

describe("readonly surface: exact subset and forbidden ports", () => {
  it("carries only workspace+original+recovery+capabilities and never a write or generic lane", () => {
    const { bridge } = rootBridge(async () => okReply({ present: false }));
    const bindings = createDesktopRootBindings(bridge);
    expect(Object.keys(bindings.readOnly).sort()).toEqual([
      "capabilities",
      "original",
      "recovery",
      "workspace",
    ]);
    for (const forbidden of [
      "editing",
      "structure",
      "sync",
      "shared",
      "storage",
      "request",
      "compatibility",
      "conflict",
    ])
      expect(forbidden in bindings.readOnly).toBe(false);
    expect(bindings.readOnly.original).toBe(bindings.writable.original);
    expect(bindings.readOnly.recovery).toBe(bindings.writable.recovery);
    expect(bindings.readOnly.capabilities).toBe(bindings.writable.capabilities);
    expect(bindings.writable.storage).not.toBe(bindings.readOnly);
  });
});

describe("original.readOriginal", () => {
  it("returns the stored source verbatim — including empty and large text — through one fixed tag", async () => {
    const large = "x".repeat(2 * 1024 * 1024);
    for (const source of ["", "{}", large, "{broken"]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: source }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(await bindings.readOnly.original.readOriginal("p-1")).toBe(source);
      expect(sent).toEqual([{ type: "pageSource", id: "p-1" }]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("rejects non-string values once, as a bounded E on the actual tag", async () => {
    for (const value of [
      42,
      true,
      { source: "x" },
      ["x"],
      undefined,
      null,
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        value === undefined
          ? okReply({ present: false })
          : okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.readOnly.original.readOriginal("p-1"),
        "pageSource",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("closes a getter-bearing or trapping carrier to the bounded E without executing it", async () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "length", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap /Users/alice/secret");
        },
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap /Users/alice/secret");
        },
      },
    );
    for (const value of [accessor, proxy]) {
      const { bridge, sent, legacyCalls } = rootBridge(
        async () =>
          ({
            tag: "folio-request-result",
            version: 1,
            ok: true,
            valueSlot: { present: true, value },
          }) as const,
      );
      const bindings = createDesktopRootBindings(bridge);
      const error = await rejected(
        bindings.readOnly.original.readOriginal("p-1"),
      );
      expect(error).toBeInstanceOf(StorageFailureError);
      expect((error as Error).message).not.toContain("secret");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });
});

describe("original.exportOriginal", () => {
  it("sends the fixed json format and returns the display path or the picker null", async () => {
    {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: "/tmp/out/page.json" }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(
        await bindings.readOnly.original.exportOriginal({
          name: "メモ",
          content: "{}",
        }),
      ).toBe("/tmp/out/page.json");
      expect(sent).toEqual([
        { type: "export", name: "メモ", format: "json", content: "{}" },
      ]);
      expect(legacyCalls()).toBe(0);
    }
    const { bridge, sent } = rootBridge(async () =>
      okReply({ present: true, value: null }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(
      await bindings.readOnly.original.exportOriginal({
        name: "p",
        content: "",
      }),
    ).toBeNull();
    expect(sent).toEqual([
      { type: "export", name: "p", format: "json", content: "" },
    ]);
  });

  it("rejects malformed results as a bounded E on the export tag", async () => {
    for (const value of [42, true, {}, ["x"], undefined]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        value === undefined
          ? okReply({ present: false })
          : okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.readOnly.original.exportOriginal({ name: "n", content: "c" }),
        "export",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });
});

describe("recovery.salvageRaw", () => {
  it("returns the closed three-field descriptor and the picker null", async () => {
    {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({
          present: true,
          value: { directory: "/tmp/salvage-1", files: 3, bytes: 4096 },
        }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(await bindings.readOnly.recovery.salvageRaw()).toEqual({
        directory: "/tmp/salvage-1",
        files: 3,
        bytes: 4096,
      });
      expect(sent).toEqual([{ type: "storage:rawSalvage" }]);
      expect(legacyCalls()).toBe(0);
    }
    const { bridge, sent } = rootBridge(async () =>
      okReply({ present: true, value: null }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(await bindings.readOnly.recovery.salvageRaw()).toBeNull();
    expect(sent).toEqual([{ type: "storage:rawSalvage" }]);
  });

  it("rejects partial, extra-key, cycle and thenable descriptors as a bounded E", async () => {
    const cyclic: Record<string, unknown> = {
      directory: "/d",
      files: 1,
      bytes: 2,
    };
    cyclic.self = cyclic;
    const thenable = {
      directory: "/d",
      files: 1,
      bytes: 2,
      then() {
        return null;
      },
    };
    for (const value of [
      { directory: "/d", files: 1 },
      { directory: "", files: 1, bytes: 2 },
      { directory: "/d", files: "1", bytes: 2 },
      { directory: "/d", files: 1.5, bytes: 2 },
      { directory: "/d", files: 1, bytes: -1 },
      { directory: "/d", files: 1, bytes: 2, marker: "partial" },
      cyclic,
      thenable,
      "done",
      undefined,
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(
        async () =>
          value === undefined
            ? okReply({ present: false })
            : ({
                tag: "folio-request-result",
                version: 1,
                ok: true,
                valueSlot: { present: true, value },
              }) as const,
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.readOnly.recovery.salvageRaw(),
        "storage:rawSalvage",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });
});

describe("storage.readPressure (writable only)", () => {
  it("passes ready, blocked and unknown snapshots through unchanged", async () => {
    const snapshots = [
      {
        state: "ready",
        checkedAt: "2026-11-15T01:02:03.000Z",
        availableBytes: 5_000_000,
        reserveBytes: 268_435_456,
        additionalBytes: 0,
      },
      {
        state: "blocked",
        checkedAt: "2026-11-15T01:02:03.000Z",
        availableBytes: 1,
        reserveBytes: 268_435_456,
        additionalBytes: 0,
        reason: "capacity-exceeded",
      },
      {
        state: "unknown",
        checkedAt: "2026-11-15T01:02:03.000Z",
        availableBytes: null,
        reserveBytes: 268_435_456,
        additionalBytes: 0,
        reason: "capacity-unknown",
      },
    ];
    for (const snapshot of snapshots) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: snapshot }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(await bindings.writable.storage.readPressure()).toEqual(snapshot);
      expect(sent).toEqual([{ type: "storage:pressure" }]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("rejects malformed snapshots as a bounded E on the pressure tag", async () => {
    const base = {
      state: "ready",
      checkedAt: "2026-11-15T01:02:03.000Z",
      availableBytes: 0,
      reserveBytes: 0,
      additionalBytes: 0,
    };
    for (const value of [
      { ...base, state: "maybe" },
      { ...base, checkedAt: 9 },
      { ...base, availableBytes: "0" },
      { ...base, availableBytes: undefined },
      { ...base, reserveBytes: -1 },
      { ...base, additionalBytes: 1.5 },
      { ...base, reason: 7 },
      { ...base, path: "/tmp" },
      "ready",
      null,
      undefined,
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        value === undefined
          ? okReply({ present: false })
          : okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.writable.storage.readPressure(),
        "storage:pressure",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });
});

describe("capabilities.read", () => {
  it("returns the parsed table through one fixed tag on the same v1 closure", async () => {
    const dto = capabilitiesDto("PROVIDED");
    const { bridge, sent, legacyCalls } = rootBridge(async () =>
      okReply({ present: true, value: dto }),
    );
    const bindings = createDesktopRootBindings(bridge);
    const value = await bindings.readOnly.capabilities.read();
    expect(value).toEqual(parseDesktopCapabilities(dto));
    expect(sent).toEqual([{ type: "desktop:capabilities" }]);
    expect(legacyCalls()).toBe(0);
  });

  it("closes invalid tables, transport failures and typed failures to null — never a throw, never a resend", async () => {
    for (const invoke of [
      async () => okReply({ present: true, value: { version: 1 } }),
      async () => okReply({ present: true, value: "provided" }),
      async () => okReply({ present: false }),
      async () => failureReply({ kind: "OUTCOME_UNKNOWN" }),
      async () => {
        throw new Error("raw transport /Users/alice/secret");
      },
      async () => ({ unexpected: true }),
    ] as const) {
      const { bridge, sent, legacyCalls } = rootBridge(invoke);
      const bindings = createDesktopRootBindings(bridge);
      await expect(
        bindings.readOnly.capabilities.read(),
      ).resolves.toBeNull();
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
    const missing = createDesktopRootBindings(undefined);
    await expect(missing.readOnly.capabilities.read()).resolves.toBeNull();
  });
});
