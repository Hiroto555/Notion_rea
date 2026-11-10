import { createHash } from "node:crypto";

const SCHEMA = "folio.package-target.v1";
const PRODUCT_NAME = "Folio";
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
function isHash(value) {
  return (
    typeof value === "string" && value.length === 64 && HASH_PATTERN.test(value)
  );
}
const SUPPORTED = new Map([
  ["darwin", new Set(["arm64"])],
  ["win32", new Set(["x64", "arm64"])],
]);

export class PackageTargetError extends Error {
  constructor(code, message, input) {
    super(message);
    this.name = "PackageTargetError";
    this.code = code;
    this.input = input;
  }
}

function fail(code, message, input) {
  throw new PackageTargetError(code, message, input);
}

function wellFormed(value) {
  for (let i = 0; i < value.length; i++) {
    const u = value.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (u >= 0xdc00 && u <= 0xdfff) return false;
  }
  return true;
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasUnsafeText(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function normalizeRoot(value, input) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail(
      "UNSAFE_OUTPUT_ROOT",
      "outputRoot must be a bounded absolute path",
      input,
    );
  }
  if (!wellFormed(value) || hasUnsafeText(value)) {
    fail("UNSAFE_OUTPUT_ROOT", "outputRoot contains unsafe text", input);
  }
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const unc = value.startsWith("\\\\");
  if (unc) {
    fail("UNSAFE_OUTPUT_ROOT", "UNC outputRoot is not supported", input);
  }
  if (!windowsDrive && !value.startsWith("/")) {
    fail("UNSAFE_OUTPUT_ROOT", "outputRoot must be absolute", input);
  }
  if (!windowsDrive && value.startsWith("//")) {
    fail(
      "UNSAFE_OUTPUT_ROOT",
      "outputRoot must not contain repeated root separators",
      input,
    );
  }
  if (windowsDrive && /[<>:"|?*]/.test(value.slice(2))) {
    fail(
      "UNSAFE_OUTPUT_ROOT",
      "outputRoot contains Windows-reserved characters",
      input,
    );
  }

  const separator = windowsDrive ? "\\" : "/";
  const prefix = windowsDrive ? value.slice(0, 2) : "";
  let rest = windowsDrive ? value.slice(2) : value;
  rest = rest.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (rest === "") {
    return Object.freeze({
      root: windowsDrive ? `${prefix}${separator}` : "/",
      separator,
    });
  }
  const parts = rest.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail("UNSAFE_OUTPUT_ROOT", "outputRoot contains an unsafe segment", input);
  }
  parts.forEach((part) => {
    if (!wellFormed(part) || hasUnsafeText(part)) {
      fail("UNSAFE_OUTPUT_ROOT", "outputRoot contains unsafe text", input);
    }
  });
  const joined = parts.join(separator);
  return Object.freeze({
    root: windowsDrive ? `${prefix}${separator}${joined}` : `/${joined}`,
    separator,
  });
}

function joinPath(rootInfo, name) {
  const { root, separator } = rootInfo;
  if (root.endsWith(separator)) return root + name;
  return root + separator + name;
}

function validateVersion(value, input) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !wellFormed(value) ||
    hasUnsafeText(value) ||
    !VERSION_PATTERN.test(value)
  ) {
    fail(
      "INVALID_VERSION",
      "version must be a canonical semantic version",
      input,
    );
  }
  return value;
}

function validateTarget(platform, arch, input) {
  if (typeof platform !== "string" || !SUPPORTED.has(platform)) {
    fail("UNKNOWN_PLATFORM", "platform must be darwin or win32", input);
  }
  const arches = SUPPORTED.get(platform);
  if (typeof arch !== "string" || !arches.has(arch)) {
    fail("UNSUPPORTED_TARGET", "arch is not supported for the platform", input);
  }
}

