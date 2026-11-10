import { SharedRecoveryIndex } from "./shared-recovery-index";
import { dirname } from "node:path";
import { sharedCopyTransfer } from "./shared-copy-transfer";
import { lowerEditorDocument } from "../collaboration/runtime/editor-plan";
import { normalizeSharedEndpoint } from "../collaboration/runtime/endpoint-policy";
import { existsSync } from "node:fs";
import {
  DurableQueue,
  type QueueEntry,
} from "../collaboration/runtime/durable-queue";
import { parseCut } from "../collaboration/runtime/wire";
import { randomUUID } from "node:crypto";
import { previewCopyPayload } from "../collaboration/runtime/copy-command";
import {
  previewSharedCopy,
  type CopyPreview,
  type SharedCopySource,
} from "../collaboration/runtime/copy";
import type { Json } from "../collaboration/runtime/contract";
import { SharedAssetProvider } from "../collaboration/runtime/asset-provider";
import { SharedResourceClient } from "../collaboration/runtime/resource-client";
import { SharedBackupProvider } from "../collaboration/runtime/backup-provider";
import { exportSharedBackup } from "./shared-backup-export";
import { join } from "node:path";
import { SharedRuntimeClient } from "../collaboration/runtime/client";
import { HttpSharedProvider } from "../collaboration/runtime/http-provider";
import { RuntimeStore } from "../collaboration/runtime/store";
import { digest } from "../collaboration/runtime/digest";
import { canonical } from "../collaboration/runtime/canonical";
import { editorTextIntent } from "../collaboration/runtime/editor-intent";
import {
  demand,
  scopeKey,
  sameScope,
  type AuthContext,
  type Scope,
} from "../collaboration/runtime/contract";
import { projectRuntimeView } from "../renderer/shared/runtime-state";
import {
  sharedRuntimeRequestSchema,
  type SharedRuntimeSession,
} from "../shared/shared-runtime-ipc";
import type { WorkspaceListing } from "../collaboration/runtime/provider-port";
import type { CredentialProvider } from "../platform/credential-provider";
type Connection = {
  url: string;
  orgId: string;
  token: string;
  auth: AuthContext;
  provider: HttpSharedProvider;
};
/** A separate IPC service. It never imports or checkpoints the private Store. */
export class SharedRuntimeService {
  private connection: Connection | null = null;
  private client: SharedRuntimeClient | null = null;
  private copies = new Map<
    string,
    { generation: number; preview: CopyPreview; payload: Json | null }
  >();
  private resources: SharedResourceClient | null = null;
  private generation = 0;
  private workspaces: WorkspaceListing[] = [];
  private busy = false;
  constructor(
    private readonly root: string,
    private readonly credentials?: CredentialProvider,
    private readonly options: {
      copySources?: (ids: string[]) => SharedCopySource[];
      copyCatalog?: () => {id: string; title: string; kind: "page" | "record" | "database"}[];
      pickBackup?: () => Promise<string | null>;
      forbiddenRoots?: string[];
      recoveryFilesystemProof?: import("./shared-recovery-index").SharedRecoveryFilesystemProof;
      runtimeStoreOptions?: (directory: string) => import("../collaboration/runtime/store").RuntimeStoreOptions;
    } = {},
  ) {}
  private recoveryIndex() {return new SharedRecoveryIndex(this.root, {filesystemProof: this.options.recoveryFilesystemProof});}
  private storeOptions(directory: string) { return this.options.runtimeStoreOptions?.(directory) ?? {}; }
  private cache(): RuntimeStore {
    const directory = join(this.root, "connections");
    const store = new RuntimeStore(directory, this.storeOptions(directory));
    const role = store.get("meta", "role");
    if (role !== null && role !== "connection-cache") {
      store.close();
      throw new Error("WRONG_STORE_ROLE");
    }
    if (role === null)
      store.transaction(() => store.set("meta", "role", "connection-cache"));
    return store;
  }
  private fenceConnection(generation: number) {
    demand(generation === this.generation, "STALE_SHARED_SESSION");
    demand(this.connection, "SHARED_NOT_CONFIGURED");
    return this.connection;
  }
  private documentPending(): QueueEntry[] {
    if (this.client) return this.client.writerPendingEntries();
    const c = this.connection;
    if (!c) return [];
    const directory = join(
      this.root,
      "writers",
      digest({ url: c.url, orgId: c.orgId, writerId: c.auth.writerId }),
    );
    if (!existsSync(join(directory, "shared-runtime.sqlite"))) return [];
    const store = new RuntimeStore(directory, this.storeOptions(directory));
    try {
      demand(store.get("meta", "role") === "client", "WRONG_STORE_ROLE");
      const scopes = new Map<string, Scope>();
      for (const row of store.all("client.queue")) {
        const e = row.value as QueueEntry;
        demand(
          e?.intent?.scope && typeof e.intent.writerId === "string",
          "CORRUPT_QUEUE",
        );
        if (e.intent.writerId === c.auth.writerId)
          scopes.set(scopeKey(e.intent.scope), e.intent.scope);
      }
      return [...scopes.values()]
        .flatMap((scope) =>
          new DurableQueue(store, {
            scope,
            writerId: c.auth.writerId,
          }).entries(),
        )
        .filter(
          (e) =>
            e.state !== "CLIENT_RECEIPT_DURABLE" &&
            store.get(
              "client.archived",
              scopeKey(e.intent.scope) +
                ":" +
                c.auth.writerId +
                ":" +
                e.intent.intentId,
            ) === null,
        );
    } finally {
      store.close();
    }
  }
  private fence(generation: number) {
    demand(generation === this.generation, "STALE_SHARED_SESSION");
    demand(this.client, "SHARED_DOCUMENT_NOT_OPEN");
    return this.client;
  }
  private view(): SharedRuntimeSession {
    const entries = [
      ...this.documentPending(),
      ...(this.resources?.activeEntries() ?? []),
    ];
    const pending = entries.filter((e) => e.state !== "CLIENT_RECEIPT_DURABLE");
    const last = entries.at(-1);
    const editing = this.client
      ? this.client.store.get(
          "client.editing",
          scopeKey(this.client.scope) + ":" + this.client.writerId,
        )
      : null;
    const state = pending.some((e) => e.state === "UNKNOWN")
      ? "UNKNOWN"
      : pending.some((e) => e.state === "REJECTED")
        ? "REJECTED"
        : editing
          ? "LOCAL_DURABLE"
          : (last?.state ??
            (this.client ? "CLIENT_RECEIPT_DURABLE" : "OFFLINE"));
    let snapshot = null;
    try {
      snapshot = this.client?.snapshot() ?? null;
    } catch {}
    const scope = this.client?.scope ?? null;
    const role = this.workspaces.find(
      (w) => w.workspaceId === scope?.workspaceId,
    )?.role;
    return {
      orgId: this.connection?.orgId ?? null,
      pendingIntents: [
        ...this.documentPending().map((e) => ({
          kind: "document" as const,
          scope: e.intent.scope,
          intentId: e.intent.intentId,
          state: e.state,
        })),
        ...(this.resources?.activeEntries() ?? []).map((e) => ({
          kind: "resource" as const,
          scope: e.intent.scope,
          intentId: e.intent.intentId,
          state: e.state,
        })),
      ],
      generation: this.generation,
      scope,
      snapshot,
      workspaces: this.workspaces,
      view: projectRuntimeView({
        stage: state,
        readonly: role === "viewer" || !this.client,
        online: !!this.connection,
        pending: pending.length + (editing ? 1 : 0),
        rejection: pending.filter(entry => entry.state === "REJECTED").at(-1)?.attempts.at(-1)?.receipt?.code ?? null,
        scopeLabel: scope
          ? `${scope.orgId} / ${scope.workspaceId} / ${scope.documentId}`
          : "共有文書を選択してください",
      }),
    };
  }
  private async connect(
    url: string,
    token: string,
    orgId: string,
    remember = false,
    isAuthorized: () => boolean = () => true,
  ) {
    url = normalizeSharedEndpoint(url);
    const capturedGeneration = this.generation;
    const allowed = () =>
      isAuthorized() && this.generation === capturedGeneration;
    const provider = new HttpSharedProvider(url, token);
    let auth: AuthContext;
    let workspaces: WorkspaceListing[];
    try {
      auth = await provider.session(orgId);
      workspaces = await provider.workspaces(orgId);
      demand(allowed(), "UNAUTHORIZED_IPC_SENDER");
      if (remember) {
        demand(this.credentials, "CREDENTIAL_STORAGE_UNAVAILABLE");
        const connectionId = digest({ url, orgId, deviceId: auth.deviceId });
        const scope = { serverId: digest(url), orgId, deviceId: auth.deviceId };
        const sealed = await this.credentials.seal(scope, token);
        demand(allowed(), "UNAUTHORIZED_IPC_SENDER");
        const cache = this.cache();
        try {
          cache.transaction(() =>
            cache.set("connections", connectionId, {
              url,
              orgId,
              deviceId: auth.deviceId,
              sealed: Buffer.from(sealed).toString("base64"),
            }),
          );
        } finally {
          cache.close();
        }
      }
    } catch (error) {
      provider.close();
      throw error;
    }
    demand(allowed(), "UNAUTHORIZED_IPC_SENDER");
    const resourceDirectory = join(
        this.root,
        "resources",
        digest({ url, orgId, writerId: auth.writerId }),
      );
    const resources = new SharedResourceClient(
      resourceDirectory,
      new HttpSharedProvider(url, token),
      auth.writerId,
      this.storeOptions(resourceDirectory),
    );
    try { this.recoveryIndex().remember({origin: url, orgId, userId: auth.userId, writerId: auth.writerId, directory: dirname(resources.store.path), kind: "resource"}); }
    catch (error) {resources.close(); provider.close(); throw error;}
    this.resources?.close();
    this.resources = resources;
    this.client?.close();
    this.client = null;
    this.connection?.provider.close();
    this.connection = { url, orgId, token, auth, provider };
    this.workspaces = workspaces;
    this.copies.clear();
    this.generation++;
  }
  async handle(
    input: unknown,
    isAuthorized: () => boolean = () => true,
  ): Promise<unknown> {
    demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
    canonical(input, 30_000_000);
    const req = sharedRuntimeRequestSchema.parse(input);
    demand(!this.busy, "SHARED_SERVICE_BUSY");
    this.busy = true;
    try {
      let result: unknown;
      switch (req.type) {
        case "copyCatalog": {
          this.fenceConnection(req.generation);
          demand(this.options.copyCatalog, "COPY_CATALOG_UNAVAILABLE");
          result = this.options.copyCatalog();
          break;
        }
        case "copyPreview": {
          const client = this.fence(req.generation);
          demand(this.options.copySources, "COPY_SOURCE_UNAVAILABLE");
          if (this.copies.size >= 4) this.copies.delete(this.copies.keys().next().value!);
          const sources = this.options.copySources(req.sourceIds);
          const target = {orgId: client.scope.orgId, workspaceId: client.scope.workspaceId};
          let prepared: {preview: CopyPreview; payload: Json | null};
          try { prepared = previewCopyPayload(sources, req.sourceIds, target); }
          catch (error) {
            demand(error instanceof Error && ["COPY_CAPACITY_EXCEEDED", "JSON_LIMIT"].includes(error.message), error instanceof Error ? error.message : "COPY_PREVIEW_FAILED");
            prepared = {preview: previewSharedCopy(sources, req.sourceIds, target, randomUUID), payload: null};
          }
          const previewId = randomUUID();
          if (prepared.payload === null) sharedCopyTransfer(sources, prepared.preview, previewId);
          this.copies.set(previewId, {
            generation: req.generation,
            ...prepared,
          });
          result = {
            previewId,
            destination: {
              orgId: client.scope.orgId,
              workspaceId: client.scope.workspaceId,
            },
            documents: prepared.preview.documents.map((d) => ({
              sourceId: d.sourceId,
              title: d.title,
              scope: d.scope,
            })),
            assets: prepared.preview.assetManifests,
            warnings: prepared.preview.warnings,
            fingerprint: prepared.preview.fingerprint,
          };
          break;
        }
        case "copyAbandon": {
          const connection = this.fenceConnection(req.generation);
          demand(this.resources && req.scope.orgId === connection.orgId &&
            this.workspaces.some(workspace => workspace.workspaceId === req.scope.workspaceId), "AUTH_SCOPE_MISMATCH");
          demand(this.documentPending().length === 0 && !this.resources.hasPending() &&
            (!this.client || this.client.canWrite()), "PENDING_INTENT_BLOCKS_WRITE");
          if (this.client) demand(this.client.store.get("client.editing",
            scopeKey(this.client.scope) + ":" + this.client.writerId) === null, "PENDING_INTENT_BLOCKS_WRITE");
          const base = parseCut(await connection.provider.admin({action: "head", scope: req.scope}));
          demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
          result = await this.resources.execute(req.scope, {kind: "resource", action: "copy.stage.abandon",
            payload: {copyId: req.copyId, manifestHash: req.manifestHash}}, base);
          break;
        }
        case "copyCommit": {
          const client = this.fence(req.generation);
          demand(
            this.resources && this.options.copySources,
            "COPY_SOURCE_UNAVAILABLE",
          );
          demand(
            !client.hasPendingWriterIntents(),
            "PENDING_INTENT_BLOCKS_WRITE",
          );
          const selected = this.copies.get(req.previewId);
          demand(
            selected && selected.generation === req.generation,
            "COPY_PREVIEW_EXPIRED",
          );
          const sources = this.options.copySources(selected.preview.sourceIds);
          let allocated = 0;
          const current = previewSharedCopy(
            sources,
            selected.preview.sourceIds,
            selected.preview.target,
            () => selected.preview.scopes[allocated++].documentId,
          );
          demand(
            current.fingerprint === selected.preview.fingerprint,
            "COPY_SOURCE_CHANGED",
          );
          if (selected.payload !== null) {
          result = await this.resources.execute(
            client.scope,
            {
              kind: "resource",
              action: "copy.commit",
              payload: selected.payload,
            },
            client.snapshot().cut,
          );
          } else {
            const transfer = sharedCopyTransfer(sources, selected.preview, req.previewId);
            const execute = async (action: string, payload: Json) => {
              const connection = this.fenceConnection(req.generation);
              demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
              const base = parseCut(await connection.provider.admin({action: "head", scope: client.scope}));
              demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
              const receipt = await this.resources!.execute(client.scope, {kind: "resource", action, payload}, base);
              demand(receipt.status === "SERVER_ACCEPTED", receipt.code ?? "COPY_STAGE_FAILED");
              demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
              return receipt;
            };
            const connection = this.fenceConnection(req.generation);
            const assetProvider = new SharedAssetProvider(connection.url, connection.token);
            try {
              const unique = new Map(selected.preview.assets.map(a => [a.hash, a]));
              for (const asset of unique.values()) {
                demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
                await assetProvider.stage(client.scope, "copy-" + req.previewId + "-" + asset.hash.slice(0, 40), asset.bytes);
              }
            } finally { assetProvider.close(); }
            await execute("copy.stage.prepare", {manifest: transfer.manifest} as unknown as Json);
            for (let index = 0; index < transfer.parts.length; index++)
              await execute("copy.stage.part", {copyId: req.previewId, index, raw: transfer.parts[index]});
            result = await execute("copy.stage.commit", {copyId: req.previewId, manifestHash: transfer.manifestHash});
          }
          this.copies.delete(req.previewId);
          break;
        }
        case "assetStage": {
          const client = this.fence(req.generation);
          const c = this.connection;
          demand(
            c && client.canWrite() && !this.resources?.hasPending(),
            "PENDING_INTENT_BLOCKS_WRITE",
          );
          demand(
            req.base64.length % 4 === 0 &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(req.base64),
            "INVALID_BASE64",
          );
          const bytes = Buffer.from(req.base64, "base64");
          demand(
            bytes.toString("base64") === req.base64 &&
              bytes.length <= 20_000_000,
            "ASSET_LIMIT",
          );
          const provider = new SharedAssetProvider(c.url, c.token);
          try {
            result = await provider.stage(client.scope, req.uploadId, bytes);
          } finally {
            provider.close();
          }
          break;
        }
        case "assetRead": {
          const client = this.fence(req.generation);
          const c = this.connection;
          demand(c, "SHARED_NOT_CONFIGURED");
          const provider = new SharedAssetProvider(c.url, c.token);
          try {
            const bytes = await provider.read(client.scope, req.hash);
            result = {
              mediaType: imageType(bytes),
              hash: req.hash,
              base64: Buffer.from(bytes).toString("base64"),
              bytes: bytes.length,
            };
          } finally {
            provider.close();
          }
          break;
        }
        case "backupExport": {
          const c = this.connection;
          demand(c && req.orgId === c.orgId, "AUTH_SCOPE_MISMATCH");
          demand(this.options.pickBackup, "BACKUP_PICKER_UNAVAILABLE");
          const backup = new SharedBackupProvider(c.url, c.token);
          try {
            result = await exportSharedBackup({
              download: () => backup.download(c.orgId),
              pick: this.options.pickBackup,
              isAuthorized,
              forbiddenRoots: [
                this.root,
                ...(this.options.forbiddenRoots ?? []),
              ],
            });
          } finally {
            backup.close();
          }
          break;
        }
        case "resource": {
          const c = this.fenceConnection(req.generation);
          demand(this.resources, "SHARED_NOT_CONFIGURED");
          demand(
            req.scope.orgId === c.orgId &&
              this.workspaces.some(
                (w) => w.workspaceId === req.scope.workspaceId,
              ),
            "AUTH_SCOPE_MISMATCH",
          );
          demand(req.command.kind === "resource", "INVALID_COMMAND");
          demand(req.command.action !== "copy.stage.abandon", "COPY_ABANDON_REQUIRES_TYPED_REQUEST");
          demand(
            this.documentPending().length === 0,
            "PENDING_INTENT_BLOCKS_WRITE",
          );
          const base = parseCut(
            await c.provider.admin({ action: "head", scope: req.scope }),
          );
          demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
          result = await this.resources.execute(req.scope, req.command, base);
          break;
        }
        case "recoveryList":
        case "recoveryRead": {
          const c = this.fenceConnection(req.generation);
          const index = this.recoveryIndex();
          const filter = {origin: c.url, orgId: c.orgId, userId: c.auth.userId};
          result = req.type === "recoveryList" ? index.list(filter) : canonical(index.read(req.entryId, filter), 160_000_000);
          break;
        }
        case "resourceReconcile":
          this.fenceConnection(req.generation);
          demand(this.resources, "SHARED_NOT_CONFIGURED");
          await this.resources.reconcile();
          break;
        case "resourceRecover":
          this.fenceConnection(req.generation);
          demand(this.resources, "SHARED_NOT_CONFIGURED");
          result = this.resources.recover();
          break;
        case "resourceInvalidate": {
          const c = this.fenceConnection(req.generation);
          demand(
            this.resources && req.scope.orgId === c.orgId,
            "AUTH_SCOPE_MISMATCH",
          );
          await this.resources.invalidate(req.scope, req.intentId);
          break;
        }
        case "resourceArchive": {
          const c = this.fenceConnection(req.generation);
          demand(
            this.resources && req.scope.orgId === c.orgId,
            "AUTH_SCOPE_MISMATCH",
          );
          this.resources.archive(req.scope, req.intentId);
          break;
        }
        case "command": {
          const client = this.fence(req.generation);
          demand(req.command.kind !== "resource", "INVALID_COMMAND");
          demand(!this.resources?.hasPending(), "PENDING_INTENT_BLOCKS_WRITE");
          await client.submit(req.command);
          break;
        }

        case "admin": {
          demand(this.connection, "SHARED_NOT_CONFIGURED");
          const orgId =
            "orgId" in req.command
              ? req.command.orgId
              : req.command.scope.orgId;
          demand(orgId === this.connection.orgId, "AUTH_SCOPE_MISMATCH");
          result = await this.connection.provider.admin(req.command);
          break;
        }
        case "join": {
          const provider = new HttpSharedProvider(req.url, req.inviteToken);
          try {
            const joined = await provider.join(req.orgId, req.deviceId);
            await this.connect(
              req.url,
              joined.token,
              req.orgId,
              req.remember,
              isAuthorized,
            );
          } finally {
            provider.close();
          }
          break;
        }

        case "connect":
          await this.connect(
            req.url,
            req.token,
            req.orgId,
            req.remember,
            isAuthorized,
          );
          break;
        case "connections": {
          const cache = this.cache();
          try {
            result = cache.all("connections").map((r) => {
              const v = r.value as {
                url: string;
                orgId: string;
                deviceId: string;
              };
              return {
                connectionId: r.key,
                url: v.url,
                orgId: v.orgId,
                deviceId: v.deviceId,
              };
            });
          } finally {
            cache.close();
          }
          break;
        }
        case "resume": {
          demand(this.credentials, "CREDENTIAL_STORAGE_UNAVAILABLE");
          const cache = this.cache();
          let saved;
          try {
            saved = cache.get("connections", req.connectionId) as {
              url: string;
              orgId: string;
              deviceId: string;
              sealed: string;
            } | null;
          } finally {
            cache.close();
          }
          demand(saved, "CONNECTION_NOT_FOUND");
          const token = await this.credentials.open(
            {
              serverId: digest(saved.url),
              orgId: saved.orgId,
              deviceId: saved.deviceId,
            },
            Buffer.from(saved.sealed, "base64"),
          );
          await this.connect(
            saved.url,
            token,
            saved.orgId,
            false,
            isAuthorized,
          );
          break;
        }
        case "disconnect":
          this.close();
          break;
        case "list":
          demand(this.connection, "SHARED_NOT_CONFIGURED");
          {
            const listed = await this.connection.provider.workspaces(
              this.connection.orgId,
            );
            demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
            this.workspaces = listed;
          }
          break;
        case "open": {
          const capturedGeneration = this.generation;
          const connection = this.connection;
          demand(
            connection && req.scope.orgId === connection.orgId,
            "SHARED_NOT_CONFIGURED",
          );
          demand(
            (!this.client?.hasPendingWriterIntents() ||
              sameScope(this.client.scope, req.scope)) &&
              !this.resources?.hasPending(),
            "PENDING_INTENT_BLOCKS_NAVIGATION",
          );
          const nextDirectory = join(
              this.root,
              "writers",
              digest({
                url: connection.url,
                orgId: connection.orgId,
                writerId: connection.auth.writerId,
              }),
            );
          const next = new SharedRuntimeClient(
            nextDirectory,
            new HttpSharedProvider(connection.url, connection.token),
            req.scope,
            connection.auth.writerId,
            this.storeOptions(nextDirectory),
          );
          try {
            demand(
              next
                .writerPendingEntries()
                .every((e) => sameScope(e.intent.scope, req.scope)),
              "PENDING_IN_OTHER_DOCUMENT",
            );
            await next.open();
            demand(
              isAuthorized() && this.generation === capturedGeneration,
              "UNAUTHORIZED_IPC_SENDER",
            );
            this.recoveryIndex().remember({origin: connection.url, orgId: connection.orgId, userId: connection.auth.userId, writerId: connection.auth.writerId, directory: dirname(next.store.path), kind: "document"});
          } catch (error) {
            next.close();
            throw error;
          }
          this.client?.close();
          this.client = next;
          this.generation++;
          break;
        }
        case "closeDocument": {
          this.fenceConnection(req.generation);
          demand(this.documentPending().length === 0 && !this.resources?.hasPending(), "PENDING_INTENT_BLOCKS_NAVIGATION");
          demand(!this.client || !this.client.store.get("client.editing", scopeKey(this.client.scope) + ":" + this.client.writerId), "UNSAVED_DRAFT");
          this.client?.close(); this.client = null; this.generation++; break;
        }
        case "refresh":
          await this.fence(req.generation).open();
          break;
        case "parkDraft": {
          const client = this.fence(req.generation);
          const editing = client.store.get(
            "client.editing",
            scopeKey(client.scope) + ":" + client.writerId,
          );
          if (editing) {
            client.retainDraft(editing);
            client.clearEditingRaw();
          }
          break;
        }
        case "draft":
          this.fence(req.generation).retainEditingRaw(req.raw);
          break;
        case "document":
        case "editorDocument": {
          const client = this.fence(req.generation);
          client.retainEditingRaw(JSON.stringify(req.document));
          demand(!this.resources?.hasPending(), "PENDING_INTENT_BLOCKS_WRITE");
          const snapshot = client.snapshot();
          try {
            demand(
              canonical(req.base) === canonical(snapshot.cut),
              "STALE_EDITOR_BASE",
            );
            const command = req.type === "document"
              ? editorTextIntent(snapshot.state.document, req.document as Parameters<typeof editorTextIntent>[1])
              : (() => {
                const plan = lowerEditorDocument(snapshot.state, req.document as Parameters<typeof lowerEditorDocument>[1], client.scope.incarnationId);
                return plan.commands.length ? {kind: "batch" as const, commands: plan.commands} : null;
              })();
            if (command) {
              const result = await client.submit(command);
              if (result.receipt.status === "SERVER_ACCEPTED")
                client.clearEditingRaw();
              else client.retainDraft(req.document);
            } else client.clearEditingRaw();
          } catch (error) {
            client.retainDraft(req.document);
            throw error;
          }
          break;
        }
        case "undo":
        case "redo":
          demand(!this.resources?.hasPending(), "PENDING_INTENT_BLOCKS_WRITE");
          await this.fence(req.generation).historyStep(req.type);
          break;
        case "reconcile":
          await this.fence(req.generation).reconcile();
          break;
        case "recover":
          result = canonical(
            {
              document: JSON.parse(this.fence(req.generation).recover()),
              resources: this.resources
                ? JSON.parse(this.resources.recover())
                : null,
            },
            160_000_000,
          );
          break;
        case "invalidate":
          await this.fence(req.generation).invalidate(req.intentId);
          break;
        case "archive":
          this.fence(req.generation).archive(req.intentId);
          break;
      }
      demand(isAuthorized(), "UNAUTHORIZED_IPC_SENDER");
      return result ?? this.view();
    } finally {
      this.busy = false;
    }
  }
  close(): void {
    this.copies.clear();
    this.resources?.close();
    this.resources = null;
    this.client?.close();
    this.client = null;
    this.connection?.provider.close();
    this.connection = null;
    this.workspaces = [];
    this.generation++;
  }
}

function imageType(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (
    b.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))
  )
    return "image/gif";
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return "application/octet-stream";
}
