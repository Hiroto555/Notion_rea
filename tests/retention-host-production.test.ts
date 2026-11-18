import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAssets } from "../src/collaboration/runtime/assets";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { canonical } from "../src/collaboration/runtime/canonical";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import {
  CollaborationError,
  type Cut,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import { SharedMaintenance } from "../src/collaboration/runtime/maintenance";
import {
  ProductionRetentionHost,
  createRetainedSqliteOwner,
  createStoreRetainedOwner,
} from "../src/collaboration/runtime/retention-host-environment";
import { verifyRetentionReleaseReceipt } from "../src/collaboration/runtime/retention-release";
import {
  createMaintenanceRetentionPorts,
  readRetentionHostConfig,
  runSharedServer,
} from "../src/collaboration/runtime/server-entry";
import type { SharedProvider } from "../src/collaboration/runtime/provider-port";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { Store } from "../src/persistence/store";
import type { Doc } from "../src/shared/types";

/**
 * AUTHORED, NOT_RUN: production host registry, opaque SQLite retained
 * adapters, live-client leases, offline server wiring and the rooted audit
 * receipt path. All assertions run only when the suite is executed.
 */

const directories: string[] = [];
const closables: { close(): void }[] = [];

function directory(prefix = "folio-host-"): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(path);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const item of closables.splice(0))
    try {
      item.close();
    } catch {}
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function document(): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "intro" },
        content: [{ type: "text", text: "retention release" }],
      },
    ],
  };
}

function setup() {
  const authority = new SharedAuthority(directory("folio-host-authority-"));
  closables.push(authority);
  const boot = authority.bootstrap({
    orgId: "org",
    userId: "owner",
    deviceId: "owner-device",
    workspaceId: "workspace",
    documentId: "document",
    document: document(),
  });
  const client = new RuntimeStore(directory("folio-host-client-"));
  client.transaction(() => client.set("meta", "role", "client"));
  closables.push(client);
  const assets = new SharedAssets(authority.store);
  return { authority, client, assets, token: boot.token, scope: boot.scope };
}

function publishAsset(
  authority: SharedAuthority,
  token: string,
  scope: Scope,
  uploadId: string,
  bytes: Uint8Array,
): { hash: string; bytes: number; attemptId: string; receipt: unknown } {
  const staged = authority.stageAsset(token, scope, uploadId, bytes);
  const base: Cut = authority.head();
  const auth = authority.session(token, scope.orgId);
  const attemptId = randomUUID();
  const receipt = authority.submit(token, {
    v: 1,
    attemptId,
    base,
    intent: {
      v: 1,
      intentId: randomUUID(),
      writerId: auth.writerId,
      scope,
      base,
      command: {
        kind: "resource",
        action: "asset.publish",
        payload: { uploadId, hash: staged.hash },
      },
    },
  });
  expect(receipt.status).toBe("SERVER_ACCEPTED");
  return { hash: staged.hash, bytes: bytes.byteLength, attemptId, receipt };
}

function privateSqlite(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(
    "CREATE TABLE m3_private_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),role TEXT NOT NULL,version INTEGER NOT NULL);" +
      "CREATE TABLE m3_private_records(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
  );
  db.prepare("INSERT INTO m3_private_identity VALUES(1,?,1)").run("workspace");
  db.prepare("INSERT INTO m3_private_records VALUES(?,?)").run(
    "original",
    canonical({ raw: "retained raw original" }),
  );
  closables.push(db);
  return db;
}

function prepareRelease(f = setup()) {
  const published = publishAsset(f.authority, f.token, f.scope, "held", new Uint8Array([4, 5, 6]));
  f.assets.hold(f.scope, published.hash, "selected");
  const host = new ProductionRetentionHost({ authority: f.authority, expectedServiceIds: ["client"] });
  const registration = host.registerRuntimeStore("client", f.client);
  const registry = host.registry();
  const maintenance = new SharedMaintenance(f.authority, registry);
  const request = { scope: f.scope, expectedCut: f.authority.head(),
    holds: [{ hash: published.hash, holdId: "selected" }] };
  const destination = new RuntimeStore(directory("folio-host-artifact-"));
  closables.push(destination);
  const prepared = registry.withLease(() => {
    const preview = maintenance.retentionReleasePreview(f.token, request);
    expect(preview.releasable).toBe(true);
    const fingerprint = preview.combinedFingerprint!;
    return { fingerprint, artifact: maintenance.exportRetentionRelease(
      f.token, request, fingerprint, destination) };
  });
  return { ...f, published, host, registration, registry, maintenance, request, destination, ...prepared,
    release: () => registry.withLease(() => maintenance.releaseRetentionHolds(
      f.token, request, prepared.fingerprint, prepared.artifact.artifactHash,
      prepared.artifact.artifactHash, destination)) };
}

function sourceImage(authority: SharedAuthority) {
  return {
    head: authority.head(),
    records: authority.store.db.prepare(
      "SELECT namespace,key,raw FROM runtime_records ORDER BY namespace,key").all(),
    blobs: authority.store.db.prepare(
      "SELECT scope,hash,hex(bytes) AS raw FROM runtime_blobs ORDER BY scope,hash").all(),
  };
}

