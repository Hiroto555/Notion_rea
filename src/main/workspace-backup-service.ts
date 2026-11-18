import {assertPrivateOperationAuthority} from "../platform/private-operation-authority";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createFullBackup } from "../persistence/full-backup-create";
import { readBackupManifestSelection, verifyFullBackup } from "../persistence/full-backup-verify";
import { restoreFullBackup } from "../persistence/full-backup-restore";
import type { BackupPreview, BackupRestored, VerifiedWorkspaceBackup } from "../shared/workspace-backup";
import { estimateBackupBytes, estimateRestoreBytes } from "./bulk-storage-budget";
import { assertBackupRetention } from "../sync/backup-retention";
import { privatePersistencePort, withPrivatePersistence, type PrivatePersistenceOptions } from "../platform/private-persistence";
import {requireCondition} from "../sync/protocol";
import {types} from "node:util";
import type {NativeMaintenance, BackupSelection, PreparedRestoreHandoff} from "./windows-maintenance-selection";

/** Trusted launch boundary: the third argument is the per-invocation
 * observation mark; callbacks with fewer parameters stay compatible. */
export type WorkspaceOpenLaunch =
  (directory: string, handoff?: PreparedRestoreHandoff, markStarted?: () => void) => Promise<void>;
export type WorkspaceOpenTerminal =
  | Readonly<{terminal: "RETURNED"; value: undefined; launchStarted: boolean}>
  | Readonly<{terminal: "THREW"; value: unknown; launchStarted: boolean}>;
/** Paths originate only in the main process/native chooser. Renderer tickets
 * pin the exact verified manifest and never grant arbitrary filesystem access. */
export class WorkspaceBackupService {
  private tickets = new Map<string, {canonical: string; verified: VerifiedWorkspaceBackup; selection: BackupSelection; restored: boolean; opened: boolean; blocked?: boolean}>();
  constructor(private db: DatabaseSync, private directory: string,
    private readonly admission: {beforeCreate?: (additionalBytes: number) => void; beforeRestore?: (parent: string, additionalBytes: number) => void} = {},
    private readonly persistenceOptions?: PrivatePersistenceOptions,
    private readonly admitSelectedBackup?: (selection: {directory: string; manifestPath: string; manifestSha256: string}, current: () => void) => void,
    private readonly nativeMaintenance?: NativeMaintenance) {}

