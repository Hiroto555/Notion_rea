import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { DurableQueue } from "../src/collaboration/runtime/durable-queue";
import { SharedMaintenance } from "../src/collaboration/runtime/maintenance";
import { runMaintenanceOperator } from "../src/collaboration/runtime/maintenance-operator";
import { RetentionHostRegistry } from "../src/collaboration/runtime/retention-host-environment";
import { verifyRetentionReleaseReceipt } from "../src/collaboration/runtime/retention-release";
import { LocalHistory } from "../src/collaboration/runtime/local-history";
import type { SharedProvider } from "../src/collaboration/runtime/provider-port";
import { applyText } from "../src/collaboration/runtime/text-intent";
import type {
  RetentionReleaseCoverage,
  RetentionReleaseEnvironment,
} from "../src/collaboration/runtime/retention-dependencies";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import type { Doc } from "../src/shared/types";

/**
 * AUTHORED, NOT_RUN: these tests exercise the bounded retention-release path
 * end to end against a real SharedAuthority and real RuntimeStore instances.
 */

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const authorities: SharedAuthority[] = [];

function directory(prefix = "folio-release-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const authority of authorities.splice(0)) authority.close();
  for (const store of stores.splice(0)) store.close();
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
  const authority = new SharedAuthority(directory("folio-release-authority-"));
  authorities.push(authority);
  const boot = authority.bootstrap({
    orgId: "org",
    userId: "owner",
    deviceId: "owner-device",
    workspaceId: "workspace",
    documentId: "document",
    document: document(),
  });
  const client = new RuntimeStore(directory("folio-release-client-"));
  stores.push(client);
  const assets = new SharedAssets(authority.store);
  return {
    authority,
    client,
    assets,
    token: boot.token,
    scope: boot.scope,
    orgId: "org",
  };
}

function coverage(
  authority: SharedAuthority,
  client: RuntimeStore,
  overrides: Partial<RetentionReleaseCoverage> = {},
): RetentionReleaseCoverage {
  return {
    requiredStoreIds: ["authority", "client"],
    stores: [
      { id: "authority", store: authority.store },
      { id: "client", store: client },
    ],
    liveHistory: {
      status: "QUIESCENT",
      generation: "live-gen-1",
      roots: { head: authority.head() },
    },
    unaccountedStores: [],
    ...overrides,
  };
}

function environment(
  authority: SharedAuthority,
  client: RuntimeStore,
  overrides: Partial<RetentionReleaseCoverage> = {},
): RetentionReleaseEnvironment {
  return {
    inspect: () => coverage(authority, client, overrides),
  };
}

