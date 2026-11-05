import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { estimateBackupBytes } from "../main/bulk-storage-budget";
import { WorkspaceStoragePressure } from "../main/storage-pressure";
import { createFullBackup } from "../persistence/full-backup-create";
import { readUserVersion } from "../persistence/schema-startup";
import type { Store } from "../persistence/store";
import { CheckpointRemote } from "./client";
import {
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
import { validateWorkspaceCheckpoint } from "./workspace-checkpoint";
import { WorkspaceSyncStore } from "./workspace-store";

type WorkspaceSyncOptions = WorkspaceDevice & {
  store: Store;
  baseUrl: string;
  token: string;
  mode?: "publish" | "join";
  canApply: () => boolean;
  timeoutMs?: number;
  admitBytes?: (bytes: number) => void;
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
  private readonly admitBytes: (bytes: number) => void;
  private readonly remote: CheckpointRemote;

  private constructor(
    private readonly options: WorkspaceSyncOptions,
    private readonly local: WorkspaceSyncStore,
    remote: CheckpointRemote,
  ) {
    this.directory = dirname(options.store.path);
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
    requireCondition(
      version === 5 || options.mode === "publish" || options.mode === "join",
      "explicit-sync-opt-in-required",
    );
    requireCondition(
      options.mode === undefined ||
        options.mode === "publish" ||
        options.mode === "join",
      "invalid-sync-mode",
    );
    // Check before any authenticated request. A restored v5 backup has no
    // live binding, including when a caller passes the old credentials.
    if (version === 5)
      verifyWorkspaceBinding(options.store.path, options, false);
    const remote = new CheckpointRemote(options);
    const { serverEpoch } = await remote.head();
    const local = new WorkspaceSyncStore(options.store, {
      workspaceId: options.workspaceId,
      clientId: options.clientId,
      bindingId: options.bindingId,
      serverEpoch,
    });
    const sync = new WorkspaceSync(options, local, remote);
    if (version === 5) {
      local.status();
    } else {
      local.enable(options.mode!, () => {
        sync.backup("before-enable");
        verifyWorkspaceBinding(options.store.path, options, true);
      });
    }
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
    for (const change of page.changes)
      requireCondition(
        validateWorkspaceCheckpoint(change.checkpoint),
        "checkpoint-schema-rejected",
        422,
      );
    this.local.stageChanges(page);
  }

  private async apply(change: Change, resolving: boolean): Promise<boolean> {
    if (this.options.canApply() !== true) return false;
    await stageCheckpointAssets(
      this.transferOptions(),
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
    this.admitBytes(Buffer.byteLength(JSON.stringify(change.checkpoint)));
    // Invalidate before applying. A lost SQLite COMMIT acknowledgement must
    // also leave pre-apply editor requests stale.
    this.epoch++;
    const assertAssets = (assets: Change["checkpoint"]["assets"]) =>
      assertWorkspaceAssets(this.assetsDirectory, assets);
    if (resolving) this.local.chooseRemote(change, assertAssets);
    else this.local.applyNext(change, assertAssets);
    return true;
  }

  private backup(reason: "before-enable" | "before-apply"): void {
    const { store } = this.options;
    this.admitBytes(estimateBackupBytes(store.db, this.directory));
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
      admitBytes: this.admitBytes,
    };
  }
}

export const openWorkspaceSync = WorkspaceSync.open;
