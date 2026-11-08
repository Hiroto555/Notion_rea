import { describe, expect, it, vi } from "vitest";
import type { Request } from "../src/shared/types";
import {
  assertRequestStorage,
  storageActionForRequest,
} from "../src/main/storage-write-policy";

type RequestType = Request["type"] | "storage:pressure";
type StorageAction = "read" | "checkpoint" | "write" | "maintenance";

// Independent, exhaustive expectations from the Round 3 contract. The
// satisfies clause makes a new Request type a type error here as well.
const EXPECTED = {
  "recovery:list":"read", "recovery:status":"read", "recovery:export":"read", "recovery:restore":"read",
  load: "read",
  search: "read",
  versions: "read",
  pageSource: "read",
  "record:get": "read",
  "record:read": "read",
  "database:load": "read",
  "database:read": "read",
  "database:resolve": "read",
  "page:resolve": "read",
  "save:resolve": "read",
  "property:resolve": "read",
  "migration:resolve": "read",
  "property:preview": "read",
  "migration:preview": "read",
  "pageOrder:preview": "read",
  "pageOrder:apply": "write",
  "recovery:read": "read",
  import: "read",
  export: "read",
  exportRecovery: "read",
  exportPendingJournal: "read",
  downloadAttachment: "read",
  openExternal: "read",
  "workspaceBackup:choose": "read",
  "workspaceBackup:restore": "read",
  "workspaceBackup:open": "read",
  "startup:status": "read",
  "sync:status": "read",
    "sync:connectionStatus": "read", "sync:retentionStatus": "read", "sync:connectionConfigure": "checkpoint", "sync:connectionDisable": "checkpoint", "sync:connectionResolve": "read",
    "sync:transferInventory": "read", "sync:transferPlan": "checkpoint", "sync:transferRelease": "maintenance", "sync:transferResolve": "read",
  "sync:run": "write",
  "sync:restartStatus": "read",
  "sync:restartRequest": "checkpoint",
  "sync:restartCancel": "checkpoint",
  "sync:conflict": "read",
  "sync:conflictDecisionStatus": "read",
  "sync:conflictPreview": "checkpoint",
  "sync:conflictConfirm": "checkpoint",
  "sync:conflictCancel": "checkpoint",
  "sync:conflictCandidate": "read",
  "sync:conflictExport": "read",
  "storage:pressure": "read",
  "storage:readLimits": "read",
  "storage:applyLimits": "write",
  "storage:overview": "read",
  "storage:archivePlan": "read",
  "storage:archiveMove": "maintenance",
  "storage:orphanPlan": "read",
  "storage:orphanMove": "maintenance",
  "storage:rawSalvage": "read",
  "workspaceBackup:release": "read",

  "recovery:write": "checkpoint",

  create: "write",
  update: "write",
  move: "write",
  duplicate: "write",
  trash: "write",
  restore: "write",
  setting: "write",
  "save:commit": "write",
  "page:commit": "write",
  "database:commit": "write",
  "property:commit": "write",
  "migration:commit": "write",
  "record:create": "write",
  "record:patch": "write",
  "record:pageUpdate": "write",
  "record:trash": "write",
  "record:restore": "write",
  "record:duplicate": "write",
  "database:settings": "write",
  "recovery:copy": "write",
  attach: "write",
  recover: "write",
  restoreVersion: "write",
  backup: "write",
  "workspaceBackup:create": "write",
} satisfies Record<RequestType, StorageAction>;

const ROWS = Object.entries(EXPECTED) as [RequestType, StorageAction][];

describe("request storage policy", () => {
  it("classifies every Request type exactly once", () => {
    expect(ROWS).toHaveLength(89);
    expect(new Set(ROWS.map(([type]) => type)).size).toBe(ROWS.length);
    expect(ROWS.filter(([, action]) => action === "write")).toHaveLength(28);
    expect(ROWS.filter(([, action]) => action === "checkpoint")).toHaveLength(9);
    for (const [type, action] of ROWS)
      expect(storageActionForRequest(type)).toBe(action);
  });

  it("keeps contract-critical boundaries: backup writes, restore entries read", () => {
    for (const type of [
      "backup",
      "workspaceBackup:create",
      "recovery:copy",
      "recover",
      "restoreVersion",
      "record:trash",
      "database:settings",
    ] as const)
      expect(storageActionForRequest(type)).toBe("write");
    for (const type of [
      "workspaceBackup:choose",
      "workspaceBackup:restore",
      "workspaceBackup:open",
      "export",
      "exportRecovery",
      "exportPendingJournal",
      "import",
      "recovery:read",
      "storage:pressure",
    ] as const)
      expect(storageActionForRequest(type)).toBe("read");
    expect(storageActionForRequest("recovery:write")).toBe("checkpoint");
  });

  it("calls assertWritable only for write requests", () => {
    for (const [type, action] of ROWS) {
      const assertWritable = vi.fn();
      const result = assertRequestStorage(
        { type } as Request,
        { assertWritable },
      );
      expect({ type, calls: assertWritable.mock.calls.length }).toEqual({
        type,
        calls: action === "write" ? 1 : 0,
      });
      expect(result).toBeUndefined();
      if (action === "write") expect(assertWritable).toHaveBeenCalledWith();
    }
  });

  it("keeps reads and the recovery checkpoint alive when capacity is unknown", () => {
    const pressure = {
      assertWritable() {
        throw new Error("capacity-unknown");
      },
    };
    for (const [type, action] of ROWS) {
      const run = () => assertRequestStorage({ type } as Request, pressure);
      if (action === "write") expect(run).toThrow("capacity-unknown");
      else expect(run).not.toThrow();
    }
  });

  it("fails closed on unknown request types without probing capacity", () => {
    for (const type of [
      "unknown",
      "constructor",
      "__proto__",
      "toString",
      "",
    ]) {
      expect(() => storageActionForRequest(type as RequestType)).toThrow(
        /Unknown request type/,
      );
      const assertWritable = vi.fn();
      expect(() =>
        assertRequestStorage(
          { type } as unknown as Request,
          { assertWritable },
        ),
      ).toThrow(/Unknown request type/);
      expect(assertWritable).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed requests instead of treating them as reads", () => {
    for (const input of [null, undefined, 1, {}, { type: 1 }]) {
      const assertWritable = vi.fn();
      expect(() =>
        assertRequestStorage(input as unknown as Request, { assertWritable }),
      ).toThrow(/Unknown request type/);
      expect(assertWritable).not.toHaveBeenCalled();
    }
  });

  it("does not mutate or reformat the request payload", () => {
    const request = {
      type: "update",
      id: "page-1",
      revision: 3,
      patch: {
        title: "未保存の入力",
        doc: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "残す" }] },
          ],
        },
      },
    };
    const before = JSON.stringify(request);
    const assertWritable = vi.fn();
    assertRequestStorage(request as unknown as Request, { assertWritable });
    expect(assertWritable).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(request)).toBe(before);

    const rescue = {
      type: "exportPendingJournal",
      content: JSON.stringify({ saved: true }),
    };
    const rescueBefore = JSON.stringify(rescue);
    const rescuePressure = { assertWritable: vi.fn() };
    assertRequestStorage(rescue as unknown as Request, rescuePressure);
    expect(rescuePressure.assertWritable).not.toHaveBeenCalled();
    expect(JSON.stringify(rescue)).toBe(rescueBefore);
  });
});
