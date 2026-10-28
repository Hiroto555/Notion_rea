import { expect, it } from "vitest";
import {
  emptyDatabase,
  blankDoc,
  type Page,
  type DatabaseSettings,
  type DatabaseProjection,
} from "../src/shared/types";
import { PendingEdits } from "../src/renderer/pending-edits";
import {
  SettingsSaveCoordinator,
  type SettingsSaveRequest,
} from "../src/renderer/settings-save-coordinator";
import type { SettingsIntent } from "../src/renderer/settings-intent";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function settings(): DatabaseSettings {
  const { rows: _rows, ...value } = emptyDatabase();
  return value;
}
function projection(
  revision: number,
  value: DatabaseSettings = settings(),
): DatabaseProjection {
  return { revision, settings: value, records: [] };
}
function page(revision = 0, value: DatabaseSettings = settings()): Page {
  return {
    id: "db",
    schemaVersion: 1,
    parentId: null,
    title: "owner",
    icon: "▦",
    cover: "",
    position: 3,
    doc: blankDoc(),
    kind: "database",
    database: { ...structuredClone(value), rows: [] },
    favorite: false,
    createdAt: 10,
    updatedAt: 20,
    revision,
    deletedAt: null,
  };
}
function rename(name: string): SettingsIntent {
  return {
    kind: "viewPatch",
    viewId: "view-default",
    base: { name: "テーブル" },
    patch: { name },
  };
}
function savedPage(
  current: Page,
  patch: Partial<Page>,
  revision: number,
): Page {
  return {
    ...structuredClone(current),
    ...structuredClone(patch),
    revision,
    updatedAt: current.updatedAt + 1,
  };
}

it("serializes owner Page then settings with verified installation and one revision lineage", async () => {
  const edits = new PendingEdits();
  const requests: SettingsSaveRequest[] = [];
  const coordinator = new SettingsSaveCoordinator(edits, async (req) => {
    requests.push(req);
    return projection(req.revision + 1, req.settings);
  });
  coordinator.initialize("db", projection(0));
  const initial = page();
  coordinator.bindOwnerPage("db", initial);
  const pageSeq = coordinator.submitPage("db", 0, { title: "pending title" });
  const settingsSeq = coordinator.submit("db", 0, rename("renamed"));
  const staged = await coordinator.flushOwnerPage("db", pageSeq, async (req) =>
    savedPage(initial, req.patch, req.revision + 1),
  );
  expect(edits.has("db", pageSeq)).toBe(true);
  expect(edits.snapshotSettingsIntents("db")).toHaveLength(1);
  const installed = await coordinator.confirmOwnerInstall(
    "db",
    staged.installToken,
    staged.page,
    async () => staged.page,
  );
  expect(installed.title).toBe("pending title");
  expect(coordinator.revision("db")).toBe(1);
  const ack = await coordinator.flush("db", settingsSeq);
  expect(ack.installToken).toBeTruthy();
  expect(edits.snapshotSettingsIntents("db")).toHaveLength(1);
  const after = savedPage(
    installed,
    { database: { ...ack.settings, rows: [] } },
    ack.revision,
  );
  await coordinator.confirmOwnerInstall(
    "db",
    ack.installToken!,
    after,
    async () => after,
  );
  expect(requests.map((req) => req.revision)).toEqual([1]);
  expect(coordinator.revision("db")).toBe(2);
  expect(edits.size).toBe(0);
});

it("serializes settings then owner Page without replacing document or losing later inputs", async () => {
  const edits = new PendingEdits();
  const coordinator = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  coordinator.initialize("db", projection(0));
  const initial = page();
  coordinator.bindOwnerPage("db", initial);
  const s = coordinator.submit("db", 0, rename("renamed"));
  const p = coordinator.submitPage("db", 0, { title: "later" });
  const ack = await coordinator.flush("db", s);
  const afterSettings = savedPage(
    initial,
    { database: { ...ack.settings, rows: [] } },
    ack.revision,
  );
  await coordinator.confirmOwnerInstall(
    "db",
    ack.installToken!,
    afterSettings,
    async () => afterSettings,
  );
  expect(edits.has("db", p)).toBe(true);
  const staged = await coordinator.flushOwnerPage("db", p, async (req) =>
    savedPage(afterSettings, req.patch, req.revision + 1),
  );
  const after = await coordinator.confirmOwnerInstall(
    "db",
    staged.installToken,
    staged.page,
    async () => staged.page,
  );
  expect(after.title).toBe("later");
  expect(after.doc).toEqual(initial.doc);
  expect(after.database?.views[0].name).toBe("renamed");
  expect(edits.size).toBe(0);
  expect(coordinator.revision("db")).toBe(2);
});