describe.skipIf(process.platform === "win32")("ProductionRetentionHost (NOT_RUN)", () => {
  it("registers runtime/private stores and releases with a rooted audit receipt", () => {
    const f = setup();
    const published = publishAsset(
      f.authority,
      f.token,
      f.scope,
      "held",
      new TextEncoder().encode("recovery bytes"),
    );
    f.assets.hold(f.scope, published.hash, "selected");
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["client", "workspace-store", "private-source"],
      unaccountedStores: [],
    });
    host.registerRuntimeStore("client", f.client);
    host.registerPrivateStore("workspace-store", { path: file, db });
    const privateSource = new Store(join(directory("folio-host-source-"), "store.sqlite"));
    closables.push(privateSource);
    host.registerPrivateStore("private-source", privateSource);
    const registry = host.registry(f.authority);
    const maintenance = new SharedMaintenance(f.authority, registry);
    const request = {
      scope: f.scope,
      expectedCut: f.authority.head(),
      holds: [{ hash: published.hash, holdId: "selected" }],
    };
    const head = f.authority.head();
    const destination = new RuntimeStore(directory("folio-host-artifact-"));
    closables.push(destination);
    const released = registry.withLease(() => {
      const preview = maintenance.retentionReleasePreview(f.token, request);
      expect(preview.releasable).toBe(true);
      expect(preview.stores.map((entry) => entry.id)).toContain(
        "workspace-store",
      );
      const artifact = maintenance.exportRetentionRelease(
        f.token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      return maintenance.releaseRetentionHolds(
        f.token,
        request,
        preview.combinedFingerprint!,
        artifact.artifactHash,
        artifact.artifactHash,
        destination,
      );
    });
    expect(released.sourceCut).toEqual(head);
    expect(released.cut).toEqual(f.authority.head());
    expect(f.authority.head().seq).toBe(head.seq + 1);
    expect(
      f.authority.store.get(
        "asset.holds",
        "org:workspace:" + published.hash + ":selected",
      ),
    ).toBeNull();
    // The rooted audit blob carries the exact canonical receipt bytes and is
    // protected by a permanent hold; the unrooted row is only a lookup.
    const reference = verifyRetentionReleaseReceipt(
      f.authority,
      released.artifactHash,
    );
    expect(reference.hash).toBe(released.audit.hash);
    expect(
      f.authority.store.get(
        "asset.holds",
        "org:workspace:" + released.audit.hash + ":" + released.audit.uploadId,
      ),
    ).not.toBeNull();
    // Original private-store rows are untouched and still readable.
    expect(
      db.prepare("SELECT value FROM m3_private_records WHERE key='original'").get(),
    ).toMatchObject({ value: canonical({ raw: "retained raw original" }) });
  });

  it("blocks release when a private store drifts under the same head", () => {
    const f = setup();
    const published = publishAsset(
      f.authority,
      f.token,
      f.scope,
      "held",
      new TextEncoder().encode("recovery bytes"),
    );
    f.assets.hold(f.scope, published.hash, "selected");
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["client", "workspace-store"],
    });
    host.registerRuntimeStore("client", f.client);
    host.registerPrivateStore("workspace-store", { path: file, db });
    const registry = host.registry(f.authority);
    const maintenance = new SharedMaintenance(f.authority, registry);
    const request = {
      scope: f.scope,
      expectedCut: f.authority.head(),
      holds: [{ hash: published.hash, holdId: "selected" }],
    };
    const destination = new RuntimeStore(directory("folio-host-artifact-"));
    closables.push(destination);
    const prepared = registry.withLease(() => {
      const preview = maintenance.retentionReleasePreview(f.token, request);
      const artifact = maintenance.exportRetentionRelease(
        f.token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      return { fingerprint: preview.combinedFingerprint!, artifact };
    });
    db.prepare("INSERT INTO m3_private_records VALUES(?,?)").run(
      "draft",
      canonical({ raw: "private drift" }),
    );
    expect(f.authority.head()).toEqual(request.expectedCut);
    expect(() =>
      registry.withLease(() =>
        maintenance.releaseRetentionHolds(
          f.token,
          request,
          prepared.fingerprint,
          prepared.artifact.artifactHash,
          prepared.artifact.artifactHash,
          destination,
        ),
      ),
    ).toThrow("RETENTION_FINGERPRINT_MISMATCH");
    expect(
      f.authority.store.get(
        "asset.holds",
        "org:workspace:" + published.hash + ":selected",
      ),
    ).not.toBeNull();
  });

  it("rejects incomplete rosters, duplicates, closed handles and leased changes", () => {
    const f = setup();
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["client", "workspace-store"],
    });
    expect(() => host.registry(f.authority)).toThrow(
      "RETENTION_HOST_INCOMPLETE",
    );
    const registration = host.registerRuntimeStore("client", f.client);
    expect(() => host.registerRuntimeStore("client", f.client)).toThrow(
      "RETENTION_HOST_DUPLICATE",
    );
    registration.close();
    expect(() => registration.close()).toThrow("RETENTION_HOST_CLOSED");
    expect(() => host.registry(f.authority)).toThrow(
      "RETENTION_HOST_INCOMPLETE",
    );
    host.registerRuntimeStore("client", f.client);
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    host.registerPrivateStore("workspace-store", { path: file, db });
    const registry = host.registry(f.authority);
    const extra = new RuntimeStore(directory());
    closables.push(extra);
    registry.withLease(() => {
      expect(() => host.registerRuntimeStore("extra", extra)).toThrow(
        "RETENTION_HOST_ROSTER_FROZEN",
      );
      expect(() =>
        host.registerPrivateStore("extra-private", {
          path: "unreachable",
          db: db,
        }),
      ).toThrow("RETENTION_HOST_ROSTER_FROZEN");
    });
  });

  it("acquires a real client lease that blocks client operations", async () => {
    const f = setup();
    const provider: SharedProvider = {
      snapshot: async (scope, after) =>
        f.authority.snapshot(f.token, scope, after),
      submit: async (attempt) => f.authority.submit(f.token, attempt),
      receipt: async (attempt) => f.authority.receipt(f.token, attempt),
      invalidate: async (attempt) => f.authority.invalidate(f.token, attempt),
      proof: async (scope, seq) => f.authority.proof(f.token, scope, seq),
      workspaces: async (org) => f.authority.workspaces(f.token, org),
      close() {},
    };
    const live = new SharedRuntimeClient(
      directory("folio-host-live-"),
      provider,
      f.scope,
      f.authority.session(f.token, "org").writerId,
    );
    closables.push(live);
    await live.open();
    const lease = live.acquireRetentionLease();
    const roots = lease.inspect();
    expect(roots.generation).toMatch(/^[a-f0-9]{64}$/);
    await expect(live.open()).rejects.toThrow("CLIENT_BUSY");
    expect(() => live.close()).toThrow("CLIENT_BUSY");
    expect(() => live.history.clear()).toThrow("RETENTION_HISTORY_BUSY");
    lease.release();
    expect(() => lease.inspect()).toThrow("RETENTION_CLIENT_BUSY");
    await live.open();
    live.close();
  });

  it("verifies then rejects a tampered receipt row or audit blob", () => {
    const f = setup();
    const published = publishAsset(
      f.authority,
      f.token,
      f.scope,
      "held",
      new TextEncoder().encode("recovery bytes"),
    );
    f.assets.hold(f.scope, published.hash, "selected");
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["client"],
    });
    host.registerRuntimeStore("client", f.client);
    const registry = host.registry(f.authority);
    const maintenance = new SharedMaintenance(f.authority, registry);
    const request = {
      scope: f.scope,
      expectedCut: f.authority.head(),
      holds: [{ hash: published.hash, holdId: "selected" }],
    };
    const destination = new RuntimeStore(directory("folio-host-artifact-"));
    closables.push(destination);
    const released = registry.withLease(() => {
      const preview = maintenance.retentionReleasePreview(f.token, request);
      const artifact = maintenance.exportRetentionRelease(
        f.token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      return maintenance.releaseRetentionHolds(
        f.token,
        request,
        preview.combinedFingerprint!,
        artifact.artifactHash,
        artifact.artifactHash,
        destination,
      );
    });
    expect(
      verifyRetentionReleaseReceipt(f.authority, released.artifactHash).hash,
    ).toBe(released.audit.hash);
    // Direct unrooted-row tampering fails verification even though
    // authority.verify() itself stays clean.
    const row = f.authority.store.get(
      "retention.releases",
      released.artifactHash,
    ) as Record<string, unknown>;
    f.authority.store.transaction(() =>
      f.authority.store.set("retention.releases", released.artifactHash, {
        ...row,
        payload: { ...(row.payload as object), actor: { userId: "intruder" } },
      }),
    );
    expect(() => f.authority.verify()).not.toThrow();
    expect(() =>
      verifyRetentionReleaseReceipt(f.authority, released.artifactHash),
    ).toThrow(CollaborationError);
  });
});

