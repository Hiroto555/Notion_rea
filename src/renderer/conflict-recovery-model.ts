import type {
  ArchiveCursor,
  ArchiveItem,
  ArchivePage,
  ArchiveTarget,
  RecoveryActionResult,
  RecoveryRequestContext,
} from "../shared/conflict-recovery";

export type RecoveryExportMode = "metadata-only" | "complete-bundle";
export type RecoverySuccessKind =
  "metadata-only" | "complete-bundle" | "restored";

export type RecoveryResultView = {
  kind: RecoverySuccessKind;
  directory: string;
  checkpointHash: string;
  target: ArchiveTarget;
};

export type RecoveryPendingUnknown = {
  target: ArchiveTarget;
  operationId?: string;
  mode?: RecoveryRequestContext["mode"];
  directory?: string;
  reason: string;
};

export type RecoveryNotice =
  | { kind: "info"; message: string }
  | { kind: "caution"; message: string }
  | {
      kind: "blocked";
      message: string;
      target?: ArchiveTarget;
      directory?: string;
    }
  | { kind: "error"; message: string }
  | {
      kind: "outcome-unknown";
      message: string;
      directory?: string;
      target: ArchiveTarget;
    };

export type RecoveryBusy =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "export"; mode: RecoveryExportMode; target: ArchiveTarget }
  | { kind: "restore"; target: ArchiveTarget };

export type RecoveryPanelModel = {
  generation: number;
  disposed: boolean;
  page: ArchivePage | null;
  target: ArchiveTarget | null;
  busy: RecoveryBusy | null;
  pendingUnknown: RecoveryPendingUnknown | null;
  lastSuccess: RecoveryResultView | null;
  notice: RecoveryNotice | null;
};

export function createRecoveryPanelModel(): RecoveryPanelModel {
  return {
    generation: 0,
    disposed: false,
    page: null,
    target: null,
    busy: null,
    pendingUnknown: null,
    lastSuccess: null,
    notice: null,
  };
}

export function disposeRecoveryPanelModel(
  model: RecoveryPanelModel,
): RecoveryPanelModel {
  if (model.disposed) return model;
  return {
    ...model,
    disposed: true,
    generation: model.generation + 1,
    busy: null,
  };
}

export function holdRecoveryRequest(
  model: RecoveryPanelModel,
  request: RecoveryRequestContext,
): RecoveryPanelModel {
  return {
    ...model,
    pendingUnknown: { ...request, reason: "recovery-response-unconfirmed" },
    notice: {
      kind: "outcome-unknown",
      message:
        "操作の応答を確認できません。同じ操作IDの結果を再照会してください。",
      target: request.target,
      directory: request.directory,
    },
  };
}

function isCurrent(model: RecoveryPanelModel, token: number): boolean {
  return !model.disposed && token === model.generation;
}

export function targetIdentityMatches(
  a: ArchiveTarget,
  b: ArchiveTarget,
): boolean {
  return (
    a.source === b.source &&
    a.id === b.id &&
    a.operationId === b.operationId &&
    a.kind === b.kind &&
    a.createdAt === b.createdAt &&
    a.checkpointHash === b.checkpointHash
  );
}

export function targetFromItem(item: ArchiveItem): ArchiveTarget | null {
  if (!item.valid || item.target === null) return null;
  return item.target;
}

export function selectTarget(
  model: RecoveryPanelModel,
  target: ArchiveTarget,
): RecoveryPanelModel {
  return { ...model, target, notice: null };
}

export function clearSelectedTarget(
  model: RecoveryPanelModel,
): RecoveryPanelModel {
  return { ...model, target: null };
}

export function beginList(
  model: RecoveryPanelModel,
  token: number,
  cursor?: ArchiveCursor,
): RecoveryPanelModel {
  if (model.disposed) return model;
  return {
    ...model,
    generation: token,
    busy: { kind: "list" },
    notice: cursor ? model.notice : null,
  };
}

