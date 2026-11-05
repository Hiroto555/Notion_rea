import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  mkdtempSync,
  linkSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { createRawWorkspaceSalvage } from "../src/persistence/raw-workspace-salvage";
import { Store } from "../src/persistence/store";
import { attachFile, resolveAsset } from "../src/persistence/assets";
import { readWorkspaceOverview } from "../src/persistence/workspace-overview";
import { WorkspaceStorageService } from "../src/main/workspace-storage-service";
import { makeStorageOverviewReader } from "../src/main/storage-overview-reader";
import { preparePageCreation } from "../src/shared/page-operation";
import { requestSchema } from "../src/shared/types";
import type {
  ArchiveProposal,
  ManagedStorageOverview,
  WorkspaceLimitView,
} from "../src/shared/storage-overview";

let buildRoot: string;
let worker: string;
beforeAll(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "folio-r4-test-worker-"));
  worker = join(buildRoot, "storage-overview-worker.cjs");
  buildSync({
    entryPoints: [resolve("src/main/storage-overview-worker.ts")],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["node:sqlite"],
  });
});
afterAll(() => rmSync(buildRoot, { recursive: true, force: true }));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function fixture(env: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-r4-integrated-"),
  );
  const source = join(root, "source"),
    assets = join(source, "assets"),
    outside = join(root, "outside");
  mkdirSync(assets, { recursive: true });
  mkdirSync(outside);
  const store = new Store(join(source, "workspace.sqlite"));
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const chosen: (string | null)[] = [];
  const storage = new WorkspaceStorageService(
    source,
    store.db,
    env,
    async () => chosen.shift() ?? null,
    worker,
  );
  return { root, source, assets, outside, store, chosen, storage };
}

it("reads usage on one worker for concurrent requests, sees WAL and preserves registry discrepancies", async () => {
  const f = fixture();
  f.store.create(null, "page", "先行編集");
  writeFileSync(join(f.assets, "unregistered.txt"), "候補");
  const id = "11111111-1111-1111-1111-111111111111";
  f.store.db
    .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
    .run(id, JSON.stringify({ id, storageName: id }));
  const read = makeStorageOverviewReader(f.store.path, worker);
  const first = read();
  expect(read()).toBe(first);
  const secondPage = f.store.create(null, "page", "計測開始後の編集");
  const report = await first;
  expect(report.registry).toEqual({
    state: "complete",
    unregisteredFiles: 1,
    missingFiles: 1,
  });
  expect(report.assetBytes).toBe(Buffer.byteLength("候補"));
  expect(f.store.get(secondPage.id).title).toBe("計測開始後の編集");
  expect(readFileSync(join(f.assets, "unregistered.txt"), "utf8")).toBe("候補");
  expect(readWorkspaceOverview(f.store.path).receiptRows).toBe(0);
});

it("rejects DB growth before a receipt while preserving load, resolve, diagnostics and input", async () => {
  const f = fixture({ FOLIO_MAX_DATABASE_BYTES: "0" });
  const op = preparePageCreation("後で再試行", null);
  const before = structuredClone(op);
  const req = requestSchema.parse({ type: "page:commit", operation: op });
  expect(() => f.storage.admitRequest(req)).toThrow(/workspace-limit-exceeded/);
  expect(f.store.pages()).toHaveLength(0);
  expect(f.store.resolvePageOperation(op).status).toBe("unknown");
  expect(
    f.store.db.prepare("SELECT count(*) AS n FROM save_receipts").get()?.n,
  ).toBe(0);
  expect(op).toEqual(before);
  expect(() => f.storage.admitRequest({ type: "load" })).not.toThrow();
  const report = (await f.storage.handleUtility({
    type: "storage:overview",
  })) as ManagedStorageOverview;
  expect(report.limits).toEqual({ maxDatabaseBytes: 0 });
  const recovered = new WorkspaceStorageService(
    f.source,
    f.store.db,
    {},
    async () => null,
    worker,
  );
  recovered.admitRequest(req);
  expect(f.store.commitPageOperation(op).status).toBe("applied");
  expect(f.store.commitPageOperation(op).status).toBe("applied");
  expect(f.store.pages()).toHaveLength(1);
});

it("invalid config preserves diagnostics and source rescue; untrusted picker paths never cross renderer IPC", async () => {
  const f = fixture({ FOLIO_MAX_BACKUP_BYTES: "invalid" });
  expect(() =>
    f.storage.admitRequest({ type: "setting", key: "theme", value: "dark" }),
  ).toThrow(/workspace-limit-unknown/);
  const report = (await f.storage.handleUtility({
    type: "storage:overview",
  })) as ManagedStorageOverview;
  expect(report.limits).toBeNull();
  expect(
    requestSchema.safeParse({
      type: "storage:rawSalvage",
      directory: f.outside,
    }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      type: "storage:archiveMove",
      ticket: "made-up",
      source: f.source,
    }).success,
  ).toBe(false);
  expect(
    await f.storage.handleUtility({ type: "storage:rawSalvage" }),
  ).toBeNull();
  expect(readdirSync(f.outside)).toEqual([]);
  const page = f.store.create(null, "page", "raw");
  f.store.db
    .prepare("UPDATE pages SET data=? WHERE id=?")
    .run("{broken", page.id);
  f.chosen.push(f.outside);
  const result = (await f.storage.handleUtility({
    type: "storage:rawSalvage",
  })) as { directory: string };
  expect(result.directory.startsWith(f.outside + "/")).toBe(true);
  expect(
    f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(page.id)?.data,
  ).toBe("{broken");
  expect(() => f.storage.backups.choose(result.directory)).toThrow();
});

