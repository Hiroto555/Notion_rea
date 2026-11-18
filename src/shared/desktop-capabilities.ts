/**
 * W09/O1 readonly desktop-capability table (contract version 1).
 *
 * This DTO is descriptive metadata only. It reports which desktop-host
 * capabilities are bound and which renderer operations exist; it is never an
 * authority, never an operation result and never proof that an operation
 * succeeded. `binding` records whether the underlying host dependency is
 * present, while `readiness`, `osVerification` and `verified` stay UNPROBED /
 * NOT_RUN / false because this table performs no probe and no OS verification.
 * Availability is never inferred from the OS name or from binding presence.
 */

export const DESKTOP_CAPABILITIES_VERSION = 1 as const;

export const DESKTOP_CAPABILITY_IDS = [
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
export type DesktopCapabilityId = (typeof DESKTOP_CAPABILITY_IDS)[number];

/** Whether the host dependency behind a feature is bound. HOST_MANAGED means
 * the host owns the capability and no renderer binding applies. */
export const DESKTOP_CAPABILITY_BINDINGS = [
  "PROVIDED",
  "NOT_PROVIDED",
  "HOST_MANAGED",
] as const;
export type DesktopCapabilityBinding =
  (typeof DESKTOP_CAPABILITY_BINDINGS)[number];

/** Whether a renderer-callable operation exists for the feature at all. This
 * is an API-surface fact, independent of whether the host binding is present
 * or whether the operation would succeed. */
export const DESKTOP_CAPABILITY_OPERATIONS = [
  "PROVIDED",
  "NOT_PROVIDED",
] as const;
export type DesktopCapabilityOperation =
  (typeof DESKTOP_CAPABILITY_OPERATIONS)[number];

/** Readiness is intentionally a single value: this table never probes. */
export const DESKTOP_CAPABILITY_READINESS = ["UNPROBED"] as const;
export type DesktopCapabilityReadiness =
  (typeof DESKTOP_CAPABILITY_READINESS)[number];

/** OS verification is never run to produce this table. */
export const DESKTOP_CAPABILITY_OS_VERIFICATION = ["NOT_RUN"] as const;
export type DesktopCapabilityOsVerification =
  (typeof DESKTOP_CAPABILITY_OS_VERIFICATION)[number];

/** The success-payload shape a feature's operation returns, described
 * declaratively. UTF8_TEXT_OR_NULL is the import result {name, format,
 * content} | null; DISPLAY_PATH_OR_NULL is the export selected display path
 * string | null (never raw file bytes); HOST_MANAGED means the host owns the
 * lifecycle and there is no renderer result. */
export const DESKTOP_CAPABILITY_RESULTS = [
  "UTF8_TEXT_OR_NULL",
  "DISPLAY_PATH_OR_NULL",
  "UNSPECIFIED",
  "HOST_MANAGED",
] as const;
export type DesktopCapabilityResult =
  (typeof DESKTOP_CAPABILITY_RESULTS)[number];

export const DESKTOP_HOST_KINDS = ["desktop"] as const;
export type DesktopHostKind = (typeof DESKTOP_HOST_KINDS)[number];

export const DESKTOP_WORKSPACE_MODES = ["writable", "read-only"] as const;
export type DesktopWorkspaceMode = (typeof DESKTOP_WORKSPACE_MODES)[number];

export interface DesktopHostInfo {
  readonly kind: DesktopHostKind;
  /** Declarative OS metadata only (e.g. process.platform). Never probed. */
  readonly platform: string;
  readonly mode: DesktopWorkspaceMode;
}

export interface DesktopCapabilityRow {
  readonly id: DesktopCapabilityId;
  readonly binding: DesktopCapabilityBinding;
  readonly operation: DesktopCapabilityOperation;
  readonly readiness: DesktopCapabilityReadiness;
  readonly osVerification: DesktopCapabilityOsVerification;
  readonly verified: false;
  readonly result: DesktopCapabilityResult;
}

export interface DesktopCapabilities {
  readonly version: typeof DESKTOP_CAPABILITIES_VERSION;
  readonly host: DesktopHostInfo;
  /** Exactly the fixed feature IDs in canonical order. */
  readonly features: readonly DesktopCapabilityRow[];
}

/* ------------------------------------------------------------------ */
/* Strict bounded validator                                            */
/* ------------------------------------------------------------------ */

const ROOT_KEYS = ["version", "host", "features"] as const;
const HOST_KEYS = ["kind", "platform", "mode"] as const;
const ROW_KEYS = [
  "id",
  "binding",
  "operation",
  "readiness",
  "osVerification",
  "verified",
  "result",
] as const;

/** Static per-feature contract: the result shape and renderer-operation
 * surface are fixed by feature ID. `binding` stays dynamic because it reports
 * live host state; exit is the only host-managed row. */
const FEATURE_CONTRACT: Record<
  DesktopCapabilityId,
  { result: DesktopCapabilityResult; operation: DesktopCapabilityOperation }
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

/** Bounded declarative platform token. Rejects paths, separators, control
 * characters and oversized strings; there is no free-text field anywhere in
 * the DTO, so a path, secret or handle cannot be carried. */
function isPlatformToken(input: unknown): input is string {
  return typeof input === "string" && /^[a-z0-9]{1,48}$/.test(input);
}

function inSet<T extends string>(
  input: unknown,
  allowed: readonly T[],
): input is T {
  return typeof input === "string" && (allowed as readonly string[]).includes(input);
}

/** Read an own-enumerable-data-property record with EXACTLY `keys`. Rejects
 * non-plain objects, accessors, symbol keys, inherited or extra/missing keys
 * and any trap-throwing carrier. Returns a null-prototype record. */
function readFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  try {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(input).length !== 0) return null;
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== keys.length) return null;
    const wanted = new Set(keys);
    const out = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      if (!wanted.has(name)) return null;
      const desc = Object.getOwnPropertyDescriptor(input, name);
      if (!desc || !desc.enumerable || !("value" in desc)) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[name] = desc.value;
    }
    return out;
  } catch {
    return null;
  }
}

