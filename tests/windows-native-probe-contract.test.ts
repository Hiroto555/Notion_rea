import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  assertWindowsProbe,
  asciiCaseFold,
  validateWindowsPath,
  type WindowsProbeExpectation,
} from "../src/platform/windows/path-policy";
import {
  WINDOWS_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_PROBE_TIMEOUT_MS,
  WindowsPrivateRoot,
  windowsPowerShellCommand,
} from "../src/platform/windows/private-root";
import {
  WindowsNativeProbe,
  type WindowsProbeExecRequest,
  type WindowsProbeExecResult,
  type WindowsNativeProbeOptions,
} from "../src/platform/windows/native-probe";

const PATH = "C:\\Users\\me\\Folio\\db.sqlite";
const ROOT = "C:\\Users\\me\\Folio";
const VOLUME = "0123456789abcdef";

function evidence(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    canonicalPath: PATH,
    canonicalRoot: ROOT,
    daclPrivate: true,
    fileId: "a".repeat(32),
    linkCount: 1,
    localFilesystem: true,
    ownerSid: "S-1-5-21-100",
    platform: "win32",
    reparsePoint: false,
    rootFileId: "b".repeat(32),
    rootVolumeId: VOLUME,
    sid: "S-1-5-21-100",
    volumeId: VOLUME,
    ...overrides,
  };
}

function expectation(path = PATH, root = ROOT): WindowsProbeExpectation {
  return { canonicalPath: path, canonicalRoot: root };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectReject(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function ok(stdout: string): WindowsProbeExecResult {
  return { status: 0, signal: null, stdout, stderr: "" };
}

function encode(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new Error("JSON encoding failed");
  return text;
}

function probeOptions(
  exec: WindowsNativeProbeOptions["untrustedTestExec"],
): WindowsNativeProbeOptions {
  return {
    systemRoot: "C:\\Windows",
    scriptPath: "C:\\Program Files\\Folio\\resources\\probe-private-root.ps1",
    untrustedTestExec: exec,
  };
}

describe("windows path policy", () => {
  it("accepts exact Japanese segments and ASCII case differences", () => {
    expect(
      validateWindowsPath(
        "C:\\Users\\山田\\Folio\\メモ.txt",
        "C:\\Users\\山田\\Folio",
      ),
    ).toEqual({
      canonical: "C:\\Users\\山田\\Folio\\メモ.txt",
      relative: "メモ.txt",
    });
    expect(validateWindowsPath("c:\\root\\File.TXT", "C:\\Root")).toEqual({
      canonical: "C:\\root\\File.TXT",
      relative: "File.TXT",
    });
  });

  it("never folds non-ASCII case variants, including the Kelvin sign", () => {
    expect(asciiCaseFold("K")).toBe("k");
    expect(asciiCaseFold("\u212A")).toBe("\u212A");
    expectCode(
      () => validateWindowsPath("C:\\root\\K\\file", "C:\\root\\\u212A"),
      "OUTSIDE_ROOT",
    );
    expectCode(
      () => validateWindowsPath("C:\\\u00C4\\file", "C:\\\u00E4"),
      "OUTSIDE_ROOT",
    );
    expect(validateWindowsPath("C:\\\u00C4\\file", "C:\\\u00C4").relative).toBe(
      "file",
    );
  });

  it("rejects traversal, device, UNC, alternate streams and aliases", () => {
    expectCode(
      () => validateWindowsPath("C:\\root\\..\\outside", "C:\\root"),
      "TRAVERSAL",
    );
    expectCode(
      () => validateWindowsPath("\\\\?\\C:\\root\\file", "C:\\root"),
      "DEVICE_PREFIX",
    );
    expectCode(
      () => validateWindowsPath("\\\\server\\share\\file", "C:\\root"),
      "UNC_PATH",
    );
    expectCode(
      () => validateWindowsPath("C:\\root\\file:stream", "C:\\root"),
      "ADS",
    );
    expectCode(
      () => validateWindowsPath("C:\\root\\PROGRA~1\\file", "C:\\root"),
      "SHORT_NAME_ALIAS",
    );
    expectCode(
      () => validateWindowsPath("D:\\root\\file", "C:\\root"),
      "DRIVE_MISMATCH",
    );
  });
});

describe("windows probe evidence", () => {
  it("accepts a fully bound, private probe record", () => {
    expect(() => assertWindowsProbe(evidence(), expectation())).not.toThrow();
  });

  it("binds canonical path and root to the caller request", () => {
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({ canonicalPath: "C:\\Users\\me\\Folio\\other.sqlite" }),
          expectation(),
        ),
      "PROBE_PATH_MISMATCH",
    );
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({ canonicalRoot: "C:\\Users\\me" }),
          expectation(),
        ),
      "PROBE_ROOT_MISMATCH",
    );
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({
            canonicalPath: "C:\\other\\db.sqlite",
            canonicalRoot: "C:\\other",
          }),
          expectation(),
        ),
      "PROBE_PATH_MISMATCH",
    );
  });

  it("rejects fake, incomplete, accessor and inconsistent evidence", () => {
    expectCode(
      () => assertWindowsProbe(evidence({ extra: true }), expectation()),
      "PROBE_INVALID",
    );
    expectCode(
      () => assertWindowsProbe(evidence({ daclPrivate: false }), expectation()),
      "PROBE_DACL",
    );
    expectCode(
      () => assertWindowsProbe(evidence({ reparsePoint: true }), expectation()),
      "PROBE_REPARSE",
    );
    expectCode(
      () => assertWindowsProbe(evidence({ linkCount: 2 }), expectation()),
      "PROBE_LINK_COUNT",
    );
    expectCode(
      () =>
        assertWindowsProbe(evidence({ localFilesystem: false }), expectation()),
      "PROBE_LOCAL_FS",
    );
    expectCode(
      () => assertWindowsProbe(evidence({ fileId: "xyz" }), expectation()),
      "PROBE_FILE_ID",
    );
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({ rootFileId: "a".repeat(31) }),
          expectation(),
        ),
      "PROBE_ROOT_FILE_ID",
    );
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({ rootVolumeId: "f".repeat(16) }),
          expectation(),
        ),
      "PROBE_VOLUME_MISMATCH",
    );
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({ ownerSid: "S-1-5-21-999" }),
          expectation(),
        ),
      "PROBE_OWNER",
    );
    expectCode(
      () =>
        assertWindowsProbe(
          evidence({ canonicalPath: "C:\\Users\\me\\Folio\\..\\x" }),
          expectation(),
        ),
      "PROBE_CANONICAL_PATH",
    );

    const accessor = evidence();
    Object.defineProperty(accessor, "fileId", {
      enumerable: true,
      get: () => "a".repeat(32),
    });
    expectCode(
      () => assertWindowsProbe(accessor, expectation()),
      "PROBE_ACCESSOR",
    );
  });
});

