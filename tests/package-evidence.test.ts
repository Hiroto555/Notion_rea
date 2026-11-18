import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore - untyped ESM orchestration; all executable/archiver seams are mocked.
import * as packaging from "../scripts/platform/package-evidence.mjs";
// @ts-ignore - import-safe CLI, never executes packaging on import.
import * as entry from "../scripts/package.mjs";
// @ts-ignore - import-safe artifact-only CLI; GUI remains explicitly gated.
import * as verifier from "../scripts/verify-package.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const marker = Buffer.from("8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae", "hex");
type Arch = "x64" | "arm64";
type Role = "probe" | "owned";
const names = { probe: "PrivateRootProbe", owned: "OwnedNodeJob" };

// Synthetic PE and .NET v6 bundle. It is data only, never launched.
function helperBytes(arch: Arch, role: Role, omit = "", version = "10.0.0") {
  const name = names[role];
  const runtime = Buffer.from(JSON.stringify({
    runtimeOptions: { tfm: "net10.0", framework: { name: "Microsoft.NETCore.App", version } },
  }));
  const definitions = [
    { name: `${name}.dll`, type: 1, bytes: Buffer.from("MZmock-managed-assembly") },
    { name: `${name}.deps.json`, type: 3, bytes: Buffer.from('{"runtimeTarget":{}}') },
    { name: `${name}.runtimeconfig.json`, type: 4, bytes: runtime },
  ].filter(item => item.name !== omit);
  let position = 512;
  const entries = definitions.map(item => {
    const entry = { ...item, offset: position }; position += item.bytes.length; return entry;
  });
  const headerOffset = position + 16, bytes = Buffer.alloc(headerOffset + 1024);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 68);
  bytes.writeBigUInt64LE(BigInt(headerOffset), 120); marker.copy(bytes, 128);
  for (const item of entries) item.bytes.copy(bytes, item.offset);
  let cursor = headerOffset;
  const u32 = (n: number) => { bytes.writeUInt32LE(n, cursor); cursor += 4; };
  const u64 = (n: number) => { bytes.writeBigUInt64LE(BigInt(n), cursor); cursor += 8; };
  const string = (s: string) => {
    const value = Buffer.from(s); expect(value.length).toBeLessThan(128);
    bytes[cursor++] = value.length; value.copy(bytes, cursor); cursor += value.length;
  };
  u32(6); u32(0); u32(entries.length); string("mock-bundle-id");
  for (const suffix of ["deps.json", "runtimeconfig.json"]) {
    const item = entries.find(entry => entry.name === `${name}.${suffix}`);
    u64(item?.offset ?? 0); u64(item?.bytes.length ?? 0);
  }
  u64(0);
  for (const item of entries) {
    u64(item.offset); u64(item.bytes.length); u64(0); bytes[cursor++] = item.type; string(item.name);
  }
  return bytes.subarray(0, cursor);
}

function put(path: string, bytes: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
}

function fixture(platform = "darwin", arch = "arm64") {
  const root = mkdtempSync(join(tmpdir(), "folio-package-evidence-")); roots.push(root);
  put(join(root, "package.json"), JSON.stringify({
    name: "folio-desktop", productName: "Folio", version: "0.1.0",
    devDependencies: { electron: "45.0.0" },
  }));
  for (const path of ["package-lock.json", "docs/THIRD_PARTY_NOTICES.txt",
    "scripts/package.mjs", "scripts/verify-package.mjs", "scripts/platform/package-target.mjs",
    "scripts/platform/package-evidence.mjs", "scripts/build.mjs",
    "scripts/platform/windows/probe-source.cs", "src/main/index.ts", "dist/main.cjs", "dist/preload.cjs"])
    put(join(root, path), `mock ${path}`);
  const windowsHelpers: Record<string, { path: string; sha256: string }> = {};
  if (platform === "win32") for (const role of ["probe", "owned"] as const) {
    const bytes = helperBytes(arch as Arch, role), path = join(root, "trusted", role, names[role] + ".exe");
    put(path, bytes); windowsHelpers[role] = { path, sha256: hash(bytes) };
  }
  const input = { root, platform, arch,
    ...(platform === "win32" ? { windowsHelpers } : {}) };
  const outputDir = join(root, "release", `Folio-${platform}-${arch}`);
  const resources = platform === "darwin" ? join(outputDir, "Folio.app/Contents/Resources")
    : join(outputDir, "resources");
  const executable = platform === "darwin" ? join(outputDir, "Folio.app/Contents/MacOS/Folio")
    : join(outputDir, "Folio.exe");
  const packager = vi.fn(async (options: { extraResource?: string[] }) => {
    put(join(resources, "app.asar"), "mock asar"); put(executable, "mock executable");
    for (const path of options.extraResource ?? []) cpSync(path, join(resources, basename(path)));
    return [outputDir];
  });
  const archive = vi.fn(async (plan: { artifactPath: string }) => {
    // Minimal stored-entry ZIP (a mock archive, not evidence of Electron build).
    const name = Buffer.from("fixture"), data = Buffer.from("mock");
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    writeFileSync(plan.artifactPath, Buffer.concat([local, name, data, central, name, end]), { flag: "wx" });
  });
  return { input, root, outputDir, resources, executable, windowsHelpers, packager, archive };
}

