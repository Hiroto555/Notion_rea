import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Request } from "../src/shared/types";
import type {
  ArchiveTarget,
  RecoveryActionResult,
} from "../src/shared/conflict-recovery";
import { createConflictRecoveryPort } from "../src/renderer/conflict-recovery-port";
import {
  applyActionResult,
  applyStatus,
  beginExport,
  beginRestore,
  beginStatus,
  canStartOperation,
  createRecoveryPanelModel,
  failOperation,
  failStatus,
  holdRecoveryRequest,
} from "../src/renderer/conflict-recovery-model";

const target: ArchiveTarget = {
  source: "a".repeat(64),
  id: 1,
  operationId: "archive-operation",
  kind: "conflict-local",
  createdAt: 1,
  checkpointHash: "b".repeat(64),
};

it.each(["complete-bundle", "restore"] as const)(
  "recovers a lost %s response by the same ID after a panel remount",
  async (mode) => {
    const id = randomUUID(),
      calls: Request[] = [];
    let effects = 0;
    const hostResult: RecoveryActionResult = {
      kind: mode === "restore" ? "restored" : mode,
      directory: "/temporary/preserved-output",
      checkpointHash: target.checkpointHash,
    };
    const port = createConflictRecoveryPort(
      async <T>(value: Request): Promise<T> => {
        calls.push(value);
        if (
          value.type === "recovery:export" ||
          value.type === "recovery:restore"
        ) {
          effects++;
          // The host succeeded; only its IPC response is lost.
          throw new Error("response lost after host success");
        }
        if (value.type !== "recovery:status" || value.operationId !== id)
          throw new Error("wrong request ID");
        return hostResult as T;
      },
      () => id,
    );
    let model =
      mode === "restore"
        ? beginRestore(createRecoveryPanelModel(), 1, target)
        : beginExport(createRecoveryPanelModel(), 1, target, mode);
    try {
      await (mode === "restore"
        ? port.restore(target)
        : port.export(target, mode));
      throw new Error("expected IPC rejection");
    } catch (error) {
      model = failOperation(model, 1, {
        target,
        message: String(error),
        request: port.currentRequest()!,
      });
    }
    expect(model.pendingUnknown?.operationId).toBe(id);
    expect(model.pendingUnknown?.directory).toBeUndefined();
    expect(canStartOperation(model, target)).toBe(false);
    await expect(
      port.export({ ...target, id: 2 }, "metadata-only"),
    ).rejects.toThrow("recovery-request-unconfirmed");
    expect(effects).toBe(1);
    expect(port.currentRequest()?.operationId).toBe(id);
    // Recreating the pure model represents panel unmount/remount; bridge survives.
    model = holdRecoveryRequest(
      createRecoveryPanelModel(),
      port.currentRequest()!,
    );
    expect(canStartOperation(model, target)).toBe(false);
    model = applyStatus(beginStatus(model, 2), 2, await port.status());
    expect(model.pendingUnknown).toBeNull();
    expect(model.lastSuccess?.directory).toBe(hostResult.directory);
    expect(model.lastSuccess?.kind).toBe(hostResult.kind);
    expect(canStartOperation(model, target)).toBe(true);
    expect(effects).toBe(1);
    expect(calls.filter((value) => value.type === "recovery:status")).toEqual([
      { type: "recovery:status", operationId: id },
    ]);
  },
);

it("keeps an unconfirmed request on missing, pending, null, failed or mismatched status", async () => {
  let response: RecoveryActionResult | null = {
    kind: "blocked",
    reason: "recovery-operation-not-found",
  };
  const port = createConflictRecoveryPort(
    async <T>(value: Request): Promise<T> => {
      if (value.type === "recovery:restore") throw new Error("lost");
      return response as T;
    },
  );
  await expect(port.restore(target)).rejects.toThrow("lost");
  const context = port.currentRequest()!;
  let model = holdRecoveryRequest(createRecoveryPanelModel(), context);
  let token = 0;
  for (const result of [
    null,
    { kind: "blocked", reason: "recovery-operation-pending" },
    { kind: "blocked", reason: "recovery-operation-not-found" },
    { kind: "restored", directory: "/other", checkpointHash: "c".repeat(64) },
    {
      kind: "complete-bundle",
      directory: "/other",
      checkpointHash: target.checkpointHash,
    },
  ] as (RecoveryActionResult | null)[]) {
    response = result;
    token++;
    model = applyStatus(beginStatus(model, token), token, await port.status());
    expect(canStartOperation(model, target)).toBe(false);
    await expect(port.restore(target)).rejects.toThrow(
      "recovery-request-unconfirmed",
    );
    expect(port.currentRequest()).toEqual(context);
  }
  model = failStatus(
    beginStatus(model, ++token),
    token,
    "status transport lost",
  );
  expect(model.pendingUnknown?.operationId).toBe(context.operationId);
  expect(canStartOperation(model, target)).toBe(false);
});

