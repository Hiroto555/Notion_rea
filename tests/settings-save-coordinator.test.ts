import { describe, expect, it } from "vitest";
import {
  emptyDatabase,
  type DatabaseProjection,
  type DatabaseSettings,
  type DatabaseView,
} from "../src/shared/types";
import { PendingEdits } from "../src/renderer/pending-edits";
import {
  SettingsSaveCoordinator,
  type SettingsSaveRequest,
} from "../src/renderer/settings-save-coordinator";
import {
  applySettingsIntent,
  type SettingsIntent,
} from "../src/renderer/settings-intent";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function initial(): DatabaseSettings {
  const { rows: _rows, ...settings } = emptyDatabase();
  return settings;
}
function projection(
  revision: number,
  settings: DatabaseSettings = initial(),
): DatabaseProjection {
  return { revision, settings, records: [] };
}
function rename(base: string, name: string): SettingsIntent {
  return {
    kind: "viewPatch",
    viewId: "view-default",
    base: { name: base },
    patch: { name },
  };
}

describe("settings save coordinator", () => {
  it("retains a newer edit captured during a delayed ACK and sends it only at the proven next revision", async () => {
    const edits = new PendingEdits();
    const first = deferred<DatabaseProjection>();
    const started = deferred<void>();
    const calls: SettingsSaveRequest[] = [];
    const save = new SettingsSaveCoordinator(edits, (request) => {
      calls.push(request);
      if (calls.length === 1) {
        started.resolve(undefined);
        return first.promise;
      }
      return Promise.resolve(
        projection(request.revision + 1, request.settings),
      );
    });
    save.initialize("db", projection(0));
    const a = save.submit("db", 0, rename("テーブル", "first"));
    const writing = save.flush("db", a);
    await started.promise;
    const b = save.submit("db", 0, rename("first", "second"));
    expect(save.overlay("db").views[0].name).toBe("second");
    first.resolve(projection(1, calls[0].settings));
    await writing;
    expect(edits.snapshotSettingsIntents("db")).toMatchObject([
      { seq: b, observedRevision: 0, observedKnown: true },
    ]);
    expect(save.overlay("db").views[0].name).toBe("second");
    await save.flush("db", b);
    expect(calls.map((call) => call.revision)).toEqual([0, 1]);
    expect(calls[1].settings.views[0].name).toBe("second");
    expect(edits.size).toBe(0);
  });

  it("retains drafts and stops after a transport error with unknown commit outcome", async () => {
    const edits = new PendingEdits();
    const save = new SettingsSaveCoordinator(edits, async () => {
      throw new Error("connection lost");
    });
    save.initialize("db", projection(0));
    const a = save.submit("db", 0, rename("テーブル", "local"));
    await expect(save.flush("db", a)).rejects.toThrow("connection lost");
    expect(edits.snapshotSettingsIntents("db")).toMatchObject([{ seq: a }]);
    expect(edits.failed.has("db")).toBe(true);
    await expect(save.flush("db", a)).rejects.toThrow("connection lost");
    expect(() => save.initialize("db", projection(1))).toThrow(
      "pending or existing",
    );
    expect(save.revision("db")).toBe(0);
  });

  it("retains unknown intent fields without sending or acknowledging them", async () => {
    const edits = new PendingEdits();
    let calls = 0;
    const save = new SettingsSaveCoordinator(edits, async (request) => {
      calls++;
      return projection(request.revision + 1, request.settings);
    });
    save.initialize("db", projection(0));
    const intent = {
      ...rename("テーブル", "local"),
      futureIntent: { value: "keep" },
    } as unknown as SettingsIntent;
    const seq = save.submit("db", 0, intent);
    await expect(save.flush("db", seq)).rejects.toThrow(
      "Unsupported settings intent fields",
    );
    expect(calls).toBe(0);
    expect(edits.snapshotSettingsIntents("db")[0].intent).toEqual(intent);
    expect(edits.failed.has("db")).toBe(true);
  });

  it("rejects invalid ACK and wrong generation without acknowledging unrelated Page edits", async () => {
    const edits = new PendingEdits();
    const save = new SettingsSaveCoordinator(edits, async (request) =>
      projection(request.revision + 2, request.settings),
    );
    save.initialize("db", projection(3));
    const a = save.submit("db", 3, rename("テーブル", "draft"));
    const page = edits.add("db", { title: "owner draft" });
    await expect(save.flush("db", a)).rejects.toThrow("Invalid settings ACK");
    expect(edits.snapshotSettingsIntents("db")).toMatchObject([{ seq: a }]);
    expect(edits.has("db", page)).toBe(true);
    expect(save.revision("db")).toBe(3);
    expect(() => edits.ackSettingsIntent("db", a + 999)).toThrow(
      "acknowledgement mismatch",
    );
  });

  it("blocks late stale input and detects earlier Page writes without discarding either draft", async () => {
    const edits = new PendingEdits();
    const save = new SettingsSaveCoordinator(edits, async (request) =>
      projection(request.revision + 1, request.settings),
    );
    save.initialize("db", projection(0));
    const first = save.submit("db", 0, rename("テーブル", "first"));
    await save.flush("db", first);
    const stale = save.submit("db", 0, rename("first", "late stale"));
    await expect(save.flush("db", stale)).rejects.toThrow(
      "Unknown settings revision",
    );
    expect(edits.snapshotSettingsIntents("db")).toMatchObject([
      { seq: stale, observedKnown: false },
    ]);
    const otherEdits = new PendingEdits();
    const other = new SettingsSaveCoordinator(otherEdits, async (request) =>
      projection(request.revision + 1, request.settings),
    );
    other.initialize("db", projection(0));
    const page = otherEdits.add("db", { title: "owner title" });
    const intent = other.submit("db", 0, rename("テーブル", "pending"));
    await expect(other.flush("db", intent)).rejects.toThrow(
      "Earlier owner edit",
    );
    expect(otherEdits.has("db", page)).toBe(true);
    expect(otherEdits.snapshotSettingsIntents("db")).toHaveLength(1);
  });

  it("refuses external revisions, semantic conflicts and unsafe Page-only recovery without dropping anything", async () => {
    const edits = new PendingEdits();
    const save = new SettingsSaveCoordinator(edits, async () => {
      throw new Error("保存の競合");
    });
    save.initialize("db", projection(0));
    const page = edits.add("other", { title: "page" });
    const seq = save.submit("db", 0, rename("テーブル", "mine"));
    await expect(save.flush("db", seq)).rejects.toThrow("競合");
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
    expect(() => edits.discardThrough(seq)).toThrow("settings intents");
    expect(edits.has("other", page)).toBe(true);
    expect(edits.snapshotSettingsIntents("db")).toHaveLength(1);
    expect(() =>
      applySettingsIntent(initial(), rename("external", "mine")),
    ).toThrow("field conflict");
  });

  it("rejects same-revision but different ACK content and preserves later inputs", async () => {
    const edits = new PendingEdits();
    const response = deferred<DatabaseProjection>();
    const started = deferred<void>();
    const save = new SettingsSaveCoordinator(edits, () => {
      started.resolve(undefined);
      return response.promise;
    });
    save.initialize("db", projection(0));
    const a = save.submit("db", 0, rename("テーブル", "first"));
    const writing = save.flush("db", a);
    await started.promise;
    const b = save.submit("db", 0, rename("first", "next"));
    response.resolve(projection(1, initial()));
    await expect(writing).rejects.toThrow("Invalid settings ACK");
    expect(
      edits.snapshotSettingsIntents("db").map((entry) => entry.seq),
    ).toEqual([a, b]);
    expect(save.revision("db")).toBe(0);
    expect(edits.failed.has("db")).toBe(true);
    await expect(save.flush("db", b)).rejects.toThrow();
  });

  it("clones submitted intents and refuses settings payloads with rows", async () => {
    const edits = new PendingEdits();
    const save = new SettingsSaveCoordinator(edits, async (request) =>
      projection(request.revision + 1, request.settings),
    );
    save.initialize("db", projection(0));
    const intent = rename("テーブル", "retained") as Extract<
      SettingsIntent,
      { kind: "viewPatch" }
    >;
    const seq = save.submit("db", 0, intent);
    intent.patch.name = "mutated";
    expect(save.overlay("db").views[0].name).toBe("retained");
    expect(() =>
      save.initialize(
        "other",
        projection(0, {
          ...initial(),
          rows: [],
        } as unknown as DatabaseSettings),
      ),
    ).toThrow();
    await save.flush("db", seq);
  });

  it("uses fixed view IDs and detects changed delete targets without mutating input", () => {
    const before = initial();
    const view: DatabaseView = {
      ...structuredClone(before.views[0]),
      id: "created",
      name: "copy",
      filter: { ...before.views[0].filter, id: "fixed-filter" },
    };
    const create: SettingsIntent = {
      kind: "createView",
      view,
      baseOrder: ["view-default"],
      baseActive: "view-default",
      afterViewId: "view-default",
      source: structuredClone(before.views[0]),
    };
    const copy = applySettingsIntent(before, create);
    expect(copy.views[1]).toEqual(view);
    expect(copy.activeViewId).toBe("created");
    expect(before.views).toHaveLength(1);
    expect(() =>
      applySettingsIntent(copy, {
        kind: "moveView",
        viewId: "created",
        delta: -1,
        baseOrder: ["view-default", "created"],
        baseActive: "view-default",
      }),
    ).toThrow("view order conflict");
    const moved = applySettingsIntent(copy, {
      kind: "moveView",
      viewId: "created",
      delta: -1,
      baseOrder: ["view-default", "created"],
      baseActive: "created",
    });
    expect(moved.views.map((item) => item.id)).toEqual([
      "created",
      "view-default",
    ]);
    const updated = applySettingsIntent(copy, {
      kind: "viewPatch",
      viewId: "created",
      base: { name: "copy" },
      patch: { name: "changed" },
    });
    expect(() =>
      applySettingsIntent(updated, { kind: "deleteView", base: view }),
    ).toThrow("delete view conflict");
    expect(() => applySettingsIntent(copy, create)).toThrow(
      "create view conflict",
    );
  });
});
