import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { estimateBackupBytes } from "../main/bulk-storage-budget";
import { WorkspaceStoragePressure } from "../main/storage-pressure";
import { createFullBackup } from "../persistence/full-backup-create";
import { readUserVersion } from "../persistence/schema-startup";
import type { Store } from "../persistence/store";
import { CheckpointRemote } from "./client";
import {
  canonicalJson,
  hashCheckpoint,
  requireCondition,
  type Change,
  type Commit,
} from "./protocol";
import {
  assertWorkspaceAssets,
  stageCheckpointAssets,
  uploadCheckpointAssets,
} from "./workspace-blobs";
import {
  verifyWorkspaceBinding,
  type WorkspaceDevice,
} from "./workspace-binding";
import { WorkspaceSyncStore } from "./workspace-store";

export type WorkspaceSyncAdmission = (
  bytes: number,
  purpose: "content" | "assets" | "backup",
) => void;

type WorkspaceSyncOptions = WorkspaceDevice & {
  store: Store;
  baseUrl: string;
  token: string;
  mode?: "publish" | "join" | "recover";
  canApply: () => boolean;
  timeoutMs?: number;
  admitBytes?: WorkspaceSyncAdmission;
};

type SyncStatus = ReturnType<WorkspaceSyncStore["status"]>;

/** One Store owner. Pass a synchronous clean check at the host's write
 * boundary. While the editor is active, that boundary must also use the epoch
 * on requests and install a fresh editing session after it changes. */
export class WorkspaceSync {
  private running = false;
  private epoch = 0;
  private readonly directory: string;
  private readonly assetsDirectory: string;
  private readonly admitBytes: WorkspaceSyncAdmission;
  private readonly remote: CheckpointRemote;

  private constructor(
    private readonly options: WorkspaceSyncOptions,
    private readonly local: WorkspaceSyncStore,
    remote: CheckpointRemote,
  ) {
    this.directory = dirname(realpathSync(options.store.path));
    this.assetsDirectory = join(this.directory, "assets");
    const pressure = new WorkspaceStoragePressure(this.directory);
    this.admitBytes =
      options.admitBytes ?? ((bytes) => pressure.assertWritable(bytes));
    this.remote = remote;
  }

  static async open(options: WorkspaceSyncOptions): Promise<WorkspaceSync> {
    requireCondition(
      basename(options.store.path) === "workspace.sqlite",
      "invalid-workspace-path",
    );
    requireCondition(
      typeof options.canApply === "function",
      "edit-barrier-required",
    );
    const version = readUserVersion(options.store.db);
    const mode = options.mode;
    const recovering = mode === "recover";
    requireCondition(
      mode === undefined || mode === "publish" || mode === "join" || recovering,
      "invalid-sync-mode",
    );
    requireCondition(
      !recovering || version === 5,
      "rebind-requires-v5-workspace",
    );
    requireCondition(
      version === 5 || mode === "publish" || mode === "join",
      "explicit-sync-opt-in-required",
    );
    // A restored v5 backup has no live binding, including when a caller
    // passes the old credentials. Recovery is a separate explicit enrollment.
    if (version === 5 && !recovering)
      verifyWorkspaceBinding(options.store.path, options, false);
    const remote = new CheckpointRemote(options);
    const { serverEpoch, head } = await remote.head();
    // The receipt route is device scoped. A workspace reader's token cannot
    // enroll or run another device even when it can read this head.
    await remote.lookup(options.clientId, randomUUID());
    const local = new WorkspaceSyncStore(options.store, {
      workspaceId: options.workspaceId,
      clientId: options.clientId,
      bindingId: options.bindingId,
      serverEpoch,
    });
    const sync = new WorkspaceSync({ ...options }, local, remote);
    if (recovering) {
      local.rebindRestored(() => {
        sync.backup("before-rebind");
        verifyWorkspaceBinding(options.store.path, options, true);
      });
      verifyWorkspaceBinding(options.store.path, options, false);
    } else if (version !== 5 && (mode === "publish" || mode === "join")) {
      local.enable(mode, () => {
        sync.backup("before-enable");
        verifyWorkspaceBinding(options.store.path, options, true);
      });
    }
    const { appliedRevision, receivedCursor } = local.status();
    requireCondition(
      head.revision >= Math.max(appliedRevision, receivedCursor),
      "server-head-regressed",
      409,
    );
    return sync;
  }

  status(): SyncStatus {
    return this.local.status();
  }

  conflict() {
    return this.local.conflict();
  }

  writeEpoch(): number {
    return this.epoch;
  }