it.each(["recovery-refused", "recovery-incomplete-preserved", "cancelled"])(
  "releases only after the same request is confirmed as %s",
  async (reason) => {
    const result: RecoveryActionResult =
      reason === "cancelled"
        ? { kind: "cancelled" }
        : reason === "recovery-incomplete-preserved"
          ? {
              kind: "blocked",
              reason,
              target,
              directory: "/temporary/incomplete",
            }
          : { kind: "blocked", reason, target };
    const port = createConflictRecoveryPort(
      async <T>(value: Request): Promise<T> => {
        if (value.type === "recovery:restore") throw new Error("lost response");
        return result as T;
      },
    );
    await expect(port.restore(target)).rejects.toThrow("lost response");
    let model = holdRecoveryRequest(
      createRecoveryPanelModel(),
      port.currentRequest()!,
    );
    model = applyStatus(beginStatus(model, 1), 1, await port.status());
    expect(model.pendingUnknown).toBeNull();
    expect(canStartOperation(model, target)).toBe(true);
    if (result.kind === "blocked")
      expect(model.notice).toMatchObject({
        kind: "blocked",
        directory: result.directory,
      });
  },
);

it("adopts an unknown directory only for the original target", () => {
  const context = {
    operationId: randomUUID(),
    target,
    mode: "restore" as const,
  };
  let model = holdRecoveryRequest(createRecoveryPanelModel(), context);
  model = applyStatus(beginStatus(model, 1), 1, {
    kind: "outcome-unknown",
    target: { ...target, id: 2 },
    directory: "/other",
    reason: "unknown",
  });
  expect(model.pendingUnknown?.directory).toBeUndefined();
  model = applyStatus(beginStatus(model, 2), 2, {
    kind: "outcome-unknown",
    target,
    directory: "/same",
    reason: "unknown",
  });
  expect(model.pendingUnknown?.directory).toBe("/same");
  expect(model.pendingUnknown?.operationId).toBe(context.operationId);
  model = applyStatus(beginStatus(model, 3), 3, {
    kind: "restored",
    directory: "/wrong",
    checkpointHash: target.checkpointHash,
  });
  expect(model.pendingUnknown?.directory).toBe("/same");
  expect(model.lastSuccess).toBeNull();
});

it("preserves an already known output directory in the bridge across remount", async () => {
  let result: RecoveryActionResult = {
    kind: "outcome-unknown",
    target,
    directory: "/original",
    reason: "unknown",
  };
  const port = createConflictRecoveryPort(
    async <T>(): Promise<T> => result as T,
  );
  await port.restore(target);
  expect(port.currentRequest()?.directory).toBe("/original");
  let model = holdRecoveryRequest(
    createRecoveryPanelModel(),
    port.currentRequest()!,
  );
  result = {
    kind: "restored",
    directory: "/wrong",
    checkpointHash: target.checkpointHash,
  };
  model = applyStatus(beginStatus(model, 1), 1, await port.status());
  expect(model.pendingUnknown?.directory).toBe("/original");
  await expect(port.restore(target)).rejects.toThrow(
    "recovery-request-unconfirmed",
  );
  result = {
    kind: "restored",
    directory: "/original",
    checkpointHash: target.checkpointHash,
  };
  model = applyStatus(beginStatus(model, 2), 2, await port.status());
  expect(model.lastSuccess?.directory).toBe("/original");
  expect(model.pendingUnknown).toBeNull();
});

it.each(["restored", "blocked", "cancelled"] as const)(
  "releases an in-flight model request on a confirmed %s action response",
  (kind) => {
    let model = beginRestore(createRecoveryPanelModel(), 1, target);
    model = holdRecoveryRequest(model, {
      operationId: randomUUID(),
      target,
      mode: "restore",
    });
    const result: RecoveryActionResult =
      kind === "restored"
        ? { kind, directory: "/out", checkpointHash: target.checkpointHash }
        : kind === "blocked"
          ? { kind, reason: "recovery-refused", target }
          : { kind };
    model = applyActionResult(model, 1, result);
    expect(model.pendingUnknown).toBeNull();
    expect(canStartOperation(model, target)).toBe(true);
  },
);