it("checks asset and automatic backup budgets before writing and keeps the original bytes", () => {
  const f = fixture({
    FOLIO_MAX_ASSET_BYTES: "3",
    FOLIO_MAX_BACKUP_BYTES: "1",
  });
  const file = join(f.root, "test.txt");
  writeFileSync(file, "four");
  expect(() =>
    attachFile(f.store.db, f.assets, file, (n) => f.storage.admitAttachment(n)),
  ).toThrow(/workspace-limit-exceeded/);
  expect(readdirSync(f.assets)).toEqual([]);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM assets").get()?.n).toBe(
    0,
  );
  expect(() => f.storage.backups.createAutomatic("before-rich-blocks")).toThrow(
    /workspace-limit-exceeded/,
  );
  expect(existsSync(join(f.source, "backups"))).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("four");
});

it("only an explicit archive ticket moves an older backup; pinned tickets, the newest backup and repeats are protected", async () => {
  const f = fixture();
  const p = f.store.create(null, "page", "古い世代");
  const old = f.storage.backups.create();
  f.store.update(p.id, p.revision, { title: "新しい世代" });
  const recent = f.storage.backups.create();
  f.chosen.push(old.directory);
  await expect(
    f.storage.handleUtility({ type: "storage:archivePlan" }),
  ).rejects.toThrow();
  await f.storage.handleUtility({ type: "workspaceBackup:release" });
  f.chosen.push(recent.directory);
  await expect(
    f.storage.handleUtility({ type: "storage:archivePlan" }),
  ).rejects.toThrow();
  f.chosen.push(old.directory);
  const plan = (await f.storage.handleUtility({
    type: "storage:archivePlan",
  })) as ArchiveProposal;
  expect(existsSync(old.directory)).toBe(true);
  f.chosen.push(f.outside);
  const moved = (await f.storage.handleUtility({
    type: "storage:archiveMove",
    ticket: plan.ticket,
  })) as { destination: string };
  expect(existsSync(old.directory)).toBe(false);
  expect(existsSync(recent.directory)).toBe(true);
  expect(f.storage.backups.choose(moved.destination).inventory.pages).toBe(1);
  expect(() =>
    f.storage.handleUtility({
      type: "storage:archiveMove",
      ticket: plan.ticket,
    }),
  ).toThrow();
  expect(f.store.get(p.id).title).toBe("新しい世代");
});

it("refuses a multiply-linked attachment before exporting external file contents", async () => {
  const f = fixture();
  const external = join(f.root, "unrelated-private-file");
  writeFileSync(external, "not workspace content");
  linkSync(external, join(f.assets, "alias"));
  f.chosen.push(f.outside);
  await expect(
    f.storage.handleUtility({ type: "storage:rawSalvage" }),
  ).rejects.toThrow();
  for (const child of readdirSync(f.outside)) {
    expect(existsSync(join(f.outside, child, "assets", "alias"))).toBe(false);
  }
  expect(readFileSync(external, "utf8")).toBe("not workspace content");
});

it("rejects a salvage request if the live SQLite handle belongs to another workspace", () => {
  const f = fixture(),
    other = fixture();
  expect(() =>
    createRawWorkspaceSalvage(other.store.db, f.source, f.outside),
  ).toThrow();
  expect(readdirSync(f.outside)).toEqual([]);
});

