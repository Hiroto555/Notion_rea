import { join } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { archiveBackup, planBackupArchive } from "./backup-maintenance";
import type { ArchiveProposal } from "../shared/storage-overview";

/** The renderer receives an expiring ticket. Source and destination paths
 * come exclusively from main-process directory choosers. */
export class WorkspaceMaintenance {
  private plan?: {
    ticket: string;
    source: string;
    name: string;
    fingerprint: string;
    expires: number;
  };
  constructor(
    private readonly workspace: string,
    private readonly isPinned: (source: string) => boolean,
  ) {}

  choose(source: string): ArchiveProposal {
    this.clear();
    const { name, bytes, fingerprint } = planBackupArchive(
      this.workspace,
      source,
      this.isPinned,
    );
    const ticket = randomUUID();
    this.plan = {
      ticket,
      source: join(realpathSync(this.workspace), "backups", name),
      name,
      fingerprint,
      expires: Date.now() + 10 * 60_000,
    };
    return { name, bytes, ticket };
  }

  check(ticket: string) {
    const plan = this.plan;
    if (!plan || plan.ticket !== ticket || plan.expires <= Date.now())
      throw new Error("バックアップを選び直してください。");
    return plan;
  }

  move(ticket: string, parent: string) {
    const { source, name, fingerprint } = this.check(ticket);
    this.clear();
    const archive = archiveBackup(
      this.workspace,
      source,
      parent,
      fingerprint,
      this.isPinned,
    );
    return { destination: join(archive.destination, name) };
  }

  clear() {
    this.plan = undefined;
  }
}
