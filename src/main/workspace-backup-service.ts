import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createFullBackup } from "../persistence/full-backup-create";
import { verifyFullBackup } from "../persistence/full-backup-verify";
import { restoreFullBackup } from "../persistence/full-backup-restore";
import type { BackupPreview, BackupRestored, VerifiedWorkspaceBackup } from "../shared/workspace-backup";
import { estimateBackupBytes, estimateRestoreBytes } from "./bulk-storage-budget";

/** Paths originate only in the main process/native chooser. Renderer tickets
 * pin the exact verified manifest and never grant arbitrary filesystem access. */
export class WorkspaceBackupService {
  private tickets = new Map<string, {canonical: string; verified: VerifiedWorkspaceBackup; restored: boolean; opened: boolean}>();
  constructor(private db: DatabaseSync, private directory: string,
    private readonly admission: {beforeCreate?: (additionalBytes: number) => void; beforeRestore?: (parent: string, additionalBytes: number) => void} = {}) {}

  private preview(verified: VerifiedWorkspaceBackup, restored = false): BackupPreview {
    const ticket = randomUUID();
    this.tickets.set(ticket, {canonical: realpathSync(verified.directory), verified, restored, opened: false});
    const manifest = verified.manifest;
    return {ticket, directory: verified.directory, createdAt: manifest.createdAt,
      inventory: manifest.inventory,
      bytes: manifest.database.bytes + manifest.assets.reduce((total, file) => total + file.bytes, 0)};
  }
  create(prefix = "workspace"): BackupPreview {
    // Covers automatic rich-document/layout backups as well as manual ones.
    // The estimate runs before the destination directory or files exist.
    const beforeCreate = this.admission.beforeCreate;
    if (beforeCreate)
      beforeCreate(estimateBackupBytes(this.db, this.directory));
    const root = join(this.directory, "backups");
    mkdirSync(root, {recursive: true});
    return this.preview(createFullBackup(this.db, this.directory, join(root, `${prefix}-${Date.now()}-${randomUUID()}`)));
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
  choose(directory: string): BackupPreview {return this.preview(verifyFullBackup(directory));}
  restore(ticket: string, parent: string): BackupRestored {
    const source = this.tickets.get(ticket);
    if (!source) throw new Error("バックアップをもう一度選んで検証してください。");
    // Restore is rescue into another location: inspect its volume, not the
    // source workspace's potentially full volume, before creating a target.
    // The byte estimate is computed only when an admission hook is installed.
    const beforeRestore = this.admission.beforeRestore;
    if (beforeRestore)
      beforeRestore(parent, estimateRestoreBytes(source.verified));
    const destination = join(parent, `Folio-restored-${Date.now()}-${randomUUID()}`);
    restoreFullBackup(source.verified.directory, destination, source.verified.fingerprint);
    return {...this.preview(verifyFullBackup(destination), true), sourceDirectory: source.verified.directory};
  }
  async open(ticket: string, launch: (directory: string) => Promise<void>): Promise<void> {
    const entry = this.tickets.get(ticket);
    if (!entry?.restored) throw new Error("この操作で復元した保存先だけを開けます。");
    if (entry.opened) throw new Error("復元先は既に開いています。");
    const verified = verifyFullBackup(entry.verified.directory);
    if (verified.fingerprint !== entry.verified.fingerprint) throw new Error("復元先が変更されています。起動を停止しました。");
    await launch(verified.directory);
    entry.opened = true;
  }
}