it("rejects a forged owner Page ACK and keeps both Page and settings drafts", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  save.initialize("db", projection(0));
  const initial = page();
  save.bindOwnerPage("db", initial);
  const p = save.submitPage("db", 0, { title: "mine" });
  const s = save.submit("db", 0, rename("settings"));
  await expect(
    save.flushOwnerPage("db", p, async (req) => ({
      ...savedPage(initial, req.patch, 1),
      id: "other",
    })),
  ).rejects.toThrow();
  expect(edits.has("db", p)).toBe(true);
  expect(edits.snapshotSettingsIntents("db")[0].seq).toBe(s);
  expect(save.revision("db")).toBe(0);
  await expect(save.flush("db", s)).rejects.toThrow();
});

it("retains every draft when a transport outcome is unknown", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", page());
  const p = save.submitPage("db", 0, { title: "mine" });
  const s = save.submit("db", 0, rename("settings"));
  await expect(
    save.flushOwnerPage("db", p, async () => {
      throw new Error("lost ACK");
    }),
  ).rejects.toThrow("lost ACK");
  expect(edits.has("db", p)).toBe(true);
  expect(edits.snapshotSettingsIntents("db")[0].seq).toBe(s);
  expect(edits.failed.has("db")).toBe(true);
});

it("prevents Page-only recovery from discarding an owner Page draft", () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", page());
  const seq = save.submitPage("db", 0, { title: "owner draft" });
  expect(edits.snapshotPages()[0].expectedOwnerId).toBe("db");
  expect(edits.snapshotPages()[0].recoveryKind).toBe("database");
  expect(() => edits.snapshot()).toThrow();
  expect(() => edits.discardThrough(seq)).toThrow();
  expect(edits.has("db", seq)).toBe(true);
});

it("rejects an invalid settings ACK without dropping its intent or a later Page draft", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async () =>
    projection(1, settings()),
  );
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", page());
  const s = save.submit("db", 0, rename("mine"));
  const p = save.submitPage("db", 0, { title: "later" });
  await expect(save.flush("db", s)).rejects.toThrow("Invalid settings ACK");
  expect(edits.snapshotSettingsIntents("db")[0].seq).toBe(s);
  expect(edits.has("db", p)).toBe(true);
  expect(save.revision("db")).toBe(0);
});

it("keeps a settings intent and later Page draft when final read sees an external revision", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const s = save.submit("db", 0, rename("settings"));
  const p = save.submitPage("db", 0, { title: "later" });
  const ack = await save.flush("db", s);
  const installed = savedPage(
    initial,
    { database: { ...ack.settings, rows: [] } },
    ack.revision,
  );
  await expect(
    save.confirmOwnerInstall("db", ack.installToken!, installed, async () => ({
      ...installed,
      revision: 2,
    })),
  ).rejects.toThrow();
  expect(edits.snapshotSettingsIntents("db")[0].seq).toBe(s);
  expect(edits.has("db", p)).toBe(true);
  expect(save.revision("db")).toBe(0);
});

it("rejects a same-revision final read whose Page contents changed", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const s = save.submit("db", 0, rename("settings"));
  const ack = await save.flush("db", s);
  const installed = savedPage(
    initial,
    { database: { ...ack.settings, rows: [] } },
    ack.revision,
  );
  const changed = { ...installed, title: "external" };
  await expect(
    save.confirmOwnerInstall(
      "db",
      ack.installToken!,
      installed,
      async () => changed,
    ),
  ).rejects.toThrow();
  expect(edits.snapshotSettingsIntents("db")[0].seq).toBe(s);
  expect(save.revision("db")).toBe(0);
});

it("retains a settings intent when authoritative Page read fails after ACK", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const seq = save.submit("db", 0, rename("settings"));
  const ack = await save.flush("db", seq);
  const installed = savedPage(
    initial,
    { database: { ...ack.settings, rows: [] } },
    ack.revision,
  );
  await expect(
    save.confirmOwnerInstall("db", ack.installToken!, installed, async () => {
      throw new Error("read unavailable");
    }),
  ).rejects.toThrow("read unavailable");
  expect(edits.snapshotSettingsIntents("db")[0].seq).toBe(seq);
  expect(save.revision("db")).toBe(0);
  expect(edits.failed.has("db")).toBe(true);
});

it("does not acknowledge unrelated Page drafts while confirming an owner write", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const unrelated = edits.add("other", { title: "other pending" });
  const seq = save.submitPage("db", 0, { title: "owner saved" });
  const stage = await save.flushOwnerPage("db", seq, async (req) =>
    savedPage(initial, req.patch, 1),
  );
  await save.confirmOwnerInstall(
    "db",
    stage.installToken,
    stage.page,
    async () => stage.page,
  );
  expect(edits.has("other", unrelated)).toBe(true);
  expect(edits.has("db", seq)).toBe(false);
});