describe("selected package production orchestration (mock executors only)", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"], ["win32", "arm64"]]) {
    it(`${platform}-${arch}: exact invocation, zip/manifest writer and artifact consumer`, async () => {
      const f = fixture(platform, arch);
      const manifest = await packaging.runPackage(f.input, f);
      const options = f.packager.mock.calls[0][0] as Record<string, unknown>;
      expect(options).toEqual(manifest.invocation.packagerOptions);
      expect(options.prune).toBe(true); expect(options.electronVersion).toBe("45.0.0");
      expect(options.platform).toBe(platform); expect(options.arch).toBe(arch);
      expect(manifest.plan.artifactPath).toBe(join(f.root, "release", `Folio-0.1.0-${platform}-${arch}.zip`));
      expect(manifest.plan.manifestPath).toBe(join(f.root, "release",
        `Folio-0.1.0-${platform}-${arch}.manifest.json`));
      expect(existsSync(manifest.plan.artifactPath)).toBe(true);
      expect(packaging.verifyPackageArtifacts(f.input)).toEqual(manifest);
      expect(manifest.evidence).toMatchObject({ artifactBuilt: true, osExecuted: false, signed: false });
      if (platform === "win32") {
        expect(options.win32metadata).toEqual({ CompanyName: "Folio" });
        expect(options.extraResource).toEqual([f.windowsHelpers.probe.path, f.windowsHelpers.owned.path]);
        expect(manifest.prerequisites).toEqual([
          { name: "Microsoft.NETCore.App", major: 10, arch, bundled: false },
        ]);
        expect(manifest.nativeHelpers).toHaveLength(2);
        expect(manifest.nativeHelpers[0]).toMatchObject({
          arch, sha256: f.windowsHelpers.probe.sha256, resource: "resources/PrivateRootProbe.exe",
          assemblySha256: hash("MZmock-managed-assembly"),
        });
        expect(() => packaging.verifyPackageArtifacts({ ...f.input, windowsHelpers: undefined }))
          .toThrow("PACKAGE_HELPER_PIN_REQUIRED");
      } else expect(options.extraResource).toBeUndefined();
    });
  }

  it("rejects missing configuration and unsupported selection before packager invocation", async () => {
    const f = fixture("win32", "x64");
    await expect(packaging.runPackage({ ...f.input, windowsHelpers: undefined }, f))
      .rejects.toThrow("PACKAGE_HELPER_PIN_REQUIRED");
    await expect(packaging.runPackage({ ...f.input, platform: "linux" }, f)).rejects.toThrow();
    expect(f.packager).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  });

  it("passes the selected Windows icon through the real invocation and consumer", async () => {
    const f = fixture("win32", "x64"), icon = join(f.root, "assets/icon.ico");
    put(icon, "mock Windows icon");
    const manifest = await packaging.runPackage(f.input, f);
    expect((f.packager.mock.calls[0][0] as Record<string, unknown>).icon).toBe(icon);
    expect(manifest.invocation.packagerOptions.icon).toBe(icon);
    expect(packaging.verifyPackageArtifacts(f.input)).toEqual(manifest);
  });

  it("binds more than 256 source records without weakening the evidence hash-array bound", async () => {
    const f = fixture();
    for (let i = 0; i < 260; i++) put(join(f.root, "src", `source-${i}.ts`), `source ${i}`);
    put(join(f.root, "src/empty.ts"), "");
    const manifest = await packaging.runPackage(f.input, f);
    expect(manifest.source.length).toBeGreaterThan(256);
    expect(manifest.evidence.sourceHashes).toHaveLength(1);
    expect(packaging.verifyPackageArtifacts(f.input)).toEqual(manifest);
  });

  it("retains prior artifacts and refuses output collisions without repackaging", async () => {
    const f = fixture(), manifest = await packaging.runPackage(f.input, f);
    const before = readFileSync(manifest.plan.manifestPath);
    await expect(packaging.runPackage(f.input, f)).rejects.toThrow("PACKAGE_OUTPUT_EXISTS");
    expect(readFileSync(manifest.plan.manifestPath)).toEqual(before);
    expect(f.packager).toHaveBeenCalledTimes(1);
  });

  it("retains produced files on archiver failure and never publishes a manifest", async () => {
    const f = fixture();
    await expect(packaging.runPackage(f.input, {
      packager: f.packager, archive: () => { throw new Error("ARCHIVE_FAIL"); },
    })).rejects.toThrow("ARCHIVE_FAIL");
    expect(existsSync(f.executable)).toBe(true);
    expect(existsSync(join(f.root, "release/Folio-0.1.0-darwin-arm64.manifest.json"))).toBe(false);
  });

  it("rejects wrong returned output directory", async () => {
    const f = fixture();
    await expect(packaging.runPackage(f.input, { ...f, packager: async () => ["/wrong/output"] }))
      .rejects.toThrow("PACKAGE_RESULT_MISMATCH");
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("rejects source changes during packaging before archive construction", async () => {
    const f = fixture();
    const packager = async (options: unknown) => {
      const result = await f.packager(options as never);
      put(join(f.root, "dist/main.cjs"), "changed"); return result;
    };
    await expect(packaging.runPackage(f.input, { ...f, packager }))
      .rejects.toThrow("PACKAGE_SOURCE_CHANGED");
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("rejects copied helper corruption before archiving", async () => {
    const f = fixture("win32", "arm64");
    const packager = async (options: unknown) => {
      const result = await f.packager(options as never);
      put(join(f.resources, "PrivateRootProbe.exe"), "not the pinned helper"); return result;
    };
    await expect(packaging.runPackage(f.input, { ...f, packager })).rejects.toThrow("PACKAGE_HELPER_HASH");
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("rejects invalid archive bytes rather than asserting a built artifact", async () => {
    const f = fixture();
    await expect(packaging.runPackage(f.input, {
      packager: f.packager, archive: (plan: { artifactPath: string }) => put(plan.artifactPath, "not zip"),
    })).rejects.toThrow("PACKAGE_ZIP_INVALID");
  });

  it("rejects a missing archive or a ZIP signature without a central directory", async () => {
    for (const writePrefix of [false, true]) {
      const f = fixture();
      await expect(packaging.runPackage(f.input, {
        packager: f.packager, archive: (plan: { artifactPath: string }) => {
          if (writePrefix) put(plan.artifactPath, Buffer.from([0x50, 0x4b, 3, 4, 0]));
        },
      })).rejects.toThrow();
    }
  });
});

describe("pinned helper bytes, not native execution", () => {
  for (const arch of ["x64", "arm64"] as const) {
    it(`accepts both embedded ${arch} helper roles`, () => {
      const f = fixture("win32", arch);
      for (const role of ["probe", "owned"] as const) {
        const pin = f.windowsHelpers[role];
        expect(packaging.inspectWindowsHelper(pin.path, pin.sha256, arch, role))
          .toMatchObject({ role, arch, sha256: pin.sha256,
            peMachine: arch === "x64" ? 0x8664 : 0xaa64,
            runtime: { name: "Microsoft.NETCore.App", version: "10.0.0", bundled: false } });
      }
    });
  }

  it("requires a trusted expected hash and the actual selected machine", () => {
    const f = fixture("win32", "x64"), pin = f.windowsHelpers.probe;
    expect(() => packaging.inspectWindowsHelper(pin.path, undefined, "x64", "probe"))
      .toThrow("PACKAGE_HELPER_PIN_REQUIRED");
    expect(() => packaging.inspectWindowsHelper(pin.path, "a".repeat(64), "x64", "probe"))
      .toThrow("PACKAGE_HELPER_HASH");
    expect(() => packaging.inspectWindowsHelper(pin.path, pin.sha256, "arm64", "probe"))
      .toThrow("PACKAGE_HELPER_ARCH");
  });

  it("rejects source, bare PE, missing app/deps/config, wrong runtime and malformed bundle offset", () => {
    const f = fixture("win32", "x64"), path = f.windowsHelpers.probe.path;
    const bare = Buffer.alloc(256);
    bare.write("MZ"); bare.writeUInt32LE(64, 0x3c); bare.write("PE\0\0", 64);
    bare.writeUInt16LE(0x8664, 68);
    const malformed = helperBytes("x64", "probe");
    malformed.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 120);
    for (const bytes of [Buffer.from("C# source is not a binary"), bare, malformed,
      helperBytes("x64", "probe", "PrivateRootProbe.dll"),
      helperBytes("x64", "probe", "PrivateRootProbe.deps.json"),
      helperBytes("x64", "probe", "PrivateRootProbe.runtimeconfig.json"),
      helperBytes("x64", "probe", "", "9.0.0")]) {
      put(path, bytes);
      expect(() => packaging.inspectWindowsHelper(path, hash(bytes), "x64", "probe")).toThrow();
    }
  });

  it("rejects mutable companion DLL even when EXE hash is correct", () => {
    const f = fixture("win32", "x64"), pin = f.windowsHelpers.probe;
    put(join(dirname(pin.path), "PrivateRootProbe.dll"), "mutable companion");
    expect(() => packaging.inspectWindowsHelper(pin.path, pin.sha256, "x64", "probe"))
      .toThrow("PACKAGE_HELPER_NOT_SINGLE_FILE");
  });
});

describe("artifact verification refuses stale/contradictory evidence", () => {
  for (const kind of ["source", "version", "archive", "built", "prerequisite"]) {
    it(`rejects stale ${kind} without rewriting the manifest`, async () => {
      const f = fixture(), manifest = await packaging.runPackage(f.input, f);
      if (kind === "source") put(join(f.root, "dist/preload.cjs"), "changed current build");
      if (kind === "version") {
        const pkgPath = join(f.root, "package.json"), pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        pkg.version = "0.2.0"; put(pkgPath, JSON.stringify(pkg));
      }
      if (kind === "archive") {
        const zip = readFileSync(manifest.plan.artifactPath);
        zip[zip.length - 1] ^= 1; writeFileSync(manifest.plan.artifactPath, zip);
      }
      if (kind === "built") put(f.executable, "changed packaged executable");
      if (kind === "prerequisite") manifest.prerequisites = [{ bundled: true }];
      if (kind === "prerequisite") writeFileSync(manifest.plan.manifestPath, JSON.stringify(manifest));
      const before = readFileSync(manifest.plan.manifestPath);
      expect(() => packaging.verifyPackageArtifacts(f.input)).toThrow();
      expect(readFileSync(manifest.plan.manifestPath)).toEqual(before);
    });
  }

  it("rejects manifest plan, packager option, invocation hash and unsupported execution claims", async () => {
    const f = fixture(), original = await packaging.runPackage(f.input, f);
    for (const change of [
      (m: any) => { m.plan.arch = "x64"; },
      (m: any) => { m.invocation.packagerOptions.prune = false; },
      (m: any) => { m.invocation.packagerOptions.electronVersion = "44.0.0"; },
      (m: any) => { m.invocation.deterministicBase = "a".repeat(64); },
      (m: any) => { m.evidence.osExecuted = true; },
      (m: any) => { m.evidence.signed = true; },
    ]) {
      const altered = JSON.parse(JSON.stringify(original)); change(altered);
      const text = JSON.stringify(altered); writeFileSync(original.plan.manifestPath, text);
      expect(() => packaging.verifyPackageArtifacts(f.input)).toThrow();
      expect(readFileSync(original.plan.manifestPath, "utf8")).toBe(text);
    }
  });

  it("rejects trusted helper mutation during archive without a manifest", async () => {
    const f = fixture("win32", "x64");
    const archive = async (plan: { artifactPath: string }) => {
      await f.archive(plan); put(f.windowsHelpers.probe.path, "helper replaced");
    };
    await expect(packaging.runPackage(f.input, { ...f, archive })).rejects.toThrow("PACKAGE_HELPER_HASH");
    expect(existsSync(join(f.root, "release/Folio-0.1.0-win32-x64.zip"))).toBe(true);
    expect(existsSync(join(f.root, "release/Folio-0.1.0-win32-x64.manifest.json"))).toBe(false);
  });
});

describe("CLI and GUI separation", () => {
  it("imports safe production entrypoints and rejects duplicate/incomplete CLI flags", () => {
    expect(entry.runPackage).toBe(packaging.runPackage);
    expect(verifier.verifyPackageArtifacts).toBe(packaging.verifyPackageArtifacts);
    expect(entry.parsePackageArgs([])).toMatchObject({ platform: "darwin", arch: "arm64" });
    for (const args of [["--platform"], ["--arch", "x64", "--arch", "arm64"],
      ["--unknown", "x"], ["--native-probe", "/trusted/helper.exe"]])
      expect(() => entry.parsePackageArgs(args)).toThrow();
    expect(() => verifier.main(["--gui"])).toThrow("GUI_REFUSED");
  });

  it("has no GUI launch without exact explicit batch authorization", async () => {
    const launch = vi.fn();
    for (const args of [{}, { batch: true, env: {} }, { batch: false, env: { FOLIO_GUI_TEST_OPT_IN: "1" } },
      { batch: true, env: { FOLIO_GUI_TEST_OPT_IN: "true" } }])
      await expect(verifier.runPackagedGuiSmoke(args, { launch })).rejects.toThrow("GUI_REFUSED");
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!((process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "win32" && ["x64", "arm64"].includes(process.arch))))(
    "retains save/restart smoke behind the batch gate using mocked pages, never Electron", async () => {
      const f = fixture(process.platform, process.arch);
      await packaging.runPackage(f.input, f);
      let title = "";
      const locator = {
        fill: vi.fn(async (value: string) => { title = value; }),
        inputValue: vi.fn(async () => title),
        filter: () => ({ waitFor: async () => {} }),
      };
      const page = { waitForSelector: async () => {}, locator: () => locator };
      const close = vi.fn(async () => {});
      const launch = vi.fn(async (options: { env: { FOLIO_DATA_DIR: string } }) => {
        expect(options.env.FOLIO_DATA_DIR.startsWith(join(f.root, "output/package-smoke-"))).toBe(true);
        return { firstWindow: async () => page, close };
      });
      const observation = await verifier.runPackagedGuiSmoke({
        selection: f.input, batch: true, env: { FOLIO_GUI_TEST_OPT_IN: "1", FOLIO_DATA_DIR: "/never-use" },
      }, { launch });
      expect(observation.persistence).toBe(true); expect(observation.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(launch).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(2);
    },
  );
});

const actualRoot = process.env.FOLIO_WINDOWS_HELPER_BUILD_ROOT;
const actualArch = process.env.FOLIO_WINDOWS_HELPER_BUILD_RUNTIME === "win-arm64" ? "arm64" : "x64";
const actualPins = {
  probe: process.env.FOLIO_WINDOWS_PACKAGE_PROBE_SHA256,
  owned: process.env.FOLIO_WINDOWS_PACKAGE_OWNED_SHA256,
};
describe.skipIf(!actualRoot || !actualPins.probe || !actualPins.owned)(
  "parent-selected actual helper PE/bundle evidence (never execution)", () => {
    for (const role of ["probe", "owned"] as const) it(role, () => {
      const path = join(actualRoot!, role, names[role] + ".exe");
      expect(packaging.inspectWindowsHelper(path, actualPins[role], actualArch, role))
        .toMatchObject({ arch: actualArch, sha256: actualPins[role] });
    });
  },
);