it("allows raising a saved limit at capacity, rejects a stale change, and enforces the persisted result on reopen", async () => {
  const f = fixture();
  const initial = (await f.storage.handleUtility({
    type: "storage:readLimits",
  })) as WorkspaceLimitView;
  expect(initial).toMatchObject({ revision: null, configured: {} });
  const lower = (await f.storage.handleUtility({
    type: "storage:applyLimits",
    expectedRevision: null,
    configured: { maxDatabaseBytes: 0 },
  })) as WorkspaceLimitView;
  const service = new WorkspaceStorageService(
    f.source,
    f.store.db,
    {},
    async () => null,
    worker,
  );
  const op = preparePageCreation("設定後", null);
  expect(() =>
    service.admitRequest({ type: "page:commit", operation: op }),
  ).toThrow(/workspace-limit-exceeded/);
  await expect(async () =>
    service.handleUtility({
      type: "storage:applyLimits",
      expectedRevision: null,
      configured: {},
    }),
  ).rejects.toThrow();
  const next = (await f.storage.handleUtility({
    type: "storage:applyLimits",
    expectedRevision: lower.revision,
    configured: {},
  })) as WorkspaceLimitView;
  expect(next.revision).not.toBe(lower.revision);
  expect(() =>
    service.admitRequest({ type: "page:commit", operation: op }),
  ).not.toThrow();
  expect(f.store.commitPageOperation(op).status).toBe("applied");
  const envLimited = new WorkspaceStorageService(
    f.source,
    f.store.db,
    { FOLIO_MAX_ASSET_BYTES: "10" },
    async () => null,
    worker,
  );
  const capped = (await envLimited.handleUtility({
    type: "storage:applyLimits",
    expectedRevision: next.revision,
    configured: { maxAssetBytes: 100 },
  })) as WorkspaceLimitView;
  expect(capped.effective.maxAssetBytes).toBe(10);
  expect(() => envLimited.admitAttachment(11)).toThrow(
    /workspace-limit-exceeded/,
  );
});

it("cannot invalidate an external verified backup by writing a rescue bundle into it", async () => {
  const source = fixture(),
    other = fixture();
  other.store.create(null, "page", "別の原本");
  const protectedBackup = other.storage.backups.create();
  const before = readdirSync(protectedBackup.directory);
  source.chosen.push(protectedBackup.directory);
  await expect(
    source.storage.handleUtility({ type: "storage:rawSalvage" }),
  ).rejects.toThrow(/退避先/);
  expect(readdirSync(protectedBackup.directory)).toEqual(before);
  expect(
    other.storage.backups.choose(protectedBackup.directory).inventory.pages,
  ).toBe(1);
});

it("reclaims only workspace bytes with a confirmed auxiliary-file move and keeps a working legacy asset URL", async () => {
  const f = fixture({ FOLIO_MAX_ASSET_BYTES: "5" });
  const legacyId = "e505d7c4-aeba-4c6e-8d56-5bfdfa2ad172";
  writeFileSync(join(f.assets, legacyId), "kept");
  writeFileSync(join(f.assets, "notes.txt"), "extra");
  expect(() => f.storage.admitAttachment(1)).toThrow(
    /workspace-limit-exceeded/,
  );
  f.chosen.push(join(f.assets, legacyId));
  await expect(
    f.storage.handleUtility({ type: "storage:orphanPlan" }),
  ).rejects.toThrow();
  expect(
    readFileSync(
      resolveAsset(f.store.db, f.assets, "folio-asset://" + legacyId).path,
      "utf8",
    ),
  ).toBe("kept");
  f.chosen.push(join(f.assets, "notes.txt"));
  const plan = (await f.storage.handleUtility({
    type: "storage:orphanPlan",
  })) as ArchiveProposal;
  expect(plan).toMatchObject({ name: "notes.txt", bytes: 5 });
  expect(existsSync(join(f.assets, "notes.txt"))).toBe(true);
  f.chosen.push(f.outside);
  const result = (await f.storage.handleUtility({
    type: "storage:orphanMove",
    ticket: plan.ticket,
  })) as { destination: string };
  expect(readFileSync(result.destination, "utf8")).toBe("extra");
  expect(existsSync(join(f.assets, "notes.txt"))).toBe(false);
  expect(() => f.storage.admitAttachment(1)).not.toThrow();
  expect(() =>
    f.storage.handleUtility({
      type: "storage:orphanMove",
      ticket: plan.ticket,
    }),
  ).toThrow();
  expect(readFileSync(join(f.assets, legacyId), "utf8")).toBe("kept");
});

it("keeps receipt rows at the configured limit, permits replay and then resumes the same refused operation", async () => {
  const f = fixture();
  const limited = (await f.storage.handleUtility({
    type: "storage:applyLimits",
    expectedRevision: null,
    configured: { maxReceiptRows: 1 },
  })) as WorkspaceLimitView;
  const first = preparePageCreation("確定", null),
    next = preparePageCreation("入力保全", null);
  f.storage.admitRequest({ type: "page:commit", operation: first });
  f.store.commitPageOperation(first);
  f.storage.admitRequest({ type: "page:commit", operation: first });
  expect(f.store.commitPageOperation(first).status).toBe("applied");
  expect(() =>
    f.storage.admitRequest({ type: "page:commit", operation: next }),
  ).toThrow(/workspace-limit-exceeded/);
  expect(f.store.resolvePageOperation(next).status).toBe("unknown");
  expect(f.store.pages()).toHaveLength(1);
  await f.storage.handleUtility({
    type: "storage:applyLimits",
    expectedRevision: limited.revision,
    configured: { maxReceiptRows: 2 },
  });
  f.storage.admitRequest({ type: "page:commit", operation: next });
  expect(f.store.commitPageOperation(next).status).toBe("applied");
  expect(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM save_receipts").get()?.n,
  ).toBe(2);
  expect(f.store.pages()).toHaveLength(2);
});