describe.skipIf(process.platform === "win32")("retention production safety regressions (NOT_RUN)", () => {
  it("charges opaque inventories against the existing combined capacity bound", () => {
    const f = setup();
    const published = publishAsset(f.authority, f.token, f.scope, "held", new Uint8Array([1]));
    f.assets.hold(f.scope, published.hash, "selected");
    const host = new ProductionRetentionHost({ authority: f.authority, expectedServiceIds: ["large"] });
    const file = join(directory(), "large.sqlite");
    const db = privateSqlite(file);
    db.prepare("INSERT INTO m3_private_records VALUES(?,?)").run("large", "x".repeat(7_999_000));
    host.registerPrivateStore("large", { path: file, db });
    const registry = host.registry();
    const request = { scope: f.scope, expectedCut: f.authority.head(),
      holds: [{ hash: published.hash, holdId: "selected" }] };
    const before = sourceImage(f.authority);
    const preview = registry.withLease(() =>
      new SharedMaintenance(f.authority, registry).retentionReleasePreview(f.token, request));
    expect(preview.releasable).toBe(false);
    expect(preview.blocks).toContain("RETENTION_INVENTORY_LIMIT");
    expect(sourceImage(f.authority)).toEqual(before);
  });

  it("does not let a replacement registration reuse an exported fingerprint", () => {
    const f = prepareRelease();
    f.registration.close();
    f.host.registerRuntimeStore("client", f.client);
    const registry = f.host.registry();
    const maintenance = new SharedMaintenance(f.authority, registry);
    expect(() => f.registry.bindAuthority(f.authority).withLease(() => null))
      .toThrow("RETENTION_HOST_ROSTER_STALE");
    expect(() => registry.withLease(() => maintenance.releaseRetentionHolds(
      f.token, f.request, f.fingerprint, f.artifact.artifactHash,
      f.artifact.artifactHash, f.destination))).toThrow("RETENTION_FINGERPRINT_MISMATCH");
    expect(f.authority.head()).toEqual(f.request.expectedCut);
  });

  it("rolls back all staged evidence when the audit returns no receipt", () => {
    const f = prepareRelease();
    const before = sourceImage(f.authority);
    const submit = vi.spyOn(f.authority, "submit").mockReturnValue(undefined as never);
    expect(f.release).toThrow("UNKNOWN");
    expect(sourceImage(f.authority)).toEqual(before);
    expect(f.destination.get("retention.recovery", f.artifact.artifactHash)).not.toBeNull();
    expect(f.release).toThrow("UNKNOWN");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a known asynchronous audit port before invocation", () => {
    const f = prepareRelease();
    const before = sourceImage(f.authority);
    let calls = 0;
    Object.defineProperty(f.authority, "submit", {
      configurable: true,
      value: async () => { calls++; return undefined; },
    });
    expect(f.release).toThrow("SYNCHRONOUS_PORT_UNSUPPORTED");
    expect(calls).toBe(0);
    expect(sourceImage(f.authority)).toEqual(before);
  });

  it("rolls back an actual audit capacity failure without deleting the artifact", () => {
    const f = prepareRelease();
    const root = dirname(f.authority.store.path);
    const count = f.authority.store.db.prepare(
      "SELECT (SELECT count(*) FROM runtime_records) + (SELECT count(*) FROM runtime_blobs) AS c",
    ).get() as { c: number };
    f.authority.close();
    const authority = new SharedAuthority(root, { maxRows: Number(count.c) + 1 });
    closables.push(authority);
    const host = new ProductionRetentionHost({ authority, expectedServiceIds: ["client"] });
    host.registerRuntimeStore("client", f.client);
    const registry = host.registry();
    const maintenance = new SharedMaintenance(authority, registry);
    const before = sourceImage(authority);
    expect(() => registry.withLease(() => maintenance.releaseRetentionHolds(
      f.token, f.request, f.fingerprint, f.artifact.artifactHash,
      f.artifact.artifactHash, f.destination))).toThrow("SHARED_RUNTIME_LIMIT");
    expect(sourceImage(authority)).toEqual(before);
    expect(f.destination.get("retention.recovery", f.artifact.artifactHash)).not.toBeNull();
  });

  it("revalidates the privately pinned configuration before opening host evidence", () => {
    const f = setup();
    const path = join(directory(), "host.json");
    writeFileSync(path, canonical(strictConfig(f, [])), { mode: 0o600 });
    const ports = createMaintenanceRetentionPorts({}, readRetentionHostConfig(path)!);
    writeFileSync(path, canonical({ ...strictConfig(f, []), unaccountedStores: ["remote"] }));
    expect(() => ports.retentionHostFactory!(f.authority)).toThrow(CollaborationError);
    const inside = join(dirname(f.authority.store.path), "host-config.json");
    writeFileSync(inside, canonical(strictConfig(f, [])), { mode: 0o600 });
    const overlapping = createMaintenanceRetentionPorts({}, readRetentionHostConfig(inside)!);
    expect(() => overlapping.retentionHostFactory!(f.authority))
      .toThrow("RETENTION_HOST_CONFIG_INVALID");
  });

  it("checks current authorization before constructing a production roster", async () => {
    const f = setup();
    const tokenFile = join(directory(), "token.json");
    writeFileSync(tokenFile, canonical({ token: "invalid-current-session" }), { mode: 0o600 });
    const factory = vi.fn(() => { throw new Error("must not construct"); });
    await expect(runSharedServer(maintainArgs(f, tokenFile, "retention-preview", [
      "--holds", canonical([{ hash: digest("none"), holdId: "none" }]),
    ]), { retentionHostFactory: factory })).rejects.toThrow(CollaborationError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps BLOB roots byte-exact, detects escaped UNKNOWN, and fingerprints BLOB drift", () => {
    const file = join(directory(), "evidence.sqlite");
    const db = privateSqlite(file);
    db.exec("CREATE TABLE raw_blobs(id TEXT PRIMARY KEY,raw BLOB NOT NULL)");
    const bytes = Buffer.from('{"state":"\\u0055NKNOWN"}');
    db.prepare("INSERT INTO raw_blobs VALUES(?,?)").run("original", bytes);
    const owner = createStoreRetainedOwner({ path: file, db });
    const first = owner.acquire();
    const before = first.inspect();
    expect(before.unresolved).toBe(true);
    first.release();
    expect((db.prepare("SELECT raw FROM raw_blobs").get() as {raw: Uint8Array}).raw).toEqual(new Uint8Array(bytes));
    db.prepare("UPDATE raw_blobs SET raw=?").run(new Uint8Array([0, 255, 42]));
    const second = owner.acquire();
    expect(second.inspect().fingerprint).not.toBe(before.fingerprint);
    second.release();
  });

  it("cleans up a lost ownership proof without leaking its SQLite write lease", () => {
    const file = join(directory(), "evidence.sqlite");
    privateSqlite(file).close();
    const before = readFileSync(file);
    let owned = true;
    const owner = createRetainedSqliteOwner({
      path: file, role: "workspace",
      assertOwned: () => { if (!owned) throw new Error("ownership lost"); },
    });
    const lease = owner.acquire();
    expect(lease.inspect().unresolved).toBe(false);
    owned = false;
    expect(() => lease.release()).toThrow("UNKNOWN");
    expect(() => owner.acquire()).toThrow("RETENTION_HOST_LEASE_UNAVAILABLE");
    const probe = new DatabaseSync(file);
    try { probe.exec("BEGIN IMMEDIATE; ROLLBACK"); } finally { probe.close(); }
    expect(readFileSync(file)).toEqual(before);
  });

  it("requires an exact binding for source-bound retained journals", () => {
    const file = join(directory(), "bound.sqlite");
    const db = new DatabaseSync(file);
    closables.push(db);
    db.exec("CREATE TABLE artifact_identity(singleton INTEGER PRIMARY KEY,role TEXT,version INTEGER,binding TEXT)");
    db.prepare("INSERT INTO artifact_identity VALUES(1,?,1,?)").run("source", "bound-source");
    const missing = createRetainedSqliteOwner({ path: file, role: "source", assertOwned() {} }).acquire();
    expect(() => missing.inspect()).toThrow("RETENTION_HOST_SOURCE_BINDING_REQUIRED");
    missing.release();
    const exact = createRetainedSqliteOwner({
      path: file, role: "source", binding: "bound-source", assertOwned() {},
    }).acquire();
    expect(exact.inspect().unresolved).toBe(false);
    exact.release();
  });

  it("does not treat a native file-proof port as a semantic journal binding", () => {
    const f = setup();
    const file = join(directory(), "native-journal.sqlite");
    privateSqlite(file).close();
    const configFile = join(directory(), "host.json");
    writeFileSync(configFile, canonical(strictConfig(f, [
      { id: "journal", path: file, role: "workspace" },
    ])), { mode: 0o600 });
    // Contract simulation only: no Windows helper/native operation is invoked.
    const read = vi.fn(() => Buffer.alloc(0));
    const ports = createMaintenanceRetentionPorts({
      runtimeStoreOptions: () => ({}),
      privateFiles: {
        kind: "windows",
        assertDirectory: (path) => path,
        assertNewFile: (path) => path,
        assertNewDirectory: (path) => path,
        createDirectory() {},
        readPrivateFile: read,
        publishNewFile() {},
      },
    }, readRetentionHostConfig(configFile)!);
    expect(() => ports.retentionHostFactory!(f.authority))
      .toThrow("RETENTION_NATIVE_EVIDENCE_REQUIRED");
    expect(read).not.toHaveBeenCalled();
  });
});

function strictConfig(
  f: ReturnType<typeof setup>,
  retained: readonly { id: string; path: string; role: string }[],
): Record<string, unknown> {
  const root = f.authority.store.path.slice(
    0,
    -"/shared-runtime.sqlite".length,
  );
  return {
    profile: "DISPOSABLE_OFFLINE_V1",
    sourceRoot: root,
    orgId: "org",
    sourceGenesisHash: createHash("sha256")
      .update(canonical(f.authority.store.get("meta", "genesis")))
      .digest("hex"),
    expectedCut: f.authority.head(),
    runtimeStores: [],
    retainedStores: retained,
  };
}

function maintainArgs(
  f: ReturnType<typeof setup>,
  tokenFile: string,
  action: string,
  extra: readonly string[],
): string[] {
  return [
    "maintain",
    "--root",
    f.authority.store.path.slice(0, -"/shared-runtime.sqlite".length),
    "--org", "org",
    "--token-file", tokenFile,
    "--action", action,
    "--workspace", "workspace",
    "--document", "document",
    "--incarnation", f.scope.incarnationId,
    "--expected-cut", canonical(f.authority.head()),
    ...extra,
  ];
}

describe.skipIf(process.platform === "win32")("offline maintenance host wiring (NOT_RUN)", () => {
  it("runs the default config path preview -> export -> release +1", async () => {
    const f = setup();
    const bytes = new TextEncoder().encode("recovery bytes");
    const published = publishAsset(f.authority, f.token, f.scope, "held", bytes);
    f.assets.hold(f.scope, published.hash, "selected");
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    const tokenFile = join(directory(), "token.json");
    writeFileSync(tokenFile, canonical({ token: f.token }), { mode: 0o600 });
    const configFile = join(directory(), "retention-host.json");
    writeFileSync(
      configFile,
      canonical({
        ...strictConfig(f, [{ id: "workspace-store", path: file, role: "workspace" }]),
        runtimeStores: [{ id: "client", path: dirname(f.client.path), role: "client" }],
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("FOLIO_RETENTION_HOST_CONFIG", configFile);
    const holds = canonical([{ hash: published.hash, holdId: "selected" }]);
    const args = (action: string, extra: string[]) =>
      maintainArgs(f, tokenFile, action, [
        "--holds", holds,
        ...extra,
      ]);
    const head = f.authority.head();
    const previewHandle = await runSharedServer(args("retention-preview", []));
    const preview = previewHandle.result as {
      blocks: string[];
      releasable: boolean;
      combinedFingerprint?: string;
    };
    expect(preview.releasable).toBe(true);
    await previewHandle.close();
    const destination = join(directory(), "artifact-dest");
    const exportHandle = await runSharedServer(
      args("retention-export", [
        "--fingerprint", preview.combinedFingerprint!,
        "--destination", destination,
      ]),
    );
    const exported = exportHandle.result as { artifactHash: string };
    expect(exported.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    await exportHandle.close();
    const releaseHandle = await runSharedServer(
      args("retention-release", [
        "--fingerprint", preview.combinedFingerprint!,
        "--artifact", destination,
        "--artifact-hash", exported.artifactHash,
        "--ack-artifact-hash", exported.artifactHash,
      ]),
    );
    const released = releaseHandle.result as {
      artifactHash: string;
      sourceCut: Cut;
      cut: Cut;
    };
    expect(released.sourceCut).toEqual(head);
    expect(released.cut.seq).toBe(head.seq + 1);
    expect(f.authority.head().seq).toBe(head.seq + 1);
    await releaseHandle.close();
    // Byte-exact artifact: manifest metadata and blob bytes survive intact.
    const artifactStore = new RuntimeStore(destination);
    closables.push(artifactStore);
    const manifest = artifactStore.get(
      "retention.recovery",
      exported.artifactHash,
    ) as {
      body: {
        assets: {
          hash: string;
          bytes: number;
          record: { uploads: string[] };
        }[];
      };
    };
    expect(manifest.body.assets.length).toBe(1);
    expect(manifest.body.assets[0]).toMatchObject({
      hash: published.hash,
      bytes: bytes.byteLength,
    });
    expect(manifest.body.assets[0]!.record.uploads).toEqual(["held"]);
    expect(
      artifactStore.blobGet("retention-recovery", published.hash),
    ).toEqual(bytes);
    expect(
      f.authority.store.get(
        "asset.holds",
        "org:workspace:" + published.hash + ":selected",
      ),
    ).toBeNull();
    expect(verifyRetentionReleaseReceipt(f.authority, exported.artifactHash).cut).toEqual(released.cut);
    expect(releaseHandle.result).toMatchObject({ assetsDeleted: 0, bytesReclaimed: 0 });
    // Original private-store rows are untouched.
    expect(
      db.prepare("SELECT value FROM m3_private_records WHERE key='original'").get(),
    ).toMatchObject({ value: canonical({ raw: "retained raw original" }) });
  });

  it("fails explicitly without configuration and rejects bad profiles", async () => {
    const f = setup();
    const tokenFile = join(directory(), "token.json");
    writeFileSync(tokenFile, canonical({ token: f.token }), { mode: 0o600 });
    await expect(
      runSharedServer(
        maintainArgs(f, tokenFile, "retention-preview", [
          "--holds", canonical([{ hash: digest("none"), holdId: "none" }]),
        ]),
      ),
    ).rejects.toThrow("RETENTION_HOST_REQUIRED");
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    privateSqlite(file).close();
    const retained = [{ id: "workspace-store", path: file, role: "workspace" }];
    const badFile = join(directory(), "bad.json");
    writeFileSync(
      badFile,
      canonical({ profile: "ARBITRARY_UI", orgId: "org" }),
      { mode: 0o600 },
    );
    expect(() => readRetentionHostConfig(badFile)).toThrow(
      "RETENTION_HOST_CONFIG_INVALID",
    );
    // Unknown key rejected.
    writeFileSync(
      badFile,
      canonical({
        ...strictConfig(f, retained),
        unknown: 1,
      }),
      { mode: 0o600 },
    );
    expect(() => readRetentionHostConfig(badFile)).toThrow(
      "RETENTION_HOST_CONFIG_INVALID",
    );
    // A serialized clients section is not accepted in this profile.
    writeFileSync(
      badFile,
      canonical({ ...strictConfig(f, retained), clients: [] }),
      { mode: 0o600 },
    );
    expect(() => readRetentionHostConfig(badFile)).toThrow(
      "RETENTION_HOST_CONFIG_INVALID",
    );
    // Noncanonical JSON (whitespace/key order) is rejected outright.
    writeFileSync(
      badFile,
      JSON.stringify(strictConfig(f, retained), null, 2),
      { mode: 0o600 },
    );
    expect(() => readRetentionHostConfig(badFile)).toThrow(
      "RETENTION_HOST_CONFIG_INVALID",
    );
    // Symlinked and world-readable config files are rejected before parse.
    const valid = join(directory(), "valid.json");
    writeFileSync(valid, canonical(strictConfig(f, retained)), {
      mode: 0o600,
    });
    const link = join(directory(), "link.json");
    symlinkSync(valid, link);
    expect(() => readRetentionHostConfig(link)).toThrow(
      "RETENTION_HOST_CONFIG_INVALID",
    );
    chmodSync(valid, 0o644);
    expect(() => readRetentionHostConfig(valid)).toThrow(
      "RETENTION_HOST_CONFIG_INVALID",
    );
  });

  it("rejects source drift and wrong-source configs at factory use", () => {
    const f = setup();
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    privateSqlite(file).close();
    const configFile = join(directory(), "cfg.json");
    writeFileSync(
      configFile,
      canonical(strictConfig(f, [
        { id: "workspace-store", path: file, role: "workspace" },
      ])),
      { mode: 0o600 },
    );
    const config = readRetentionHostConfig(configFile)!;
    const ports = createMaintenanceRetentionPorts({}, config);
    // Wrong source: a different authority fails genesis/source binding.
    const other = new SharedAuthority(directory("folio-host-other-"));
    closables.push(other);
    other.bootstrap({
      orgId: "org",
      userId: "owner",
      deviceId: "device",
      workspaceId: "ws",
      documentId: "doc",
      document: document(),
    });
    expect(() =>
      ports.retentionHostFactory!(other),
    ).toThrow("RETENTION_HOST_SOURCE_CHANGED");
    // Cut drift after a publish invalidates the declared expectedCut.
    publishAsset(f.authority, f.token, f.scope, "drift", new Uint8Array([7]));
    expect(() =>
      ports.retentionHostFactory!(f.authority),
    ).toThrow("RETENTION_HOST_SOURCE_CHANGED");
  });

  it("rejects an asynchronous host factory before it can run", async () => {
    const f = setup();
    const tokenFile = join(directory(), "token.json");
    writeFileSync(tokenFile, canonical({ token: f.token }), { mode: 0o600 });
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls++;
      return {host: {} as never, close() {}};
    };
    await expect(
      runSharedServer(
        maintainArgs(f, tokenFile, "retention-preview", [
          "--holds", canonical([{ hash: digest("none"), holdId: "none" }]),
        ]),
        { retentionHostFactory: factory as never },
      ),
    ).rejects.toThrow(CollaborationError);
    expect(factoryCalls).toBe(0);
  });

  it("marks issued registries stale after any roster change", () => {
    const f = setup();
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["workspace-store"],
    });
    const registration = host.registerPrivateStore("workspace-store", {
      path: file,
      db,
    });
    const registry = host.registry(f.authority);
    registration.close();
    expect(() => registry.withLease(() => "stale")).toThrow(
      "RETENTION_HOST_ROSTER_STALE",
    );
    // Replacing the same id also invalidates the issued registry.
    host.registerPrivateStore("workspace-store", { path: file, db });
    expect(() => registry.withLease(() => "stale")).toThrow(
      "RETENTION_HOST_ROSTER_STALE",
    );
    expect(() => host.registry(f.authority)).not.toThrow();
  });

  it("rejects a foreign authority binding", () => {
    const f = setup();
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["workspace-store"],
    });
    host.registerPrivateStore("workspace-store", { path: file, db });
    const other = new SharedAuthority(directory("folio-host-other-"));
    closables.push(other);
    other.bootstrap({
      orgId: "other-org",
      userId: "owner",
      deviceId: "device",
      workspaceId: "ws",
      documentId: "doc",
      document: document(),
    });
    expect(() => host.registry(other)).toThrow(
      "RETENTION_HOST_SOURCE_CHANGED",
    );
  });

  it("detects escaped nonterminal states and open attempt reservations", () => {
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    // Neither the raw string nor its JSON field contains literal UNKNOWN.
    db.prepare("INSERT INTO m3_private_records VALUES(?,?)").run(
      "escaped",
      JSON.stringify({ nested: '{"state":"\\u0055NKNOWN"}' }),
    );
    const owner = createStoreRetainedOwner({ path: file, db });
    const escaped = owner.acquire();
    expect(escaped.inspect().unresolved).toBe(true);
    escaped.release();
    db.prepare("DELETE FROM m3_private_records WHERE key='escaped'").run();
    // An attempts table reservation with no terminal state blocks too.
    db.exec(
      "CREATE TABLE attempts(attemptId TEXT PRIMARY KEY,state TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO attempts VALUES(?,?)").run("a1", "RESERVED");
    const reserved = owner.acquire();
    expect(reserved.inspect().unresolved).toBe(true);
    reserved.release();
    db.prepare("UPDATE attempts SET state='COMMITTED' WHERE attemptId='a1'").run();
    const terminal = owner.acquire();
    expect(terminal.inspect().unresolved).toBe(false);
    terminal.release();
    db.exec("CREATE TABLE reservations(id TEXT PRIMARY KEY,raw TEXT NOT NULL)");
    db.prepare("INSERT INTO reservations VALUES(?,?)").run("a2", '{"intent":"original-without-receipt"}');
    const missingReceipt = owner.acquire();
    expect(missingReceipt.inspect().unresolved).toBe(true);
    missingReceipt.release();
  });

  it("rejects unrelated receipt substitution and payload/blob tampering", () => {
    const f = setup();
    const published = publishAsset(
      f.authority,
      f.token,
      f.scope,
      "held",
      new TextEncoder().encode("recovery bytes"),
    );
    f.assets.hold(f.scope, published.hash, "selected");
    const host = new ProductionRetentionHost({
      authority: f.authority,
      expectedServiceIds: ["client"],
    });
    host.registerRuntimeStore("client", f.client);
    const registry = host.registry(f.authority);
    const maintenance = new SharedMaintenance(f.authority, registry);
    const request = {
      scope: f.scope,
      expectedCut: f.authority.head(),
      holds: [{ hash: published.hash, holdId: "selected" }],
    };
    const destination = new RuntimeStore(directory("folio-host-artifact-"));
    closables.push(destination);
    const released = registry.withLease(() => {
      const preview = maintenance.retentionReleasePreview(f.token, request);
      const artifact = maintenance.exportRetentionRelease(
        f.token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      return maintenance.releaseRetentionHolds(
        f.token,
        request,
        preview.combinedFingerprint!,
        artifact.artifactHash,
        artifact.artifactHash,
        destination,
      );
    });
    const hash = released.artifactHash;
    const tamper = (mutate: (row: Record<string, unknown>) => void) => {
      const row = f.authority.store.get("retention.releases", hash) as Record<
        string,
        unknown
      >;
      const copy = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      mutate(copy);
      f.authority.store.transaction(() =>
        f.authority.store.set("retention.releases", hash, copy),
      );
      expect(() =>
        verifyRetentionReleaseReceipt(f.authority, hash),
      ).toThrow(CollaborationError);
      f.authority.store.transaction(() =>
        f.authority.store.set("retention.releases", hash, row),
      );
    };
    // An unrelated accepted publish attempt must not substitute for the audit.
    const unrelated = publishAsset(
      f.authority,
      f.token,
      f.scope,
      "unrelated",
      new Uint8Array([9]),
    );
    tamper((row) => {
      const audit = row.audit as Record<string, unknown>;
      audit.attemptId = unrelated.attemptId;
      audit.receipt = unrelated.receipt;
    });
    // Altered payload artifact hash fails the rooted payload comparison.
    tamper((row) => {
      (row.payload as Record<string, unknown>).artifactHash = digest("other");
    });
    // Raw audit blob bytes are compared against the stored payload hash.
    f.authority.store.db
      .prepare("UPDATE runtime_blobs SET bytes=? WHERE hash=?")
      .run(new Uint8Array([1, 2, 3]), released.audit.hash);
    expect(() =>
      verifyRetentionReleaseReceipt(f.authority, hash),
    ).toThrow("CORRUPT_SHARED_RUNTIME");
  });

  it("store owner rolls back and never mutates the inspected file", () => {
    const file = join(directory("folio-host-private-"), "workspace.sqlite");
    const db = privateSqlite(file);
    const owner = createStoreRetainedOwner({ path: file, db });
    const lease = owner.acquire();
    const evidence = lease.inspect();
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.unresolved).toBe(false);
    lease.release();
    expect(db.prepare("SELECT count(*) AS c FROM m3_private_records").get())
      .toMatchObject({ c: 1 });
    db.prepare("INSERT INTO m3_private_records VALUES(?,?)").run(
      "pending",
      canonical({ state: "PREPARED" }),
    );
    const second = owner.acquire();
    expect(second.inspect().unresolved).toBe(true);
    second.release();
    // A busy store rejects the lease rather than queuing behind writers.
    db.exec("BEGIN IMMEDIATE");
    expect(() => owner.acquire()).toThrow("RETENTION_HOST_LEASE_UNAVAILABLE");
    db.exec("ROLLBACK");
  });

  it("inspects a real persistence Store and leaves raw/BLOB rows untouched", () => {
    const file = join(directory("folio-host-store-"), "store.sqlite");
    const store = new Store(file);
    closables.push(store);
    const blob = new Uint8Array([0, 159, 146, 150, 255]);
    store.db
      .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
      .run("p1", "original text", blob);
    const owner = createStoreRetainedOwner({ path: store.path, db: store.db });
    const lease = owner.acquire();
    // An actual ordinary Store is RETAIN_ALL, including BLOB originals.
    const evidence = lease.inspect();
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.unresolved).toBe(false);
    lease.release();
    expect(() => lease.inspect()).toThrow("RETENTION_HOST_LEASE_REQUIRED");
    const row = store.db
      .prepare("SELECT data,body FROM pages WHERE id='p1'")
      .get() as { data: string; body: Uint8Array };
    expect(row.data).toBe("original text");
    expect(row.body).toEqual(blob);
  });
});
