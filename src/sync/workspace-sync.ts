import { assertRecoverySyncAllowed } from "../persistence/recovery-origin";
import type { NormalApplyRecord } from "./normal-apply-journal";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { estimateBackupBytes } from "../main/bulk-storage-budget";
import { WorkspaceStoragePressure } from "../main/storage-pressure";
import { readSyncSuccess, writeSyncSuccess } from "../main/workspace-sync-history";
import { createFullBackup } from "../persistence/full-backup-create";
import { readUserVersion } from "../persistence/schema-startup";
import type { Store } from "../persistence/store";
import type { WorkspaceConflictCandidateTarget } from "../shared/workspace-conflict-view";
import type { WorkspaceConflictResolutionTarget } from "../shared/workspace-conflict-resolution";
import { assertPendingConflictDecision } from "./conflict-decision";
import { CheckpointRemote } from "./client";
import {
  canonicalJson,
  hashCheckpoint,
  requireCondition,
  sha256,
  type Change,
  type Commit,
} from "./protocol";
import {
  assertWorkspaceAssets,
  publishCheckpointAssetsFromStaging,
  stageCheckpointAssets,
  uploadCheckpointAssets,
} from "./workspace-blobs";
import {
  verifyWorkspaceBinding,
  type WorkspaceDevice,
} from "./workspace-binding";
import { WorkspaceSyncStore, type WorkspaceSyncIdentity } from "./workspace-store";

