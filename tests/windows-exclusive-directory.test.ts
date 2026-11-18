import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createWindowsExclusiveDirectory,
  createWindowsExclusiveDirectoryForTesting,
  WINDOWS_EXCLUSIVE_DIRECTORY_MAX_OUTPUT_BYTES,
  type WindowsExclusiveDirectoryExecRequest,
  type WindowsExclusiveDirectoryExecResult,
  type WindowsExclusiveDirectoryTestPort,
} from "../src/platform/windows/exclusive-directory";
import type { WindowsRuntimeFsPort } from "../src/platform/windows/runtime-platform";
import { CollaborationError } from "../src/collaboration/runtime/contract";

// Contract simulation over injected fs/exec ports: this is NOT Windows OS
// acceptance and proves nothing about real NtCreateFile behavior.
const ROOT = "C:\\Folio";
const PARENT = "C:\\Folio\\keep";
const TARGET = "C:\\Folio\\keep\\dest";
const HELPER = "C:\\Folio\\bin\\PrivateRootProbe.exe";
const SYSTEM_ROOT = "C:\\Windows";
const HELPER_BYTES = new Uint8Array([0x46, 0x4f, 0x4c, 0x49, 0x4f]);
const OTHER_BYTES = new Uint8Array([0x42, 0x41, 0x44]);
const HELPER_HASH = createHash("sha256").update(HELPER_BYTES).digest("hex");
const ROOT_ID = "1".repeat(32);
const VOL_ID = "2".repeat(16);
const PARENT_ID = "3".repeat(32);
const DIR_ID = "4".repeat(32);
const ATTEMPT = "a".repeat(32);
const SID = "S-1-5-21-1000";

function helperFs(onRead?: (call: number) => Uint8Array): Pick<WindowsRuntimeFsPort, "lstat" | "readFile"> {
  let reads = 0;
  return {
    lstat() {
      return {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        nlink: 1,
        dev: 1,
        ino: 7,
        size: HELPER_BYTES.byteLength,
        mtimeMs: 42,
      };
    },
    readFile() {
      reads++;
      return onRead ? onRead(reads) : HELPER_BYTES;
    },
  };
}

function probeEvidence(
  path: string,
  fileId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    platform: "win32",
    sid: SID,
    ownerSid: SID,
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    localFilesystem: true,
    fileId,
    rootFileId: ROOT_ID,
    volumeId: VOL_ID,
    rootVolumeId: VOL_ID,
    canonicalPath: path,
    canonicalRoot: ROOT,
    ...overrides,
  };
}

function successReply(
  path = TARGET,
  parent = PARENT,
  attempt = ATTEMPT,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    contractVersion: 1,
    operation: "create-directory",
    path,
    root: ROOT,
    attemptId: attempt,
    state: "CREATED",
    rootEvidence: probeEvidence(ROOT, ROOT_ID),
    parent: probeEvidence(parent, parent === ROOT ? ROOT_ID : PARENT_ID),
    directory: probeEvidence(path, DIR_ID),
    handleFileId: DIR_ID,
    handleVolumeId: VOL_ID,
    filesystem: "NTFS",
    ancestorsHeld: true,
    daclProtected: true,
    namespace: "EXCLUSIVE_CREATE",
    ...overrides,
  });
}

function failureReply(
  path: string,
  attempt: string,
  state: "EXISTS" | "REJECTED" | "UNKNOWN",
): string {
  const reason =
    state === "EXISTS"
      ? "EXCLUSIVE_DIRECTORY_EXISTS"
      : state === "REJECTED"
        ? "EXCLUSIVE_DIRECTORY_REJECTED"
        : "EXCLUSIVE_DIRECTORY_UNKNOWN";
  return JSON.stringify({
    contractVersion: 1,
    operation: "create-directory",
    path,
    root: ROOT,
    attemptId: attempt,
    state,
    reason,
  });
}

function reply(
  partial: Partial<WindowsExclusiveDirectoryExecResult>,
): WindowsExclusiveDirectoryExecResult {
  return { status: 0, signal: null, stdout: "", stderr: "", ...partial };
}

