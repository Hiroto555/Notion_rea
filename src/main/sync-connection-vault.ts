import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { asciiCaseFold, validateWindowsPath } from "../platform/windows/path-policy";
import { syncConnectionInputSchema, type SyncConnectionAction, type SyncConnectionInput, type SyncConnectionReason, type SyncConnectionView } from "../shared/sync-management";
import { canonicalJson, requireCondition, sha256, SyncError } from "../sync/protocol";
import { PrivateLedger } from "../sync/private-ledger";
import type { PrivatePlatform } from "../sync/private-platform";
import { assertSecureStorageBackend, SecretStoreError, type SafeStoragePort } from "../sync/secret-store";
import { openConnectionToken, sealConnectionToken } from "../sync/connection-credential-codec";
import { verifyWorkspaceBinding } from "../sync/workspace-binding";

const uuid = z.string().uuid();
const targetSchema = syncConnectionInputSchema.omit({requestId: true, expectedRevision: true, token: true})
  .extend({bindingId: uuid}).strict();
const profileSchema = z.object({nonce: uuid, revision: uuid, config: targetSchema.nullable(),
  ciphertext: z.string().max(32 * 1024).nullable(), enabled: z.boolean(), activated: z.boolean()}).strict();
const receiptSchema = z.object({fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["configure", "disable"]), outcome: z.enum(["saved", "disabled"]), revision: uuid}).strict();
type Profile = z.infer<typeof profileSchema>;
export type LoadedSyncConnection = {revision: string; baseUrl: string; workspaceId: string; clientId: string;
  bindingId: string; token: string; mode?: "publish" | "join" | "recover"};
export type WorkspaceNativeIdentity = Readonly<{
  canonicalPath: string;
  volumeId: string;
  fileId: string;
}>;
export type SyncConnectionVaultOptions = {
  directory: string; forbiddenRoots: readonly string[]; safeStorage: SafeStoragePort; platform?: NodeJS.Platform;
  assertWorkspaceAllowed(databasePath: string): void;
  /** Existing crash-recovery workspace identity; main creates it before startup. */
  workspaceIdentity(databasePath: string): string;
  privatePlatformFactory?: (directory: string, name: string) => PrivatePlatform;
  workspaceNativeIdentity?: (databasePath: string) => WorkspaceNativeIdentity;
};
const emptyView = (): SyncConnectionView => ({state: "unconfigured", revision: null, target: null, hasCredential: false, reason: null});