function publishAsset(
  authority: SharedAuthority,
  token: string,
  scope: Scope,
  uploadId: string,
  bytes: Uint8Array,
): { hash: string; bytes: number } {
  const staged = authority.stageAsset(token, scope, uploadId, bytes);
  const base: Cut = authority.head();
  const auth = authority.session(token, scope.orgId);
  const receipt = authority.submit(token, {
    v: 1,
    attemptId: randomUUID(),
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
  return { hash: staged.hash, bytes: bytes.byteLength };
}

function holdKey(hash: string, holdId: string): string {
  return "org:workspace:" + hash + ":" + holdId;
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readyRelease(env?: (f: ReturnType<typeof setup>) => RetentionReleaseEnvironment) {
  const f = setup();
  const published = publishAsset(f.authority, f.token, f.scope, "held",
    new TextEncoder().encode("original complete recovery asset"));
  f.assets.hold(f.scope, published.hash, "selected");
  const destination = new RuntimeStore(directory("folio-lead-artifact-"));
  stores.push(destination);
  const maintenance = new SharedMaintenance(f.authority,
    env?.(f) ?? environment(f.authority, f.client));
  const request = { scope: f.scope, expectedCut: f.authority.head(),
    holds: [{ hash: published.hash, holdId: "selected" }] };
  const preview = maintenance.retentionReleasePreview(f.token, request);
  const fingerprint = preview.combinedFingerprint!;
  const artifact = maintenance.exportRetentionRelease(f.token, request, fingerprint, destination);
  const release = (hash = artifact.artifactHash) =>
    maintenance.releaseRetentionHolds(f.token, request, fingerprint, hash, hash, destination);
  return { ...f, published, destination, maintenance, request, artifact, release };
}

describe.skipIf(process.platform === "win32")("lead retention safety regressions (NOT_RUN)", () => {
  it("connects an owned offline host, live client, cache and retained ledger to all three CLI actions", async () => {
    const f = setup();
    const published = publishAsset(f.authority, f.token, f.scope, "cli-held",
      new TextEncoder().encode("CLI recovery bytes"));
    f.assets.hold(f.scope, published.hash, "cli-hold");
    const provider: SharedProvider = {
      snapshot: async (scope, after) => f.authority.snapshot(f.token, scope, after),
      submit: async (attempt) => f.authority.submit(f.token, attempt),
      receipt: async (attempt) => f.authority.receipt(f.token, attempt),
      invalidate: async (attempt) => f.authority.invalidate(f.token, attempt),
      proof: async (scope, seq) => f.authority.proof(f.token, scope, seq),
      workspaces: async (org) => f.authority.workspaces(f.token, org),
      close() {},
    };
    const live = new SharedRuntimeClient(directory(), provider, f.scope,
      f.authority.session(f.token, "org").writerId);
    stores.push(live.store);
    const opening = live.open();
    expect(() => live.retentionRoots()).toThrow("RETENTION_CLIENT_BUSY");
    await opening;
    await live.submit({ kind: "text", blockId: "intro", from: 0, to: 0,
      text: "x", before: "retention release" });
    live.retainEditingRaw("original unsubmitted private draft");
    const snapshot = live.retentionRoots();
    expect(snapshot.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(live.history.canUndo()).toBe(true);
    const cache = new RuntimeStore(directory());
    const ledger = new RuntimeStore(directory());
    stores.push(cache, ledger);
    cache.transaction(() => {
      cache.set("meta", "role", "connection-cache");
      cache.set("connections", "connection", { url: "http://127.0.0.1:1", orgId: "org" });
    });
    ledger.transaction(() => ledger.set("private.evidence", "original", { raw: "retained raw original" }));
    const ledgerBefore = canonical(ledger.all("private.evidence"));
    const host = new RetentionHostRegistry({
      authority: f.authority,
      runtimeStores: [{ id: "cache", store: cache }, { id: "resources", store: f.client }],
      clients: [{ id: "document-client", client: live }],
      retainedStores: [{
        id: "private-ledger",
        owner: {
          acquire() {
            ledger.db.exec("BEGIN IMMEDIATE");
            return {
              inspect: () => ({ generation: "generation-1",
                fingerprint: digest(ledger.all("private.evidence")), unresolved: false }),
              release() { ledger.db.exec("ROLLBACK"); },
            };
          },
        },
      }],
      unaccountedStores: [],
    });
    expect(() => host.inspect()).toThrow("RETENTION_HOST_LEASE_REQUIRED");
    const root = f.authority.store.path.slice(0, -"/shared-runtime.sqlite".length);
    const tokenFile = join(directory(), "token.json");
    writeFileSync(tokenFile, canonical({ token: f.token }), { mode: 0o600 });
    const cut = f.authority.head();
    const args = (action: string) => [
      "--root", root, "--org", "org", "--token-file", tokenFile, "--action", action,
      "--workspace", f.scope.workspaceId, "--document", f.scope.documentId,
      "--incarnation", f.scope.incarnationId, "--expected-cut", canonical(cut),
      "--holds", canonical([{ hash: published.hash, holdId: "cli-hold" }]),
    ];
    f.authority.close();
    await expect(runMaintenanceOperator(args("retention-preview")))
      .rejects.toThrow("RETENTION_HOST_REQUIRED");
    const previewHandle = await runMaintenanceOperator(args("retention-preview"), { retentionHost: host });
    const preview = previewHandle.result as { combinedFingerprint: string; releasable: boolean };
    expect(preview.releasable).toBe(true);
    await previewHandle.close();
    const artifactRoot = join(directory(), "artifact");
    const exportHandle = await runMaintenanceOperator([
      ...args("retention-export"), "--fingerprint", preview.combinedFingerprint,
      "--destination", artifactRoot,
    ], { retentionHost: host });
    const exported = exportHandle.result as { artifactHash: string };
    await exportHandle.close();
    const releaseHandle = await runMaintenanceOperator([
      ...args("retention-release"), "--fingerprint", preview.combinedFingerprint,
      "--artifact", artifactRoot, "--artifact-hash", exported.artifactHash,
      "--ack-artifact-hash", exported.artifactHash,
    ], { retentionHost: host });
    expect(releaseHandle.result).toMatchObject({ assetsDeleted: 0, bytesReclaimed: 0,
      released: [{ hash: published.hash, holdId: "cli-hold" }] });
    await releaseHandle.close();
    const reopened = new SharedAuthority(root);
    authorities.push(reopened);
    expect(reopened.store.get("asset.holds", holdKey(published.hash, "cli-hold"))).toBeNull();
    expect(new SharedMaintenance(reopened).collectPreview(f.token, f.scope).referenced)
      .toContain(published.hash);
    expect(ledgerBefore).toBe(canonical(ledger.all("private.evidence")));
    expect(live.retentionRoots()).toEqual(snapshot);
    expect(live.store.all("client.editing")[0]!.value).toMatchObject({
      raw: "original unsubmitted private draft",
    });
    expect(() => reopened.verify()).not.toThrow();
    live.close();
  });

  it("keeps host unresolved/unaccounted evidence and rejects deferred host work", () => {
    const f = readyRelease();
    let acquired = false;
    const host = new RetentionHostRegistry({
      authority: f.authority, runtimeStores: [{ id: "private", store: f.client }],
      clients: [], retainedStores: [{
        id: "publication", owner: { acquire() {
          acquired = true;
          return { inspect: () => ({ generation: "g1", fingerprint: digest("UNKNOWN original"),
            unresolved: true }), release() { acquired = false; } };
        } },
      }], unaccountedStores: ["remote-client"],
    });
    expect(() => host.withLease(async () => "deferred")).toThrow("RETENTION_HOST_ASYNC");
    expect(acquired).toBe(false);
    host.withLease(() => {
      const blocked = new SharedMaintenance(f.authority, host)
        .retentionReleasePreview(f.token, f.request);
      expect(blocked.blocks).toContain("RETENTION_UNACCOUNTED_STORES");
    });
    expect(acquired).toBe(false);
    expect(f.authority.store.get("asset.holds", holdKey(f.published.hash, "selected"))).not.toBeNull();
  });

  it("reinspects live roots inside the final transaction, after artifact readback", () => {
    let inspections = 0;
    let releaseStarted = false;
    const f = readyRelease((fixture) => ({
      inspect() {
        const result = coverage(fixture.authority, fixture.client);
        if (releaseStarted && ++inspections === 2)
          return { ...result, liveHistory: { status: "QUIESCENT", generation: "changed", roots: [] } };
        return result;
      },
    }));
    releaseStarted = true;
    expect(() => f.release()).toThrow("RETENTION_FINGERPRINT_MISMATCH");
    expect(f.authority.store.get("asset.holds", holdKey(f.published.hash, "selected"))).not.toBeNull();
    expect(f.destination.get("retention.recovery", f.artifact.artifactHash)).not.toBeNull();
  });

  it.each(["missing-asset", "metadata-loss", "duplicate-hold"] as const)(
    "rejects a freshly hash-valid artifact with %s", (fault) => {
      const f = readyRelease();
      const stored = f.destination.get("retention.recovery", f.artifact.artifactHash) as {
        body: { assets: { record: { uploads: string[] } }[]; holds: unknown[] };
      };
      const body = structuredClone(stored.body);
      if (fault === "missing-asset") body.assets = [];
      if (fault === "metadata-loss") body.assets[0]!.record.uploads = [];
      if (fault === "duplicate-hold") body.holds.push(body.holds[0]);
      const forged = digest(body);
      f.destination.transaction(() => f.destination.set("retention.recovery", forged, {
        v: 1, kind: "retention.release", artifactHash: forged, body,
      }));
      expect(() => f.release(forged)).toThrow(/RETENTION_ARTIFACT_(INVALID|MISMATCH)/);
      expect(f.authority.store.get("asset.holds", holdKey(f.published.hash, "selected"))).not.toBeNull();
    },
  );

  it("preserves complete asset metadata and rejects separate private draft drift", () => {
    const f = readyRelease();
    const stored = f.destination.get("retention.recovery", f.artifact.artifactHash) as {
      body: { assets: { record: unknown }[] };
    };
    expect(stored.body.assets[0]!.record).toEqual(
      f.authority.store.get("asset", "org:workspace:" + f.published.hash));
    const head = f.authority.head();
    f.client.transaction(() => f.client.set("client.editing", "private", {
      raw: "unsubmitted original", cut: null,
    }));
    expect(f.authority.head()).toEqual(head);
    expect(() => f.release()).toThrow("RETENTION_FINGERPRINT_MISMATCH");
    expect(f.client.get("client.editing", "private")).toEqual({ raw: "unsubmitted original", cut: null });
  });

  it("rejects known async coverage before invocation and retains all originals", () => {
    const f = readyRelease();
    let called = false;
    const maintenance = new SharedMaintenance(f.authority, {
      inspect: async () => { called = true; return coverage(f.authority, f.client); },
    } as unknown as RetentionReleaseEnvironment);
    expect(maintenance.retentionReleasePreview(f.token, f.request).blocks)
      .toContain("RETENTION_COVERAGE_ASYNC");
    expect(called).toBe(false);
    expect(f.authority.store.get("asset.holds", holdKey(f.published.hash, "selected"))).not.toBeNull();
  });

  it("rejects active external transactions and unavailable history without releasing a hold", () => {
    const f = readyRelease();
    f.client.transaction(() => {
      expect(() => f.release()).toThrow("RETENTION_TRANSACTION_ACTIVE");
    });
    const unavailable = new SharedMaintenance(f.authority, environment(f.authority, f.client, {
      liveHistory: { status: "UNAVAILABLE" },
    }));
    expect(unavailable.retentionReleasePreview(f.token, f.request).releasable).toBe(false);
    expect(f.authority.store.get("asset.holds", holdKey(f.published.hash, "selected"))).not.toBeNull();
  });

  it("snapshots real history without clearing or exposing mutable stacks", () => {
    const history = new LocalHistory("incarnation");
    const before = { document: document(), tables: [], tombstones: [] };
    const command = { kind: "text" as const, blockId: "intro", from: 0, to: 0,
      text: "x", before: "retention release" };
    const applied = applyText(before, command, []);
    const cut = { epoch: "epoch", seq: 1, hash: digest("history") };
    history.record(before, command, applied, cut);
    const roots = history.retentionRoots();
    expect(history.canUndo()).toBe(true);
    expect(roots.pending).toBe(false);
    expect(canonical(roots.roots)).toContain("retention release");
    (roots.roots as { undo: unknown[] }).undo.length = 0;
    expect(history.canUndo()).toBe(true);
    expect(history.retentionRoots().generation).toBe(roots.generation);
    history.clear();
    expect(history.retentionRoots().generation).not.toBe(roots.generation);
  });
});

describe.skipIf(process.platform === "win32")("retention release", () => {
  it("exports, acknowledges and releases only the selected hold rows", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory("folio-release-artifact-"));
    stores.push(destination);
    try {
      const bytes = new TextEncoder().encode("held asset bytes");
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        bytes,
      );
      expect(published.hash).toBe(sha(bytes));
      assets.hold(scope, published.hash, "hold-a");
      const unselected = publishAsset(authority, token, scope, "upload-b",
        new TextEncoder().encode("unselected held asset"));
      assets.hold(scope, unselected.hash, "hold-b");
      const head = authority.head();
      const before = authority.store.db
        .prepare(
          "SELECT namespace,key,raw FROM runtime_records ORDER BY namespace,key",
        )
        .all();
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: head,
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };

      const preview = maintenance.retentionReleasePreview(token, request);
      expect(preview.releasable).toBe(true);
      expect(preview.blocks).toEqual([]);
      expect(preview.combinedFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(preview.actor.userId).toBe("owner");
      expect(preview.cut).toEqual(head);
      expect(preview.holds).toEqual([
        {
          hash: published.hash,
          holdId: "hold-a",
          key: holdKey(published.hash, "hold-a"),
          present: true,
          recordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
      expect(preview.recovery).toMatchObject({
        obligation: "EXPLICIT_HOLD",
        holdsSelected: 1,
        assetsPreserved: 1,
        bytesReclaimed: 0,
        assetsDeleted: 0,
      });
      const fingerprint = preview.combinedFingerprint!;

      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        fingerprint,
        destination,
      );
      expect(artifact.verification).toBe("READBACK_VERIFIED");
      expect(artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.assets).toEqual([
        {
          hash: published.hash,
          uri: "folio-asset://" + published.hash,
          bytes: bytes.byteLength,
        },
      ]);
      // The artifact preserves the original hold record and byte-exact blob.
      const manifestRecord = destination.get(
        "retention.recovery",
        artifact.artifactHash,
      ) as Record<string, unknown>;
      expect(manifestRecord).not.toBeNull();
      const manifest = manifestRecord.body as Record<string, unknown>;
      expect(manifest.kind).toBe("retention.release");
      expect(manifest.scope).toEqual(scope);
      expect(manifest.cut).toEqual(head);
      expect(manifest.fingerprint).toBe(fingerprint);
      expect(manifest.holds).toEqual([
        {
          key: holdKey(published.hash, "hold-a"),
          hash: published.hash,
          holdId: "hold-a",
          record: { hash: published.hash, holdId: "hold-a" },
        },
      ]);
      expect(destination.blobGet("retention-recovery", published.hash)).toEqual(
        bytes,
      );
      // Export never mutates the source.
      expect(authority.store.get("asset.holds", holdKey(published.hash, "hold-a"))).toEqual(
        { hash: published.hash, holdId: "hold-a" },
      );
      expect(authority.head()).toEqual(head);
      expect(
        authority.store.db
          .prepare(
            "SELECT namespace,key,raw FROM runtime_records ORDER BY namespace,key",
          )
          .all(),
      ).toEqual(before);

      const release = maintenance.releaseRetentionHolds(
        token,
        request,
        fingerprint,
        artifact.artifactHash,
        artifact.artifactHash,
        destination,
      );
      expect(release).toMatchObject({
        artifactHash: artifact.artifactHash,
        fingerprint,
        released: [{ hash: published.hash, holdId: "hold-a" }],
        bytesReclaimed: 0,
        assetsDeleted: 0,
        releaseRecord: artifact.artifactHash,
      });
      // Only the selected hold row is removed; the unselected hold stays.
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).toBeNull();
      expect(
        authority.store.get("asset.holds", holdKey(unselected.hash, "hold-b")),
      ).toEqual({ hash: unselected.hash, holdId: "hold-b" });
      // Asset metadata and blob bytes are preserved.
      expect(authority.store.get("asset", "org:workspace:" + published.hash))
        .not.toBeNull();
      expect(authority.store.blobGet("org:workspace", published.hash)).toEqual(
        bytes,
      );
      // The immutable receipt carries the folio-asset:// references that keep
      // the released asset protected by the existing collect reference scan.
      const receipt = authority.store.get(
        "retention.releases",
        artifact.artifactHash,
      );
      expect(receipt).not.toBeNull();
      expect(JSON.stringify(receipt)).toContain(
        "folio-asset://" + published.hash,
      );
      const collection = maintenance.collectPreview(token, scope);
      expect(collection.unreferenced).not.toContain(published.hash);
      expect(collection.referenced).toContain(published.hash);
      // The authority chain still verifies; the rooted audit publication
      // advanced the head by exactly one committed cut.
      expect(() => authority.verify()).not.toThrow();
      expect(release.sourceCut).toEqual(head);
      expect(release.audit.cut).toEqual(authority.head());
      expect(authority.head().epoch).toBe(head.epoch);
      expect(authority.head().seq).toBe(head.seq + 1);
      const verified = verifyRetentionReleaseReceipt(
        authority,
        artifact.artifactHash,
      );
      expect(verified.hash).toBe(release.audit.hash);
      expect(verified.uploadId).toBe(
        "retention-audit-" + artifact.artifactHash,
      );
      // A repeated release reports the recorded state only after re-auth.
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          fingerprint,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/RETENTION_ALREADY_RELEASED/);
    } finally {
      authority.close();
      client.close();
    }
  });

  it.each(["wrong", "not-a-hash"])(
    "refuses a missing or wrong explicit acknowledgment: %s",
    (acknowledged) => {
      const { authority, client, assets, token, scope } = setup();
      const destination = new RuntimeStore(directory());
      stores.push(destination);
      try {
        const published = publishAsset(
          authority,
          token,
          scope,
          "upload-a",
          new TextEncoder().encode("bytes"),
        );
        assets.hold(scope, published.hash, "hold-a");
        const maintenance = new SharedMaintenance(
          authority,
          environment(authority, client),
        );
        const request = {
          scope,
          expectedCut: authority.head(),
          holds: [{ hash: published.hash, holdId: "hold-a" }],
        };
        const preview = maintenance.retentionReleasePreview(token, request);
        const artifact = maintenance.exportRetentionRelease(
          token,
          request,
          preview.combinedFingerprint!,
          destination,
        );
        const bad =
          acknowledged === "wrong" ? "0".repeat(64) : acknowledged;
        expect(() =>
          maintenance.releaseRetentionHolds(
            token,
            request,
            preview.combinedFingerprint!,
            artifact.artifactHash,
            bad,
            destination,
          ),
        ).toThrow(acknowledged === "wrong" ? /RETENTION_ACK_MISMATCH/ : /INVALID_ARTIFACT_ACK/);
        expect(
          authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
        ).not.toBeNull();
      } finally {
        authority.close();
        client.close();
      }
    },
  );

  it("refuses a missing, tampered, or blob-corrupted artifact", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const fingerprint = preview.combinedFingerprint!;
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        fingerprint,
        destination,
      );
      // Missing artifact: a valid-shaped hash that was never exported.
      const missing = "f".repeat(64);
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          fingerprint,
          missing,
          missing,
          destination,
        ),
      ).toThrow(/RETENTION_ARTIFACT_MISSING/);
      // Tampered manifest: digest(body) no longer binds the artifactHash.
      destination.transaction(() => {
        const stored = destination.get(
          "retention.recovery",
          artifact.artifactHash,
        ) as Record<string, unknown>;
        destination.set("retention.recovery", artifact.artifactHash, {
          ...stored,
          body: { ...(stored.body as object), note: "tampered" },
        });
      });
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          fingerprint,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/RETENTION_ARTIFACT_INVALID/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("refuses a release when the artifact blob was deleted", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      destination.transaction(() =>
        destination.blobDelete("retention-recovery", published.hash),
      );
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          preview.combinedFingerprint!,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/RETENTION_ARTIFACT_INVALID/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects a release from a different session/device of the same user", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      // Enroll before freezing the cut so this reaches actor binding instead
      // of being rejected first as a stale plan.
      const invite = authority.invite(token, "org", "owner");
      const second = authority.acceptInvite(invite, "owner-device-2");
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      // The same user on a second device has a fresh writer/session context.
      expect(() =>
        maintenance.releaseRetentionHolds(
          second.token,
          request,
          preview.combinedFingerprint!,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/RETENTION_ACTOR_MISMATCH/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects release after workspace access is revoked", () => {
    const { authority, client, assets, token, scope, orgId } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      // Keep another workspace owner, then revoke the exporting owner's body
      // permission. Organization ownership alone never grants body access.
      const invite = authority.invite(token, orgId, "member");
      authority.acceptInvite(invite, "member-device");
      authority.grant(token, scope, "member", "owner");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(
        token,
        request,
      );
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      authority.grant(token, scope, "owner", null);
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          preview.combinedFingerprint!,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/FORBIDDEN/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it.each([
    { epoch: "other-epoch" },
    { seq: 0 },
    { hash: digest("stale") },
  ])("rejects a stale expectedCut component: %j", (patch) => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const stale: Cut = { ...authority.head(), ...patch };
      const request = {
        scope,
        expectedCut: stale,
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      expect(() =>
        maintenance.retentionReleasePreview(token, request),
      ).toThrow(/RETENTION_PLAN_STALE|STALE/);
      expect(() =>
        maintenance.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_PLAN_STALE|STALE/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects release when a draft changes without advancing the head", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      // An unrooted client draft changes the combined fingerprint while the
      // head stays exactly the same.
      authority.store.transaction(() =>
        authority.store.set("client.editing", "draft", {
          raw: "unsaved change",
          cut: null,
        }),
      );
      expect(authority.head()).toEqual(request.expectedCut);
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          preview.combinedFingerprint!,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/RETENTION_FINGERPRINT_MISMATCH/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects release when the live history generation changes", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      const drifted = new SharedMaintenance(
        authority,
        environment(authority, client, {
          liveHistory: {
            status: "QUIESCENT",
            generation: "live-gen-2",
            roots: { head: authority.head() },
          },
        }),
      );
      expect(() =>
        drifted.releaseRetentionHolds(
          token,
          request,
          preview.combinedFingerprint!,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/RETENTION_FINGERPRINT_MISMATCH/);
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects a scope pointing at an old incarnation", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const oldScope = { ...scope, incarnationId: randomUUID() };
      const request = {
        scope: oldScope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      expect(() =>
        maintenance.retentionReleasePreview(token, request),
      ).toThrow(/SCOPE_NOT_ACTIVE/);
      expect(() =>
        maintenance.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/SCOPE_NOT_ACTIVE/);
    } finally {
      authority.close();
      client.close();
    }
  });

  it("fails closed when a trusted port is absent, async, or unaccounted", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      // Absent port: preview reports the block, export refuses.
      const uncovered = new SharedMaintenance(authority);
      const preview = uncovered.retentionReleasePreview(token, request);
      expect(preview.releasable).toBe(false);
      expect(preview.blocks).toContain("RETENTION_COVERAGE_REQUIRED");
      expect(() =>
        uncovered.exportRetentionRelease(
          token,
          request,
          preview.combinedFingerprint ?? "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_REQUIRED/);
      // Async inspect is rejected before any store is touched.
      const asyncEnvironment = {
        inspect: async () => coverage(authority, client),
      } as unknown as RetentionReleaseEnvironment;
      const asyncMaintenance = new SharedMaintenance(
        authority,
        asyncEnvironment,
      );
      expect(() =>
        asyncMaintenance.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_ASYNC/);
      // A thenable coverage result fails closed the same way.
      const thenableEnvironment = {
        inspect: () => ({ then: () => {} }),
      } as unknown as RetentionReleaseEnvironment;
      const thenableMaintenance = new SharedMaintenance(
        authority,
        thenableEnvironment,
      );
      expect(() =>
        thenableMaintenance.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_ASYNC/);
      // Unaccounted stores block.
      const unaccounted = new SharedMaintenance(
        authority,
        environment(authority, client, {
          unaccountedStores: ["private-store"],
        }),
      );
      const blocked = unaccounted.retentionReleasePreview(token, request);
      expect(blocked.releasable).toBe(false);
      expect(blocked.blocks).toContain("RETENTION_UNACCOUNTED_STORES");
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("fails closed on duplicate, missing, or role-contaminated store coverage", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      // Duplicate store id.
      const duplicated = new SharedMaintenance(authority, {
        inspect: () =>
          coverage(authority, client, {
            stores: [
              { id: "authority", store: authority.store },
              { id: "client", store: client },
              { id: "client", store: client },
            ],
          }),
      });
      expect(() =>
        duplicated.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_INVALID/);
      // A required store id without a matching entry.
      const missingStore = new SharedMaintenance(authority, {
        inspect: () =>
          coverage(authority, client, {
            requiredStoreIds: ["authority", "client", "private-store"],
          }),
      });
      expect(() =>
        missingStore.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_INVALID/);
      // Role contamination: the stable authority id bound to another object.
      const contaminated = new SharedMaintenance(authority, {
        inspect: () =>
          coverage(authority, client, {
            stores: [
              { id: "authority", store: client },
              { id: "client", store: client },
            ],
          }),
      });
      expect(() =>
        contaminated.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_INVALID/);
      // The authority store object under a different id is also contamination.
      const swapped = new SharedMaintenance(authority, {
        inspect: () =>
          coverage(authority, client, {
            requiredStoreIds: ["authority", "client"],
            stores: [
              { id: "authority", store: authority.store },
              { id: "client", store: authority.store },
            ],
          }),
      });
      expect(() =>
        swapped.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_INVALID/);
      // A retain-only entry must carry generation + fingerprint.
      const malformedRetainOnly = new SharedMaintenance(authority, {
        inspect: () =>
          coverage(authority, client, {
            requiredStoreIds: ["authority", "client", "journal"],
            stores: [
              { id: "authority", store: authority.store },
              { id: "client", store: client },
              {
                id: "journal",
                retention: "RETAIN_ALL" as const,
                generation: "gen-1",
                fingerprint: "not-a-hash",
              },
            ],
          }),
      });
      expect(() =>
        malformedRetainOnly.exportRetentionRelease(
          token,
          request,
          "0".repeat(64),
          destination,
        ),
      ).toThrow(/RETENTION_COVERAGE_INVALID/);
    } finally {
      authority.close();
      client.close();
    }
  });

  it.each(["PREPARED", "UNKNOWN"] as const)(
    "blocks release while a durable queue holds a %s attempt",
    (status) => {
      const { authority, client, assets, token, scope } = setup();
      const destination = new RuntimeStore(directory());
      stores.push(destination);
      try {
        const published = publishAsset(
          authority,
          token,
          scope,
          "upload-a",
          new TextEncoder().encode("bytes"),
        );
        assets.hold(scope, published.hash, "hold-a");
        const base = authority.head();
        const intent = {
          v: 1 as const,
          intentId: "intent",
          writerId: "writer",
          scope,
          base,
          command: {
            kind: "resource" as const,
            action: "test",
            payload: null,
          },
        };
        const attempt = {
          v: 1 as const,
          attemptId: "attempt",
          intent,
          base,
        };
        const queue = new DurableQueue(client, { scope, writerId: "writer" });
        queue.enqueue(intent);
        queue.attempt(attempt);
        if (status === "UNKNOWN")
          queue.markUnknown(intent.intentId, attempt.attemptId);
        const maintenance = new SharedMaintenance(
          authority,
          environment(authority, client),
        );
        const request = {
          scope,
          expectedCut: authority.head(),
          holds: [{ hash: published.hash, holdId: "hold-a" }],
        };
        const preview = maintenance.retentionReleasePreview(token, request);
        expect(preview.releasable).toBe(false);
        expect(preview.blocks).toContain("RETENTION_UNRESOLVED_ATTEMPT");
        expect(() =>
          maintenance.exportRetentionRelease(
            token,
            request,
            preview.combinedFingerprint!,
            destination,
          ),
        ).toThrow(/RETENTION_UNRESOLVED_ATTEMPT/);
        // The unresolved queue evidence is preserved, never touched.
        expect(queue.read(intent.intentId)?.raw).toBeDefined();
        expect(
          authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
        ).not.toBeNull();
      } finally {
        authority.close();
        client.close();
      }
    },
  );

  it("blocks release when the store contains unclassified evidence", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      client.transaction(() =>
        client.set("future.namespace", "evidence", { v: 1, note: "opaque" }),
      );
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      expect(preview.releasable).toBe(false);
      expect(preview.blocks).toContain("RETENTION_UNCLASSIFIED_EVIDENCE");
      expect(() =>
        maintenance.exportRetentionRelease(
          token,
          request,
          preview.combinedFingerprint!,
          destination,
        ),
      ).toThrow(/RETENTION_UNCLASSIFIED_EVIDENCE/);
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects a destination sharing source identity, path, or role", () => {
    const { authority, client, assets, token, scope } = setup();
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const fingerprint = preview.combinedFingerprint!;
      // The source store object itself is never a valid destination.
      expect(() =>
        maintenance.exportRetentionRelease(
          token,
          request,
          fingerprint,
          authority.store,
        ),
      ).toThrow(/RETENTION_DESTINATION_NOT_ISOLATED/);
      // A store already carrying a role/records is not an empty artifact.
      const contaminated = new RuntimeStore(directory());
      stores.push(contaminated);
      contaminated.transaction(() =>
        contaminated.set("meta", "role", "authority"),
      );
      expect(() =>
        maintenance.exportRetentionRelease(
          token,
          request,
          fingerprint,
          contaminated,
        ),
      ).toThrow(/RETENTION_DESTINATION_NOT_EMPTY/);
      // A valid isolated destination still works afterwards.
      const destination = new RuntimeStore(directory());
      stores.push(destination);
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        fingerprint,
        destination,
      );
      expect(artifact.verification).toBe("READBACK_VERIFIED");
      // The same destination cannot receive a second artifact.
      const second = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      expect(() =>
        second.exportRetentionRelease(
          token,
          request,
          fingerprint,
          destination,
        ),
      ).toThrow(/RETENTION_DESTINATION_NOT_EMPTY/);
    } finally {
      authority.close();
      client.close();
    }
  });

  it("refuses artifact export above the bounded capacity", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-large",
        new Uint8Array(9 * 1024 * 1024),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      expect(() =>
        maintenance.exportRetentionRelease(
          token,
          request,
          preview.combinedFingerprint!,
          destination,
        ),
      ).toThrow(/RETENTION_ARTIFACT_LIMIT/);
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).not.toBeNull();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("keeps the artifact and all source rows when the source transaction rolls back", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const artifact = maintenance.exportRetentionRelease(
        token,
        request,
        preview.combinedFingerprint!,
        destination,
      );
      // Fail the post-write authority.verify so the mutation transaction
      // rolls back: no receipt, no deleted hold, artifact retained.
      const original = authority.verify.bind(authority);
      vi.spyOn(authority, "verify").mockImplementation(() => {
        if (authority.store.get("retention.releases", artifact.artifactHash) !== null)
          throw new CollaborationError("VERIFY_FORCED_FAILURE");
        original();
      });
      expect(() =>
        maintenance.releaseRetentionHolds(
          token,
          request,
          preview.combinedFingerprint!,
          artifact.artifactHash,
          artifact.artifactHash,
          destination,
        ),
      ).toThrow(/VERIFY_FORCED_FAILURE/);
      vi.mocked(authority.verify).mockRestore();
      expect(
        authority.store.get("asset.holds", holdKey(published.hash, "hold-a")),
      ).toEqual({ hash: published.hash, holdId: "hold-a" });
      expect(
        authority.store.get("retention.releases", artifact.artifactHash),
      ).toBeNull();
      expect(
        destination.get("retention.recovery", artifact.artifactHash),
      ).not.toBeNull();
      expect(() => authority.verify()).not.toThrow();
    } finally {
      authority.close();
      client.close();
    }
  });

  it("rejects export and release while source or destination transaction is active", () => {
    const { authority, client, assets, token, scope } = setup();
    const destination = new RuntimeStore(directory());
    stores.push(destination);
    try {
      const published = publishAsset(
        authority,
        token,
        scope,
        "upload-a",
        new TextEncoder().encode("bytes"),
      );
      assets.hold(scope, published.hash, "hold-a");
      const maintenance = new SharedMaintenance(
        authority,
        environment(authority, client),
      );
      const request = {
        scope,
        expectedCut: authority.head(),
        holds: [{ hash: published.hash, holdId: "hold-a" }],
      };
      const preview = maintenance.retentionReleasePreview(token, request);
      const fingerprint = preview.combinedFingerprint!;
      authority.store.transaction(() => {
        expect(() =>
          maintenance.exportRetentionRelease(
            token,
            request,
            fingerprint,
            destination,
          ),
        ).toThrow(/RETENTION_TRANSACTION_ACTIVE/);
      });
      destination.transaction(() => {
        expect(() =>
          maintenance.exportRetentionRelease(
            token,
            request,
            fingerprint,
            destination,
          ),
        ).toThrow(/RETENTION_TRANSACTION_ACTIVE/);
      });
    } finally {
      authority.close();
      client.close();
    }
  });
});
