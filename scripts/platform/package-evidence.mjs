import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { planPackage, validateArtifactEvidence } from "./package-target.mjs";

const SCHEMA = "folio.package-artifact.v1";
const HASH = /^[a-f0-9]{64}$/;
const MAX_HELPER = 128 * 1024 * 1024;
const BUNDLE_MARKER = Buffer.from(
  "8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae", "hex",
);
const HELPER_NAMES = { probe: "PrivateRootProbe", owned: "OwnedNodeJob" };

function fail(code) { throw new Error(code); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function equal(a, b, code) { if (canonical(a) !== canonical(b)) fail(code); }
function absolute(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") ||
      resolve(path) !== path) fail("PACKAGE_ABSOLUTE_PATH_REQUIRED");
  return path;
}
function regular(path, max = Number.MAX_SAFE_INTEGER, allowEmpty = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < (allowEmpty ? 0 : 1) || stat.size > max)
    fail("PACKAGE_FILE_INVALID");
  return stat;
}
function boundedBytes(path, max) {
  regular(path, max);
  const bytes = readFileSync(path);
  if (bytes.length > max) fail("PACKAGE_FILE_TOO_LARGE");
  return bytes;
}
function json(path, max = 4 * 1024 * 1024) {
  return JSON.parse(boundedBytes(path, max).toString("utf8"));
}
function fileHash(path, allowEmpty = false) {
  regular(path, Number.MAX_SAFE_INTEGER, allowEmpty);
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) fail("PACKAGE_FILE_INVALID");
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) break;
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail("PACKAGE_PATH_OUTSIDE_ROOT");
  return rel.split(sep).join("/");
}