function setup(
  exec: (
    request: WindowsExclusiveDirectoryExecRequest,
  ) => WindowsExclusiveDirectoryExecResult,
  fs?: Pick<WindowsRuntimeFsPort, "lstat" | "readFile">,
) {
  const calls: WindowsExclusiveDirectoryExecRequest[] = [];
  const port: WindowsExclusiveDirectoryTestPort = {
    fs: fs ?? helperFs(),
    exec(request) {
      calls.push(request);
      return exec(request);
    },
  };
  const api = createWindowsExclusiveDirectoryForTesting(
    {
      root: ROOT,
      probeExecutable: HELPER,
      expectedHash: HELPER_HASH,
      systemRoot: SYSTEM_ROOT,
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOL_ID },
    },
    port,
  );
  return { api, calls };
}

const REQUEST = {
  path: TARGET,
  attemptId: ATTEMPT,
  expectedDirectory: { fileId: PARENT_ID, volumeId: VOL_ID },
};
const ROOT_CHILD = "C:\\Folio\\dest";
const ROOT_REQUEST = {
  path: ROOT_CHILD,
  attemptId: ATTEMPT,
  expectedDirectory: { fileId: ROOT_ID, volumeId: VOL_ID },
};

describe("windows exclusive directory contract (injected ports, not OS)", () => {
  it("rejects the production factory on this non-Windows host", () => {
    expect(() =>
      createWindowsExclusiveDirectory({
        root: ROOT,
        probeExecutable: HELPER,
        expectedHash: HELPER_HASH,
        systemRoot: SYSTEM_ROOT,
        expectedRoot: { rootFileId: ROOT_ID, volumeId: VOL_ID },
      }),
    ).toThrow("UNSUPPORTED_PLATFORM");
  });

  it("dispatches the exact bounded wire and returns CREATED with preserved raw evidence", () => {
    const raw = successReply();
    const { api, calls } = setup(() => reply({ stdout: raw }));
    const result = api.create(REQUEST);
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.executable).toBe(HELPER);
    expect(request.args).toEqual(["--exclusive-directory-v1"]);
    expect(request.cwd).toBe(SYSTEM_ROOT);
    expect(request.env).toEqual({
      SystemRoot: SYSTEM_ROOT,
      windir: SYSTEM_ROOT,
      TEMP: `${SYSTEM_ROOT}\\Temp`,
      TMP: `${SYSTEM_ROOT}\\Temp`,
    });
    expect(request.timeoutMs).toBe(15_000);
    expect(request.maxBuffer).toBe(WINDOWS_EXCLUSIVE_DIRECTORY_MAX_OUTPUT_BYTES);
    expect(request.shell).toBe(false);
    expect(request.windowsHide).toBe(true);
    expect(request.stdio).toBe("pipe");
    expect(request.encoding).toBe("buffer");
    const wire = Buffer.from(request.input).toString("utf8");
    expect(JSON.parse(wire)).toEqual({
      contractVersion: 1,
      operation: "create-directory",
      path: TARGET,
      root: ROOT,
      attemptId: ATTEMPT,
      rootFileId: ROOT_ID,
      rootVolumeId: VOL_ID,
      directoryFileId: PARENT_ID,
      directoryVolumeId: VOL_ID,
    });
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(4096);
    expect(result.state).toBe("CREATED");
    if (result.state !== "CREATED") throw new Error("unreachable");
    expect(result.path).toBe(TARGET);
    expect(result.attemptId).toBe(ATTEMPT);
    expect(result.preserve).toBe(true);
    expect(result.identity).toEqual({
      canonicalPath: TARGET,
      directoryFileId: DIR_ID,
      directoryVolumeId: VOL_ID,
      rootFileId: ROOT_ID,
      rootVolumeId: VOL_ID,
    });
    expect(result.evidence.exactWire).toBe(wire);
    expect(result.evidence.captured).toEqual({
      stdout: raw,
      stderr: "",
      captureEncoding: "latin1",
      status: 0,
      signal: null,
    });
  });

  it("accepts a direct child of the private root with the root id as parent", () => {
    const { api } = setup(() => reply({ stdout: successReply(ROOT_CHILD, ROOT) }));
    const result = api.create(ROOT_REQUEST);
    expect(result.state).toBe("CREATED");
    if (result.state !== "CREATED") throw new Error("unreachable");
    expect(result.identity.canonicalPath).toBe(ROOT_CHILD);
    expect(result.identity.directoryFileId).toBe(DIR_ID);
  });

  it("maps the exact structured failure envelopes with preserved evidence", () => {
    const exists = setup(() =>
      reply({ status: 2, stdout: failureReply(TARGET, ATTEMPT, "EXISTS") }),
    );
    const existsResult = exists.api.create(REQUEST);
    expect(existsResult.state).toBe("EXISTS");
    expect(existsResult.state === "EXISTS" && existsResult.reason).toBe(
      "EXCLUSIVE_DIRECTORY_EXISTS",
    );
    expect(existsResult.evidence.captured.status).toBe(2);
    expect(existsResult.evidence.exactWire.length).toBeGreaterThan(0);

    const rejected = setup(() =>
      reply({ status: 1, stdout: failureReply(TARGET, ATTEMPT, "REJECTED") }),
    );
    expect(rejected.api.create(REQUEST).state).toBe("REJECTED");

    const unknown = setup(() =>
      reply({ status: 3, stdout: failureReply(TARGET, ATTEMPT, "UNKNOWN") }),
    );
    const unknownResult = unknown.api.create(REQUEST);
    expect(unknownResult.state).toBe("UNKNOWN");
    expect(unknownResult.state !== "CREATED" && unknownResult.reason).toBe(
      "EXCLUSIVE_DIRECTORY_UNKNOWN",
    );
  });

  it("rejects inconsistent status/state envelopes as UNKNOWN, not as the claimed state", () => {
    const combos: ReadonlyArray<
      readonly [number, string, string]
    > = [
      [0, failureReply(TARGET, ATTEMPT, "EXISTS"), "exit0-with-EXISTS"],
      [2, failureReply(TARGET, ATTEMPT, "REJECTED"), "exit2-with-REJECTED"],
      [1, failureReply(TARGET, ATTEMPT, "EXISTS"), "exit1-with-EXISTS"],
      [3, failureReply(TARGET, ATTEMPT, "REJECTED"), "exit3-with-REJECTED"],
      [
        0,
        JSON.stringify({
          contractVersion: 1,
          operation: "create-directory",
          path: TARGET,
          root: ROOT,
          attemptId: ATTEMPT,
          state: "SOMETHING",
          reason: "EXCLUSIVE_DIRECTORY_UNKNOWN",
        }),
        "unknown-state-label",
      ],
    ];
    for (const [status, stdout, name] of combos) {
      const { api } = setup(() => reply({ status, stdout }));
      const result = api.create(REQUEST);
      expect(result.state, name).toBe("UNKNOWN");
    }
  });

  it.each([
    ["reparse directory", { directory: probeEvidence(TARGET, DIR_ID, { reparsePoint: true }) }],
    ["remote/non-local filesystem flag", { filesystem: "REMOTE" }],
    ["non-local root proof", { rootEvidence: probeEvidence(ROOT, ROOT_ID, { localFilesystem: false }) }],
    ["non-local parent proof", { parent: probeEvidence(PARENT, PARENT_ID, { localFilesystem: false }) }],
    ["non-local directory proof", { directory: probeEvidence(TARGET, DIR_ID, { localFilesystem: false }) }],
    ["non-NTFS filesystem", { filesystem: "FAT32" }],
    ["non-private directory DACL", { directory: probeEvidence(TARGET, DIR_ID, { daclPrivate: false }) }],
    ["unprotected DACL flag", { daclProtected: false }],
    ["unheld ancestors flag", { ancestorsHeld: false }],
    ["unexpected namespace", { namespace: "EXCLUSIVE_NO_REPLACE" }],
    ["directory SID mismatch", { directory: probeEvidence(TARGET, DIR_ID, { sid: "S-1-5-21-9999" }) }],
    ["directory owner mismatch", { directory: probeEvidence(TARGET, DIR_ID, { ownerSid: "S-1-5-21-9999" }) }],
    ["changed root id", { rootEvidence: probeEvidence(ROOT, "9".repeat(32)) }],
    ["changed parent id", { parent: probeEvidence(PARENT, "8".repeat(32)) }],
    ["changed directory handle id", { handleFileId: "7".repeat(32) }],
    ["handle volume mismatch", { handleVolumeId: "9".repeat(16) }],
    ["directory id equal to root", { directory: probeEvidence(TARGET, ROOT_ID) }],
    ["directory id equal to parent", { directory: probeEvidence(TARGET, PARENT_ID) }],
    ["directory volume mismatch", { directory: probeEvidence(TARGET, DIR_ID, { volumeId: "9".repeat(16) }) }],
    ["wrong canonical path echo", { directory: probeEvidence("C:\\Folio\\keep\\other", DIR_ID) }],
    ["extra unexpected field", { injected: true }],
  ])("treats a tampered success proof (%s) as UNKNOWN", (_name, overrides) => {
    const { api } = setup(() =>
      reply({ stdout: successReply(TARGET, PARENT, ATTEMPT, overrides) }),
    );
    const result = api.create(REQUEST);
    expect(result.state).toBe("UNKNOWN");
    expect(result.preserve).toBe(true);
  });

  it("rejects shape/path/identity failures BEFORE dispatch without touching exec", () => {
    const { api, calls } = setup(() => {
      throw new Error("exec must not run");
    });
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { ...REQUEST, path: "C:\\Other\\dest" },
      { ...REQUEST, path: ROOT },
      { ...REQUEST, path: "c:\\folio\\keep\\dest" },
      { ...REQUEST, path: "C:\\Folio\\keep\\..\\dest" },
      { ...REQUEST, attemptId: "A".repeat(32) },
      { ...REQUEST, attemptId: "short" },
      { ...REQUEST, expectedDirectory: { fileId: PARENT_ID, volumeId: "9".repeat(16) } },
      { path: ROOT_CHILD, attemptId: ATTEMPT, expectedDirectory: { fileId: PARENT_ID, volumeId: VOL_ID } },
      { path: TARGET, attemptId: ATTEMPT },
      { ...REQUEST, extra: true },
    ];
    for (const request of cases) {
      const result = api.create(
        request as Parameters<typeof api.create>[0],
      );
      expect(result.state).toBe("REJECTED");
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["exec throws", () => { throw new Error("spawn failed"); }],
    ["timeout error code", () => reply({ status: null, errorCode: "EXEC_FAILED" })],
    ["signaled", () => reply({ status: null, signal: "SIGKILL", stdout: successReply() })],
    ["stdout and stderr", () => reply({ stdout: successReply(), stderr: "noise" })],
    ["stderr only", () => reply({ status: 3, stdout: failureReply(TARGET, ATTEMPT, "UNKNOWN"), stderr: "x" })],
    ["null status", () => reply({ status: null })],
    ["out-of-range status", () => reply({ status: 7, stdout: successReply() })],
    ["empty stdout success", () => reply({ stdout: "" })],
    ["malformed JSON", () => reply({ stdout: "{broken" })],
    ["duplicate key", () => reply({ stdout: successReply().replace('"state":"CREATED"', '"state":"CREATED","state":"EXISTS"') })],
    ["escaped duplicate key", () => reply({ stdout: successReply().replace('"state":"CREATED"', '"state":"CREATED","st\\u0061te":"EXISTS"') })],
    ["non-ASCII output", () => reply({ stdout: successReply().replace('"state"', '"stâte"') })],
    ["missing status", () => { const r = reply({ stdout: successReply() }); delete (r as Record<string, unknown>).status; return r; }],
    ["missing signal", () => { const r = reply({ stdout: successReply() }); delete (r as Record<string, unknown>).signal; return r; }],
    ["missing stdout", () => { const r = reply({}); delete (r as Record<string, unknown>).stdout; return r; }],
    ["missing stderr", () => { const r = reply({ stdout: successReply() }); delete (r as Record<string, unknown>).stderr; return r; }],
    ["extra field", () => ({ ...reply({ stdout: successReply() }), extra: "x" })],
    ["extra then field", () => ({ ...reply({ stdout: successReply() }), then: () => undefined })],
  ])("treats a malformed transport (%s) as UNKNOWN with raw capture", (_name, exec) => {
    const { api } = setup(exec as () => WindowsExclusiveDirectoryExecResult);
    const result = api.create(REQUEST);
    expect(result.state).toBe("UNKNOWN");
    expect(result.evidence.captured.captureEncoding).toBe("latin1");
    expect(typeof result.evidence.captured.stdout).toBe("string");
  });

  it("retains every oversized captured byte and invalid latin1 stderr verbatim as UNKNOWN", () => {
    const oversized = `${" ".repeat(20000)}${successReply()}`;
    const stderr = "x\u0000\u0080\u00ff";
    const { api } = setup(() => reply({ stdout: oversized, stderr }));
    const result = api.create(REQUEST);
    expect(result.state).toBe("UNKNOWN");
    const captured = result.evidence.captured;
    expect(captured.stdout).toBe(oversized);
    expect(captured.stderr).toBe(stderr);
    // Captured strings are reversible latin1 of the exact delivered bytes.
    expect(Buffer.from(captured.stdout, "latin1").toString("latin1")).toBe(
      oversized,
    );
    expect(Buffer.from(captured.stderr, "latin1").toString("latin1")).toBe(
      stderr,
    );
  });

  it("treats a throwing-descriptor Proxy result as UNKNOWN keeping accessible raw strings", () => {
    const raw = reply({ stdout: successReply() });
    const proxied = new Proxy(raw, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "stderr") throw new Error("trap");
        return Object.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target);
      },
    });
    const { api } = setup(
      () => proxied as unknown as WindowsExclusiveDirectoryExecResult,
    );
    const result = api.create(REQUEST);
    expect(result.state).toBe("UNKNOWN");
    expect(result.evidence.captured.stdout).toBe(raw.stdout);
    expect(result.evidence.captured.status).toBe(0);
  });

  it("treats a promise-shaped fabricated success as UNKNOWN and sinks a real rejection", () => {
    const promised = setup(
      () =>
        Promise.resolve(reply({ stdout: successReply() })) as unknown as WindowsExclusiveDirectoryExecResult,
    );
    expect(promised.api.create(REQUEST).state).toBe("UNKNOWN");
    const rejected = setup(
      () =>
        Promise.reject(new Error("late")) as unknown as WindowsExclusiveDirectoryExecResult,
    );
    expect(rejected.api.create(REQUEST).state).toBe("UNKNOWN");
  });

  it("refuses async and generator transport functions before any invocation", () => {
    const options = {
      root: ROOT,
      probeExecutable: HELPER,
      expectedHash: HELPER_HASH,
      systemRoot: SYSTEM_ROOT,
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOL_ID },
    };
    let calls = 0;
    const count = () => {
      calls++;
      return reply({ stdout: successReply() });
    };
    const asyncExec = async () => count();
    const genExec = function* () {
      yield count();
    };
    const asyncFs = { ...helperFs(), readFile: async () => HELPER_BYTES };
    const genFs = {
      lstat: helperFs().lstat,
      readFile: function* () {
        yield HELPER_BYTES;
      },
    };
    for (const port of [
      { fs: helperFs(), exec: asyncExec },
      { fs: helperFs(), exec: genExec },
      { fs: asyncFs, exec: count },
      { fs: genFs, exec: count },
    ]) {
      expect(() =>
        createWindowsExclusiveDirectoryForTesting(
          options,
          port as unknown as WindowsExclusiveDirectoryTestPort,
        ),
      ).toThrow(CollaborationError);
    }
    expect(calls).toBe(0);
  });

  it("flags accessor-valued exec results as UNKNOWN instead of invoking them", () => {
    const hostile: Record<string, unknown> = {
      status: 0,
      signal: null,
      stderr: "",
    };
    Object.defineProperty(hostile, "stdout", {
      get: () => successReply(),
      enumerable: true,
    });
    const { api } = setup(
      () => hostile as unknown as WindowsExclusiveDirectoryExecResult,
    );
    expect(api.create(REQUEST).state).toBe("UNKNOWN");
  });

  it("converts a post-invocation helper hash change to UNKNOWN", () => {
    const { api } = setup(
      () => reply({ stdout: successReply() }),
      helperFs((call) => (call <= 2 ? HELPER_BYTES : OTHER_BYTES)),
    );
    expect(api.create(REQUEST).state).toBe("UNKNOWN");
  });

  it("consumes a target and an attempt after dispatch even across UNKNOWN", () => {
    const { api, calls } = setup(() => reply({ stdout: "{broken" }));
    expect(api.create(REQUEST).state).toBe("UNKNOWN");
    expect(api.create(REQUEST).state).toBe("REJECTED");
    expect(
      api.create({ ...REQUEST, attemptId: "b".repeat(32) }).state,
    ).toBe("REJECTED");
    expect(
      api.create({ ...ROOT_REQUEST, attemptId: ATTEMPT }).state,
    ).toBe("REJECTED");
    expect(calls).toHaveLength(1);
  });

  it("requires a lowercase sha256 helper hash and an .exe helper", () => {
    const options = {
      root: ROOT,
      probeExecutable: HELPER,
      expectedHash: HELPER_HASH,
      systemRoot: SYSTEM_ROOT,
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOL_ID },
    };
    const port = { fs: helperFs(), exec: () => reply({}) };
    expect(() =>
      createWindowsExclusiveDirectoryForTesting(
        { ...options, expectedHash: HELPER_HASH.toUpperCase() },
        port,
      ),
    ).toThrow(CollaborationError);
    expect(() =>
      createWindowsExclusiveDirectoryForTesting(
        { ...options, expectedHash: "0".repeat(64) },
        port,
      ),
    ).toThrow(CollaborationError);
    expect(() =>
      createWindowsExclusiveDirectoryForTesting(
        { ...options, probeExecutable: "C:\\Folio\\bin\\probe.dll" },
        port,
      ),
    ).toThrow(CollaborationError);
  });

  it("pins the helper as a regular single-link file before and after exec", () => {
    const { api, calls } = setup(() => reply({ stdout: successReply() }));
    const badFs: Pick<WindowsRuntimeFsPort, "lstat" | "readFile"> = {
      lstat: () => ({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => true,
        nlink: 1,
        dev: 1,
        ino: 7,
        size: HELPER_BYTES.byteLength,
        mtimeMs: 42,
      }),
      readFile: () => HELPER_BYTES,
    };
    expect(() =>
      createWindowsExclusiveDirectoryForTesting(
        {
          root: ROOT,
          probeExecutable: HELPER,
          expectedHash: HELPER_HASH,
          systemRoot: SYSTEM_ROOT,
          expectedRoot: { rootFileId: ROOT_ID, volumeId: VOL_ID },
        },
        { fs: badFs, exec: () => reply({}) },
      ),
    ).toThrow(CollaborationError);
    expect(calls).toHaveLength(0);
  });

  // Source-only inspection: this reads the native sources as text and checks
  // that the exclusive-create path uses the documented primitives. It is NOT
  // evidence the compiled helper behaves this way on Windows.
  it("keeps the native source on FILE_CREATE held-handle create without open-if or delete", () => {
    const program = readFileSync(
      new URL("../scripts/platform/windows/PrivateRootProbeProgram.cs", import.meta.url),
      "utf8",
    );
    const ps1 = readFileSync(
      new URL("../scripts/platform/windows/probe-private-root.ps1", import.meta.url),
      "utf8",
    );
    expect(program).toContain('"--exclusive-directory-v1"');
    expect(program).toContain('EntryPoint="NtCreateFile"');
    expect(program).toContain("IoFileCreate=2");
    expect(program).toContain("IoFileDirectoryFile|IoFileSynchronousIoNonAlert|IoFileOpenReparsePoint");
    expect(program).toContain("RunHeldDirectory");
    expect(program).toContain("D:P(A;OICI;FA;;;");
    expect(program).toContain("IoStatusObjectNameCollision=unchecked((int)0xC0000035)");
    expect(program).toContain("RecheckExclusive");
    // The exclusive operation must not share create-or-open or delete verbs.
    expect(program).not.toContain("CREATE_ALWAYS");
    expect(program).not.toContain("OPEN_ALWAYS");
    expect(program).not.toContain("OPEN_IF");
    expect(program).not.toContain("File.Delete");
    expect(program).not.toContain("Directory.Delete");
    expect(ps1).toContain("RunHeldDirectory");
    expect(ps1).toContain("targetHandle");
  });
});
