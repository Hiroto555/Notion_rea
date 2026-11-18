// NOT OS PROOF: these tests exercise the additive Windows GUI fixture policy
// through the untrustedTest exec seam - fake probe results are a contract
// check only, never proof of Windows filesystem safety. No real native helper
// is ever launched; the fake .exe is inert bytes hashed for the pin check.
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep, win32 } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore: additive .mjs policy module ships no .d.mts (owned-file bound).
import { WINDOWS_GUI_TRUST_BOUNDARY, assertWindowsGuiChild, prepareWindowsGuiBatch, windowsGuiDataRoot } from "../scripts/windows-gui-batch-policy.mjs";
import {
  fixtureElectronOptions,
  fixtureRoot,
} from "./e2e/fixture-isolation";

const SID = "S-1-5-21-1000-2000-3000";
const VOLUME = "0011223344556677";
const SYSTEM_ROOT = "C:\\Windows";

type ProbeRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  shell: boolean;
  stdio: string[];
};

function pathId(path: string) {
  return createHash("sha256").update(`file:${path}`).digest("hex").slice(0, 32);
}

function evidenceOf(target: string, root: string, idOf: (p: string) => string) {
  return {
    canonicalPath: target,
    canonicalRoot: root,
    daclPrivate: true,
    fileId: idOf(target),
    linkCount: 1,
    localFilesystem: true,
    ownerSid: SID,
    platform: "win32",
    reparsePoint: false,
    rootFileId: idOf(root),
    rootVolumeId: VOLUME,
    sid: SID,
    volumeId: VOLUME,
  };
}

