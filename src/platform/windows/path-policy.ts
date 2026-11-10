import {
  CollaborationError,
  wellFormed,
} from "../../collaboration/runtime/contract";

type ParsedWindowsPath = Readonly<{
  drive: string;
  segments: readonly string[];
}>;
type WindowsPathResult = Readonly<{ canonical: string; relative: string }>;

export type WindowsProbeExpectation = Readonly<{
  canonicalPath: string;
  canonicalRoot: string;
}>;

export type WindowsProbeEvidence = Readonly<{
  platform: "win32";
  sid: string;
  ownerSid: string;
  daclPrivate: true;
  reparsePoint: false;
  linkCount: 1;
  localFilesystem: true;
  fileId: string;
  rootFileId: string;
  volumeId: string;
  rootVolumeId: string;
  canonicalPath: string;
  canonicalRoot: string;
}>;

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

const ILLEGAL_SEGMENT_CHAR = /[<>:"|?*]/;
const isSeparator = (value: string): boolean => value === "\\" || value === "/";

function fail(code: string): never {
  throw new CollaborationError(code);
}

export function asciiCaseFold(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    folded +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : value[index];
  }
  return folded;
}

function asciiUpper(value: string): string {
  let upper = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    upper +=
      code >= 0x61 && code <= 0x7a
        ? String.fromCharCode(code - 0x20)
        : value[index];
  }
  return upper;
}

function validateSegment(segment: string): void {
  if (segment.length === 0) fail("EMPTY_SEGMENT");
  if (segment === "..") fail("TRAVERSAL");
  if (segment === ".") fail("DOT_SEGMENT");
  for (let index = 0; index < segment.length; index++) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) fail("CONTROL_CHAR");
  }
  if (segment.includes(":")) fail("ADS");
  if (ILLEGAL_SEGMENT_CHAR.test(segment)) fail("ILLEGAL_CHAR");
  if (/[ .]$/.test(segment)) fail("TRAILING_DOT_OR_SPACE");
  if (/~\d/.test(segment)) fail("SHORT_NAME_ALIAS");
  const stem = asciiUpper(segment.split(".")[0]);
  if (RESERVED_NAMES.has(stem)) fail("RESERVED_NAME");
}

function parseWindowsPath(input: unknown, label: string): ParsedWindowsPath {
  if (typeof input !== "string") fail(`INVALID_${label}_TYPE`);
  const value = input as string;
  if (value.length === 0) fail(`EMPTY_${label}`);
  if (!wellFormed(value)) fail("UNICODE");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) fail("CONTROL_CHAR");
  }
  if (/^[\\/]{2}[?.][\\/]/.test(value)) fail("DEVICE_PREFIX");
  if (/^[\\/]{2}/.test(value)) fail("UNC_PATH");
  if (!/^[A-Za-z]:/.test(value)) fail("NOT_ABSOLUTE");
  const drive = value[0].toUpperCase();
  const afterDrive = value.slice(2);
  if (afterDrive.length === 0 || !isSeparator(afterDrive[0]))
    fail("NOT_ABSOLUTE");
  let rest = afterDrive.slice(1);
  if (rest.length > 0 && isSeparator(rest[0])) fail("REPEATED_SEPARATOR");
  if (/[\\/]{2}/.test(rest)) fail("REPEATED_SEPARATOR");
  if (rest.length > 0 && isSeparator(rest[rest.length - 1]))
    rest = rest.slice(0, -1);
  const segments = rest.length === 0 ? [] : rest.split(/[\\/]/);
  for (const segment of segments) validateSegment(segment);
  return { drive, segments };
}

function canonicalOf(parsed: ParsedWindowsPath): string {
  return parsed.drive + ":\\" + parsed.segments.join("\\");
}

function sameSegment(left: string, right: string): boolean {
  return asciiCaseFold(left) === asciiCaseFold(right);
}

export function validateWindowsPath(
  path: string,
  root: string,
): WindowsPathResult {
  const target = parseWindowsPath(path, "PATH");
  const base = parseWindowsPath(root, "ROOT");
  if (target.drive !== base.drive) fail("DRIVE_MISMATCH");
  if (target.segments.length < base.segments.length) fail("OUTSIDE_ROOT");
  for (let index = 0; index < base.segments.length; index++) {
    if (!sameSegment(base.segments[index], target.segments[index]))
      fail("OUTSIDE_ROOT");
  }
  const relativeSegments = target.segments.slice(base.segments.length);
  return {
    canonical: canonicalOf(target),
    relative: relativeSegments.join("\\"),
  };
}