// Read the pinned .NET single-file apphost, never execute it. App assemblies
// cannot be supplied by a mutable sibling DLL outside the hashed EXE.
export function inspectWindowsHelper(path, expectedHash, arch, role, checkDirectory = true) {
  absolute(path);
  const name = HELPER_NAMES[role];
  if (!name || basename(path) !== `${name}.exe` || !HASH.test(expectedHash ?? ""))
    fail("PACKAGE_HELPER_PIN_REQUIRED");
  if (!["x64", "arm64"].includes(arch)) fail("PACKAGE_HELPER_ARCH");
  if (checkDirectory &&
      readdirSync(dirname(path)).some(entry => entry !== `${name}.exe`))
    fail("PACKAGE_HELPER_NOT_SINGLE_FILE");
  const bytes = boundedBytes(path, MAX_HELPER);
  if (digest(bytes) !== expectedHash) fail("PACKAGE_HELPER_HASH");
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ")
    fail("PACKAGE_HELPER_PE");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 > bytes.length ||
      !bytes.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0])))
    fail("PACKAGE_HELPER_PE");
  const machine = bytes.readUInt16LE(pe + 4);
  if (machine !== (arch === "x64" ? 0x8664 : 0xaa64)) fail("PACKAGE_HELPER_ARCH");
  const marker = bytes.indexOf(BUNDLE_MARKER);
  if (marker < 8 || bytes.indexOf(BUNDLE_MARKER, marker + 1) !== -1)
    fail("PACKAGE_HELPER_BUNDLE");
  let cursor = 0;
  const safe64 = offset => {
    if (offset < 0 || offset + 8 > bytes.length) fail("PACKAGE_HELPER_BUNDLE");
    const value = Number(bytes.readBigUInt64LE(offset));
    if (!Number.isSafeInteger(value)) fail("PACKAGE_HELPER_BUNDLE");
    return value;
  };
  const header = safe64(marker - 8);
  if (header <= marker || header + 12 > bytes.length) fail("PACKAGE_HELPER_BUNDLE");
  cursor = header;
  const u32 = () => {
    if (cursor + 4 > bytes.length) fail("PACKAGE_HELPER_BUNDLE");
    const value = bytes.readUInt32LE(cursor); cursor += 4; return value;
  };
  const u64 = () => { const value = safe64(cursor); cursor += 8; return value; };
  const string = () => {
    let length = 0, shift = 0;
    for (let count = 0; count < 5; count++) {
      if (cursor >= bytes.length) fail("PACKAGE_HELPER_BUNDLE");
      const part = bytes[cursor++]; length += (part & 0x7f) * 2 ** shift;
      if (!(part & 0x80)) {
        if (length < 1 || length > 65_536 || cursor + length > bytes.length)
          fail("PACKAGE_HELPER_BUNDLE");
        const result = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes.subarray(cursor, cursor + length));
        cursor += length; return result;
      }
      shift += 7;
    }
    fail("PACKAGE_HELPER_BUNDLE");
  };
  if (u32() !== 6 || u32() !== 0) fail("PACKAGE_HELPER_BUNDLE");
  const count = u32();
  if (count < 3 || count > 255) fail("PACKAGE_HELPER_BUNDLE");
  string();
  const depsOffset = u64(), depsSize = u64(), configOffset = u64(), configSize = u64();
  if (u64() !== 0) fail("PACKAGE_HELPER_EXTRACTION");
  const entries = new Map(), ranges = [];
  for (let i = 0; i < count; i++) {
    const offset = u64(), size = u64(), compressedSize = u64();
    if (cursor >= bytes.length) fail("PACKAGE_HELPER_BUNDLE");
    const type = bytes[cursor++], entryPath = string();
    if (compressedSize !== 0 || offset < 1 || size < 1 || offset + size > header ||
        !/^[A-Za-z0-9_.-]+$/.test(entryPath) || entryPath === "." ||
        entryPath === ".." || entries.has(entryPath) ||
        ranges.some(([a, b]) => offset < b && offset + size > a))
      fail("PACKAGE_HELPER_BUNDLE");
    ranges.push([offset, offset + size]);
    entries.set(entryPath, { offset, size, type });
  }
  const app = entries.get(`${name}.dll`), deps = entries.get(`${name}.deps.json`);
  const config = entries.get(`${name}.runtimeconfig.json`);
  if (!app || app.type !== 1 || !deps || deps.type !== 3 || !config || config.type !== 4 ||
      deps.offset !== depsOffset || deps.size !== depsSize ||
      config.offset !== configOffset || config.size !== configSize || config.size > 65_536)
    fail("PACKAGE_HELPER_EMBEDDED_FILES");
  const runtime = JSON.parse(bytes.toString("utf8", config.offset, config.offset + config.size));
  const options = runtime.runtimeOptions;
  const framework = options?.framework;
  if (options?.tfm !== "net10.0" || framework?.name !== "Microsoft.NETCore.App" ||
      !/^10\.\d+\.\d+$/.test(framework.version) || options.frameworks !== undefined ||
      options.includedFrameworks !== undefined)
    fail("PACKAGE_HELPER_RUNTIME");
  const assembly = bytes.subarray(app.offset, app.offset + app.size);
  if (assembly.length < 2 || assembly.toString("ascii", 0, 2) !== "MZ")
    fail("PACKAGE_HELPER_EMBEDDED_FILES");
  return Object.freeze({
    role, path, sha256: expectedHash, arch, peMachine: machine,
    assemblySha256: digest(assembly),
    runtime: Object.freeze({ name: framework.name, version: framework.version, bundled: false }),
  });
}

export function createPackageInvocation({ plan, stage, electronVersion, cacheRoot, helpers = [] }) {
  absolute(stage); absolute(cacheRoot);
  equal(plan, planPackage({ platform: plan.platform, arch: plan.arch, version: plan.appVersion,
    outputRoot: plan.outputRoot, icon: plan.packagerOptions?.icon }), "PACKAGE_STALE_PLAN");
  if (typeof electronVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(electronVersion))
    fail("PACKAGE_ELECTRON_VERSION");
  const expected = plan.platform === "win32" ? ["probe", "owned"] : [];
  if (helpers.length !== expected.length ||
      helpers.some((helper, i) => helper.role !== expected[i] || helper.arch !== plan.arch ||
        !HASH.test(helper.sha256 ?? "") || !HASH.test(helper.assemblySha256 ?? "")))
    fail("PACKAGE_HELPER_PIN_REQUIRED");
  helpers.forEach(helper => absolute(helper.path));
  const packagerOptions = Object.freeze({
    ...plan.packagerOptions, dir: stage, electronVersion, tmpdir: `${stage}-packager`,
    download: Object.freeze({ cacheRoot }),
    ...(plan.platform === "darwin" ? {
      appBundleId: "local.folio.desktop", appCategoryType: "public.app-category.productivity",
    } : {
      win32metadata: Object.freeze({ CompanyName: "Folio" }),
      extraResource: Object.freeze(helpers.map(helper => helper.path)),
    }),
  });
  return Object.freeze({
    packagerOptions,
    deterministicBase: digest(canonical({ plan: plan.deterministicBase, packagerOptions, helpers })),
  });
}