  assertWritable(epoch: number): void {
    requireCondition(epoch === this.epoch, "stale-edit-epoch", 409);
  }

  syncOnce(): Promise<SyncStatus> {
    return this.exclusive(async () => {
      const operation = this.local.prepare();
      if (operation) await this.send(operation);
      await this.receive();
      const status = this.local.status();
      if (
        status.conflict ||
        status.pending ||
        status.generation !== status.cleanGeneration
      )
        return status;
      const next = this.local.nextIncoming();
      if (next) await this.apply(next, false);
      return this.local.status();
    });
  }

  resolveConflict(
    choice: "local" | "remote",
    expectedRevision: number,
  ): Promise<SyncStatus> {
    return this.exclusive(async () => {
      const conflict = this.local.conflict();
      requireCondition(
        conflict && conflict.result.head.revision === expectedRevision,
        "conflict-head-mismatch",
        409,
      );
      requireCondition(
        this.options.canApply() === true,
        "edit-session-busy",
        409,
      );
      if (choice === "local") {
        await this.send(this.local.chooseLocal(expectedRevision));
      } else {
        requireCondition(choice === "remote", "invalid-conflict-choice");
        if (!this.local.incoming(expectedRevision)) await this.receive();
        const incoming = this.local.incoming(expectedRevision);
        requireCondition(incoming, "conflict-head-not-received", 409);
        requireCondition(
          await this.apply(incoming, true),
          "edit-session-busy",
          409,
        );
      }
      return this.local.status();
    });
  }

  private async exclusive(
    work: () => Promise<SyncStatus>,
  ): Promise<SyncStatus> {
    requireCondition(!this.running, "sync-already-running", 409);
    verifyWorkspaceBinding(this.options.store.path, this.options, false);
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }

  private async send(operation: Commit): Promise<void> {
    const receipt = await this.remote.lookup(
      operation.clientId,
      operation.operationId,
    );
    if (receipt) {
      this.local.recordResult(operation, receipt);
      return;
    }
    await uploadCheckpointAssets(
      this.transferOptions(),
      operation.checkpoint.assets,
    );
    const result = await this.remote.commit(operation);
    this.local.recordResult(operation, result);
  }

  private async receive(): Promise<void> {
    const page = await this.remote.changes(this.local.status().receivedCursor);
    if (page.changes.length)
      this.admitBytes(Buffer.byteLength(canonicalJson(page)), "content");
    this.local.stageChanges(page);
  }

  private async apply(change: Change, resolving: boolean): Promise<boolean> {
    if (this.options.canApply() !== true) return false;
    await stageCheckpointAssets(
      {
        ...this.transferOptions(),
        admitBytes: (bytes) => this.admitBytes(bytes, "assets"),
      },
      change.checkpoint.assets,
    );
    // No asynchronous gap between this clean check, the backup, and SQLite apply.
    if (this.options.canApply() !== true) return false;
    const status = this.local.status();
    if (
      !resolving &&
      (status.pending ||
        status.conflict ||
        status.generation !== status.cleanGeneration)
    )
      return false;
    requireCondition(
      change.checkpointHash === hashCheckpoint(change.checkpoint),
      "checkpoint-hash-mismatch",
      422,
    );
    this.backup("before-apply");
    this.admitBytes(
      Buffer.byteLength(JSON.stringify(change.checkpoint)),
      "content",
    );
    // Invalidate before applying. A lost SQLite COMMIT acknowledgement must
    // also leave pre-apply editor requests stale.
    this.epoch++;
    const assertAssets = (assets: Change["checkpoint"]["assets"]) =>
      assertWorkspaceAssets(this.assetsDirectory, assets);
    if (resolving) this.local.chooseRemote(change, assertAssets);
    else this.local.applyNext(change, assertAssets);
    return true;
  }

  private backup(
    reason: "before-enable" | "before-apply" | "before-rebind",
  ): void {
    const { store } = this.options;
    this.admitBytes(estimateBackupBytes(store.db, this.directory), "backup");
    const root = join(this.directory, "backups");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    createFullBackup(
      store.db,
      this.directory,
      join(root, `sync-${reason}-${Date.now()}-${randomUUID()}`),
    );
  }

  private transferOptions() {
    const { baseUrl, token, workspaceId, timeoutMs } = this.options;
    return {
      baseUrl,
      token,
      workspaceId,
      timeoutMs,
      assetsDirectory: this.assetsDirectory,
    };
  }
}

export const openWorkspaceSync = WorkspaceSync.open;