/** Read a dense plain array of exactly `length` own data elements. Rejects
 * non-arrays, accessors, symbols, extra/holes and trap-throwing carriers. */
function readDenseArray(input: unknown, length: number): unknown[] | null {
  if (!Array.isArray(input)) return null;
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(input).length !== 0) return null;
    const names = Object.getOwnPropertyNames(input);
    const lengthDesc = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDesc || !("value" in lengthDesc)) return null;
    if (lengthDesc.get !== undefined || lengthDesc.set !== undefined) return null;
    if (lengthDesc.value !== length) return null;
    if (names.length !== length + 1) return null;
    const out: unknown[] = new Array(length);
    for (const name of names) {
      if (name === "length") continue;
      if (!/^(0|[1-9]\d*)$/.test(name)) return null;
      const index = Number(name);
      if (String(index) !== name || index >= length) return null;
      const desc = Object.getOwnPropertyDescriptor(input, name);
      if (!desc || !desc.enumerable || !("value" in desc)) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[index] = desc.value;
    }
    return out;
  } catch {
    return null;
  }
}

function readRow(input: unknown, expectedId: DesktopCapabilityId): DesktopCapabilityRow | null {
  const f = readFields(input, ROW_KEYS);
  if (!f) return null;
  const { id, binding, operation, readiness, osVerification, verified, result } = f;
  if (id !== expectedId) return null;
  const contract = FEATURE_CONTRACT[expectedId];
  if (operation !== contract.operation || result !== contract.result) return null;
  if (readiness !== "UNPROBED" || osVerification !== "NOT_RUN") return null;
  if (verified !== false) return null;
  if (expectedId === "exit") {
    if (binding !== "HOST_MANAGED" && binding !== "NOT_PROVIDED") return null;
  } else if (binding !== "PROVIDED" && binding !== "NOT_PROVIDED") {
    return null;
  }
  return Object.freeze({
    id: expectedId,
    binding: binding as DesktopCapabilityBinding,
    operation: contract.operation,
    readiness: "UNPROBED" as const,
    osVerification: "NOT_RUN" as const,
    verified: false as const,
    result: contract.result,
  });
}

function readHost(input: unknown): DesktopHostInfo | null {
  const f = readFields(input, HOST_KEYS);
  if (!f) return null;
  if (f.kind !== "desktop") return null;
  if (!isPlatformToken(f.platform)) return null;
  if (!inSet(f.mode, DESKTOP_WORKSPACE_MODES)) return null;
  return Object.freeze({
    kind: "desktop" as const,
    platform: f.platform,
    mode: f.mode,
  });
}

/** Strictly validate an untrusted desktop-capability payload. Returns a fresh
 * frozen DTO on success, or null on any deviation: unknown/extra keys,
 * oversize, accessors, symbols, cycles, non-plain objects, invalid enums,
 * inconsistent per-feature contract, or a forged verified/host-managed claim.
 * Never throws and never trusts a partial or mutated carrier. */
export function parseDesktopCapabilities(
  input: unknown,
): DesktopCapabilities | null {
  try {
    const f = readFields(input, ROOT_KEYS);
    if (!f) return null;
    if (f.version !== DESKTOP_CAPABILITIES_VERSION) return null;
    const host = readHost(f.host);
    if (!host) return null;
    const items = readDenseArray(f.features, DESKTOP_CAPABILITY_IDS.length);
    if (!items) return null;
    const rows: DesktopCapabilityRow[] = [];
    for (let i = 0; i < DESKTOP_CAPABILITY_IDS.length; i += 1) {
      const row = readRow(items[i], DESKTOP_CAPABILITY_IDS[i]);
      if (!row) return null;
      rows.push(row);
    }
    return Object.freeze({
      version: DESKTOP_CAPABILITIES_VERSION,
      host,
      features: Object.freeze(rows),
    });
  } catch {
    return null;
  }
}