export function parsePackageArgs(args) {
  const values = { platform: "darwin", arch: "arm64" }, seen = new Set();
  const allowed = new Set(["platform", "arch", "icon", "native-probe",
    "native-probe-sha256", "owned-helper", "owned-helper-sha256"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith("--") ? args[i].slice(2) : "";
    if (!allowed.has(key) || seen.has(key) || !args[i + 1] || args[i + 1].startsWith("--"))
      fail("PACKAGE_ARGUMENTS");
    values[key] = args[i + 1]; seen.add(key);
  }
  const pins = ["native-probe", "native-probe-sha256", "owned-helper", "owned-helper-sha256"];
  if (pins.some(key => seen.has(key))) {
    if (!pins.every(key => seen.has(key))) fail("PACKAGE_HELPER_PIN_REQUIRED");
    values.windowsHelpers = {
      probe: { path: values["native-probe"], sha256: values["native-probe-sha256"] },
      owned: { path: values["owned-helper"], sha256: values["owned-helper-sha256"] },
    };
  }
  return { platform: values.platform, arch: values.arch, icon: values.icon,
    windowsHelpers: values.windowsHelpers };
}

function sourceInventory(root, icon) {
  const files = [];
  const walk = path => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      regular(path, Number.MAX_SAFE_INTEGER, true);
      files.push({ path: inside(root, path), sha256: fileHash(path, true) });
    }
  };
  for (const path of ["package.json", "package-lock.json", "docs/THIRD_PARTY_NOTICES.txt",
    "scripts/package.mjs", "scripts/verify-package.mjs", "scripts/platform/package-target.mjs",
    "scripts/platform/package-evidence.mjs", "scripts/build.mjs",
    "scripts/platform/windows", "src", "dist"]) walk(join(root, path));
  regular(join(root, "dist/main.cjs"));
  regular(join(root, "dist/preload.cjs"));
  if (icon) files.push({ path: absolute(icon), sha256: fileHash(icon) });
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function select(input) {
  const root = absolute(resolve(input.root ?? process.cwd()));
  const pkg = json(join(root, "package.json"));
  const platform = input.platform ?? "darwin", arch = input.arch ?? "arm64";
  const defaultIcon = join(root, "assets", platform === "darwin" ? "icon.icns" : "icon.ico");
  const icon = input.icon ?? (existsSync(defaultIcon) ? defaultIcon : undefined);
  const plan = planPackage({ platform, arch, version: pkg.version,
    outputRoot: join(root, "release"), icon });
  const helpers = [];
  if (platform === "win32") {
    for (const role of ["probe", "owned"]) {
      const pin = input.windowsHelpers?.[role];
      if (!pin || typeof pin.path !== "string" || typeof pin.sha256 !== "string")
        fail("PACKAGE_HELPER_PIN_REQUIRED");
      helpers.push(inspectWindowsHelper(pin.path, pin.sha256, arch, role));
    }
  } else if (input.windowsHelpers !== undefined) {
    fail("PACKAGE_HELPERS_WRONG_TARGET");
  }
  const source = sourceInventory(root, icon);
  return { root, pkg, plan, helpers, source };
}

function ensureOutputDirectory(path) {
  mkdirSync(path, { recursive: true });
  if (!lstatSync(path).isDirectory()) fail("PACKAGE_OUTPUT_DIRECTORY_INVALID");
}

function sourceHashes(source) {
  // Keep the full inventory in the manifest; bind its digest rather than
  // exceeding validateArtifactEvidence's 256-hash bound on a real source tree.
  return [digest(canonical(source))];
}

function invocation(selection, stage) {
  return createPackageInvocation({
    plan: selection.plan, stage, helpers: selection.helpers,
    electronVersion: selection.pkg.devDependencies?.electron,
    cacheRoot: join(selection.root, ".cache/electron"),
  });
}