  private preview(verified: VerifiedWorkspaceBackup, restored = false): BackupPreview {
    const ticket = randomUUID();
    this.tickets.set(ticket, {canonical: realpathSync(verified.directory), verified,
      selection: {directory: verified.directory, manifestPath: join(verified.directory, "manifest.json"), manifestSha256: verified.fingerprint},
      restored, opened: false});
    const manifest = verified.manifest;
    return {ticket, directory: verified.directory, createdAt: manifest.createdAt,
      inventory: manifest.inventory,
      bytes: manifest.database.bytes + manifest.assets.reduce((total, file) => total + file.bytes, 0)};
  }
  create(prefix = "workspace"): BackupPreview {
    return withPrivatePersistence(this.persistenceOptions, () => {
    // Covers automatic rich-document/layout backups as well as manual ones.
    // The estimate runs once before the destination directory or files exist.
    const estimatedBytes = estimateBackupBytes(this.db, this.directory);
    const beforeCreate = this.admission.beforeCreate;
    if (beforeCreate) beforeCreate(estimatedBytes);
    assertBackupRetention(this.directory, estimatedBytes);
    const root = join(this.directory, "backups");
    const native = privatePersistencePort();
    if (native) {
      if (existsSync(root)) native.inspectDirectory(root);
      else native.createDirectory(root);
    } else mkdirSync(root, {recursive: true, mode: 0o700});
    return this.preview(createFullBackup(this.db, this.directory, join(root, `${prefix}-${Date.now()}-${randomUUID()}`)));
    });
  }
  createAutomatic(prefix: string): void {
    const preview = this.create(prefix);
    this.tickets.delete(preview.ticket);
  }
  isPinned(canonical: string): boolean {
    for (const entry of this.tickets.values()) if (entry.canonical === canonical) return true;
    return false;
  }
  releaseTickets(): void { this.tickets.clear(); }
  choose(directory: string): BackupPreview {return withPrivatePersistence(this.persistenceOptions, () => {
    assertPrivateOperationAuthority();
    const selected = {directory, ...readBackupManifestSelection(directory)};
    if (this.nativeMaintenance)
      return this.nativeMaintenance.withScope({kind: "backup-source", source: selected},
        assertPrivateOperationAuthority, () => this.preview(verifyFullBackup(directory)));
    if (this.admitSelectedBackup) this.admitSelectedBackup(selected, assertPrivateOperationAuthority);
    assertPrivateOperationAuthority();
    return this.preview(verifyFullBackup(directory));
  });}
  restore(ticket: string, parent: string, current: () => void = assertPrivateOperationAuthority): BackupRestored {
    return withPrivatePersistence(this.persistenceOptions, () => {
    const source = this.tickets.get(ticket);
    if (!source) throw new Error("バックアップをもう一度選んで検証してください。");
    current();
    const work = () => {
    // Re-read the exact manifest the ticket was verified against; a changed
    // path or hash rejects the restore rather than following new bytes.
    if (this.nativeMaintenance) {
      const reread = readBackupManifestSelection(source.verified.directory);
      if (reread.manifestPath !== source.selection.manifestPath ||
        reread.manifestSha256 !== source.selection.manifestSha256)
        throw new Error("選択したバックアップが変更されています。選び直してください。");
    }
    // Restore is rescue into another location: inspect its volume, not the
    // source workspace's potentially full volume, before creating a target.
    // The byte estimate is computed only when an admission hook is installed.
    const beforeRestore = this.admission.beforeRestore;
    if (beforeRestore)
      beforeRestore(parent, estimateRestoreBytes(source.verified));
    // Re-check authority after the host hook and before the first native
    // mutation; a hook must not be able to smuggle a stale operation on.
    current();
    const destination = join(parent, `Folio-restored-${Date.now()}-${randomUUID()}`);
    restoreFullBackup(source.verified.directory, destination, source.verified.fingerprint);
    const restored = {...this.preview(verifyFullBackup(destination), true), sourceDirectory: source.verified.directory};
    current();
    return restored;
    };
    if (this.nativeMaintenance)
      return this.nativeMaintenance.withScope({kind: "restore-target", source: source.selection, parent},
        current, work);
    current();
    return work();
    });
  }
  async restoreAfterPicker(ticket: string, pick: () => Promise<string | null>, authorized: () => boolean, current?: () => void): Promise<BackupRestored | null> {
    const parent = await pick();
    if (!parent) return null;
    const fence = () => {
      requireCondition(!types.isAsyncFunction(authorized) && !types.isGeneratorFunction(authorized) && authorized() === true, "unauthorized", 403);
      assertPrivateOperationAuthority();
      current?.();
    };
    fence();
    return this.restore(ticket, parent, fence);
  }
  /** Terminal observation of one open attempt. The frozen record carries the
   * exact original thrown value — primitive or aggregate cleanup alike — and
   * whether this invocation actually reached the injected launch boundary.
   * The mark stops accepting signals once the terminal is finalized. Not a
   * renderer DTO; Main consumption arrives with U4-U9. */
  async openObserved(ticket: string, launch: WorkspaceOpenLaunch): Promise<WorkspaceOpenTerminal> {
    let launchStarted = false, finalized = false;
    const markStarted = () => { if (!finalized) launchStarted = true; };
    try {
      await this.openCore(ticket, launch, markStarted);
      finalized = true;
      return Object.freeze({terminal: "RETURNED", value: undefined, launchStarted});
    } catch (error) {
      finalized = true;
      return Object.freeze({terminal: "THREW", value: error, launchStarted});
    }
  }
  async open(ticket: string, launch: WorkspaceOpenLaunch): Promise<void> {
    const terminal = await this.openObserved(ticket, launch);
    if (terminal.terminal === "THREW") throw terminal.value;
  }
  private async openCore(ticket: string, launch: WorkspaceOpenLaunch, markStarted: () => void): Promise<void> {
    return withPrivatePersistence(this.persistenceOptions, async () => {
    const entry = this.tickets.get(ticket);
    if (!entry?.restored) throw new Error("この操作で復元した保存先だけを開けます。");
    if (entry.opened || entry.blocked) throw new Error("復元先は既に開いています。");
    const maintenance = this.nativeMaintenance;
    if (maintenance?.prepareRestored && maintenance.checkRestored) {
      // Verify before any restore-startup metadata is created. Reserve the
      // ticket once: partial preparation or an uncertain spawn never licenses
      // another state directory, enrollment or launch attempt.
      const verified = maintenance.withScope({kind: "backup-source", source: entry.selection},
        assertPrivateOperationAuthority, () => verifyFullBackup(entry.verified.directory));
      if (verified.fingerprint !== entry.verified.fingerprint) throw new Error("復元先が変更されています。起動を停止しました。");
      entry.blocked = true;
      let handoff: PreparedRestoreHandoff | undefined, failure: unknown, failed = false;
      try {
        handoff = maintenance.prepareRestored(verified, assertPrivateOperationAuthority, ticket);
        maintenance.checkRestored(handoff, assertPrivateOperationAuthority);
        await launch(verified.directory, handoff, markStarted);
        assertPrivateOperationAuthority();
        entry.opened = true;
      } catch (error) {failure = error; failed = true;}
      try {handoff?.close();} catch (cleanup) {
        if (failed) throw new AggregateError([failure, cleanup], "Restored launch and protector cleanup failed");
        throw cleanup;
      }
      if (failed) throw failure;
      return;
    }
    const verified = verifyFullBackup(entry.verified.directory);
    if (verified.fingerprint !== entry.verified.fingerprint) throw new Error("復元先が変更されています。起動を停止しました。");
    // A failed or uncertain POSIX launch must never be retried with this ticket.
    entry.blocked = true;
    await launch(verified.directory, undefined, markStarted);
    entry.opened = true;
    });
  }
}
