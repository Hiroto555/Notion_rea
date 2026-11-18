import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceSyncIntentJournal } from "../src/main/normal-apply-intent";
import {
  WorkspaceSyncRestartRequest,
  type RestartObservation,
} from "../src/main/workspace-sync-restart-request";
import type { SyncApplyTarget } from "../src/main/workspace-sync-intent";
import { Store } from "../src/persistence/store";
import {
  NORMAL_APPLY_KEY,
  completeNormalApply,
  readNormalApply,
  reserveNormalApply,
  type NormalApplyRecord,
} from "../src/sync/normal-apply-journal";

const fixtures: { directory: string; store: Store }[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.store.close();
    } catch {}
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture(): { directory: string; store: Store } {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-normal-journal-cancel-fault-"),
  );
  const store = new Store(join(directory, "workspace.sqlite"));
  const value = { directory, store };
  fixtures.push(value);
  return value;
}

const digest = (value: number): string =>
  value.toString(16).padStart(64, "0").slice(-64);

function target(revision = 2): SyncApplyTarget {
  return {
    workspaceId: "ws1",
    clientId: "client1",
    bindingId: "bind1",
    serverEpoch: "epoch1",
    revision,
    checkpointHash: digest(revision),
  };
}

function pendingRecord(
  value: SyncApplyTarget,
  id = randomUUID(),
): NormalApplyRecord {
  return {
    format: "folio-normal-apply/v1",
    id,
    createdAt: 1,
    target: value,
    state: "pending",
  };
}

it("cancels an admission-failed selection and allows a later prepare", () => {
  const { directory, store } = fixture();
  let denyAdmission = true;
  const journal = new WorkspaceSyncIntentJournal(directory, store, () => {
    if (denyAdmission) throw new Error("admission-denied");
  });
  const first = target(2),
    second = target(3);
  const observation: RestartObservation = {
    target: first,
    clean: true,
    idle: true,
    windowsClosed: false,
  };
  const request = new WorkspaceSyncRestartRequest(journal, () => observation);

  expect(request.prepare()).toBe("prepared");
  observation.windowsClosed = true;
  expect(request.commitAfterWindowsClosed()).toBe("blocked");
  expect(request.state()).toBe("uncertain");
  expect(readNormalApply(store.db)).toEqual({ status: "empty" });

  expect(request.cancel()).toBe("cancelled");
  expect(readNormalApply(store.db)).toEqual({ status: "empty" });

  denyAdmission = false;
  observation.target = second;
  observation.windowsClosed = false;
  expect(request.prepare()).toBe("prepared");
  observation.windowsClosed = true;
  expect(request.commitAfterWindowsClosed()).toBe("committed");
  expect(readNormalApply(store.db)).toMatchObject({
    status: "ready",
    record: { state: "pending", target: second },
  });
});

it("does not cancel a different reservation with the same target", () => {
  const { directory, store } = fixture();
  const value = target(2);
  const first = new WorkspaceSyncIntentJournal(directory, store);
  first.prepare(value);
  first.create(value);
  const reservationId = first.pending()?.id;
  if (!reservationId) throw new Error("expected a pending reservation");

  const second = new WorkspaceSyncIntentJournal(directory, store);
  second.prepare(value);
  expect(second.cancelIfMatches(value)).toBe("different");
  expect(() => second.cancel(value)).toThrow("apply-intent-mismatch");
  expect(readNormalApply(store.db)).toMatchObject({
    status: "ready",
    record: { id: reservationId, state: "pending", target: value },
  });
});

it("refuses a blocked journal without rewriting its corrupt bytes", () => {
  const { directory, store } = fixture();
  store.db
    .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
    .run(NORMAL_APPLY_KEY, "{corrupt");
  const journal = new WorkspaceSyncIntentJournal(directory, store);
  journal.prepare(target(2));

  expect(journal.cancelIfMatches(target(2))).toBe("different");
  expect(readNormalApply(store.db)).toEqual({ status: "blocked" });
  expect(
    (
      store.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(NORMAL_APPLY_KEY) as { value: string }
    ).value,
  ).toBe("{corrupt");
});

it("refuses a consumed reservation with a different id", () => {
  const { directory, store } = fixture();
  const value = target(2);
  const record = pendingRecord(value);
  store.transaction(() => reserveNormalApply(store.db, record));
  store.transaction(() => completeNormalApply(store.db, record));

  const journal = new WorkspaceSyncIntentJournal(directory, store);
  journal.prepare(value);
  expect(journal.cancelIfMatches(value)).toBe("different");
  expect(readNormalApply(store.db)).toMatchObject({
    status: "ready",
    record: { id: record.id, state: "consumed", target: value },
  });
});

it("keeps lost-acknowledgement uncertainty while safely cancelling its own row", () => {
  const { directory, store } = fixture();
  const value = target(2);
  const journal = new WorkspaceSyncIntentJournal(directory, store);
  const observation: RestartObservation = {
    target: value,
    clean: true,
    idle: true,
    windowsClosed: false,
  };
  const port = {
    read: () => journal.read(),
    cancelIfMatches: (candidate: SyncApplyTarget) =>
      journal.cancelIfMatches(candidate),
    create: (candidate: SyncApplyTarget) => {
      journal.create(candidate);
      throw new Error("lost-acknowledgement");
    },
  };
  const request = new WorkspaceSyncRestartRequest(port, () => observation);

  expect(request.prepare()).toBe("prepared");
  observation.windowsClosed = true;
  expect(request.commitAfterWindowsClosed()).toBe("blocked");
  expect(request.state()).toBe("uncertain");
  expect(readNormalApply(store.db)).toMatchObject({
    status: "ready",
    record: { state: "pending", target: value },
  });

  expect(request.cancel()).toBe("cancelled");
  expect(readNormalApply(store.db)).toMatchObject({
    status: "ready",
    record: { state: "cancelled", target: value },
  });
  expect(journal.read()).toEqual({ status: "empty" });
});
