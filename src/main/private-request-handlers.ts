import {types as utilTypes} from "node:util";
import {requestSchema, type Request} from "../shared/types";
import type {RequestReplyV1} from "../shared/private-storage-failure";
import type {CrashRecoveryRead, CrashRecoverySnapshot} from "../shared/crash-recovery";
import {getCrashRecoveryReadFailure, type CrashRecoveryFile, type RecoveryWriteObservation} from "../persistence/crash-recovery-file";
import {withPrivateOperationAuthority} from "../platform/private-operation-authority";
import type {CheckpointPriorPending} from "../platform/private-mutation-diagnostic";
import {requireCondition} from "../sync/protocol";
import {storageActionForRequest} from "./storage-write-policy";
import type {WorkspaceBackupService, WorkspaceOpenLaunch, WorkspaceOpenTerminal} from "./workspace-backup-service";
import {
  privateRequestFailureReply,
  privateRequestSuccessReply,
  type PrivateRequestBlockedRead,
} from "./private-request-envelope";

export type PrivateRequestWindow = Readonly<{
  isDestroyed(): boolean;
  readonly webContents: Readonly<{mainFrame: unknown}>;
}>;

export type PrivateRequestEvent = Readonly<{
  sender: unknown;
  senderFrame: unknown;
}>;

export type PrivateRequestLifecycle = Readonly<{
  run<T>(work: () => T): T;
  observe(error: unknown): void;
  isUsable(): boolean;
  retainedFailure(): unknown;
}>;

export type PrivateRequestContext<W extends PrivateRequestWindow> = Readonly<{
  requestWindow: W;
  isAuthorized(): boolean;
  withStorageAction<T>(req: Request, handle: () => Promise<T> | T): Promise<T>;
  readRecovery(file: Pick<CrashRecoveryFile, "read">): CrashRecoveryRead;
  writeRecovery(
    file: Pick<CrashRecoveryFile, "writeObserved">,
    expectedGeneration: number,
    snapshot: CrashRecoverySnapshot,
  ): CrashRecoveryRead;
  openBackup(
    service: Pick<WorkspaceBackupService, "openObserved">,
    ticket: string,
    launch: WorkspaceOpenLaunch,
  ): Promise<void>;
}>;

type InvocationFacts = {
  read?: PrivateRequestBlockedRead;
  write?: RecoveryWriteObservation;
  launch?: WorkspaceOpenTerminal;
};

export type PrivateRequestHandlerOptions<W extends PrivateRequestWindow> = Readonly<{
  lifecycle: PrivateRequestLifecycle;
  syncGate: {write<T>(work: () => Promise<T> | T): Promise<T>};
  enterScope<T>(work: () => T): T;
  getRequestWindow(): W | null | undefined;
  getRendererGeneration(): number;
  getWorkspaceBinding(): unknown;
  trustedUrl: string;
  dispatch(req: Request, context: PrivateRequestContext<W>): Promise<unknown> | unknown;
}>;

export type PrivateRequestHandlers = Readonly<{
  legacy(event: PrivateRequestEvent, input: unknown): Promise<unknown>;
  diagnostic(event: PrivateRequestEvent, input: unknown): Promise<RequestReplyV1<unknown>>;
}>;

function retainedFailure(lifecycle: PrivateRequestLifecycle): unknown {
  try { return lifecycle.retainedFailure(); }
  catch { return undefined; }
}

/** Common Node boundary for the legacy raw IPC lane and the bounded v1
 * diagnostic lane. Electron is represented structurally; Main supplies the
 * real scope, gate, window, generation, store binding and dispatch callback. */