function host(windowsPaths = false) {
  const tempBase = realpathSync(tmpdir());
  const physicalRunRoot = mkdtempSync(join(tempBase, "folio-owned-shutdown-"));
  const physicalWorkspace = join(physicalRunRoot, "workspace");
  mkdirSync(physicalWorkspace);
  const exeDir = mkdtempSync(join(tempBase, "folio-wgui-exe-"));
  const physicalExe = join(exeDir, "probe.exe");
  writeFileSync(physicalExe, Buffer.from("synthetic probe bytes"));
  const windowsTempRoot = "C:\\FolioSyntheticTemp";
  const native = (path: string) => windowsPaths
    ? win32.join(windowsTempRoot, ...relative(tempBase, path).split(sep))
    : path;
  const physical = (path: string) => windowsPaths
    ? join(tempBase, ...path.slice(windowsTempRoot.length).split("\\").filter(Boolean))
    : path;
  const runRoot = native(physicalRunRoot);
  const workspace = native(physicalWorkspace);
  const exe = native(physicalExe);
  const env: NodeJS.ProcessEnv = {
    FOLIO_GUI_TEST_OPT_IN: "1",
    FOLIO_WINDOWS_NATIVE_PROBE: exe,
    FOLIO_WINDOWS_NATIVE_SHA256: createHash("sha256")
      .update(readFileSync(physicalExe))
      .digest("hex"),
    SystemRoot: SYSTEM_ROOT,
  };
  const requests: ProbeRequest[] = [];
  const ids = new Map<string, string>();
  const idOf = (path: string) => ids.get(path) ?? pathId(path);
  let override: ((request: ProbeRequest) => unknown) | undefined;
  const exec = (request: unknown) => {
    const req = request as ProbeRequest;
    requests.push(req);
    if (override) return override(req);
    return {
      status: 0,
      signal: null,
      stdout: Buffer.from(
        JSON.stringify(evidenceOf(req.args[0], req.args[1], idOf)),
      ),
      stderr: Buffer.alloc(0),
    };
  };
  const seam = { platform: "win32" as const, exec,
    ...(windowsPaths ? {windowsTempRoot} : {}) };
  const createdStateRoots = () => readdirSync(physicalRunRoot)
    .filter(name => /^windows-gui-state-[a-f0-9-]+\.json$/.test(name))
    .map(name => {
      const record = JSON.parse(readFileSync(join(physicalRunRoot, name), "utf8")) as {root: string};
      const path = physical(record.root);
      if (dirname(path) !== tempBase || !basename(path).startsWith("folio-windows-gui-state-"))
        throw new Error("Test refuses cleanup outside its recorded allocation");
      return path;
    });
  return {
    runRoot,
    workspace,
    exe,
    env,
    requests,
    seam,
    idOf,
    realRunRoot: native(realpathSync(physicalRunRoot)),
    physicalRunRoot,
    physicalWorkspace,
    physicalExe,
    native,
    physical,
    tempBase,
    setOverride: (fn: typeof override) => {
      override = fn;
    },
    setId: (path: string, id: string) => ids.set(path, id),
    createdStateRoots,
    cleanup: () => {
      for (const dir of [
        ...createdStateRoots(),
        physicalRunRoot,
        exeDir,
      ])
        rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Host = ReturnType<typeof host>;

function prepared(t: Host) {
  return prepareWindowsGuiBatch(
    { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
    t.seam,
  ) as Record<string, string>;
}

function capturedBinaries(dir: string) {
  return readdirSync(dir).filter((name) => name.endsWith(".stdout.bin"));
}

describe.skipIf(process.platform === "win32")("windows-gui fixture policy - POSIX fake seam, NOT OS PROOF", () => {
  it("declares the injected probe trust boundary", () => {
    expect(WINDOWS_GUI_TRUST_BOUNDARY.toLowerCase()).toContain("untrusted");
    expect(WINDOWS_GUI_TRUST_BOUNDARY).toContain("not proof");
  });

  it("stays inert when no Windows batch flags are present", () => {
    expect(windowsGuiDataRoot({}, "win32")).toBeUndefined();
    expect(
      windowsGuiDataRoot(
        { FOLIO_LOCAL_GUI_BATCH: "1", FOLIO_LOCAL_GUI_DATA_ROOT: "/x" },
        "win32",
      ),
    ).toBeUndefined();
    expect(
      windowsGuiDataRoot(
        { FOLIO_LINUX_GUI_CI: "1", FOLIO_GUI_CI_DATA_ROOT: "/x" },
        "win32",
      ),
    ).toBeUndefined();
  });

  it("refuses mixed-case sync and credential aliases before native preparation", () => {
    for (const key of ["folio_sync_secret", "FoLiO_CREDENTIAL_DIR"]) {
      const t=host();
      try {t.env[key]="synthetic-must-not-forward";expect(()=>prepared(t)).toThrow("canonical uppercase");expect(t.requests).toHaveLength(0);}
      finally {t.cleanup();}
    }
  });
  it("prepares a frozen child env only after native root/workspace/state proofs", () => {
    const t = host();
    try {
      Object.assign(t.env, {
        FOLIO_DATA_DIR: "/never-use", FOLIO_CREDENTIAL_DIR: "/never-use-vault",
        FOLIO_SYNC_TOKEN: "synthetic", FOLIO_EMPTY_WORKSPACE: "1",
        FOLIO_WINDOWS_OWNED_HELPER: t.exe,
        FOLIO_WINDOWS_OWNED_HELPER_SHA256: t.env.FOLIO_WINDOWS_NATIVE_SHA256,
      });
      const original = {...t.env};
      const child = prepared(t);
      expect(t.env).toEqual(original);
      expect(Object.isFrozen(child)).toBe(true);
      expect(Object.values(child).every(value => typeof value === "string")).toBe(true);
      expect(child.FOLIO_SYNC_TOKEN).toBeUndefined();
      expect(child.FOLIO_EMPTY_WORKSPACE).toBeUndefined();
      expect(child.FOLIO_WINDOWS_OWNED_HELPER).toBe(original.FOLIO_WINDOWS_OWNED_HELPER);
      expect(child.FOLIO_WINDOWS_OWNED_HELPER_SHA256).toBe(original.FOLIO_WINDOWS_OWNED_HELPER_SHA256);
      expect(child.FOLIO_WINDOWS_GUI_BATCH).toBe("1");
      expect(child.FOLIO_WINDOWS_GUI_DATA_ROOT).toBe(t.realRunRoot);
      expect(child.FOLIO_WINDOWS_NATIVE_ROOT).toBe(t.realRunRoot);
      expect(child.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES).toBe("1");
      expect(child.FOLIO_DATA_DIR).toBe(join(t.realRunRoot, "workspace"));
      expect(child.FOLIO_CREDENTIAL_DIR).toBe(
        join(t.realRunRoot, "workspace") + "-credentials",
      );
      expect(child.FOLIO_WINDOWS_NATIVE_PROBE).toBe(t.exe);
      expect(child.FOLIO_WINDOWS_NATIVE_SHA256).toBe(
        t.env.FOLIO_WINDOWS_NATIVE_SHA256,
      );
      expect(child.FOLIO_GUI_TEST_OPT_IN).toBe("1");
      const stateRoot = child.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT;
      const stateDir = child.FOLIO_WINDOWS_PUBLICATION_STATE_DIR;
      expect(dirname(stateRoot)).toBe(t.tempBase);
      expect(basename(stateRoot).startsWith("folio-windows-gui-state-")).toBe(
        true,
      );
      expect(stateDir).toBe(join(stateRoot, "state"));
      expect(stateRoot).not.toBe(t.realRunRoot);
      expect(stateRoot.startsWith(`${t.realRunRoot}/`)).toBe(false);
      expect(existsSync(stateDir)).toBe(true);
      const rootIdentity = JSON.parse(child.FOLIO_WINDOWS_GUI_ROOT_IDENTITY);
      expect(rootIdentity).toEqual({
        canonicalPath: t.realRunRoot,
        fileId: t.idOf(t.realRunRoot),
        volumeId: VOLUME,
        sid: SID,
      });
      const stateIdentity = JSON.parse(child.FOLIO_WINDOWS_GUI_STATE_IDENTITY);
      expect(stateIdentity).toEqual({
        root: {
          canonicalPath: stateRoot,
          fileId: t.idOf(stateRoot),
          volumeId: VOLUME,
          sid: SID,
        },
        directory: {
          canonicalPath: stateDir,
          fileId: t.idOf(stateDir),
          volumeId: VOLUME,
          sid: SID,
        },
      });
    } finally {
      t.cleanup();
    }
  });

  it("sends the pinned exe the exact argv and trusted helper environment", () => {
    const t = host();
    try {
      prepared(t);
      expect(t.requests.length).toBeGreaterThanOrEqual(6);
      for (const request of t.requests) {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.args)).toBe(true);
        expect(Object.isFrozen(request.env)).toBe(true);
        expect(request.command).toBe(t.exe);
        expect(request.args).toHaveLength(2);
        expect(request.cwd).toBe(SYSTEM_ROOT);
        expect(request.env).toEqual({
          SystemRoot: SYSTEM_ROOT,
          windir: SYSTEM_ROOT,
          TEMP: `${SYSTEM_ROOT}\\Temp`,
          TMP: `${SYSTEM_ROOT}\\Temp`,
        });
        expect(request.windowsHide).toBe(true);
        expect(request.shell).toBe(false);
        expect(request.stdio).toEqual(["ignore", "pipe", "pipe"]);
        expect(request.timeout).toBe(15000);
        expect(request.maxBuffer).toBe(65536);
      }
      const selfProbe = t.requests.find(
        (r) => r.args[0] === t.realRunRoot && r.args[1] === t.realRunRoot,
      );
      const workspaceProbe = t.requests.find(
        (r) =>
          r.args[0] === join(t.realRunRoot, "workspace") &&
          r.args[1] === t.realRunRoot,
      );
      expect(selfProbe).toBeDefined();
      expect(workspaceProbe).toBeDefined();
    } finally {
      t.cleanup();
    }
  });

  it("preserves exact raw captured bytes, including whitespace padding", () => {
    const t = host();
    try {
      t.setOverride((request) => ({
        status: 0,
        signal: null,
        stdout: Buffer.from(
          `\r\n  ${JSON.stringify(evidenceOf(request.args[0], request.args[1], t.idOf))}  `,
        ),
        stderr: Buffer.alloc(0),
      }));
      prepared(t);
      const files = capturedBinaries(t.realRunRoot);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const bytes = readFileSync(join(t.realRunRoot, file));
        expect(bytes.subarray(0, 4).toString()).toBe("\r\n  ");
        const pair = join(
          t.realRunRoot,
          file.replace(".stdout.bin", ".stderr.bin"),
        );
        expect(existsSync(pair)).toBe(true);
        expect(readFileSync(pair)).toHaveLength(0);
        const meta = join(
          t.realRunRoot,
          file.replace(".stdout.bin", ".json"),
        );
        expect(existsSync(meta)).toBe(true);
      }
    } finally {
      t.cleanup();
    }
  });

  it("windowsGuiDataRoot re-proves the root and returns the canonical path", () => {
    const t = host();
    try {
      const child = prepared(t);
      expect(
        windowsGuiDataRoot(child, "win32", t.seam),
      ).toBe(t.realRunRoot);
    } finally {
      t.cleanup();
    }
  });

  it("routes canonical Windows data/state/fixture paths using actual POSIX temp dirs (NOT OS PROOF)", () => {
    const t = host(true);
    try {
      const child = prepared(t);
      expect(child.FOLIO_WINDOWS_GUI_DATA_ROOT).toBe(t.runRoot);
      expect(t.runRoot).toMatch(/^C:\\FolioSyntheticTemp\\folio-owned-shutdown-[A-Za-z0-9]{6}$/);
      expect(windowsGuiDataRoot(child, "win32", t.seam)).toBe(t.runRoot);
      expect(win32.dirname(child.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT)).toBe("C:\\FolioSyntheticTemp");
      expect(child.FOLIO_WINDOWS_PUBLICATION_STATE_DIR).toBe(
        win32.join(child.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT, "state"),
      );
      expect(existsSync(t.physical(child.FOLIO_WINDOWS_PUBLICATION_STATE_DIR))).toBe(true);
      const fixture = fixtureRoot("canonical-", child, "win32", t.seam);
      expect(win32.dirname(fixture)).toBe(t.runRoot);
      const directory = win32.join(fixture, "workspace");
      mkdirSync(t.physical(directory));
      const options = fixtureElectronOptions(directory, {
        ...child, FOLIO_DATA_DIR: "D:\\NeverUse", FOLIO_CREDENTIAL_DIR: "D:\\NeverUseVault",
        FOLIO_SYNC_TOKEN: "synthetic",
      }, "win32", t.seam);
      expect(options.env.FOLIO_DATA_DIR).toBe(directory);
      expect(options.env.FOLIO_CREDENTIAL_DIR).toBe(directory + "-credentials");
      expect(options.env.FOLIO_WINDOWS_NATIVE_ROOT).toBe(t.runRoot);
      expect(options.env.FOLIO_SYNC_TOKEN).toBeUndefined();
      expect(options.args).not.toContain("--no-sandbox");
      expect(t.requests.every(request => request.args.every(path => path.startsWith("C:\\")))).toBe(true);
      const captures = capturedBinaries(t.physicalRunRoot);
      expect(captures.length).toBeGreaterThan(0);
      const sample = JSON.parse(readFileSync(join(t.physicalRunRoot, captures[0]), "utf8"));
      expect(sample.canonicalRoot).toMatch(/^C:\\FolioSyntheticTemp\\/);
    } finally {
      t.cleanup();
    }
  });

  it.each([
    "c:\\FolioSyntheticTemp\\workspace", "C:/FolioSyntheticTemp/workspace",
    "C:\\FolioSyntheticTemp\\..\\workspace", "C:\\FolioSyntheticTemp\\CON",
    "C:\\FolioSyntheticTemp\\name.", "C:\\FolioSyntheticTemp\\name ",
    "C:\\FolioSyntheticTemp\\file:ads", "C:\\FolioSyntheticTemp\\name~1",
    "C:\\FolioSyntheticTemp\\\\workspace", "\\\\server\\share\\workspace",
    "\\\\?\\C:\\FolioSyntheticTemp\\workspace", "C:\\FolioSyntheticTemp\\nonascii-\u00e9",
  ])("refuses noncanonical or unsafe Windows fixture paths on POSIX: %s", directory => {
    const t = host(true);
    try {
      const child = prepared(t);
      expect(() => fixtureElectronOptions(directory, child, "win32", t.seam)).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("refuses every malformed or partially present batch flag", () => {
    const t = host();
    try {
      const child = prepared(t);
      const generated = [
        "FOLIO_WINDOWS_GUI_BATCH",
        "FOLIO_WINDOWS_GUI_DATA_ROOT",
        "FOLIO_WINDOWS_NATIVE_ROOT",
        "FOLIO_WINDOWS_PUBLICATION_STATE_ROOT",
        "FOLIO_WINDOWS_PUBLICATION_STATE_DIR",
        "FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES",
        "FOLIO_WINDOWS_GUI_ROOT_IDENTITY",
        "FOLIO_WINDOWS_GUI_STATE_IDENTITY",
      ];
      for (const key of generated)
        for (const value of [undefined, ""])
          expect(() =>
            windowsGuiDataRoot({ ...child, [key]: value }, "win32", t.seam),
          ).toThrow();
      for (const value of ["0", "01", "true", " 1"]) {
        expect(() =>
          windowsGuiDataRoot(
            { ...child, FOLIO_WINDOWS_GUI_BATCH: value },
            "win32",
            t.seam,
          ),
        ).toThrow();
        expect(() =>
          windowsGuiDataRoot(
            { ...child, FOLIO_GUI_TEST_OPT_IN: value },
            "win32",
            t.seam,
          ),
        ).toThrow();
      }
      expect(() =>
        windowsGuiDataRoot(
          { FOLIO_WINDOWS_GUI_BATCH: "1" },
          "win32",
          t.seam,
        ),
      ).toThrow();
      expect(() => windowsGuiDataRoot(
        {folio_windows_gui_batch: "1"}, "win32", t.seam,
      )).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("refuses non-win32 claims and any production run on a non-Windows host", () => {
    const t = host();
    try {
      const child = prepared(t);
      expect(() => windowsGuiDataRoot(child, "darwin")).toThrow();
      expect(() => windowsGuiDataRoot(child, "win32")).toThrow();
      expect(() =>
        windowsGuiDataRoot(child, "linux", t.seam),
      ).toThrow();
      expect(() =>
        prepareWindowsGuiBatch({
          runRoot: t.runRoot,
          workspace: t.workspace,
          env: t.env,
        }),
      ).toThrow();
      expect(() =>
        windowsGuiDataRoot(child, "win32", { platform: "linux", exec: () => ({}) } as never),
      ).toThrow();
      expect(() =>
        windowsGuiDataRoot(child, "win32", { platform: "win32" } as never),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("requires the independently supplied probe and sha256 pins", () => {
    const t = host();
    try {
      for (const env of [
        { FOLIO_WINDOWS_NATIVE_PROBE: undefined },
        { FOLIO_WINDOWS_NATIVE_SHA256: undefined },
        { FOLIO_WINDOWS_NATIVE_SHA256: "BAD" },
        { FOLIO_WINDOWS_NATIVE_SHA256: "A".repeat(64) },
        { FOLIO_WINDOWS_NATIVE_PROBE: "probe.exe" },
        { FOLIO_WINDOWS_NATIVE_PROBE: join(t.tempBase, "probe.txt") },
      ])
        expect(() =>
          prepareWindowsGuiBatch(
            { runRoot: t.runRoot, workspace: t.workspace, env: { ...t.env, ...env } },
            t.seam,
          ),
        ).toThrow();
      const other = join(dirname(t.exe), "other.exe");
      writeFileSync(other, Buffer.from("different bytes"));
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: t.runRoot,
            workspace: t.workspace,
            env: { ...t.env, FOLIO_WINDOWS_NATIVE_PROBE: other },
          },
          t.seam,
        ),
      ).toThrow();
      const link = join(dirname(t.exe), "link.exe");
      symlinkSync(t.exe, link);
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: t.runRoot,
            workspace: t.workspace,
            env: {
              ...t.env,
              FOLIO_WINDOWS_NATIVE_PROBE: link,
              FOLIO_WINDOWS_NATIVE_SHA256: t.env.FOLIO_WINDOWS_NATIVE_SHA256,
            },
          },
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("re-hashes the pinned exe after each spawn and refuses replacement", () => {
    const t = host();
    try {
      t.setOverride((request) => {
        writeFileSync(t.exe, Buffer.from("replaced helper bytes"));
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from(
            JSON.stringify(
              evidenceOf(request.args[0], request.args[1], t.idOf),
            ),
          ),
          stderr: Buffer.alloc(0),
        };
      });
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
          t.seam,
        ),
      ).toThrow();
      expect(capturedBinaries(t.realRunRoot).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  it("refuses hardlinked helpers and byte-identical executable replacement", () => {
    const t = host();
    const linked = join(dirname(t.exe), "linked.exe");
    try {
      linkSync(t.exe, linked);
      expect(() => prepared(t)).toThrow();
      rmSync(linked);
      t.setOverride(request => {
        const replacement = join(dirname(t.exe), "replacement.exe");
        writeFileSync(replacement, readFileSync(t.exe));
        renameSync(t.exe, join(dirname(t.exe), "original.exe"));
        renameSync(replacement, t.exe);
        return {status: 0, signal: null,
          stdout: Buffer.from(JSON.stringify(evidenceOf(request.args[0], request.args[1], t.idOf))),
          stderr: Buffer.alloc(0)};
      });
      expect(() => prepared(t)).toThrow();
      expect(capturedBinaries(t.realRunRoot).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  it.each([
    ["platform", { platform: "linux" }],
    ["ownerSid", { ownerSid: "S-1-5-18" }],
    ["sid", { sid: "S-1-5-18" }],
    ["malformed sid", { sid: "S-2-1" }],
    ["malformed matching SID", {sid: "not-a-sid", ownerSid: "not-a-sid"}],
    ["SID authority overflow", {sid: "S-1-281474976710656-1", ownerSid: "S-1-281474976710656-1"}],
    ["SID subauthority overflow", {sid: "S-1-5-4294967296", ownerSid: "S-1-5-4294967296"}],
    ["SID noncanonical decimal", {sid: "S-1-05-21-100", ownerSid: "S-1-05-21-100"}],
    ["daclPrivate", { daclPrivate: false }],
    ["reparsePoint", { reparsePoint: true }],
    ["linkCount", { linkCount: 2 }],
    ["localFilesystem", { localFilesystem: false }],
    ["fileId", { fileId: "zz" }],
    ["rootFileId", { rootFileId: "00" }],
    ["volumeId", { volumeId: "xyz" }],
    ["volume mismatch", { volumeId: "ffeeddccbbaa9988" }],
    ["extra key", { extra: true }],
    ["missing key", { platform: undefined }],
  ])("refuses malformed native evidence: %s", (_label, patch) => {
    const t = host();
    try {
      t.setOverride((request) => {
        const evidence = {
          ...evidenceOf(request.args[0], request.args[1], t.idOf),
          ...(patch as Record<string, unknown>),
        };
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from(JSON.stringify(evidence)),
          stderr: Buffer.alloc(0),
        };
      });
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("refuses evidence that does not name the exact requested paths", () => {
    const t = host();
    try {
      t.setOverride((request) => ({
        status: 0,
        signal: null,
        stdout: Buffer.from(
          JSON.stringify(
            evidenceOf(
              request.args[0] + "-other",
              request.args[1],
              t.idOf,
            ),
          ),
        ),
        stderr: Buffer.alloc(0),
      }));
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("refuses a cross-source probe whose root identity differs", () => {
    const t = host();
    try {
      t.setOverride((request) => {
        const evidence = evidenceOf(
          request.args[0],
          request.args[1],
          t.idOf,
        );
        if (request.args[0] !== request.args[1])
          evidence.rootFileId = "0".repeat(32);
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from(JSON.stringify(evidence)),
          stderr: Buffer.alloc(0),
        };
      });
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("rejects bad exec results yet still preserves captured stdout/stderr", () => {
    const bad: Array<[string, unknown]> = [
      ["invalid JSON", { status: 0, signal: null, stdout: Buffer.from("{"), stderr: Buffer.alloc(0) }],
      ["invalid UTF-8", { status: 0, signal: null, stdout: Buffer.from([0xff, 0xfe, 0xfd]), stderr: Buffer.alloc(0) }],
      ["stderr", { status: 0, signal: null, stdout: Buffer.from("{}"), stderr: Buffer.from("oops") }],
      ["nonzero", { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }],
      ["signal", { status: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }],
      ["error", { status: null, signal: null, error: new Error("boom"), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }],
      ["overflow", { status: 0, signal: null, stdout: Buffer.alloc(65537, 0x41), stderr: Buffer.alloc(0) }],
      ["string stdout", { status: 0, signal: null, stdout: "{}", stderr: Buffer.alloc(0) }],
      ["null result", null],
      ["async result", Promise.resolve({ status: 0 })],
      ["missing signal", {status: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0)}],
      ["stderr overflow", {status: 0, signal: null, stdout: Buffer.from("{}"), stderr: Buffer.alloc(65537)}],
    ];
    for (const [label, result] of bad) {
      const t = host();
      try {
        t.setOverride(() => result);
        expect(() =>
          prepareWindowsGuiBatch(
            { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
            t.seam,
          ),
          label,
        ).toThrow();
        const files = capturedBinaries(t.realRunRoot);
        expect(files.length, label).toBeGreaterThan(0);
        if (
          result &&
          typeof result === "object" &&
          Buffer.isBuffer((result as { stdout?: unknown }).stdout)
        )
          expect(
            readFileSync(join(t.realRunRoot, files[0])),
            label,
          ).toEqual((result as { stdout: Buffer }).stdout);
      } finally {
        t.cleanup();
      }
    }
    const t = host();
    try {
      let accessorCalls = 0;
      t.setOverride(() => {
        const result: Record<string, unknown> = {
          status: 0,
          signal: null,
          stderr: Buffer.alloc(0),
        };
        Object.defineProperty(result, "stdout", {
          enumerable: true,
          get: () => {accessorCalls++; return Buffer.from("{}");},
        });
        return result;
      });
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: t.runRoot, workspace: t.workspace, env: t.env },
          t.seam,
        ),
      ).toThrow();
      expect(accessorCalls).toBe(0);
      expect(capturedBinaries(t.realRunRoot).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  it("preserves both exact binary streams and error details before timeout refusal", () => {
    const t = host();
    const stdout = Buffer.from([0, 255, 13, 10]);
    const stderr = Buffer.from("native-timeout\r\n");
    try {
      t.setOverride(() => ({status: null, signal: null, stdout, stderr,
        error: Object.assign(new Error("timed out"), {code: "ETIMEDOUT"})}));
      expect(() => prepared(t)).toThrow();
      const file = capturedBinaries(t.realRunRoot)[0];
      expect(readFileSync(join(t.realRunRoot, file))).toEqual(stdout);
      expect(readFileSync(join(t.realRunRoot, file.replace(".stdout.bin", ".stderr.bin")))).toEqual(stderr);
      const metadata = JSON.parse(readFileSync(join(t.realRunRoot, file.replace(".stdout.bin", ".json")), "utf8"));
      expect(metadata.result.errorCode).toBe("ETIMEDOUT");
      expect(metadata.result.errorMessage).toBe("timed out");
      expect(t.requests).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it("rejects async functions without invoking them and rejects rejected Promise ports", () => {
    const t = host();
    let called = false;
    try {
      expect(() => prepareWindowsGuiBatch({
        runRoot: t.runRoot, workspace: t.workspace, env: t.env,
      }, {platform: "win32", exec: async () => {called = true; return {};}})).toThrow();
      expect(called).toBe(false);
      t.setOverride(() => Promise.reject(new Error("synthetic async rejection")));
      expect(() => prepared(t)).toThrow();
      expect(capturedBinaries(t.realRunRoot).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  it("compares the native canonical Windows spelling exactly, not just folded containment", () => {
    const t = host(true);
    try {
      t.setOverride(request => {
        const evidence = evidenceOf(request.args[0], request.args[1], t.idOf);
        evidence.canonicalPath = evidence.canonicalPath.replace("FolioSyntheticTemp", "foliosynthetictemp");
        return {status: 0, signal: null,
          stdout: Buffer.from(JSON.stringify(evidence)), stderr: Buffer.alloc(0)};
      });
      expect(() => prepared(t)).toThrow();
      expect(capturedBinaries(t.physicalRunRoot).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  it("refuses a changed or replaced current root identity", () => {
    const t = host();
    try {
      const child = prepared(t);
      t.setId(t.realRunRoot, "f".repeat(32));
      expect(() =>
        windowsGuiDataRoot(child, "win32", t.seam),
      ).toThrow();
    } finally {
      t.cleanup();
    }
    const t2 = host();
    try {
      t2.setOverride((request) => {
        const evidence = evidenceOf(request.args[0], request.args[1], t2.idOf);
        if (
          request.args[0] === t2.realRunRoot &&
          request.args[1] === t2.realRunRoot &&
          t2.requests.filter(
            (r) => r.args[0] === t2.realRunRoot && r.args[1] === t2.realRunRoot,
          ).length > 1
        )
          evidence.fileId = "e".repeat(32);
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from(JSON.stringify(evidence)),
          stderr: Buffer.alloc(0),
        };
      });
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: t2.runRoot, workspace: t2.workspace, env: t2.env },
          t2.seam,
        ),
      ).toThrow();
      // The fresh state root created before the failed recheck is preserved,
      // never deleted.
      expect(t2.createdStateRoots().length).toBeGreaterThan(0);
    } finally {
      t2.cleanup();
    }
  });

  it("refuses malformed, missing, overlapping or changed native state config", () => {
    const t = host();
    try {
      const child = prepared(t);
      const tampered = (patch: NodeJS.ProcessEnv) => ({
        ...child,
        ...patch,
      });
      expect(() =>
        windowsGuiDataRoot(
          tampered({
            FOLIO_WINDOWS_NATIVE_ROOT:
              child.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT,
          }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      expect(() =>
        windowsGuiDataRoot(
          tampered({ FOLIO_WINDOWS_NATIVE_ROOT: t.tempBase }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      expect(() =>
        windowsGuiDataRoot(
          tampered({ FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES: "0" }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      expect(() =>
        windowsGuiDataRoot(
          tampered({
            FOLIO_WINDOWS_PUBLICATION_STATE_DIR: join(
              t.realRunRoot,
              "workspace",
            ),
          }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      const stateIdentity = JSON.parse(
        child.FOLIO_WINDOWS_GUI_STATE_IDENTITY,
      ) as { root: { fileId: string } };
      stateIdentity.root.fileId = "0".repeat(32);
      expect(() =>
        windowsGuiDataRoot(
          tampered({
            FOLIO_WINDOWS_GUI_STATE_IDENTITY: JSON.stringify(stateIdentity),
          }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      expect(() =>
        windowsGuiDataRoot(
          tampered({ FOLIO_WINDOWS_GUI_ROOT_IDENTITY: "{broken" }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      const rootIdentity = JSON.parse(
        child.FOLIO_WINDOWS_GUI_ROOT_IDENTITY,
      ) as Record<string, unknown>;
      rootIdentity.extra = true;
      expect(() =>
        windowsGuiDataRoot(
          tampered({
            FOLIO_WINDOWS_GUI_ROOT_IDENTITY: JSON.stringify(rootIdentity),
          }),
          "win32",
          t.seam,
        ),
      ).toThrow();
      const wrong = JSON.parse(child.FOLIO_WINDOWS_GUI_ROOT_IDENTITY) as {
        fileId: string;
      };
      wrong.fileId = "1".repeat(32);
      expect(() =>
        windowsGuiDataRoot(
          tampered({
            FOLIO_WINDOWS_GUI_ROOT_IDENTITY: JSON.stringify(wrong),
          }),
          "win32",
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("refuses actual root replacement while retaining original raw evidence (fake File IDs)", () => {
    const t = host();
    const retained = t.runRoot + "-retained";
    const stateRoots: string[] = [];
    try {
      const child = prepared(t);
      stateRoots.push(...t.createdStateRoots());
      const originalCaptures = capturedBinaries(t.realRunRoot);
      renameSync(t.runRoot, retained);
      mkdirSync(t.runRoot);
      mkdirSync(t.workspace);
      t.setId(t.realRunRoot, "f".repeat(32));
      expect(() => windowsGuiDataRoot(child, "win32", t.seam)).toThrow();
      expect(originalCaptures.every(name => existsSync(join(retained, name)))).toBe(true);
      expect(capturedBinaries(t.runRoot).length).toBeGreaterThan(0);
    } finally {
      for (const root of stateRoots) rmSync(root, {recursive: true, force: true});
      rmSync(retained, {recursive: true, force: true});
      t.cleanup();
    }
  });

  it.each([
    ["GITHUB_ACTIONS", "true"],
    ["CI", "true"],
    ["RUNNER_OS", "Windows"],
    ["TF_BUILD", "True"],
    ["PWDEBUG", "1"],
    ["PWTEST_WATCH", "1"],
    ["FOLIO_DEV_URL", "http://localhost:5173"],
    ["FOLIO_LOCAL_GUI_BATCH", "1"],
    ["FOLIO_LOCAL_GUI_DATA_ROOT", "/tmp/x"],
    ["FOLIO_LINUX_GUI_CI", "1"],
    ["FOLIO_GUI_CI_DATA_ROOT", "/tmp/x"],
    ["FOLIO_LOCAL_GUI_BATCH", ""],
    ["FOLIO_LINUX_GUI_CI", ""],
    ["ci", "true"],
  ])("refuses conflicting environment %s=%s", (key, value) => {
    const t = host();
    try {
      const child = prepared(t);
      expect(() =>
        windowsGuiDataRoot({ ...child, [key]: value }, "win32", t.seam),
      ).toThrow();
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: t.runRoot,
            workspace: t.workspace,
            env: { ...t.env, [key]: value },
          },
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("refuses generated flags and missing opt-in in the parent env", () => {
    const t = host();
    try {
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: t.runRoot,
            workspace: t.workspace,
            env: { ...t.env, FOLIO_GUI_TEST_OPT_IN: "0" },
          },
          t.seam,
        ),
      ).toThrow();
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: t.runRoot,
            workspace: t.workspace,
            env: { ...t.env, FOLIO_WINDOWS_GUI_BATCH: "1" },
          },
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("rejects roots that are nested, wrong-prefix, repo, missing or symlinked", () => {
    const t = host();
    const nestedParent = mkdtempSync(join(t.tempBase, "folio-nest-"));
    try {
      const nested = join(nestedParent, "folio-owned-shutdown-x");
      mkdirSync(nested);
      mkdirSync(join(nested, "workspace"));
      for (const root of [nested, process.cwd(), t.tempBase])
        expect(() =>
          prepareWindowsGuiBatch(
            {
              runRoot: root,
              workspace: join(root, "workspace"),
              env: t.env,
            },
            t.seam,
          ),
        ).toThrow();
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: join(t.tempBase, "folio-owned-shutdown-missing"),
            workspace: join(
              t.tempBase,
              "folio-owned-shutdown-missing",
              "workspace",
            ),
            env: t.env,
          },
          t.seam,
        ),
      ).toThrow();
      const link = t.runRoot + "-link";
      symlinkSync(t.runRoot, link);
      expect(() =>
        prepareWindowsGuiBatch(
          { runRoot: link, workspace: join(link, "workspace"), env: t.env },
          t.seam,
        ),
      ).toThrow();
      expect(() =>
        prepareWindowsGuiBatch(
          {
            runRoot: t.runRoot,
            workspace: join(t.runRoot, "elsewhere"),
            env: t.env,
          },
          t.seam,
        ),
      ).toThrow();
    } finally {
      rmSync(nestedParent, { recursive: true, force: true });
      rmSync(t.runRoot + "-link", { force: true });
      t.cleanup();
    }
  });

  it("assertWindowsGuiChild refuses non-descendants and bad credential siblings", () => {
    const t = host();
    const outside = mkdtempSync(join(t.tempBase, "folio-outside-"));
    try {
      const child = prepared(t);
      const dataRoot = windowsGuiDataRoot(child, "win32", t.seam)!;
      expect(assertWindowsGuiChild(t.workspace, dataRoot, child, t.seam)).toBe(
        join(t.realRunRoot, "workspace"),
      );
      expect(() =>
        assertWindowsGuiChild(dataRoot, dataRoot, child, t.seam),
      ).toThrow();
      expect(() =>
        assertWindowsGuiChild(outside, dataRoot, child, t.seam),
      ).toThrow();
      expect(() =>
        assertWindowsGuiChild(
          t.workspace,
          join(t.realRunRoot, "workspace"),
          child,
          t.seam,
        ),
      ).toThrow();
      mkdirSync(`${t.workspace}-credentials`);
      expect(
        assertWindowsGuiChild(t.workspace, dataRoot, child, t.seam),
      ).toBe(join(t.realRunRoot, "workspace"));
      rmSync(`${t.workspace}-credentials`, { recursive: true, force: true });
      writeFileSync(`${t.workspace}-credentials`, Buffer.from("x"));
      expect(() =>
        assertWindowsGuiChild(t.workspace, dataRoot, child, t.seam),
      ).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
      t.cleanup();
    }
  });

  it("fixtureRoot creates fixture roots below the verified base", () => {
    const t = host();
    try {
      const child = prepared(t);
      const first = fixtureRoot("fixture-", child, "win32", t.seam);
      const second = fixtureRoot("fixture-", child, "win32", t.seam);
      expect(first).not.toBe(second);
      expect(dirname(first)).toBe(t.realRunRoot);
      expect(basename(first).startsWith("fixture-")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it("refuses escaping directory aliases and preexisting credential symlinks", () => {
    const t = host();
    const outside = mkdtempSync(join(t.tempBase, "folio-credential-outside-"));
    try {
      const child = prepared(t);
      const alias = join(t.runRoot, "alias");
      symlinkSync(outside, alias);
      expect(() => fixtureElectronOptions(alias, child, "win32", t.seam)).toThrow();
      symlinkSync(outside, t.workspace + "-credentials");
      expect(() => fixtureElectronOptions(t.workspace, child, "win32", t.seam)).toThrow();
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, {recursive: true, force: true});
      t.cleanup();
    }
  });

  it("fixtureElectronOptions routes data inside the root and strips settings", () => {
    const t = host();
    try {
      const child = prepared(t);
      const options = fixtureElectronOptions(
        t.workspace,
        {
          ...child,
          FOLIO_SYNC_TOKEN: "synthetic",
          FOLIO_DATA_DIR: "/original",
          FOLIO_CREDENTIAL_DIR: "/original-vault",
          FOLIO_EMPTY_WORKSPACE: "1",
          FOLIO_TEST_FORCE_READY_FAILURE: "1",
        },
        "win32",
        t.seam,
      );
      expect(options.env.FOLIO_DATA_DIR).toBe(
        join(t.realRunRoot, "workspace"),
      );
      expect(options.env.FOLIO_CREDENTIAL_DIR).toBe(
        join(t.realRunRoot, "workspace") + "-credentials",
      );
      expect(options.env.FOLIO_SYNC_TOKEN).toBeUndefined();
      expect(options.env.FOLIO_EMPTY_WORKSPACE).toBeUndefined();
      expect(options.env.FOLIO_TEST_FORCE_READY_FAILURE).toBeUndefined();
      expect(options.env.FOLIO_WINDOWS_NATIVE_PROBE).toBe(t.exe);
      expect(options.args).not.toContain("--no-sandbox");
      expect(options.args[options.args.length - 1]).toContain("main.cjs");
      expect(() =>
        fixtureElectronOptions(
          t.tempBase,
          child,
          "win32",
          t.seam,
        ),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("leaves ordinary Darwin/Linux routes untouched when flags are absent", () => {
    const t = host();
    try {
      const localEnv: NodeJS.ProcessEnv = {
        FOLIO_GUI_TEST_OPT_IN: "1",
        FOLIO_LOCAL_GUI_BATCH: "1",
        FOLIO_LOCAL_GUI_DATA_ROOT: t.runRoot,
      };
      // The Windows route never engages: the private 0700 mkdtemp root still
      // serves the existing local Mac batch contract unchanged.
      expect(windowsGuiDataRoot(localEnv, "darwin")).toBeUndefined();
      const options = fixtureElectronOptions(t.workspace, localEnv, "darwin");
      expect(options.env.FOLIO_DATA_DIR).toBe(t.workspace);
      expect(options.env.FOLIO_CREDENTIAL_DIR).toBe(
        t.workspace + "-credentials",
      );
      expect(options.args).not.toContain("--no-sandbox");
      expect(
        lstatSync(t.workspace).isDirectory(),
      ).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
