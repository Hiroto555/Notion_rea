import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Request } from "../shared/types";
import { WorkspaceLimitSettings } from "../persistence/workspace-limit-settings";
import { createRawWorkspaceSalvage } from "../persistence/raw-workspace-salvage";
import { estimateBackupBytes } from "./bulk-storage-budget";
import { WorkspaceStoragePressure } from "./storage-pressure";
import { assertRequestStorage } from "./storage-write-policy";
import { OrphanMaintenance } from "./orphan-maintenance";
import { WorkspaceMaintenance } from "./workspace-maintenance";
import { WorkspaceBackupService } from "./workspace-backup-service";
import { growthLimitsFromEnv, WorkspaceGrowth } from "./workspace-growth";
import { makeStorageOverviewReader } from "./storage-overview-reader";

type StoragePicker = (
  title: string,
  create?: boolean,
  file?: boolean,
) => Promise<string | null>;

/** Owns admission and maintenance at the main-process boundary. The picker
 * supplies trusted local paths; a renderer can supply only a request or ticket. */
export class WorkspaceStorageService {
  readonly backups: WorkspaceBackupService;
  private readonly pressure: WorkspaceStoragePressure;
  private readonly maintenance: WorkspaceMaintenance;
  private orphans?: OrphanMaintenance;
  private orphanTicket?: string;
  private readonly readOverview: ReturnType<typeof makeStorageOverviewReader>;
  private readonly settings?: WorkspaceLimitSettings;

  constructor(
    private readonly directory: string,
    private readonly db: DatabaseSync,
    env: Record<string, string | undefined>,
    private readonly pick: StoragePicker,
    workerPath?: string,
  ) {
    this.pressure = new WorkspaceStoragePressure(directory);
    this.readOverview = makeStorageOverviewReader(
      join(directory, "workspace.sqlite"),
      workerPath,
    );
    // Misconfigured limits must leave read/diagnostic/rescue paths accessible.
    try {
      this.settings = new WorkspaceLimitSettings(db, growthLimitsFromEnv(env));
    } catch {
      /* Surface invalid operator settings when queried; rescue stays available. */
    }
    this.backups = new WorkspaceBackupService(db, directory, {
      beforeCreate: (bytes) => this.admitBackup(bytes),
      beforeRestore: (parent, bytes) =>
        new WorkspaceStoragePressure(parent).assertWritable(bytes),
    });
    this.maintenance = new WorkspaceMaintenance(directory, (source) =>
      this.backups.isPinned(source),
    );
  }

  private limitSettings() {
    if (!this.settings)
      throw new Error(
        "容量上限の設定を確認してください (workspace-limit-unknown)。",
      );
    return this.settings;
  }

  private policy() {
    return new WorkspaceGrowth(
      this.directory,
      this.db,
      this.limitSettings().read().effective,
    );
  }

  admitRequest(req: Request) {
    assertRequestStorage(req, {
      assertWritable: () => {
        this.pressure.assertWritable();
        if (req.type === "backup" || req.type === "workspaceBackup:create")
          return;
        const policy = this.policy();
        policy.assertDatabaseWritable();
        switch (req.type) {
          case "save:commit":
          case "page:commit":
          case "database:commit":
          case "migration:commit":
          case "property:commit":
            policy.assertReceiptWritable(req.operation.operationId);
        }
      },
    });
  }

  admitAttachment(bytes: number) {
    this.pressure.assertWritable(bytes);
    const policy = this.policy();
    policy.assertDatabaseWritable();
    policy.assertAssetGrowth(bytes);
  }

  private admitBackup(bytes: number) {
    this.pressure.assertWritable(bytes);
    this.policy().assertBackupGrowth(bytes);
  }

  admitSnapshot() {
    this.admitBackup(estimateBackupBytes(this.db, this.directory));
  }

  resetTickets() {
    this.backups.releaseTickets();
    this.maintenance.clear();
    this.orphanTicket = undefined;
    this.orphans?.clear();
  }

  handleUtility(req: Request): Promise<unknown> | undefined {
    switch (req.type) {
      case "storage:pressure":
        return Promise.resolve(this.pressure.inspect());
      case "storage:overview":
        return this.readOverview().then((report) => {
          try {
            return { ...report, limits: this.limitSettings().read().effective };
          } catch {
            return { ...report, limits: null };
          }
        });
      case "storage:readLimits":
        return Promise.resolve(this.limitSettings().read());
      case "storage:applyLimits":
        // Raising a full DB's own limit must work. The physical reserve and
        // SQLite failures still stop this small, explicit settings write.
        assertRequestStorage(req, this.pressure);
        return Promise.resolve(
          this.limitSettings().apply(req.expectedRevision, req.configured),
        );
      case "workspaceBackup:release":
        this.backups.releaseTickets();
        return Promise.resolve(true);
      case "storage:archivePlan":
        this.maintenance.clear();
        return this.pick("退避する古い完全バックアップを選択").then((source) =>
          source ? this.maintenance.choose(source) : null,
        );
      case "storage:archiveMove":
        this.maintenance.check(req.ticket);
        return this.pick(
          "同じボリューム上のワークスペース外の移動先を選択",
          true,
        ).then((parent) =>
          parent ? this.maintenance.move(req.ticket, parent) : null,
        );
      case "storage:orphanPlan":
        this.orphans?.clear();
        this.orphanTicket = undefined;
        return this.pick(
          "添付フォルダー内の台帳外ファイルを選択",
          false,
          true,
        ).then((source) => {
          if (!source) return null;
          const maintenance = new OrphanMaintenance(this.db, this.directory);
          const plan = maintenance.plan(source);
          this.orphans = maintenance;
          this.orphanTicket = plan.ticket;
          return plan;
        });
      case "storage:orphanMove":
        if (req.ticket !== this.orphanTicket)
          throw new Error("ファイルを選び直してください。");
        return this.pick(
          "同じボリューム上のワークスペース外の移動先を選択",
          true,
        ).then((parent) => {
          if (!parent) return null;
          if (!this.orphans || req.ticket !== this.orphanTicket)
            throw new Error("ファイルを選び直してください。");
          this.orphanTicket = undefined;
          return this.orphans.move(req.ticket, parent);
        });
      case "storage:rawSalvage":
        return this.pick("診断用の原本を救出する保存先を選択", true).then(
          (parent) => {
            if (!parent) return null;
            return createRawWorkspaceSalvage(
              this.db,
              this.directory,
              parent,
              (journalBytes) => {
                const estimate =
                  estimateBackupBytes(this.db, this.directory) + journalBytes;
                new WorkspaceStoragePressure(parent).assertWritable(estimate);
              },
            );
          },
        );
      default:
        return undefined;
    }
  }
}