export type WorkspaceSyncRestartTarget = WorkspaceSyncIdentity & {revision: number; checkpointHash: string};

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
    private readonly offlineOnly = false,
  ) {
    this.directory = dirname(realpathSync(options.store.path));
    this.assetsDirectory = join(this.directory, "assets");
    const pressure = new WorkspaceStoragePressure(this.directory);
    this.admitBytes =
      options.admitBytes ?? ((bytes) => pressure.assertWritable(bytes));
    this.remote = remote;
  }

  static async open(options: WorkspaceSyncOptions): Promise<WorkspaceSync> {
    assertRecoverySyncAllowed(options.store.db);
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

  /** Reopen an already bound v5 queue without contacting the server. This
   * cannot enroll, send, receive or resolve conflicts. The caller must supply
   * the durable intent's epoch and verify recovery/intent before applying. */
  static openStaged(options: WorkspaceSyncOptions, serverEpoch: string): WorkspaceSync {
    assertRecoverySyncAllowed(options.store.db);
    requireCondition(basename(options.store.path) === "workspace.sqlite", "invalid-workspace-path");
    requireCondition(typeof options.canApply === "function", "edit-barrier-required");
    requireCondition(options.mode === undefined && readUserVersion(options.store.db) === 5, "not-a-v5-workspace");
    verifyWorkspaceBinding(options.store.path, options, false);
    const local = new WorkspaceSyncStore(options.store, {...options, serverEpoch});
    local.status(); // Validate the stored identity and schema before returning.
    return new WorkspaceSync({...options}, local, new CheckpointRemote(options), true);
  }

  status(): SyncStatus {
    return this.local.status();
  }

  conflict() {
    return this.local.conflict();
  }

  conflictInspection() { return this.local.conflictInspection(); }
  conflictArchives(limit = 20) { return this.local.conflictArchives(limit); }
  conflictCandidate(target: WorkspaceConflictCandidateTarget) { return this.local.conflictCandidate(target); }
  conflictResolutionTarget(choice: "local" | "remote") { return this.local.conflictResolutionTarget(choice); }
  conflictResolutionPreview(choice: "local" | "remote") { return this.local.conflictResolutionPreview(choice); }
  assertConflictResolutionTarget(target: WorkspaceConflictResolutionTarget) { this.local.assertConflictResolutionTarget(target); }
  readLastSuccess() { return readSyncSuccess(this.options.store.db, this.local.identity); }
  shouldRecordSuccess() { const status = this.local.status(); return !status.pending && !status.conflict; }
  recordLastSuccess(at: string) {
    this.admitBytes(Buffer.byteLength(at) + 128, "content");
    writeSyncSuccess(this.options.store.db, this.local.identity, at);
  }

  writeEpoch(): number {
    return this.epoch;
  }

  assertWritable(epoch: number): void {
    requireCondition(epoch === this.epoch, "stale-edit-epoch", 409);
  }

  syncOnce(): Promise<SyncStatus> {
    return this.exclusive(async () => {
      requireCondition(!this.offlineOnly, "offline-sync-instance", 409);
      const operation = this.local.prepare((bytes) => this.admitBytes(bytes, "content"));
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

  /** Transfer pending local work without reading or applying remote content. */
  sendPending(): Promise<SyncStatus> {
    return this.exclusive(async () => {
      requireCondition(!this.offlineOnly, "offline-sync-instance", 409);
      const operation = this.local.prepare((bytes) => this.admitBytes(bytes, "content"));
      if (operation) await this.send(operation);
      return this.local.status();
    });
  }

  /** Persist remote changes and their attachments without applying content or
   * reconciling self echoes. In particular, nextIncoming() must not be called
   * here because it can advance applied_revision while reconciling an echo. */
  receiveAndStage(): Promise<SyncStatus> {
    return this.exclusive(async () => {
      requireCondition(!this.offlineOnly, "offline-sync-instance", 409);
      await this.receive();
      const status = this.local.status();
      // A prior download may have failed after its inbox row committed. Walk
      // every unapplied remote revision on retry, not just the first/latest;
      // otherwise later attachments could be missing when the server is offline.
      for (let revision = status.appliedRevision + 1; revision <= status.receivedCursor; revision++) {
        const incoming = this.local.incoming(revision);
        requireCondition(incoming, "change-not-staged", 409);
        if (incoming.clientId === this.options.clientId || !incoming.checkpoint.assets.length) continue;
        await stageCheckpointAssets({
          ...this.transferOptions(), assetsDirectory: this.stagingDirectory(),
          admitBytes: (bytes) => this.admitBytes(bytes, "assets"),
        }, incoming.checkpoint.assets);
      }
      return this.local.status();
    });
  }

  /** Apply at most one remote revision, using only previously staged bytes.
   * This entrypoint must be invoked by a windowless owner after explicit consent. */
  stagedTarget(): { revision: number; checkpointHash: string } | null {
    const change = this.stagedChange();
    if (!change) return null;
    return {revision: change.revision, checkpointHash: change.checkpointHash};
  }

  restartTarget(): WorkspaceSyncRestartTarget | null {
    const change = this.stagedChange();
    if (!change) return null;
    return {...this.local.identity, revision: change.revision, checkpointHash: change.checkpointHash};
  }

  stagedChange(): Change | null {
    const status = this.local.status();
    for (let revision = status.appliedRevision + 1; revision <= status.receivedCursor; revision++) {
      const change = this.local.incoming(revision);
      if (!change) return null;
      if (change.clientId !== this.options.clientId) return change;
    }
    return null;
  }

  appliedMatches(target: { revision: number; checkpointHash: string }): boolean {
    return this.local.appliedMatches(target.revision, target.checkpointHash);
  }

  /** Reconcile only verified self echoes preceding the exact consent target.
   * This may advance the applied cursor but never replaces content. */
  reconcileStagedTarget(expected: { revision: number; checkpointHash: string }): Promise<SyncStatus> {
    return this.exclusive(async () => {
      this.reconcileBeforeApply(expected);
      return this.local.status();
    });
  }

  private reconcileBeforeApply(expected: { revision: number; checkpointHash: string }): Change | null {
    const status = this.local.status();
    if (status.conflict || !this.options.canApply()) return null;
    const target = this.stagedChange();
    requireCondition(target && target.revision === expected.revision && target.checkpointHash === expected.checkpointHash,
      "staged-target-mismatch", 409);
    // Check the target before nextIncoming() mutates any echo receipt/cursor.
    const next = this.local.nextIncoming();
    requireCondition(next && next.revision === target.revision && next.checkpointHash === target.checkpointHash,
      "staged-target-mismatch", 409);
    return next;
  }

  applyStaged(expected: { revision: number; checkpointHash: string }, reservation?: NormalApplyRecord): Promise<SyncStatus> {
    const pinned = reservation ? structuredClone(reservation) : undefined;
    return this.exclusive(async () => {
      const incoming = this.reconcileBeforeApply(expected);
      const status = this.local.status();
      if (!incoming || status.pending || status.conflict || status.generation !== status.cleanGeneration)
        return status;
      await this.apply(incoming, false, true, undefined, undefined, pinned);
      return this.local.status();
    });
  }

  resolveConflict(
    choice: "local" | "remote",
    expectedRevision: number,
  ): Promise<SyncStatus> {
    return this.exclusive(() => this.resolveConflictChoice(choice, expectedRevision));
  }

  /** Core-only decision boundary. The caller must own the edit/write barrier;
   * remote replacement is not exposed by the active-window service or IPC.
   * Clone before any await so caller mutation cannot retarget a decision. */
  resolveConflictTarget(target: WorkspaceConflictResolutionTarget, decisionId?: string): Promise<SyncStatus> {
    return this.exclusive(() => {
      const pinned = Object.freeze(JSON.parse(canonicalJson(target, 4096))) as WorkspaceConflictResolutionTarget;
      this.local.assertConflictResolutionTarget(pinned);
      return this.resolveConflictChoice(pinned.choice, pinned.remoteRevision, pinned, decisionId);
    });
  }

  private async resolveConflictChoice(
    choice: "local" | "remote", expectedRevision: number, target?: WorkspaceConflictResolutionTarget, decisionId?: string,
  ): Promise<SyncStatus> {
      requireCondition(!this.offlineOnly, "offline-sync-instance", 409);
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
      const assertSelection = () => {
        requireCondition(this.options.canApply() === true, "edit-session-busy", 409);
        if (target) this.local.assertConflictResolutionTarget(target);
        if (decisionId) assertPendingConflictDecision(this.options.store.db, decisionId, target!);
      };
      assertSelection();
      if (target) {
        const current = await this.remote.head();
        assertSelection();
        requireCondition(current.serverEpoch === target.serverEpoch &&
          current.head.revision === target.remoteRevision &&
          current.head.checkpointHash === target.remoteCheckpointHash, "conflict-head-changed", 409);
      }
      if (choice === "local") {
        await this.send(this.local.chooseLocal(expectedRevision, {target, decisionId,
          admitBytes: (bytes) => {this.admitBytes(bytes, "content"); assertSelection();}}));
      } else {
        requireCondition(choice === "remote", "invalid-conflict-choice");
        // Changes pages contain one revision. Catch up contiguously, but
        // bound each explicit attempt so a large history cannot monopolize the
        // main process; a retry resumes from the durable received cursor.
        for (let round = 0; round < 8 && !this.local.incoming(expectedRevision); round++) {
          const before = this.local.status().receivedCursor;
          requireCondition(before < expectedRevision, "conflict-head-not-received", 409);
          await this.receive();
          assertSelection();
          requireCondition(this.local.status().receivedCursor > before, "cursor-gap", 409);
        }
        const incoming = this.local.incoming(expectedRevision);
        requireCondition(incoming, "conflict-catchup-required", 409);
        requireCondition(
          await this.apply(incoming, true, false, target, decisionId),
          "edit-session-busy",
          409,
        );
      }
      return this.local.status();
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

  private async apply(change: Change, resolving: boolean, offline = false,
    target?: WorkspaceConflictResolutionTarget, decisionId?: string, reservation?: NormalApplyRecord): Promise<boolean> {
    if (this.options.canApply() !== true) return false;
    if (target) this.local.assertConflictResolutionTarget(target);
    if (decisionId) assertPendingConflictDecision(this.options.store.db, decisionId, target!);
    if (offline) {
      // Even an empty manifest is checked against the workspace asset root.
      mkdirSync(this.assetsDirectory, { recursive: true, mode: 0o700 });
      if (change.checkpoint.assets.length) publishCheckpointAssetsFromStaging(
        this.stagingDirectory(), this.assetsDirectory, change.checkpoint.assets,
        (bytes) => this.admitBytes(bytes, "assets"),
      );
    } else await stageCheckpointAssets(
      {
        ...this.transferOptions(),
        admitBytes: (bytes) => this.admitBytes(bytes, "assets"),
      },
      change.checkpoint.assets,
    );
    if (resolving) {
      if (this.options.canApply() !== true) return false;
      if (target) this.local.assertConflictResolutionTarget(target);
      // A conflict choice names a specific observed head. Recheck after asset
      // transfer, immediately before entering the synchronous local apply path.
      const current = await this.remote.head();
      requireCondition(current.serverEpoch === this.local.identity.serverEpoch &&
        current.head.revision === change.revision && current.head.checkpointHash === change.checkpointHash,
        "conflict-head-changed", 409);
    }
    // No asynchronous gap between this clean check, the backup, and SQLite apply.
    if (this.options.canApply() !== true) return false;
    if (target) this.local.assertConflictResolutionTarget(target);
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
    if (this.options.canApply() !== true) return false;
    if (target) this.local.assertConflictResolutionTarget(target);
    // Invalidate before applying. A lost SQLite COMMIT acknowledgement must
    // also leave pre-apply editor requests stale.
    this.epoch++;
    const assertAssets = (assets: Change["checkpoint"]["assets"]) =>
      assertWorkspaceAssets(this.assetsDirectory, assets);
    if (resolving) this.local.chooseRemote(change, assertAssets, {target, decisionId,
      admitBytes: (bytes) => {
        this.admitBytes(bytes, "content");
        requireCondition(this.options.canApply() === true, "edit-session-busy", 409);
      }});
    else this.local.applyNext(change, assertAssets, reservation);
    return true;
  }

  private stagingDirectory(): string {
    const path = join(this.directory, ".folio-sync-assets-staging");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
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
    const scope = { baseUrlHash: sha256(new URL(baseUrl).origin), workspaceId,
      clientId: this.options.clientId, bindingId: this.options.bindingId, serverEpoch: this.local.identity.serverEpoch };
    return {
      baseUrl,
      token,
      workspaceId,
      timeoutMs,
      assetsDirectory: this.assetsDirectory,
      transfer: { scope, directory: join(this.directory, ".folio-sync-transfers", sha256(canonicalJson(scope))) },
    };
  }
}

export const openWorkspaceSync = WorkspaceSync.open;