/** External private ciphertext store. This class is never exposed over IPC. */
export class SyncConnectionVault {
  constructor(private readonly options: SyncConnectionVaultOptions) {
    requireCondition(Array.isArray(options.forbiddenRoots) && options.forbiddenRoots.length > 0 &&
      typeof options.assertWorkspaceAllowed === "function" && typeof options.workspaceIdentity === "function", "connection-vault-invalid");
  }
  private platform(): NodeJS.Platform {return this.options.platform ?? process.platform;}
  private posixBinding(path: string) {
    const requested = resolve(path), stat = lstatSync(requested, {bigint: true});
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
      typeof process.getuid === "function" && stat.uid === BigInt(process.getuid()), "connection-identity-changed", 409);
    const canonical = realpathSync(requested);
    requireCondition(canonical === requested, "connection-identity-changed", 409);
    const identity = this.options.workspaceIdentity(path);
    requireCondition(typeof identity === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(identity), "connection-identity-changed", 409);
    const hash = sha256(canonicalJson({path: canonical, dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs), identity}));
    return {key: "profile:" + hash, hash};
  }
  private windowsBinding(path: string) {
    const native = this.options.workspaceNativeIdentity;
    if (typeof native !== "function" || typeof this.options.privatePlatformFactory !== "function")
      throw new SyncError("connection-identity-changed", 409);
    let proven: WorkspaceNativeIdentity;
    try { proven = native(path); }
    catch {throw new SyncError("connection-identity-changed", 409);}
    requireCondition(typeof proven === "object" && proven !== null, "connection-identity-changed", 409);
    const canonical = proven.canonicalPath, volume = proven.volumeId, file = proven.fileId;
    requireCondition(typeof canonical === "string" && /^[A-Za-z]:[\\/]/.test(canonical) &&
      typeof volume === "string" && /^[0-9A-Fa-f]{16}$/.test(volume) &&
      typeof file === "string" && /^[0-9A-Fa-f]{32}$/.test(file), "connection-identity-changed", 409);
    const identity = this.options.workspaceIdentity(path);
    requireCondition(typeof identity === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(identity), "connection-identity-changed", 409);
    const hash = sha256(canonicalJson({path: canonical, volume, file, identity}));
    return Object.freeze({key: "profile:" + hash, hash});
  }
  private binding(path: string) {
    this.options.assertWorkspaceAllowed(path);
    return this.platform() === "win32" ? this.windowsBinding(path) : this.posixBinding(path);
  }
  private assertVaultLocation(): void {
    if (this.platform() !== "win32") return;
    const canonical = (path: string): string => {
      if (/^[A-Za-z]:[\\/]/.test(path)) {
        const normalized = validateWindowsPath(
          path,
          `${path[0].toUpperCase()}:\\`,
        ).canonical;
        return asciiCaseFold(normalized);
      }
      // Existing injected Windows contract tests use real POSIX temp ledgers.
      // Production Windows accepts only fully validated drive paths.
      requireCondition(
        process.platform !== "win32",
        "connection-identity-changed",
        409,
      );
      return realpathSync(resolve(path));
    };
    const directory = canonical(this.options.directory);
    for (const raw of this.options.forbiddenRoots) {
      const root = canonical(raw);
      const separator = /^[a-z]:\\/.test(directory) ? "\\" : "/";
      const contains = (parent: string, child: string) =>
        parent === child ||
        child.startsWith(
          parent.endsWith(separator) ? parent : parent + separator,
        );
      requireCondition(
        !contains(directory, root) && !contains(root, directory),
        "connection-identity-changed",
        409,
      );
    }
  }
  private commit<T>(db: PrivateLedger, work: () => T): T {
    let callbackCompleted = false;
    try {
      return db.transaction(() => {
        const result = work();
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      // Once the full mutation reached SQLite, a failing post-COMMIT ownership
      // check cannot license a fresh request or be represented as unapplied.
      if (callbackCompleted)
        throw new SyncError("connection-outcome-unknown", 503);
      throw error;
    }
  }
  private ledger<T>(
    path: string,
    work: (
      db: PrivateLedger,
      binding: ReturnType<SyncConnectionVault["binding"]>,
    ) => T,
  ) {
    const binding = this.binding(path); // before opening or referencing the vault
    this.assertVaultLocation();
    const factory = this.options.privatePlatformFactory;
    requireCondition(
      this.platform() !== "win32" || typeof factory === "function",
      "connection-identity-changed",
      409,
    );
    const platform = factory?.(this.options.directory, "connections.sqlite");
    const db = new PrivateLedger(
      this.options.directory,
      "connections.sqlite",
      "connections",
      this.options.forbiddenRoots,
      platform,
    );
    let result: T;
    try { result = work(db, binding); }
    catch (error) {
      try { db.close(); } catch { /* Preserve the original uncertainty. */ }
      throw error;
    }
    try { db.close(); }
    catch { throw new SyncError("connection-outcome-unknown", 503); }
    return result;
  }
  private profile(raw: string | null): Profile | null {
    if (raw === null) return null;
    const profile = profileSchema.parse(JSON.parse(raw));
    requireCondition(profile.enabled ? profile.config !== null && profile.ciphertext !== null : profile.ciphertext === null,
      "connection-vault-invalid", 409);
    return profile;
  }
  private describe(profile: Profile | null, checkBackend = true): SyncConnectionView {
    const target = profile?.config ? (({baseUrl, workspaceId, clientId, mode}) => ({baseUrl, workspaceId, clientId, mode}))(profile.config) : null;
    const view: SyncConnectionView = {state: !profile ? "unconfigured" : !profile.enabled ? "disabled" :
      profile.activated ? "configured" : "pending-restart", revision: profile?.revision ?? null,
      target, hasCredential: !!profile?.ciphertext, reason: null};
    if (checkBackend && (!profile || profile.enabled)) {
      try {assertSecureStorageBackend(this.options.safeStorage, this.options.platform ?? process.platform);}
      catch {return {...view, state: "held", reason: "secure-store-unavailable"};}
    }
    return view;
  }
  private reason(error: unknown): SyncConnectionReason {
    if (
      error instanceof SecretStoreError ||
      (error instanceof SyncError &&
        error.code.startsWith("connection-secret-"))
    )
      return "secure-store-unavailable";
    const code = (error as { code?: unknown })?.code;
    if (
      code === "sync-storage-unavailable" ||
      code === "connection-outcome-unknown" ||
      (error instanceof SyncError && error.status === 503) ||
      (typeof code === "string" &&
        /^(WINDOWS_PRIVATE_(CREATE_(UNKNOWN|RACE)|OPEN_UNKNOWN|DIRECTORY_UNKNOWN)|PROBE_(EXEC_FAILED|TIMEOUT|OUTPUT_LIMIT|SIGNAL|EXIT|FAILED))$/.test(
          code,
        ))
    )
      return "outcome-unknown";
    if (code === "connection-stale") return "conflict";
    if (code === "recovered-workspace-sync-held") return "recovery-copy-held";
    if (
      code === "connection-identity-changed" ||
      code === "workspace-binding-mismatch"
    )
      return "identity-changed";
    if (error instanceof z.ZodError) return "invalid-input";
    return "local-error";
  }
  private failed(error: unknown, prior: Profile | null): SyncConnectionAction {
    const reason = this.reason(error);
    return {outcome: reason === "outcome-unknown" ? "outcome-unknown" : "held",
      view: {...this.describe(prior, false), state: "held", reason}};
  }
  /** Refuse a pending profile that cannot match an existing device sidecar.
   * Missing sidecars keep the new-workspace path; malformed or copied bindings
   * must not replace the current profile or reach encryption. */
  private assertExistingWorkspaceBinding(path: string,
    config: {workspaceId: string; clientId: string; bindingId: string}): void {
    const sidecar = join(dirname(realpathSync(path)), ".folio-sync-binding");
    try { lstatSync(sidecar); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new SyncError("workspace-binding-mismatch", 409);
    }
    try { verifyWorkspaceBinding(path, config, false); }
    catch (error) {
      if (error instanceof SyncError && error.code.startsWith("workspace-binding-")) throw error;
      throw new SyncError("workspace-binding-mismatch", 409);
    }
  }
  view(path: string): SyncConnectionView {
    try {return this.ledger(path, (db, binding) => this.describe(this.profile(db.read(binding.key))));}
    catch (error) {return {...emptyView(), state: "held", reason: this.reason(error)};}
  }
  private requestKey(profileKey: string, requestId: string) {uuid.parse(requestId); return profileKey + ":request:" + requestId;}
  configure(path: string, value: SyncConnectionInput): SyncConnectionAction {
    let prior: Profile | null = null;
    try {
      return this.ledger(path, (db, binding) => {
        const input = syncConnectionInputSchema.parse(value), requestKey = this.requestKey(binding.key, input.requestId);
        const fingerprint = sha256(canonicalJson(input, 8192));
        const oldRaw = db.read(binding.key); prior = this.profile(oldRaw);
        const previous = db.read(requestKey);
        if (previous) {
          const receipt = receiptSchema.parse(JSON.parse(previous));
          requireCondition(receipt.kind === "configure" && receipt.fingerprint === fingerprint, "connection-stale", 409);
          return {outcome: receipt.outcome, view: this.describe(prior)};
        }
        requireCondition((prior?.revision ?? null) === input.expectedRevision, "connection-stale", 409);
        const sameDevice = prior?.config?.workspaceId === input.workspaceId && prior.config.clientId === input.clientId && input.mode !== "recover";
        const config = {baseUrl: new URL(input.baseUrl).origin, workspaceId: input.workspaceId, clientId: input.clientId,
          bindingId: sameDevice ? prior!.config!.bindingId : randomUUID(), mode: input.mode};
        this.assertExistingWorkspaceBinding(path, config);
        const nonce = prior?.nonce ?? randomUUID();
        const ciphertext = sealConnectionToken(this.options.safeStorage, this.options.platform ?? process.platform,
          {profileKey: binding.hash, nonce, targetHash: sha256(canonicalJson(config))}, input.token);
        const next: Profile = {nonce, config, ciphertext, enabled: true, activated: false, revision: input.requestId};
        this.commit(db, () => {
          requireCondition(this.binding(path).key === binding.key && db.read(binding.key) === oldRaw && db.read(requestKey) === null, "connection-stale", 409);
          this.assertExistingWorkspaceBinding(path, config);
          db.write(binding.key, canonicalJson(next));
          db.write(requestKey, canonicalJson({fingerprint, kind: "configure", outcome: "saved", revision: next.revision}));
        });
        return {outcome: "saved", view: this.describe(next)};
      });
    } catch (error) {return this.failed(error, prior);}
  }
  disable(path: string, requestId: string, expectedRevision: string | null): SyncConnectionAction {
    let prior: Profile | null = null;
    try {
      return this.ledger(path, (db, binding) => {
        uuid.parse(requestId); if (expectedRevision !== null) uuid.parse(expectedRevision);
        const key = this.requestKey(binding.key, requestId), fingerprint = sha256(canonicalJson({kind: "disable", requestId, expectedRevision}));
        const oldRaw = db.read(binding.key); prior = this.profile(oldRaw);
        const previous = db.read(key);
        if (previous) {
          const receipt = receiptSchema.parse(JSON.parse(previous));
          requireCondition(receipt.kind === "disable" && receipt.fingerprint === fingerprint, "connection-stale", 409);
          return {outcome: receipt.outcome, view: this.describe(prior, false)};
        }
        requireCondition((prior?.revision ?? null) === expectedRevision, "connection-stale", 409);
        const next: Profile = {nonce: prior?.nonce ?? randomUUID(), config: prior?.config ?? null,
          revision: requestId, ciphertext: null, enabled: false, activated: false};
        this.commit(db, () => {
          requireCondition(this.binding(path).key === binding.key && db.read(binding.key) === oldRaw && db.read(key) === null, "connection-stale", 409);
          db.write(binding.key, canonicalJson(next));
          db.write(key, canonicalJson({fingerprint, kind: "disable", outcome: "disabled", revision: requestId}));
        });
        return {outcome: "disabled", view: this.describe(next, false)};
      });
    } catch (error) {return this.failed(error, prior);}
  }
  resolve(path: string, requestId: string): SyncConnectionAction | null {
    return this.ledger(path, (db, binding) => {
      const value = db.read(this.requestKey(binding.key, requestId));
      if (value === null) return null;
      const receipt = receiptSchema.parse(JSON.parse(value));
      return {outcome: receipt.outcome, view: this.describe(this.profile(db.read(binding.key)))};
    });
  }
  load(path: string): LoadedSyncConnection | null {
    return this.ledger(path, (db, binding) => {
      const profile = this.profile(db.read(binding.key));
      if (!profile?.enabled) return null;
      const config = profile.config!;
      if (profile.activated) verifyWorkspaceBinding(path, config, false);
      const token = openConnectionToken(this.options.safeStorage, this.options.platform ?? process.platform,
        {profileKey: binding.hash, nonce: profile.nonce, targetHash: sha256(canonicalJson(config))}, profile.ciphertext!);
      return {...config, revision: profile.revision, token, mode: profile.activated ? undefined : config.mode};
    });
  }
  markActivated(path: string, revision: string): void {
    this.ledger(path, (db, binding) => this.commit(db, () => {
      const profile = this.profile(db.read(binding.key));
      requireCondition(profile?.enabled && profile.revision === revision, "connection-stale", 409);
      verifyWorkspaceBinding(path, profile.config!, false);
      db.write(binding.key, canonicalJson({...profile, activated: true}));
    }));
  }
}
