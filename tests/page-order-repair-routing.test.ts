import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handlePageOrderRepair } from "../src/main/page-order-repair";
import { assertReadOnlyRequest } from "../src/main/read-only-workspace";
import { WorkspaceStorageService } from "../src/main/workspace-storage-service";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { Store } from "../src/persistence/store";
import { requestSchema } from "../src/shared/types";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(dirname(store.path), { recursive: true, force: true });
  }
});

function fixture(env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "folio-order-routing-"));
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  const first = store.create(null, "page", "First");
  const tied = store.create(null, "page", "Tied");
  store.write({ ...tied, position: first.position });
  const storage = new WorkspaceStorageService(
    directory,
    store.db,
    env,
    async () => null,
  );
  const rows = () =>
    store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
  return { directory, store, storage, first, tied, rows };
}

it("routes a validated preview and apply through admission and keeps a verified pre-change backup", () => {
  const f = fixture();
  const previewRequest = requestSchema.parse({ type: "pageOrder:preview" });
  if (previewRequest.type !== "pageOrder:preview")
    throw new Error("Wrong test request");
  const admit = vi.fn(() => f.storage.admitSnapshot());
  const before = f.rows();
  f.storage.admitRequest(previewRequest);
  const preview = handlePageOrderRepair(f.store, previewRequest, admit);
  if (!("groups" in preview)) throw new Error("Wrong test preview");
  expect(preview.canApply).toBe(true);
  expect(f.rows()).toEqual(before);
  expect(admit).not.toHaveBeenCalled();

  const request = requestSchema.parse({
    type: "pageOrder:apply",
    sourceFingerprint: preview.sourceFingerprint,
  });
  if (request.type !== "pageOrder:apply") throw new Error("Wrong test request");
  f.storage.admitRequest(request);
  const result = handlePageOrderRepair(f.store, request, admit);
  if (!("status" in result)) throw new Error("Wrong test result");
  expect(result.status).toBe("applied");
  expect(result.appliedPages).toBe(1);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(verifyFullBackup(result.backup!.directory).fingerprint).toBe(
    result.backup!.fingerprint,
  );
  expect(new Set(f.store.pages().map((page) => page.position)).size).toBe(2);
});

it("refuses a configured backup budget before creating a directory or changing Pages", () => {
  const f = fixture({ FOLIO_MAX_BACKUP_BYTES: "1" });
  const preview = handlePageOrderRepair(
    f.store,
    { type: "pageOrder:preview" },
    () => {},
  );
  const before = f.rows();
  const request = {
    type: "pageOrder:apply" as const,
    sourceFingerprint: preview.sourceFingerprint,
  };
  f.storage.admitRequest(request);
  const result = handlePageOrderRepair(f.store, request, () =>
    f.storage.admitSnapshot(),
  );
  expect(result).toMatchObject({ status: "rejected", appliedPages: 0 });
  if (!("issues" in result)) throw new Error("Wrong test result");
  expect(result.issues.join(" ")).toMatch(/バックアップ|容量/);
  expect(existsSync(join(f.directory, "backups"))).toBe(false);
  expect(f.rows()).toEqual(before);
});

it.each(["capacity-unknown", "capacity-exceeded"])(
  "keeps originals when admission fails with %s",
  (message) => {
    const f = fixture();
    const preview = handlePageOrderRepair(
      f.store,
      { type: "pageOrder:preview" },
      () => {},
    );
    const before = f.rows();
    const result = handlePageOrderRepair(
      f.store,
      {
        type: "pageOrder:apply",
        sourceFingerprint: preview.sourceFingerprint,
      },
      () => {
        throw new Error(message);
      },
    );
    expect(result).toMatchObject({
      status: "rejected",
      appliedPages: 0,
      issues: [expect.stringContaining(message)],
    });
    expect(f.rows()).toEqual(before);
    expect(existsSync(join(f.directory, "backups"))).toBe(false);
  },
);

it("rejects a stale preview before backup admission and never accepts renderer paths or positions", () => {
  const f = fixture();
  const preview = handlePageOrderRepair(
    f.store,
    { type: "pageOrder:preview" },
    () => {},
  );
  f.store.update(f.first.id, f.first.revision, {
    title: "Changed after preview",
  });
  const before = f.rows();
  const admit = vi.fn();
  const request = {
    type: "pageOrder:apply",
    sourceFingerprint: preview.sourceFingerprint,
  };
  const validated = requestSchema.parse(request);
  if (validated.type !== "pageOrder:apply")
    throw new Error("Wrong test request");
  expect(handlePageOrderRepair(f.store, validated, admit)).toMatchObject({
    status: "rejected",
    appliedPages: 0,
  });
  expect(admit).not.toHaveBeenCalled();
  expect(f.rows()).toEqual(before);
  for (const extra of [
    { backupDirectory: "/tmp/foreign" },
    { positions: [1, 2] },
  ])
    expect(requestSchema.safeParse({ ...request, ...extra }).success).toBe(
      false,
    );
  expect(
    requestSchema.safeParse({ ...request, sourceFingerprint: "bad" }).success,
  ).toBe(false);
});

it("previews from a read-only Store and refuses apply at the read-only request boundary", () => {
  const f = fixture();
  const before = f.rows();
  const readOnly = new Store(f.store.path, { readOnly: true });
  try {
    const request = { type: "pageOrder:preview" as const };
    expect(() => assertReadOnlyRequest(request)).not.toThrow();
    const preview = handlePageOrderRepair(readOnly, request, () => {
      throw new Error("unexpected admission");
    });
    expect(preview).toMatchObject({ canApply: true });
    expect(() =>
      assertReadOnlyRequest({
        type: "pageOrder:apply",
        sourceFingerprint: preview.sourceFingerprint,
      }),
    ).toThrow(/読み取り専用/);
    expect(f.rows()).toEqual(before);
  } finally {
    readOnly.close();
  }
});