const PROBE_KEYS = [
  "canonicalPath",
  "canonicalRoot",
  "daclPrivate",
  "fileId",
  "linkCount",
  "localFilesystem",
  "ownerSid",
  "platform",
  "reparsePoint",
  "rootFileId",
  "rootVolumeId",
  "sid",
  "volumeId",
] as const;

const PROBE_KEY_SET: ReadonlySet<string> = new Set(PROBE_KEYS);
const FILE_ID_PATTERN = /^[0-9A-Fa-f]{32}$/;
const VOLUME_ID_PATTERN = /^[0-9A-Fa-f]{16}$/;

function readProbeField(probe: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(probe, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
    fail("PROBE_ACCESSOR");
  return descriptor.value;
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    fail(code);
  return value;
}

function parseCanonicalOrFail(text: string, code: string): ParsedWindowsPath {
  try {
    return parseWindowsPath(text, "PATH");
  } catch {
    fail(code);
  }
}

function requireCanonicalPath(value: unknown, code: string): string {
  const text = requireNonEmptyString(value, code);
  if (!/^[A-Za-z]:[\\/]/.test(text)) fail(code);
  const parsed = parseCanonicalOrFail(text, code);
  const canonical = canonicalOf(parsed);
  if (canonical !== text) fail(code);
  return text;
}

function requireHex(value: unknown, pattern: RegExp, code: string): string {
  const text = requireNonEmptyString(value, code);
  if (!pattern.test(text)) fail(code);
  return text;
}

export function assertWindowsProbe(
  probe: unknown,
  expected?: WindowsProbeExpectation,
): void {
  if (typeof probe !== "object" || probe === null || Array.isArray(probe))
    fail("PROBE_INVALID");
  const record = probe as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null)
    fail("PROBE_INVALID");
  if (Object.getOwnPropertySymbols(record).length !== 0) fail("PROBE_INVALID");
  const keys = Object.keys(record);
  if (
    keys.length !== PROBE_KEYS.length ||
    keys.some((key) => !PROBE_KEY_SET.has(key))
  )
    fail("PROBE_INVALID");
  if (readProbeField(record, "platform") !== "win32") fail("PROBE_PLATFORM");
  const sid = requireNonEmptyString(readProbeField(record, "sid"), "PROBE_SID");
  const ownerSid = requireNonEmptyString(
    readProbeField(record, "ownerSid"),
    "PROBE_OWNER",
  );
  if (sid !== ownerSid) fail("PROBE_OWNER");
  if (readProbeField(record, "daclPrivate") !== true) fail("PROBE_DACL");
  if (readProbeField(record, "reparsePoint") !== false) fail("PROBE_REPARSE");
  if (readProbeField(record, "linkCount") !== 1) fail("PROBE_LINK_COUNT");
  requireHex(
    readProbeField(record, "fileId"),
    FILE_ID_PATTERN,
    "PROBE_FILE_ID",
  );
  requireHex(
    readProbeField(record, "rootFileId"),
    FILE_ID_PATTERN,
    "PROBE_ROOT_FILE_ID",
  );
  const volumeId = requireHex(
    readProbeField(record, "volumeId"),
    VOLUME_ID_PATTERN,
    "PROBE_VOLUME_ID",
  );
  const rootVolumeId = requireHex(
    readProbeField(record, "rootVolumeId"),
    VOLUME_ID_PATTERN,
    "PROBE_ROOT_VOLUME_ID",
  );
  if (volumeId !== rootVolumeId) fail("PROBE_VOLUME_MISMATCH");
  if (readProbeField(record, "localFilesystem") !== true)
    fail("PROBE_LOCAL_FS");
  const canonicalPath = requireCanonicalPath(
    readProbeField(record, "canonicalPath"),
    "PROBE_CANONICAL_PATH",
  );
  const canonicalRoot = requireCanonicalPath(
    readProbeField(record, "canonicalRoot"),
    "PROBE_CANONICAL_ROOT",
  );
  try {
    validateWindowsPath(canonicalPath, canonicalRoot);
  } catch {
    fail("PROBE_CONTAINMENT");
  }
  if (expected !== undefined) {
    const expectedPath = requireCanonicalPath(
      expected.canonicalPath,
      "PROBE_EXPECTED_PATH",
    );
    const expectedRoot = requireCanonicalPath(
      expected.canonicalRoot,
      "PROBE_EXPECTED_ROOT",
    );
    if (asciiCaseFold(canonicalPath) !== asciiCaseFold(expectedPath))
      fail("PROBE_PATH_MISMATCH");
    if (asciiCaseFold(canonicalRoot) !== asciiCaseFold(expectedRoot))
      fail("PROBE_ROOT_MISMATCH");
  }
}