it("preserves the staged Page and newly typed settings when input arrives during final read", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const p = save.submitPage("db", 0, { title: "mine" });
  const stage = await save.flushOwnerPage("db", p, async (req) =>
    savedPage(initial, req.patch, 1),
  );
  const pending = deferred<Page>();
  const verifying = save.confirmOwnerInstall(
    "db",
    stage.installToken,
    stage.page,
    () => pending.promise,
  );
  const s = save.submit("db", 0, rename("typed during verify"));
  pending.resolve(stage.page);
  await expect(verifying).rejects.toThrow();
  expect(edits.has("db", p)).toBe(true);
  expect(edits.snapshotSettingsIntents("db")[0]).toMatchObject({
    seq: s,
    observedKnown: false,
  });
  expect(save.revision("db")).toBe(0);
});

it("allows an unrelated Page edit during final read without acknowledging it", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const p = save.submitPage("db", 0, { title: "mine" });
  const stage = await save.flushOwnerPage("db", p, async (req) =>
    savedPage(initial, req.patch, 1),
  );
  const pending = deferred<Page>();
  const verifying = save.confirmOwnerInstall(
    "db",
    stage.installToken,
    stage.page,
    () => pending.promise,
  );
  const other = edits.add("other", { title: "still pending" });
  pending.resolve(stage.page);
  await verifying;
  expect(edits.has("other", other)).toBe(true);
  expect(edits.has("db", p)).toBe(false);
  expect(save.revision("db")).toBe(1);
});

it("rejects a stale install token without invalidating the current ticket", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const p = save.submitPage("db", 0, { title: "mine" });
  const stage = await save.flushOwnerPage("db", p, async (req) =>
    savedPage(initial, req.patch, 1),
  );
  await expect(
    save.confirmOwnerInstall("db", {}, stage.page, async () => stage.page),
  ).rejects.toThrow("ticket mismatch");
  expect(edits.has("db", p)).toBe(true);
  expect(edits.failed.has("db")).toBe(false);
  await save.confirmOwnerInstall(
    "db",
    stage.installToken,
    stage.page,
    async () => stage.page,
  );
  expect(edits.has("db", p)).toBe(false);
  expect(save.revision("db")).toBe(1);
});

it("rejects a concurrent confirmation without invalidating the original", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  const initial = page();
  save.initialize("db", projection(0));
  save.bindOwnerPage("db", initial);
  const p = save.submitPage("db", 0, { title: "mine" });
  const stage = await save.flushOwnerPage("db", p, async (req) =>
    savedPage(initial, req.patch, 1),
  );
  const pending = deferred<Page>();
  const first = save.confirmOwnerInstall(
    "db",
    stage.installToken,
    stage.page,
    () => pending.promise,
  );
  await expect(
    save.confirmOwnerInstall(
      "db",
      stage.installToken,
      stage.page,
      async () => stage.page,
    ),
  ).rejects.toThrow("already in progress");
  expect(edits.failed.has("db")).toBe(false);
  expect(edits.has("db", p)).toBe(true);
  pending.resolve(stage.page);
  await first;
  expect(edits.has("db", p)).toBe(false);
  expect(save.revision("db")).toBe(1);
});

it("rejects an unproven owner binding and never accepts unknown Page edits as known", async () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  save.initialize("db", projection(0));
  expect(() => save.bindOwnerPage("db", { ...page(), id: "other" })).toThrow();
  const seq = save.submitPage("db", 0, { title: "retained" });
  await expect(
    save.flushOwnerPage("db", seq, async () => page(1)),
  ).rejects.toThrow();
  expect(edits.has("db", seq)).toBe(true);
  expect(edits.failed.has("db")).toBe(true);
});

it("rejects mismatched owner projection settings, revision and record ownership during binding", () => {
  const edits = new PendingEdits();
  const save = new SettingsSaveCoordinator(edits, async (req) =>
    projection(req.revision + 1, req.settings),
  );
  expect(() =>
    save.initialize("db", {
      ...projection(0),
      records: [
        {
          pageId: "row",
          databasePageId: "other",
          revision: 0,
          title: "row",
          icon: "📄",
          values: {},
          deletedAt: null,
        },
      ],
    }),
  ).toThrow();
  save.initialize("db", projection(0));
  expect(() => save.bindOwnerPage("db", page(1))).toThrow();
  const other = settings();
  other.views[0].name = "different";
  expect(() => save.bindOwnerPage("db", page(0, other))).toThrow();
  expect(edits.size).toBe(0);
});