function mergeItems(
  existing: ArchiveItem[],
  incoming: ArchiveItem[],
): ArchiveItem[] {
  const seen = new Set<number>();
  const merged: ArchiveItem[] = [];
  for (const item of existing) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function applyList(
  model: RecoveryPanelModel,
  token: number,
  page: ArchivePage,
  options?: { append?: boolean },
): RecoveryPanelModel {
  if (!isCurrent(model, token)) return model;
  const items = options?.append
    ? mergeItems(model.page?.items ?? [], page.items)
    : mergeItems([], page.items);
  return {
    ...model,
    busy: null,
    page: { items, next: page.next, total: page.total },
  };
}

export function failList(
  model: RecoveryPanelModel,
  token: number,
  message: string,
): RecoveryPanelModel {
  if (!isCurrent(model, token)) return model;
  return {
    ...model,
    busy: null,
    notice: { kind: "error", message },
  };
}

export function failStatus(
  model: RecoveryPanelModel,
  token: number,
  message: string,
): RecoveryPanelModel {
  if (!isCurrent(model, token)) return model;
  return {
    ...model,
    busy: null,
    notice: {
      kind: "caution",
      message: `${message} 直近の操作結果を確認できません。不明な結果を成功として扱いません。`,
    },
  };
}

export function beginExport(
  model: RecoveryPanelModel,
  token: number,
  target: ArchiveTarget,
  mode: RecoveryExportMode,
): RecoveryPanelModel {
  if (model.disposed) return model;
  return {
    ...model,
    generation: token,
    target,
    busy: { kind: "export", mode, target },
    lastSuccess: null,
    notice: null,
  };
}

export function beginRestore(
  model: RecoveryPanelModel,
  token: number,
  target: ArchiveTarget,
): RecoveryPanelModel {
  if (model.disposed) return model;
  return {
    ...model,
    generation: token,
    target,
    busy: { kind: "restore", target },
    lastSuccess: null,
    notice: null,
  };
}

export function beginStatus(
  model: RecoveryPanelModel,
  token: number,
): RecoveryPanelModel {
  if (model.disposed) return model;
  return {
    ...model,
    generation: token,
    busy: { kind: "status" },
  };
}

function busyTarget(busy: RecoveryBusy | null): ArchiveTarget | null {
  if (busy === null) return null;
  if (busy.kind === "export") return busy.target;
  if (busy.kind === "restore") return busy.target;
  return null;
}

function isSuccess(
  result: RecoveryActionResult,
): result is Extract<RecoveryActionResult, { kind: RecoverySuccessKind }> {
  return (
    result.kind === "metadata-only" ||
    result.kind === "complete-bundle" ||
    result.kind === "restored"
  );
}

export function applyActionResult(
  model: RecoveryPanelModel,
  token: number,
  result: RecoveryActionResult,
): RecoveryPanelModel {
  if (!isCurrent(model, token)) return model;
  const target = busyTarget(model.busy) ?? model.target;

  if (isSuccess(result)) {
    if (
      target === null ||
      target.checkpointHash !== result.checkpointHash ||
      (model.pendingUnknown?.mode !== undefined &&
        result.kind !==
          (model.pendingUnknown.mode === "restore"
            ? "restored"
            : model.pendingUnknown.mode))
    ) {
      return {
        ...model,
        busy: null,
        pendingUnknown: target
          ? {
              target,
              directory: result.directory,
              reason: "recovery-result-mismatch",
            }
          : model.pendingUnknown,
        notice: {
          kind: "caution",
          message:
            "操作は完了しましたが、対象の特定情報を保持できませんでした。結果を再照会してください。",
        },
      };
    }
    const pending = model.pendingUnknown;
    const resolvesPending =
      pending !== null &&
      (pending.directory === undefined ||
        pending.directory === result.directory) &&
      targetIdentityMatches(pending.target, target) &&
      pending.target.checkpointHash === result.checkpointHash;
    return {
      ...model,
      busy: null,
      pendingUnknown: resolvesPending ? null : pending,
      lastSuccess: {
        kind: result.kind,
        directory: result.directory,
        checkpointHash: result.checkpointHash,
        target,
      },
      notice: {
        kind: "info",
        message: `${result.kind} として完了しました。保全先: ${result.directory}`,
      },
    };
  }

  if (result.kind === "blocked") {
    return {
      ...model,
      busy: null,
      pendingUnknown: confirmedBlocked(model.pendingUnknown, result)
        ? null
        : model.pendingUnknown,
      notice: {
        kind: "blocked",
        directory: result.directory,
        message: result.reason,
        target: result.target ?? target ?? undefined,
      },
    };
  }

  if (result.kind === "cancelled") {
    return {
      ...model,
      busy: null,
      pendingUnknown: null,
      notice: { kind: "info", message: "操作はキャンセルされました。" },
    };
  }

  const unknownTarget = result.target ?? target;
  if (unknownTarget === null) {
    return {
      ...model,
      busy: null,
      notice: {
        kind: "caution",
        message: `${result.reason} 保全先を特定できません。結果を再照会してください。`,
      },
    };
  }
  const pending: RecoveryPendingUnknown = {
    ...model.pendingUnknown,
    target: unknownTarget,
    directory: result.directory,
    reason: result.reason,
  };
  return {
    ...model,
    busy: null,
    pendingUnknown: pending,
    notice: {
      kind: "outcome-unknown",
      message: result.reason,
      directory: result.directory,
      target: unknownTarget,
    },
  };
}

export function failOperation(
  model: RecoveryPanelModel,
  token: number,
  context: {
    target: ArchiveTarget;
    message: string;
    directory?: string;
    request?: RecoveryRequestContext;
  },
): RecoveryPanelModel {
  if (!isCurrent(model, token)) return model;
  return {
    ...model,
    busy: null,
    pendingUnknown: {
      target: context.request?.target ?? context.target,
      ...(context.request
        ? {
            operationId: context.request.operationId,
            mode: context.request.mode,
          }
        : {}),
      ...(context.directory ? { directory: context.directory } : {}),
      reason: context.message,
    },
    notice: {
      kind: "outcome-unknown",
      message: context.message,
      directory: context.directory,
      target: context.request?.target ?? context.target,
    },
  };
}

export function applyStatus(
  model: RecoveryPanelModel,
  token: number,
  result: RecoveryActionResult | null,
): RecoveryPanelModel {
  if (!isCurrent(model, token)) return model;

  if (result === null) {
    if (model.pendingUnknown !== null) {
      return {
        ...model,
        busy: null,
        notice: {
          kind: "caution",
          message:
            "直近の操作結果を確認できません。保全先が不明な操作は成功として扱いません。",
        },
      };
    }
    return { ...model, busy: null };
  }

  if (isSuccess(result)) {
    const pending = model.pendingUnknown;
    const recovered =
      pending !== null &&
      (pending.directory === undefined ||
        pending.directory === result.directory) &&
      pending.target.checkpointHash === result.checkpointHash &&
      (pending.mode === undefined ||
        result.kind ===
          (pending.mode === "restore" ? "restored" : pending.mode));
    if (!recovered) {
      return {
        ...model,
        busy: null,
        notice: {
          kind: "caution",
          message:
            "結果は成功ですが、保全先が不明な操作と一致しません。成功として扱わずに保持します。",
        },
      };
    }
    return {
      ...model,
      busy: null,
      pendingUnknown: null,
      lastSuccess: {
        kind: result.kind,
        directory: result.directory,
        checkpointHash: result.checkpointHash,
        target: pending.target,
      },
      notice: {
        kind: "info",
        message: `再照会で完了を確認しました。保全先: ${result.directory}`,
      },
    };
  }

  if (result.kind === "blocked") {
    return {
      ...model,
      busy: null,
      pendingUnknown: confirmedBlocked(model.pendingUnknown, result)
        ? null
        : model.pendingUnknown,
      notice: {
        kind: "blocked",
        directory: result.directory,
        message: result.reason,
        target: result.target,
      },
    };
  }

  if (result.kind === "cancelled") {
    return {
      ...model,
      busy: null,
      pendingUnknown: null,
      notice: { kind: "info", message: "直近の操作はキャンセル済みです。" },
    };
  }

  const pending = model.pendingUnknown;
  if (
    pending !== null &&
    (pending.directory === undefined ||
      pending.directory === result.directory) &&
    targetIdentityMatches(pending.target, result.target)
  ) {
    return {
      ...model,
      busy: null,
      pendingUnknown: {
        ...pending,
        directory: result.directory,
        reason: result.reason,
      },
      notice: {
        kind: "outcome-unknown",
        message: result.reason,
        directory: result.directory,
        target: result.target,
      },
    };
  }

  return {
    ...model,
    busy: null,
    notice: {
      kind: "caution",
      message: `${result.reason} 保全先が不明な操作とは別の結果のため、成功として扱いません。`,
    },
  };
}

function confirmedBlocked(
  pending: RecoveryPendingUnknown | null,
  result: Extract<RecoveryActionResult, { kind: "blocked" }>,
): boolean {
  if (
    !pending ||
    !result.target ||
    !targetIdentityMatches(pending.target, result.target)
  )
    return false;
  if (
    [
      "recovery-operation-pending",
      "recovery-operation-not-found",
      "previous-recovery-result-unconfirmed",
    ].includes(result.reason)
  )
    return false;
  if (result.reason === "recovery-incomplete-preserved")
    return (
      !!result.directory &&
      (pending.directory === undefined ||
        pending.directory === result.directory)
    );
  return pending.directory === undefined && result.directory === undefined;
}

export function hasPendingUnknown(model: RecoveryPanelModel): boolean {
  return model.pendingUnknown !== null;
}

export function isPendingUnknownFor(
  model: RecoveryPanelModel,
  target: ArchiveTarget,
): boolean {
  return (
    model.pendingUnknown !== null &&
    targetIdentityMatches(model.pendingUnknown.target, target)
  );
}

export function canStartOperation(
  model: RecoveryPanelModel,
  target: ArchiveTarget | null,
): boolean {
  if (model.disposed || model.busy !== null || target === null) return false;
  if (model.pendingUnknown !== null) return false;
  return true;
}

export function canQueryStatus(model: RecoveryPanelModel): boolean {
  return !model.disposed && model.busy === null;
}