export function createPrivateRequestHandlers<W extends PrivateRequestWindow>(
  options: PrivateRequestHandlerOptions<W>,
): PrivateRequestHandlers {
  const execute = async (
    event: PrivateRequestEvent,
    input: unknown,
    diagnostic: boolean,
  ): Promise<unknown> => {
    const facts: InvocationFacts = {};
    let requestType = "UNRECOGNIZED";
    try {
      const value = await options.lifecycle.run(() => options.enterScope(async () => {
        const requestWindow = options.getRequestWindow();
        const generation = options.getRendererGeneration();
        const workspaceBinding = options.getWorkspaceBinding();
        const isAuthorized = (): boolean => {
          try {
            if (!options.lifecycle.isUsable() || requestWindow === null || requestWindow === undefined) return false;
            const currentWindow = options.getRequestWindow();
            if (currentWindow !== requestWindow || requestWindow.isDestroyed()) return false;
            if (options.getRendererGeneration() !== generation ||
                options.getWorkspaceBinding() !== workspaceBinding)
              return false;
            const senderFrame = event.senderFrame;
            if (event.sender !== requestWindow.webContents ||
                senderFrame !== requestWindow.webContents.mainFrame ||
                typeof senderFrame !== "object" || senderFrame === null)
              return false;
            return (senderFrame as {url?: unknown}).url === options.trustedUrl;
          } catch {
            return false;
          }
        };
        if (requestWindow === null || requestWindow === undefined || !isAuthorized())
          throw new Error("Unauthorized IPC sender");
        const req = requestSchema.parse(input);
        requestType = req.type;
        if (
          req.type !== "export" &&
          req.type !== "exportRecovery" &&
          req.type !== "exportPendingJournal" &&
          Buffer.byteLength(JSON.stringify(req)) > 32_000_000
        )
          throw new Error("リクエストが大きすぎます");

        const context: PrivateRequestContext<W> = Object.freeze({
          requestWindow,
          isAuthorized,
          async withStorageAction<T>(current: Request, handle: () => Promise<T> | T): Promise<T> {
            const authority = () => {
              requireCondition(isAuthorized(), "unauthorized", 403);
            };
            return withPrivateOperationAuthority(authority, async () => {
              const action = storageActionForRequest(current.type);
              const guarded = async (): Promise<T> => {
                requireCondition(isAuthorized(), "unauthorized", 403);
                return await handle();
              };
              if (action === "write" || action === "maintenance")
                return await options.syncGate.write(guarded);
              return await guarded();
            });
          },
          readRecovery(file: Pick<CrashRecoveryFile, "read">): CrashRecoveryRead {
            const value = file.read();
            const retained = getCrashRecoveryReadFailure(value);
            if (retained !== undefined) {
              options.lifecycle.observe(retained.error);
              facts.read = Object.freeze({
                value,
                error: retained.error,
                priorPending: retained.priorPending as CheckpointPriorPending | undefined,
              });
            }
            return value;
          },
          writeRecovery(
            file: Pick<CrashRecoveryFile, "writeObserved">,
            expectedGeneration: number,
            snapshot: CrashRecoverySnapshot,
          ): CrashRecoveryRead {
            const observed = file.writeObserved(expectedGeneration, snapshot);
            if (observed.terminal === "RETURNED") return observed.value;
            facts.write = observed;
            throw observed.value;
          },
          async openBackup(
            service: Pick<WorkspaceBackupService, "openObserved">,
            ticket: string,
            launch: WorkspaceOpenLaunch,
          ): Promise<void> {
            const terminal = await service.openObserved(ticket, launch);
            facts.launch = terminal;
            if (terminal.terminal === "THREW") throw terminal.value;
          },
        });
        return await options.dispatch(req, context);
      }));
      if (!diagnostic) return value;
      return privateRequestSuccessReply({
        value,
        requestType,
        retainedFailure: retainedFailure(options.lifecycle),
        read: facts.read,
      });
    } catch (original) {
      if (!diagnostic) throw original;
      return privateRequestFailureReply({
        original,
        requestType,
        retainedFailure: retainedFailure(options.lifecycle),
        write: facts.write,
        read: facts.read,
        launch: facts.launch,
      });
    }
  };

  return Object.freeze({
    legacy: (event, input) => execute(event, input, false),
    diagnostic: (event, input) => execute(event, input, true) as Promise<RequestReplyV1<unknown>>,
  });
}