describe("WindowsPrivateRoot", () => {
  it("passes canonical path and root to the probe and returns the validated result", async () => {
    let seen: readonly string[] | undefined;
    const root = new WindowsPrivateRoot(async (path, canonicalRoot) => {
      seen = [path, canonicalRoot];
      return evidence({ canonicalPath: path, canonicalRoot });
    });
    await expect(
      root.assert("c:\\Users\\me\\Folio\\db.sqlite", "C:\\Users\\me\\Folio"),
    ).resolves.toEqual({
      canonical: "C:\\Users\\me\\Folio\\db.sqlite",
      relative: "db.sqlite",
    });
    expect(seen).toEqual(["C:\\Users\\me\\Folio\\db.sqlite", ROOT]);
  });

  it("fails closed when the injected probe errors or returns unbound evidence", async () => {
    const throwing = new WindowsPrivateRoot(async () => {
      throw new Error("boom");
    });
    await expectReject(throwing.assert(PATH, ROOT), "PROBE_FAILED");

    const wrong = new WindowsPrivateRoot(async () =>
      evidence({ canonicalPath: "C:\\evil\\db.sqlite" }),
    );
    await expectReject(wrong.assert(PATH, ROOT), "PROBE_CONTAINMENT");

    expectCode(
      () => new WindowsPrivateRoot(undefined as never),
      "PROBE_NOT_FUNCTION",
    );
  });
});