function paths(plan) {
  const base = plan.platform === "darwin" ? join(plan.outputDir, "Folio.app/Contents") : plan.outputDir;
  const resources = join(base, plan.platform === "darwin" ? "Resources" : "resources");
  return {
    asar: join(resources, "app.asar"),
    executable: join(base, plan.platform === "darwin" ? "MacOS/Folio" : "Folio.exe"),
    resources,
  };
}

function builtInventory(selection) {
  const { plan, helpers } = selection, selected = paths(plan);
  const files = [selected.asar, selected.executable].map(path => ({
    path: inside(plan.outputDir, path), sha256: fileHash(path),
  }));
  const nativeHelpers = helpers.map(helper => {
    const resource = join(selected.resources, `${HELPER_NAMES[helper.role]}.exe`);
    const actual = inspectWindowsHelper(resource, helper.sha256, plan.arch, helper.role, false);
    equal({ ...actual, path: helper.path }, helper, "PACKAGE_COPIED_HELPER_MISMATCH");
    files.push({ path: inside(plan.outputDir, resource), sha256: actual.sha256 });
    return { ...helper, resource: inside(plan.outputDir, resource) };
  });
  return { files, nativeHelpers };
}

function zipHash(path) {
  const stat = regular(path, 0xffffffff);
  const fd = openSync(path, "r"), header = Buffer.alloc(4);
  try {
    if (readSync(fd, header, 0, 4, 0) !== 4 ||
        !header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      fail("PACKAGE_ZIP_INVALID");
    const tail = Buffer.alloc(Math.min(stat.size, 65_557));
    if (readSync(fd, tail, 0, tail.length, stat.size - tail.length) !== tail.length)
      fail("PACKAGE_ZIP_INVALID");
    let end = tail.length - 22;
    for (; end >= 0; end--) {
      if (tail.readUInt32LE(end) === 0x06054b50 &&
          end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
    }
    if (end < 0) fail("PACKAGE_ZIP_INVALID");
    const count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0 ||
        count < 1 || count === 0xffff || tail.readUInt16LE(end + 8) !== count ||
        size < 46 || offset < 30 || offset + size !== stat.size - tail.length + end)
      fail("PACKAGE_ZIP_INVALID");
    if (readSync(fd, header, 0, 4, offset) !== 4 || header.readUInt32LE() !== 0x02014b50)
      fail("PACKAGE_ZIP_INVALID");
  } finally { closeSync(fd); }
  return fileHash(path);
}

// Only archive creation is delegated to a fixed non-GUI host tool. No target
// executable is launched; paths never become shell/PowerShell source text.
export function writePackageArchive(plan) {
  if (existsSync(plan.artifactPath)) fail("PACKAGE_OUTPUT_EXISTS");
  let command, args, env = process.env;
  if (process.platform === "darwin") {
    command = "/usr/bin/ditto";
    args = ["-c", "-k", "--sequesterRsrc", "--keepParent", plan.outputDir, plan.artifactPath];
  } else if (process.platform === "linux") {
    command = "/usr/bin/zip";
    args = ["-qry", plan.artifactPath, basename(plan.outputDir)];
  } else if (process.platform === "win32") {
    command = join(absolute(process.env.SystemRoot ?? "C:\\Windows"),
      "System32/WindowsPowerShell/v1.0/powershell.exe");
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Compress-Archive -LiteralPath $env:FOLIO_PACKAGE_ARCHIVE_SOURCE " +
      "-DestinationPath $env:FOLIO_PACKAGE_ARCHIVE_DESTINATION -CompressionLevel Optimal -ErrorAction Stop"];
    env = { ...process.env, FOLIO_PACKAGE_ARCHIVE_SOURCE: plan.outputDir,
      FOLIO_PACKAGE_ARCHIVE_DESTINATION: plan.artifactPath };
  } else fail("PACKAGE_ARCHIVER_UNSUPPORTED");
  const result = spawnSync(command, args, { cwd: dirname(plan.outputDir),
    env, shell: false, stdio: "pipe", timeout: 300_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) fail("PACKAGE_ARCHIVER_FAILED");
}

function revalidate(input, initial) {
  const current = select(input);
  equal({ plan: current.plan, helpers: current.helpers, source: current.source },
    { plan: initial.plan, helpers: initial.helpers, source: initial.source }, "PACKAGE_SOURCE_CHANGED");
}

export async function runPackage(input = {}, dependencies = {}) {
  const selected = select(input), { root, plan, pkg } = selected;
  for (const path of [plan.outputDir, plan.artifactPath, plan.manifestPath])
    if (existsSync(path)) fail("PACKAGE_OUTPUT_EXISTS");
  ensureOutputDirectory(join(root, "output"));
  ensureOutputDirectory(plan.outputRoot);
  const stage = mkdtempSync(join(root, "output", `package-stage-${plan.platform}-${plan.arch}-`));
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(root, "docs/THIRD_PARTY_NOTICES.txt"), join(stage, "THIRD_PARTY_NOTICES.txt"));
  writeFileSync(join(stage, "package.json"), JSON.stringify({
    name: pkg.name, productName: pkg.productName, version: pkg.version, main: "dist/main.cjs",
  }), { flag: "wx" });
  const actualInvocation = invocation(selected, stage);
  const packager = dependencies.packager ?? (await import("@electron/packager")).packager;
  const results = await packager(actualInvocation.packagerOptions);
  equal(results, [plan.outputDir], "PACKAGE_RESULT_MISMATCH");
  revalidate(input, selected);
  const built = builtInventory(selected);
  await (dependencies.archive ?? writePackageArchive)(plan);
  revalidate(input, selected);
  equal(builtInventory(selected), built, "PACKAGE_BUILT_FILES_CHANGED");
  const artifactHash = zipHash(plan.artifactPath);
  const evidence = validateArtifactEvidence({
    artifactBuilt: true, osExecuted: false, signed: false,
    deterministicBase: actualInvocation.deterministicBase,
    sourceHashes: sourceHashes(selected.source),
    artifactHashes: [artifactHash],
  });
  const manifest = {
    schema: SCHEMA, plan, invocation: actualInvocation, source: selected.source,
    ...built, artifact: { path: plan.artifactPath, sha256: artifactHash },
    prerequisites: plan.platform === "win32"
      ? [{ name: "Microsoft.NETCore.App", major: 10, arch: plan.arch, bundled: false }] : [],
    evidence,
  };
  writeFileSync(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export function verifyPackageArtifacts(input = {}) {
  const selected = select(input), { plan } = selected;
  const manifest = json(plan.manifestPath);
  if (manifest?.schema !== SCHEMA) fail("PACKAGE_MANIFEST_SCHEMA");
  equal(Object.keys(manifest).sort(), ["schema", "plan", "invocation", "source",
    "files", "nativeHelpers", "artifact", "prerequisites", "evidence"].sort(),
  "PACKAGE_MANIFEST_SCHEMA");
  equal(manifest.plan, plan, "PACKAGE_STALE_PLAN");
  const stage = manifest.invocation?.packagerOptions?.dir;
  absolute(stage);
  if (dirname(stage) !== join(selected.root, "output") ||
      !basename(stage).startsWith(`package-stage-${plan.platform}-${plan.arch}-`))
    fail("PACKAGE_STALE_INVOCATION");
  const expectedInvocation = invocation(selected, stage);
  equal(manifest.invocation, expectedInvocation, "PACKAGE_STALE_INVOCATION");
  equal(manifest.source, selected.source, "PACKAGE_STALE_SOURCE");
  const built = builtInventory(selected);
  equal(manifest.files, built.files, "PACKAGE_BUILT_FILES_CHANGED");
  equal(manifest.nativeHelpers, built.nativeHelpers, "PACKAGE_COPIED_HELPER_MISMATCH");
  equal(manifest.prerequisites, plan.platform === "win32"
    ? [{ name: "Microsoft.NETCore.App", major: 10, arch: plan.arch, bundled: false }] : [],
  "PACKAGE_STALE_PREREQUISITES");
  const artifactHash = zipHash(plan.artifactPath);
  equal(manifest.artifact, { path: plan.artifactPath, sha256: artifactHash }, "PACKAGE_ARTIFACT_HASH");
  const evidence = validateArtifactEvidence(manifest.evidence);
  equal(manifest.evidence, evidence, "PACKAGE_STALE_EVIDENCE");
  equal(evidence, {
    artifactBuilt: true, osExecuted: false, signed: false,
    deterministicBase: expectedInvocation.deterministicBase,
    sourceHashes: sourceHashes(selected.source),
    artifactHashes: [artifactHash], osObservations: [],
  }, "PACKAGE_STALE_EVIDENCE");
  return manifest;
}
