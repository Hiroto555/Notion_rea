import {startupRetainsNativeLease} from "../persistence/startup-connection-owner";
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
import type { PrivatePersistenceOptions } from "../platform/private-persistence";
import type { NativePrivateFile } from "../platform/private-persistence";
import {readBackupManifestSelection} from "../persistence/full-backup-verify";
import {requireCondition} from "../sync/protocol";
import {types} from "node:util";
import {assertPrivateOperationAuthority} from "../platform/private-operation-authority";
import type {NativeMaintenance} from "./windows-maintenance-selection";

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
  private orphanExpected?: NativePrivateFile;
  private readonly readOverview: ReturnType<typeof makeStorageOverviewReader>;
  private readonly settings?: WorkspaceLimitSettings;

  constructor(
    private readonly directory: string,
    private readonly db: DatabaseSync,
    env: Record<string, string | undefined>,
    private readonly pick: StoragePicker,
    workerPath?: string,
    persistence?: PrivatePersistenceOptions,
    private readonly admitSelectedBackup?: (selection: {directory: string; manifestPath: string; manifestSha256: string}, current: () => void) => void,
    private readonly nativeMaintenance?: NativeMaintenance,
  ) {
    this.pressure = new WorkspaceStoragePressure(directory);
    this.readOverview = makeStorageOverviewReader(
      join(directory, "workspace.sqlite"),
      workerPath,
    );
    // Misconfigured limits must leave read/diagnostic/rescue paths accessible.
    try {
      this.settings = new WorkspaceLimitSettings(db, growthLimitsFromEnv(env));
    } catch (error) {
      if (startupRetainsNativeLease(error)) throw error;
      /* Surface invalid operator settings when queried; rescue stays available. */
    }
    this.backups = new WorkspaceBackupService(db, directory, {
      beforeCreate: (bytes) => this.admitBackup(bytes),
      beforeRestore: (parent, bytes) =>
        new WorkspaceStoragePressure(parent).assertWritable(bytes),
    }, persistence, admitSelectedBackup, nativeMaintenance);
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

  admitSyncWrite(bytes: number, purpose: "content" | "assets" | "backup") {
    if (purpose === "assets") return this.admitAttachment(bytes);
    if (purpose === "backup") return this.admitBackup(bytes);
    this.pressure.assertWritable(bytes);
    this.policy().assertDatabaseWritable();
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
    this.orphanExpected = undefined;
    this.orphans?.clear();
  }

  handleUtility(req: Request, authorized: () => boolean = () => true): Promise<unknown> | undefined {
    const current = () => {
      requireCondition(!types.isAsyncFunction(authorized) && !types.isGeneratorFunction(authorized) && authorized() === true, "unauthorized", 403);
      assertPrivateOperationAuthority();
    };
    switch (req.type) {
      case "storage:pressure":
        return Promise.resolve(this.pressure.inspect());
      case "storage:overview":
        return this.readOverview().then((report) => {
          current();
          try {
            return { ...report, limits: this.limitSettings().read().effective };
          } catch (error) {
            if (startupRetainsNativeLease(error)) throw error;
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
        return this.pick("退避する古い完全バックアップを選択").then((source) => {
          if (!source) return null; current();
          if (this.nativeMaintenance)
            return this.nativeMaintenance.withScope(
              {kind: "backup-source", source: {directory: source, ...readBackupManifestSelection(source)}},
              current, () => this.maintenance.choose(source));
          if (this.admitSelectedBackup) this.admitSelectedBackup({directory: source, ...readBackupManifestSelection(source)}, current);
          current(); return this.maintenance.choose(source);
        });
      case "storage:archiveMove":
        this.maintenance.check(req.ticket);
        return this.pick(
          "同じボリューム上のワークスペース外の移動先を選択",
          true,
        ).then((parent) => {
          if (!parent) return null; current();
          // Re-check the ticket AFTER the picker await and re-read the exact
          // retained source manifest; no stale pre-await selection is reused.
          const plan = this.maintenance.check(req.ticket);
          if (this.nativeMaintenance)
            return this.nativeMaintenance.withScope(
              {kind: "backup-archive", parent,
                source: {directory: plan.source, ...readBackupManifestSelection(plan.source)}},
              current, () => this.maintenance.move(req.ticket, parent));
          return this.maintenance.move(req.ticket, parent);
        });
      case "storage:orphanPlan":
        this.orphans?.clear();
        this.orphanTicket = undefined;
        this.orphanExpected = undefined;
        return this.pick(
          "添付フォルダー内の台帳外ファイルを選択",
          false,
          true,
        ).then((source) => {
          if (!source) return null;
          current();
          const expected = this.nativeMaintenance?.admitOrphan(source, current);
          const planOperation = () => {
            // Constructed under the stable forwarding facade so the captured
            // port resolves the SELECTED capability filesystem at move time.
            const maintenance = new OrphanMaintenance(this.db, this.directory);
            const plan = maintenance.plan(source);
            this.orphans = maintenance;
            this.orphanTicket = plan.ticket;
            this.orphanExpected = expected;
            return plan;
          };
          return this.nativeMaintenance
            ? this.nativeMaintenance.withOrphan(planOperation)
            : planOperation();
        });
      case "storage:orphanMove":
        if (req.ticket !== this.orphanTicket)
          throw new Error("ファイルを選び直してください。");
        return this.pick(
          "同じボリューム上のワークスペース外の移動先を選択",
          true,
        ).then((parent) => {
          if (!parent) return null;
          current();
          if (!this.orphans || req.ticket !== this.orphanTicket)
            throw new Error("ファイルを選び直してください。");
          const orphans = this.orphans, expected = this.orphanExpected;
          this.orphanTicket = undefined;
          this.orphanExpected = undefined;
          if (this.nativeMaintenance && expected)
            return this.nativeMaintenance.withScope(
              {kind: "orphan-archive", file: expected, parent},
              current, () => orphans.move(req.ticket, parent));
          return orphans.move(req.ticket, parent);
        });
      case "storage:rawSalvage":
        return this.pick("診断用の原本を救出する保存先を選択", true).then(
          (parent) => {
            if (!parent) return null;
            current();
            const salvage = () => createRawWorkspaceSalvage(
              this.db,
              this.directory,
              parent,
              (journalBytes) => {
                current();
                const estimate =
                  estimateBackupBytes(this.db, this.directory) + journalBytes;
                new WorkspaceStoragePressure(parent).assertWritable(estimate);
              },
            );
            return this.nativeMaintenance
              ? this.nativeMaintenance.withScope({kind: "raw-rescue", parent}, current, salvage)
              : salvage();
          },
        );
      default:
        return undefined;
    }
  }
}