describe("WindowsNativeProbe", () => {
  it("builds an absolute, bounded, non-bypass PowerShell request and accepts a bound record", async () => {
    let request: WindowsProbeExecRequest | undefined;
    const probe = new WindowsNativeProbe(
      probeOptions({
        exec(value) {
          request = value;
          return ok(encode(evidence()));
        },
      }),
    );

    await expect(
      probe.probe("c:\\Users\\me\\Folio\\db.sqlite", ROOT),
    ).resolves.toEqual(evidence());
    expect(request).toBeDefined();
    const captured = request as WindowsProbeExecRequest;
    expect(captured.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(captured.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "C:\\Program Files\\Folio\\resources\\probe-private-root.ps1",
      "-Path",
      PATH,
      "-Root",
      ROOT,
    ]);
    expect(captured.args.join(" ")).not.toMatch(/ExecutionPolicy/i);
    expect(captured.cwd).toBe("C:\\Windows");
    expect(captured.timeoutMs).toBe(WINDOWS_PROBE_TIMEOUT_MS);
    expect(captured.timeoutMs).toBe(15_000);
    expect(captured.maxBuffer).toBe(WINDOWS_PROBE_MAX_OUTPUT_BYTES);
    expect(captured.maxBuffer).toBe(16_384);
    expect(captured.windowsHide).toBe(true);
    expect(captured.shell).toBe(false);
    expect(captured.encoding).toBe("utf8");
    expect(Object.keys(captured.env).sort()).toEqual([
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "TEMP",
      "TMP",
      "WINDIR",
    ]);
    expect(captured.env.PATH).toBe("C:\\Windows\\System32;C:\\Windows");
    for (const key of Object.keys(captured.env))
      expect(key).not.toMatch(/FOLIO|SECRET|TOKEN|PASSWORD/i);
  });

  it("rejects malformed or unbounded executor results", async () => {
    const cases: ReadonlyArray<[WindowsProbeExecResult, string]> = [
      [{ status: 1, signal: null, stdout: "", stderr: "bad" }, "PROBE_EXIT"],
      [
        {
          status: 0,
          signal: "SIGKILL",
          stdout: encode(evidence()),
          stderr: "",
        },
        "PROBE_SIGNAL",
      ],
      [
        {
          status: 0,
          signal: null,
          stdout: encode(evidence()),
          stderr: "warning",
        },
        "PROBE_STDERR",
      ],
      [
        {
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          errorCode: "ETIMEDOUT",
        },
        "PROBE_TIMEOUT",
      ],
      [
        {
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          errorCode: "ENOBUFS",
        },
        "PROBE_OUTPUT_LIMIT",
      ],
      [
        {
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          errorCode: "EACCES",
        },
        "PROBE_EXEC_FAILED",
      ],
      [
        { status: 0, signal: null, stdout: "not json", stderr: "" },
        "PROBE_JSON",
      ],
      [{ status: 0, signal: null, stdout: "", stderr: "" }, "PROBE_OUTPUT"],
      [
        {
          status: 0,
          signal: null,
          stdout: "a".repeat(WINDOWS_PROBE_MAX_OUTPUT_BYTES + 1),
          stderr: "",
        },
        "PROBE_OUTPUT_LIMIT",
      ],
      [
        {
          status: 0,
          signal: null,
          stdout: encode(evidence({ platform: "linux" })),
          stderr: "",
        },
        "PROBE_PLATFORM",
      ],
      [
        {
          status: 0,
          signal: null,
          stdout: encode(evidence({ extra: 1 })),
          stderr: "",
        },
        "PROBE_INVALID",
      ],
      [
        {
          status: 0,
          signal: null,
          stdout: encode(evidence({ canonicalRoot: "C:\\Users\\me" })),
          stderr: "",
        },
        "PROBE_ROOT_MISMATCH",
      ],
      [
        {
          status: 0,
          signal: null,
          stdout: encode(evidence()),
          stderr: "",
          extra: true,
        } as never,
        "PROBE_EXEC_RESULT",
      ],
    ];
    for (const [result, code] of cases) {
      const probe = new WindowsNativeProbe(
        probeOptions({ exec: () => result }),
      );
      await expectReject(probe.probe(PATH, ROOT), code);
    }
  });

  it("fails closed when the test executor throws", async () => {
    const probe = new WindowsNativeProbe(
      probeOptions({
        exec() {
          throw new Error("spawn exploded");
        },
      }),
    );
    await expectReject(probe.probe(PATH, ROOT), "PROBE_EXEC_FAILED");
  });

  it("requires an absolute packaged probe script and an absolute system root", () => {
    expectCode(
      () =>
        new WindowsNativeProbe({
          systemRoot: "C:\\Windows",
          scriptPath: "probe-private-root.ps1",
          untrustedTestExec: { exec: () => ok("{}") },
        }),
      "PROBE_SCRIPT_PATH",
    );
    expectCode(
      () =>
        new WindowsNativeProbe({
          systemRoot: "C:\\Windows",
          scriptPath: "C:\\Program Files\\Folio\\other.ps1",
          untrustedTestExec: { exec: () => ok("{}") },
        }),
      "PROBE_SCRIPT_PATH",
    );
    expectCode(
      () =>
        new WindowsNativeProbe({
          systemRoot: "Windows",
          scriptPath: "C:\\Program Files\\Folio\\probe-private-root.ps1",
          untrustedTestExec: { exec: () => ok("{}") },
        }),
      "PROBE_SYSTEM_ROOT",
    );
    expectCode(
      () =>
        new WindowsNativeProbe({
          systemRoot: "C:\\Windows",
          scriptPath: "C:\\Program Files\\Folio\\probe-private-root.ps1",
          untrustedTestExec: {} as never,
        }),
      "PROBE_TEST_EXEC",
    );
  });

  it("refuses the real executor on a non-Windows host", () => {
    if (process.platform === "win32") return;
    expectCode(
      () =>
        new WindowsNativeProbe({
          systemRoot: "C:\\Windows",
          scriptPath: "C:\\Program Files\\Folio\\probe-private-root.ps1",
        }),
      "PROBE_PLATFORM",
    );
  });
});

describe("windowsPowerShellCommand", () => {
  it("uses the canonical targets and an absolute system PowerShell", () => {
    const command = windowsPowerShellCommand(
      "c:\\Users\\me\\Folio\\db.sqlite",
      ROOT,
      {
        systemRoot: "C:\\Windows",
        scriptPath: "C:\\Program Files\\Folio\\probe-private-root.ps1",
      },
    );
    expect(command.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(command.cwd).toBe("C:\\Windows");
    expect(command.args).toContain(PATH);
    expect(command.args).toContain(ROOT);
  });
});