function validateIcon(value, platform, input) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail("UNSAFE_ICON_PATH", "icon must be a bounded absolute path", input);
  }
  if (!wellFormed(value) || hasUnsafeText(value)) {
    fail("UNSAFE_ICON_PATH", "icon contains unsafe text", input);
  }
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  if (value.startsWith("\\\\")) {
    fail("UNSAFE_ICON_PATH", "UNC icon paths are not supported", input);
  }
  if (!windowsDrive && !value.startsWith("/")) {
    fail("UNSAFE_ICON_PATH", "icon must be absolute", input);
  }
  if (!windowsDrive && value.startsWith("//")) {
    fail(
      "UNSAFE_ICON_PATH",
      "icon must not contain repeated root separators",
      input,
    );
  }
  if (windowsDrive && /[<>:"|?*]/.test(value.slice(2))) {
    fail(
      "UNSAFE_ICON_PATH",
      "icon contains Windows-reserved characters",
      input,
    );
  }
  const parts = value
    .replace(/^[A-Za-z]:/, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) {
    fail("UNSAFE_ICON_PATH", "icon contains an unsafe segment", input);
  }
  if (platform === "win32" && /\.(?:dmg|app|icns)$/i.test(value)) {
    fail(
      "UNSAFE_ICON_PATH",
      "win32 icon must not reference a macOS artifact",
      input,
    );
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function frozenClaims() {
  return Object.freeze({
    artifactBuilt: false,
    osExecuted: false,
    signed: false,
  });
}

export function planPackage(input) {
  if (!isPlainObject(input)) {
    fail("INVALID_INPUT", "planPackage requires a plain object", input);
  }
  const { platform, arch, version, outputRoot, icon } = input;
  validateTarget(platform, arch, input);
  const appVersion = validateVersion(version, input);
  const rootInfo = normalizeRoot(outputRoot, input);
  const iconPath = validateIcon(icon, platform, input);

  const outputDirName = `${PRODUCT_NAME}-${platform}-${arch}`;
  const artifactName = `${PRODUCT_NAME}-${appVersion}-${platform}-${arch}.zip`;
  const manifestName = `${PRODUCT_NAME}-${appVersion}-${platform}-${arch}.manifest.json`;
  const outputDir = joinPath(rootInfo, outputDirName);
  const artifactPath = joinPath(rootInfo, artifactName);
  const manifestPath = joinPath(rootInfo, manifestName);

  const packagerOptions = {
    name: PRODUCT_NAME,
    appVersion,
    platform,
    arch,
    out: rootInfo.root,
    overwrite: false,
    asar: true,
    prune: true,
    ...(iconPath === undefined ? {} : { icon: iconPath }),
  };

  const base = {
    schema: SCHEMA,
    platform,
    arch,
    appVersion,
    outputRoot: rootInfo.root,
    outputDir,
    artifactName,
    artifactPath,
    manifestName,
    manifestPath,
    packagerOptions,
  };
  const deterministicBase = hash(base);
  const claims = frozenClaims();

  return Object.freeze({
    ...base,
    deterministicBase,
    packagerOptions: Object.freeze(packagerOptions),
    claims,
    artifactBuilt: claims.artifactBuilt,
    osExecuted: claims.osExecuted,
    signed: claims.signed,
  });
}

function evidenceFail(code, message, input) {
  fail(code, message, input);
}

function readHashes(value, field, input) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) {
    evidenceFail("INVALID_EVIDENCE", `${field} must be a bounded array`, input);
  }
  const result = [];
  for (const entry of value) {
    if (!isHash(entry)) {
      evidenceFail(
        "INVALID_HASH",
        `${field} entries must be 64 hexadecimal characters`,
        input,
      );
    }
    result.push(entry.toLowerCase());
  }
  if (new Set(result).size !== result.length) {
    evidenceFail("INVALID_HASH", `${field} must not contain duplicates`, input);
  }
  return result;
}

function readObservations(value, artifactHashes, input) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    evidenceFail(
      "INVALID_EVIDENCE",
      "osObservations must be a bounded array",
      input,
    );
  }
  const result = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      evidenceFail(
        "INVALID_OBSERVATION",
        "each osObservation must be a plain object",
        input,
      );
    }
    const { platform, arch } = entry;
    if (typeof platform !== "string" || !SUPPORTED.has(platform)) {
      evidenceFail(
        "INVALID_OBSERVATION",
        "osObservation platform is unsupported",
        input,
      );
    }
    if (typeof arch !== "string" || !SUPPORTED.get(platform).has(arch)) {
      evidenceFail(
        "INVALID_OBSERVATION",
        "osObservation arch is unsupported",
        input,
      );
    }
    if (entry.artifactHash !== undefined) {
      if (!isHash(entry.artifactHash)) {
        evidenceFail(
          "INVALID_OBSERVATION",
          "osObservation artifactHash must be 64 hexadecimal characters",
          input,
        );
      }
      const normalized = entry.artifactHash.toLowerCase();
      if (!artifactHashes.includes(normalized)) {
        evidenceFail(
          "INVALID_OBSERVATION",
          "osObservation must reference a supplied artifact hash",
          input,
        );
      }
    }
    result.push(
      Object.freeze({
        platform,
        arch,
        ...(entry.artifactHash === undefined
          ? {}
          : { artifactHash: entry.artifactHash.toLowerCase() }),
      }),
    );
  }
  return result;
}

export function validateArtifactEvidence(input) {
  if (!isPlainObject(input)) {
    evidenceFail(
      "INVALID_EVIDENCE",
      "validateArtifactEvidence requires a plain object",
      input,
    );
  }
  const claim = (name) => {
    const value = input[name] === undefined ? false : input[name];
    if (typeof value !== "boolean") {
      evidenceFail("INVALID_EVIDENCE", `${name} must be boolean`, input);
    }
    return value;
  };
  const artifactBuilt = claim("artifactBuilt");
  const osExecuted = claim("osExecuted");
  const signed = claim("signed");

  if (!isHash(input.deterministicBase)) {
    evidenceFail(
      "INVALID_HASH",
      "deterministicBase must be 64 hexadecimal characters",
      input,
    );
  }
  const deterministicBase = input.deterministicBase.toLowerCase();
  const sourceHashes = readHashes(input.sourceHashes, "sourceHashes", input);
  const artifactHashes = readHashes(
    input.artifactHashes,
    "artifactHashes",
    input,
  );
  const osObservations = readObservations(
    input.osObservations,
    artifactHashes,
    input,
  );

  if (
    artifactBuilt &&
    (sourceHashes.length === 0 || artifactHashes.length === 0)
  ) {
    evidenceFail(
      "MISSING_ARTIFACT_EVIDENCE",
      "artifactBuilt requires sourceHashes and artifactHashes",
      input,
    );
  }
  if (signed && (!artifactBuilt || artifactHashes.length === 0)) {
    evidenceFail(
      "MISSING_SIGNATURE_EVIDENCE",
      "signed requires a built artifact and artifactHashes",
      input,
    );
  }
  if (
    osExecuted &&
    (!artifactBuilt ||
      artifactHashes.length === 0 ||
      osObservations.length === 0)
  ) {
    evidenceFail(
      "MISSING_OS_EVIDENCE",
      "osExecuted requires a built artifact, artifactHashes and osObservations",
      input,
    );
  }

  return Object.freeze({
    artifactBuilt,
    osExecuted,
    signed,
    deterministicBase,
    sourceHashes: Object.freeze(sourceHashes),
    artifactHashes: Object.freeze(artifactHashes),
    osObservations: Object.freeze(osObservations),
  });
}
