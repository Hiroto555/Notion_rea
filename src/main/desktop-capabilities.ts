import {
  DESKTOP_CAPABILITY_IDS,
  type DesktopCapabilities,
  type DesktopCapabilityBinding,
  type DesktopCapabilityId,
  type DesktopCapabilityOperation,
  type DesktopCapabilityResult,
  type DesktopCapabilityRow,
} from "../shared/desktop-capabilities";

/**
 * W09/O1 pure producer for the readonly desktop-capability table.
 *
 * The producer accepts the actual Main references that are already bound for
 * the operational request handlers (the file-dialog API, the attachment store,
 * the external-link opener, the workspace-backup service, the shared
 * CredentialProvider instance, the private SyncConnectionVault, the native
 * filesystem port, the host lifecycle object) plus the current workspace mode
 * and declarative platform metadata. It only reads binding presence and
 * function type — it never invokes a chooser, export, native, credential,
 * vault, lifecycle or OS probe, so producing the table has zero side effects.
 *
 * Binding presence is reported as PROVIDED/NOT_PROVIDED (HOST_MANAGED for a
 * host-owned lifecycle); it is never treated as readiness, OS verification or
 * proof of success. readiness stays UNPROBED, osVerification stays NOT_RUN and
 * verified stays false for every row.
 */
export interface DesktopCapabilityBindings {
  /** Electron dialog surface (showOpenDialog/showSaveDialog). Presence only. */
  readonly fileDialogs?: {
    readonly showOpenDialog?: unknown;
    readonly showSaveDialog?: unknown;
  } | null;
  /** Store the attach operation writes through. Presence only. */
  readonly attachmentStore?: unknown;
  /** External-link opener (shell.openExternal). Presence only. */
  readonly externalLinkOpener?: unknown;
  /** Workspace backup service. Presence only. */
  readonly backupService?: unknown;
  /** Existing shared-runtime CredentialProvider instance. Presence only. */
  readonly sharedCredentialProvider?: unknown;
  /** Existing private SyncConnectionVault instance. Presence only. */
  readonly privateCredentialVault?: unknown;
  /** Current native filesystem port. Presence only. */
  readonly nativeFileSystem?: unknown;
  /** Host lifecycle owner for exit/quit. Presence only. */
  readonly hostLifecycle?: unknown;
  /** Current workspace mode: true means the workspace opened read-only. */
  readonly readOnly?: boolean;
  /** Declarative OS metadata (process.platform). Never probed. */
  readonly platform?: string;
}

function isBound(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

const RESULT_FOR: Record<DesktopCapabilityId, DesktopCapabilityResult> = {
  fileImport: "UTF8_TEXT_OR_NULL",
  fileExport: "DISPLAY_PATH_OR_NULL",
  attachment: "UNSPECIFIED",
  externalLink: "UNSPECIFIED",
  backup: "UNSPECIFIED",
  sharedCredential: "UNSPECIFIED",
  privateCredential: "UNSPECIFIED",
  nativeFilesystem: "UNSPECIFIED",
  exit: "HOST_MANAGED",
};

const OPERATION_FOR: Record<DesktopCapabilityId, DesktopCapabilityOperation> = {
  fileImport: "PROVIDED",
  fileExport: "PROVIDED",
  attachment: "PROVIDED",
  externalLink: "PROVIDED",
  backup: "PROVIDED",
  sharedCredential: "PROVIDED",
  privateCredential: "PROVIDED",
  nativeFilesystem: "PROVIDED",
  exit: "NOT_PROVIDED",
};

function provided(bound: boolean): DesktopCapabilityBinding {
  return bound ? "PROVIDED" : "NOT_PROVIDED";
}

/** Build the version-1 capability table from the live binding facts. Pure:
 * no I/O, no probes, no credential or vault access, no chooser, no quit. */
export function createDesktopCapabilities(
  bindings: DesktopCapabilityBindings,
): DesktopCapabilities {
  const fileDialogs = bindings.fileDialogs ?? null;
  const openBound =
    typeof fileDialogs === "object" && fileDialogs !== null
      ? isFunction(fileDialogs.showOpenDialog)
      : false;
  const saveBound =
    typeof fileDialogs === "object" && fileDialogs !== null
      ? isFunction(fileDialogs.showSaveDialog)
      : false;

  const bindingFor: Record<DesktopCapabilityId, DesktopCapabilityBinding> = {
    fileImport: provided(openBound),
    fileExport: provided(saveBound),
    attachment: provided(openBound && isBound(bindings.attachmentStore)),
    externalLink: provided(isBound(bindings.externalLinkOpener)),
    backup: provided(isBound(bindings.backupService)),
    sharedCredential: provided(isBound(bindings.sharedCredentialProvider)),
    privateCredential: provided(isBound(bindings.privateCredentialVault)),
    nativeFilesystem: provided(isBound(bindings.nativeFileSystem)),
    // Exit is host-managed whenever a lifecycle owner is bound; the renderer
    // never receives a quit/mutation operation regardless.
    exit: isBound(bindings.hostLifecycle) ? "HOST_MANAGED" : "NOT_PROVIDED",
  };

  const features: DesktopCapabilityRow[] = DESKTOP_CAPABILITY_IDS.map((id) =>
    Object.freeze({
      id,
      binding: bindingFor[id],
      operation: OPERATION_FOR[id],
      readiness: "UNPROBED" as const,
      osVerification: "NOT_RUN" as const,
      verified: false as const,
      result: RESULT_FOR[id],
    }),
  );

  const platform =
    typeof bindings.platform === "string" &&
    /^[a-z0-9]{1,48}$/.test(bindings.platform)
      ? bindings.platform
      : "unknown";

  return Object.freeze({
    version: 1 as const,
    host: Object.freeze({
      kind: "desktop" as const,
      platform,
      mode: bindings.readOnly === true ? ("read-only" as const) : ("writable" as const),
    }),
    features: Object.freeze(features),
  });
}
