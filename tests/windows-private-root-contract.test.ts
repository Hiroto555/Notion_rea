import { describe, expect, it, vi } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  WINDOWS_PROBE_SCRIPT_NAME,
  WINDOWS_PROBE_TIMEOUT_MS,
  WINDOWS_PROBE_TRUST_BOUNDARY,
  WindowsPrivateRoot,
  windowsPowerShellCommand,
  type WindowsProbe,
} from "../src/platform/windows/private-root";

const SCRIPT_PATH = "C:\\Program Files\\Folio\\probe-private-root.ps1";
const COMMAND_OPTIONS = { systemRoot: "C:\\Windows", scriptPath: SCRIPT_PATH };
const ROOT = "C:\\Users\\Alice\\Folio";
const FILE = "C:\\Users\\Alice\\Folio\\doc.txt";

function validProbe(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    daclPrivate: true,
    fileId: "0123456789abcdef0123456789abcdef",
    rootFileId: "00000000000000000000000000000002",
    rootVolumeId: "0011223344556677",
    canonicalPath: FILE,
    canonicalRoot: ROOT,
    linkCount: 1,
    localFilesystem: true,
    ownerSid: "S-1-5-21-1000",
    platform: "win32",
    reparsePoint: false,
    sid: "S-1-5-21-1000",
    volumeId: "0011223344556677",
    ...overrides,
  };
}

function rejectingProbe(probe: Record<string, unknown>): WindowsProbe {
  return async () => probe;
}

function captureSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_THROW");
}

describe("WindowsPrivateRoot synthetic contract", () => {
  it("returns the lexical canonical path and relative path for a legal scope", async () => {
    const calls: Array<[string, string]> = [];
    const adapter = new WindowsPrivateRoot(async (path, root) => {
      calls.push([path, root]);
      return validProbe();
    });

    const result = await adapter.assert(
      "c:/Users/Alice/Folio/doc.txt",
      "c:/Users/Alice/Folio",
    );

    expect(result).toEqual({
      canonical: "C:\\Users\\Alice\\Folio\\doc.txt",
      relative: "doc.txt",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls).toEqual([[FILE, ROOT]]);
  });

  it("allows the root itself and returns an empty relative path", async () => {
    const adapter = new WindowsPrivateRoot(
      rejectingProbe(validProbe({ canonicalPath: ROOT })),
    );
    await expect(adapter.assert(ROOT, ROOT)).resolves.toEqual({
      canonical: ROOT,
      relative: "",
    });
  });

  it("rejects an out-of-root path before invoking the probe", async () => {
    let called = false;
    const adapter = new WindowsPrivateRoot(async () => {
      called = true;
      return validProbe();
    });

    await expect(
      adapter.assert("C:\\Users\\Alice\\Other\\doc.txt", ROOT),
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(called).toBe(false);
  });

  it("rejects a different drive before invoking the probe", async () => {
    let called = false;
    const adapter = new WindowsPrivateRoot(async () => {
      called = true;
      return validProbe();
    });

    await expect(
      adapter.assert("D:\\Folio\\doc.txt", ROOT),
    ).rejects.toMatchObject({
      code: "DRIVE_MISMATCH",
    });
    expect(called).toBe(false);
  });

  it("rejects traversal, short-name aliases and UNC input before the probe", async () => {
    let called = false;
    const adapter = new WindowsPrivateRoot(async () => {
      called = true;
      return validProbe();
    });

    await expect(
      adapter.assert("C:\\Users\\Alice\\Folio\\..\\Other\\doc.txt", ROOT),
    ).rejects.toMatchObject({ code: "TRAVERSAL" });
    await expect(
      adapter.assert("C:\\Users\\Alice\\Folio\\DOC~1.TXT", ROOT),
    ).rejects.toMatchObject({ code: "SHORT_NAME_ALIAS" });
    await expect(
      adapter.assert("\\\\server\\share\\doc.txt", ROOT),
    ).rejects.toMatchObject({ code: "UNC_PATH" });
    expect(called).toBe(false);
  });

  it("propagates a typed probe refusal unchanged", async () => {
    const adapter = new WindowsPrivateRoot(async () => {
      throw new CollaborationError("PROBE_REFUSED");
    });
    await expect(adapter.assert(FILE, ROOT)).rejects.toMatchObject({
      code: "PROBE_REFUSED",
    });
  });

  it("wraps an unknown probe failure without exposing its message", async () => {
    const adapter = new WindowsPrivateRoot(async () => {
      throw new Error("secret command line");
    });
    await expect(adapter.assert(FILE, ROOT)).rejects.toMatchObject({
      code: "PROBE_FAILED",
      message: "PROBE_FAILED",
    });
  });

  it("rejects a non-object probe result", async () => {
    const adapter = new WindowsPrivateRoot(async () => "win32");
    await expect(adapter.assert(FILE, ROOT)).rejects.toMatchObject({
      code: "PROBE_INVALID",
    });
  });

  it("rejects an array or exotic-prototype probe result", async () => {
    const arrayAdapter = new WindowsPrivateRoot(async () => [validProbe()]);
    await expect(arrayAdapter.assert(FILE, ROOT)).rejects.toMatchObject({
      code: "PROBE_INVALID",
    });

    const exotic = Object.create({ inherited: true });
    Object.assign(exotic, validProbe());
    const exoticAdapter = new WindowsPrivateRoot(async () => exotic);
    await expect(exoticAdapter.assert(FILE, ROOT)).rejects.toMatchObject({
      code: "PROBE_INVALID",
    });
  });

  it("rejects missing or extra probe fields", async () => {
    const missing = validProbe();
    delete missing.volumeId;
    await expect(
      new WindowsPrivateRoot(rejectingProbe(missing)).assert(FILE, ROOT),
    ).rejects.toMatchObject({ code: "PROBE_INVALID" });

    await expect(
      new WindowsPrivateRoot(
        rejectingProbe(validProbe({ extra: true })),
      ).assert(FILE, ROOT),
    ).rejects.toMatchObject({ code: "PROBE_INVALID" });
  });

  it("rejects accessor-backed probe fields", async () => {
    const probe = validProbe();
    Object.defineProperty(probe, "daclPrivate", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });
    await expect(
      new WindowsPrivateRoot(rejectingProbe(probe)).assert(FILE, ROOT),
    ).rejects.toMatchObject({ code: "PROBE_ACCESSOR" });
  });

  it("rejects unsafe or mismatched probe values", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ platform: "linux" }, "PROBE_PLATFORM"],
      [{ daclPrivate: false }, "PROBE_DACL"],
      [{ reparsePoint: true }, "PROBE_REPARSE"],
      [{ linkCount: 2 }, "PROBE_LINK_COUNT"],
      [{ localFilesystem: false }, "PROBE_LOCAL_FS"],
      [{ ownerSid: "S-1-5-18" }, "PROBE_OWNER"],
      [{ fileId: "" }, "PROBE_FILE_ID"],
      [{ volumeId: "" }, "PROBE_VOLUME_ID"],
      [{ sid: "\ud800" }, "PROBE_SID"],
    ];

    for (const [overrides, code] of cases) {
      await expect(
        new WindowsPrivateRoot(rejectingProbe(validProbe(overrides))).assert(
          FILE,
          ROOT,
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it("times out a probe that never settles", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new WindowsPrivateRoot(
        () => new Promise<unknown>(() => undefined),
      );
      const pending = adapter.assert(FILE, ROOT);
      const rejected = expect(pending).rejects.toMatchObject({
        code: "PROBE_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(WINDOWS_PROBE_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects construction without a probe function", () => {
    expect(
      captureSync(
        () => new WindowsPrivateRoot(null as unknown as WindowsProbe),
      ),
    ).toMatchObject({ code: "PROBE_NOT_FUNCTION" });
  });

  it("states that an injected probe is a contract check, not safety proof", () => {
    expect(WINDOWS_PROBE_TRUST_BOUNDARY).toContain("not proof");
    expect(WINDOWS_PROBE_TRUST_BOUNDARY.toLowerCase()).toContain("untrusted");
  });
});

describe("windowsPowerShellCommand descriptor", () => {
  it("exports a non-interactive PowerShell argv descriptor without spawning anything", () => {
    const descriptor = windowsPowerShellCommand(
      "c:/Users/Alice/Folio/doc.txt",
      "c:/Users/Alice/Folio",
      COMMAND_OPTIONS,
    );

    expect(descriptor.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(descriptor.args).toContain("-NonInteractive");
    expect(descriptor.args).toContain("-NoProfile");
    expect(descriptor.args).toContain("-File");
    expect(descriptor.args).toContain(SCRIPT_PATH);
    expect(descriptor.args[descriptor.args.indexOf("-Path") + 1]).toBe(FILE);
    expect(descriptor.args[descriptor.args.indexOf("-Root") + 1]).toBe(ROOT);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.args)).toBe(true);
  });

  it("refuses to describe a command for an unsafe scope", () => {
    expect(
      captureSync(() =>
        windowsPowerShellCommand(
          "C:\\Users\\Alice\\Other\\doc.txt",
          ROOT,
          COMMAND_OPTIONS,
        ),
      ),
    ).toMatchObject({ code: "OUTSIDE_ROOT" });
  });
});
