import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { exportBackup } from "../src/collaboration/runtime/backup";
import { canonical } from "../src/collaboration/runtime/canonical";
import { runMaintenanceOperator } from "../src/collaboration/runtime/maintenance-operator";
import type {
  PublicationAuthorization,
  PublicationResolutionInspection,
  PublicationResolutionObservation,
  PublicationResolutionPort,
} from "../src/platform/windows/publication-resolution";
import { documentSchema } from "../src/shared/editor-schema";
import type { Doc } from "../src/shared/types";

const roots: string[] = [];

function privateDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(directory, 0o700);
  roots.push(directory);
  return directory;
}

function seedDocument(): Doc {
  return documentSchema
    .nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: randomUUID() } }],
    })
    .toJSON() as Doc;
}

function bootstrap(root: string) {
  const authority = new SharedAuthority(root);
  try {
    return authority.bootstrap({
      orgId: "org",
      userId: "user",
      deviceId: "device",
      workspaceId: "workspace",
      documentId: "document",
      document: seedDocument(),
    });
  } finally {
    authority.close();
  }
}

function writeTokenFile(
  directory: string,
  token: string,
  recoveryKey: string,
  name = "credentials.json",
): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify({ token, recoveryKey }), {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return path;
}

function common(root: string, tokenFile: string, action: string): string[] {
  return [
    "--root",
    root,
    "--org",
    "org",
    "--token-file",
    tokenFile,
    "--action",
    action,
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

describe("runMaintenanceOperator", () => {
  it("previews a real temp bootstrapped shared root", async () => {
    const root = privateDirectory("folio-maint-preview-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);

    const handle = await runMaintenanceOperator(
      common(root, tokenFile, "preview"),
    );
    try {
      const result = handle.result as {
        cut: { seq: number; hash: string };
        retention: { eventRows: number };
        overview: { documents: number };
        writerFenced: boolean;
      };
      expect(handle.state).toBe("maintained");
      expect(result.cut.seq).toBeGreaterThan(0);
      expect(result.cut.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.retention.eventRows).toBeGreaterThan(0);
      expect(result.overview.documents).toBe(1);
      expect(result.writerFenced).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("accepts a raw private token file", async () => {
    const root = privateDirectory("folio-maint-raw-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(
      root,
      issued.token,
      issued.recoveryKey,
      "raw-token",
    );
    writeFileSync(tokenFile, issued.token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);

    const handle = await runMaintenanceOperator(
      common(root, tokenFile, "preview"),
    );
    try {
      expect(handle.state).toBe("maintained");
    } finally {
      await handle.close();
    }
  });

  it("rejects a missing root without creating it", async () => {
    const parent = privateDirectory("folio-maint-missing-parent-");
    const root = privateDirectory("folio-maint-missing-source-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const missing = join(parent, "does-not-exist");

    await expect(
      runMaintenanceOperator(common(missing, tokenFile, "preview")),
    ).rejects.toThrow("ROOT_MISSING");
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects a destination inside the source root before creating it", async () => {
    const root = privateDirectory("folio-maint-dest-root-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const destination = join(root, "nested-destination");

    await expect(
      runMaintenanceOperator([
        ...common(root, tokenFile, "verify"),
        "--destination",
        destination,
        "--epoch",
        "epoch_verify",
      ]),
    ).rejects.toThrow("DESTINATION_INSIDE_ROOT");
    expect(existsSync(destination)).toBe(false);
  });

  it("verifies the current head into an explicit isolated destination", async () => {
    const root = privateDirectory("folio-maint-verify-");
    const parent = privateDirectory("folio-maint-verify-parent-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const destination = join(parent, "restored-head");
    const epoch = "epoch_verify";

    const handle = await runMaintenanceOperator([
      ...common(root, tokenFile, "verify"),
      "--destination",
      destination,
      "--epoch",
      epoch,
    ]);
    try {
      const proof = handle.result as {
        v: number;
        backupHash: string;
        restoreEpoch: string;
        cut: { seq: number };
      };
      expect(proof.v).toBe(1);
      expect(proof.backupHash).toMatch(/^[a-f0-9]{64}$/);
      expect(proof.restoreEpoch).toBe(epoch);
      expect(proof.cut.seq).toBeGreaterThan(0);
      expect(lstatSync(destination).isDirectory()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("verifies an explicit private backup artifact", async () => {
    const root = privateDirectory("folio-maint-artifact-");
    const parent = privateDirectory("folio-maint-artifact-parent-");
    const authority = new SharedAuthority(root);
    let issued!: ReturnType<typeof authority.bootstrap>;
    let backup!: ReturnType<typeof exportBackup>;
    try {
      issued = authority.bootstrap({
        orgId: "org",
        userId: "user",
        deviceId: "device",
        workspaceId: "workspace",
        documentId: "document",
        document: seedDocument(),
      });
      backup = exportBackup(authority.store);
    } finally {
      authority.close();
    }
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const backupFile = join(parent, "backup.json");
    writeFileSync(backupFile, canonical(backup), { mode: 0o600 });
    chmodSync(backupFile, 0o600);
    const destination = join(parent, "artifact-restore");

    const handle = await runMaintenanceOperator([
      ...common(root, tokenFile, "verify"),
      "--destination",
      destination,
      "--epoch",
      "epoch_artifact",
      "--backup",
      backupFile,
    ]);
    try {
      const proof = handle.result as {
        v: number;
        restoreEpoch: string;
        backupHash: string;
      };
      expect(proof.v).toBe(1);
      expect(proof.restoreEpoch).toBe("epoch_artifact");
      expect(proof.backupHash).toBe(backup.hash);
    } finally {
      await handle.close();
    }
  });

  it("upgrades a genuine 1003 root through the authoritative commit", async () => {
    const root = privateDirectory("folio-maint-upgrade-");
    const parent = privateDirectory("folio-maint-upgrade-parent-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const destination = join(parent, "upgrade-proof");

    const handle = await runMaintenanceOperator([
      ...common(root, tokenFile, "upgrade"),
      "--destination",
      destination,
      "--epoch",
      "epoch_upgrade",
    ]);
    try {
      const result = handle.result as {
        status: string;
        protocol: number;
      };
      expect(result.status).toBe("COMMITTED");
      expect(result.protocol).toBe(1004);
    } finally {
      await handle.close();
    }

    const reopened = new SharedAuthority(root);
    try {
      expect(reopened.protocol(issued.token, issued.scope).protocol).toBe(1004);
    } finally {
      reopened.close();
    }
  });

  it("uses the exact server asset plan for collect-preview and collect", async () => {
    const root = privateDirectory("folio-maint-collect-");
    const authority = new SharedAuthority(root);
    const issued = authority.bootstrap({
      orgId: "org",
      userId: "user",
      deviceId: "device",
      workspaceId: "workspace",
      documentId: "document",
      document: seedDocument(),
    });
    let head!: { epoch: string; seq: number; hash: string };
    let hash!: string;
    try {
      const staged = authority.stageAsset(
        issued.token,
        issued.scope,
        "upload-1",
        new TextEncoder().encode("unreferenced-asset"),
      );
      const base = authority.head();
      const receipt = authority.submit(issued.token, {
        v: 1,
        attemptId: randomUUID(),
        base,
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId: issued.auth.writerId,
          scope: issued.scope,
          base,
          command: {
            kind: "resource",
            action: "asset.publish",
            payload: { uploadId: "upload-1", hash: staged.hash },
          },
        },
      });
      expect(receipt.status).toBe("SERVER_ACCEPTED");
      head = authority.head();
      hash = staged.hash;
    } finally {
      authority.close();
    }
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const expectedCut = canonical(head);
    const scopeArgs = [
      "--workspace",
      issued.scope.workspaceId,
      "--document",
      issued.scope.documentId,
      "--incarnation",
      issued.scope.incarnationId,
      "--expected-cut",
      expectedCut,
      "--hashes",
      hash,
    ];

    const previewHandle = await runMaintenanceOperator([
      ...common(root, tokenFile, "collect-preview"),
      ...scopeArgs.slice(0, 6),
    ]);
    try {
      const preview = previewHandle.result as {
        unreferenced: string[];
        cut: { seq: number };
      };
      expect(preview.unreferenced).toEqual([hash]);
      expect(preview.cut.seq).toBe(head.seq);
    } finally {
      await previewHandle.close();
    }

    const collectHandle = await runMaintenanceOperator([
      ...common(root, tokenFile, "collect"),
      ...scopeArgs,
    ]);
    try {
      const collected = collectHandle.result as {
        removed: string[];
        baseCut: { seq: number };
      };
      expect(collected.removed).toEqual([hash]);
      expect(collected.baseCut.seq).toBe(head.seq);
    } finally {
      await collectHandle.close();
    }
  });

  it("runs compact only after the artifact path and preserves the destination on failure", async () => {
    const root = privateDirectory("folio-maint-compact-artifact-");
    const parent = privateDirectory("folio-maint-compact-artifact-parent-");
    const authority = new SharedAuthority(root);
    let issued!: ReturnType<typeof authority.bootstrap>;
    let backup!: ReturnType<typeof exportBackup>;
    try {
      issued = authority.bootstrap({
        orgId: "org",
        userId: "user",
        deviceId: "device",
        workspaceId: "workspace",
        documentId: "document",
        document: seedDocument(),
      });
      backup = exportBackup(authority.store);
    } finally {
      authority.close();
    }
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const backupFile = join(parent, "backup.json");
    writeFileSync(backupFile, canonical(backup), { mode: 0o600 });
    chmodSync(backupFile, 0o600);
    const destination = join(parent, "compact-artifact-restore");

    await expect(
      runMaintenanceOperator([
        ...common(root, tokenFile, "compact"),
        "--destination",
        destination,
        "--epoch",
        "epoch_compact_artifact",
        "--backup",
        backupFile,
      ]),
    ).rejects.toThrow();
    expect(existsSync(destination)).toBe(true);
  });

  it("requires a backup artifact for compact", async () => {
    const root = privateDirectory("folio-maint-compact-");
    const parent = privateDirectory("folio-maint-compact-parent-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const destination = join(parent, "compact-proof");

    await expect(
      runMaintenanceOperator([
        ...common(root, tokenFile, "compact"),
        "--destination",
        destination,
        "--epoch",
        "epoch_compact",
      ]),
    ).rejects.toThrow("INVALID_ARGUMENT");
    expect(existsSync(destination)).toBe(false);
  });
});

it("connects dependencies-preview through current authorization and the exact head", async () => {
  const root = privateDirectory("folio-maint-dependencies-");
  const issued = bootstrap(root), tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
  const authority = new SharedAuthority(root); const cut = authority.head(); authority.close();
  const args = [...common(root, tokenFile, "dependencies-preview"), "--expected-cut", canonical(cut)];
  const handle = await runMaintenanceOperator(args);
  expect(handle.result).toMatchObject({mode: "PLAN_ONLY", execution: "UNSUPPORTED", cut, deletions: []});
  await handle.close();
  await expect(runMaintenanceOperator([...common(root, tokenFile, "dependencies-preview"), "--expected-cut", canonical({...cut, seq: cut.seq + 1})])).rejects.toThrow("RETENTION_PLAN_STALE");
});

describe("publication resolution actions", () => {
  const attempt = "a".repeat(32);
  const CONTRACT_ROOT = "C:\\Folio";
  const CONTRACT_SOURCE = "C:\\Folio\\Shared";
  const contractAuthorization = (
    root: string,
    head: { epoch: string; seq: number; hash: string },
  ): PublicationAuthorization => ({
    sourceRoot: root,
    orgId: "org",
    genesisHash: "0".repeat(64),
    auth: {
      userId: "user",
      deviceId: "device",
      writerId: "writer-1",
      sessionId: "session-1",
    },
    cut: { ...head },
  });
  const contractInspection = (
    root: string,
    head: { epoch: string; seq: number; hash: string },
  ): PublicationResolutionInspection => ({
    version: 1,
    attemptId: attempt,
    state: "UNKNOWN",
    fingerprint: "9".repeat(64),
    snapshotFingerprint: "8".repeat(64),
    inspection: {
      reservation: {
        contractVersion: 2,
        attemptId: attempt,
        path: `${CONTRACT_ROOT}\\Private\\new.bin`,
        stagingPath: `${CONTRACT_ROOT}\\Private\\.folio-private-${attempt}.tmp`,
        root: {
          canonicalPath: CONTRACT_ROOT,
          fileId: "1".repeat(32),
          volumeId: "4".repeat(16),
        },
        directory: {
          canonicalPath: `${CONTRACT_ROOT}\\Private`,
          fileId: "2".repeat(32),
          volumeId: "4".repeat(16),
        },
        byteLength: 4,
        sha256: "7".repeat(64),
      },
      state: "UNKNOWN",
      dispatches: [
        { phase: "prepare", byteLength: 64, sha256: "6".repeat(64), chunkCount: 1 },
        {
          phase: "commit-prepared",
          byteLength: 64,
          sha256: "6".repeat(64),
          chunkCount: 1,
        },
      ],
      prepared: { byteLength: 64, sha256: "5".repeat(64) },
      terminal: {
        outcome: "UNKNOWN",
        byteLength: 64,
        sha256: "5".repeat(64),
      },
    },
    observation: "MATCH",
    resolvable: true,
    preserve: true,
    resolution: null,
  });
  const contractObservation = (
    root: string,
    head: { epoch: string; seq: number; hash: string },
  ): PublicationResolutionObservation => ({
    version: 1,
    outcome: "PUBLISHED_OBSERVED",
    attemptId: attempt,
    snapshotFingerprint: "8".repeat(64),
    fingerprint: "9".repeat(64),
    authorization: contractAuthorization(root, head),
    observed: {
      root: {
        canonicalPath: CONTRACT_ROOT,
        fileId: "1".repeat(32),
        volumeId: "4".repeat(16),
      },
      directory: {
        canonicalPath: `${CONTRACT_ROOT}\\Private`,
        fileId: "2".repeat(32),
        volumeId: "4".repeat(16),
      },
      sourceDirectory: {
        canonicalPath: CONTRACT_SOURCE,
        fileId: "3".repeat(32),
        volumeId: "4".repeat(16),
      },
      sourceDatabase: {
        canonicalPath: `${CONTRACT_SOURCE}\\shared-runtime.sqlite`,
        fileId: "5".repeat(32),
        volumeId: "4".repeat(16),
      },
      file: {
        canonicalPath: `${CONTRACT_ROOT}\\Private\\new.bin`,
        fileId: "6".repeat(32),
        volumeId: "4".repeat(16),
      },
      byteLength: 4,
      sha256: "7".repeat(64),
    },
    preserve: true,
  });

  function headOf(root: string): { epoch: string; seq: number; hash: string } {
    const authority = new SharedAuthority(root);
    try {
      return authority.head();
    } finally {
      authority.close();
    }
  }

  function publicationArgs(
    root: string,
    tokenFile: string,
    action: string,
    head: { epoch: string; seq: number; hash: string },
    extra: string[] = [],
  ): string[] {
    return [
      ...common(root, tokenFile, action),
      "--attempt",
      attempt,
      "--expected-cut",
      canonical(head),
      ...extra,
    ];
  }

  it("rejects both actions when no native publication port is wired", async () => {
    const root = privateDirectory("folio-maint-pub-absent-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const head = headOf(root);
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-inspect", head),
      ),
    ).rejects.toThrow("PUBLICATION_RESOLUTION_UNAVAILABLE");
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-resolve", head, [
          "--fingerprint",
          "0".repeat(64),
        ]),
      ),
    ).rejects.toThrow("PUBLICATION_RESOLUTION_UNAVAILABLE");
  });

  it("validates attempt, expected-cut and fingerprint arguments before wiring", async () => {
    const root = privateDirectory("folio-maint-pub-args-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const head = headOf(root);
    const calls: string[] = [];
    const port: PublicationResolutionPort = {
      inspect: () => {
        calls.push("inspect");
        throw new Error("unexpected native publication call");
      },
      resolve: () => {
        calls.push("resolve");
        throw new Error("unexpected native publication call");
      },
    };
    await expect(
      runMaintenanceOperator(
        [...common(root, tokenFile, "publication-inspect"), "--attempt", attempt],
        { nativePublication: port },
      ),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      runMaintenanceOperator(
        [
          ...common(root, tokenFile, "publication-inspect"),
          "--attempt",
          attempt.toUpperCase(),
          "--expected-cut",
          canonical(head),
        ],
        { nativePublication: port },
      ),
    ).rejects.toThrow("INVALID_ATTEMPT");
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-resolve", head),
        { nativePublication: port },
      ),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-resolve", head, [
          "--fingerprint",
          "not-hex",
        ]),
        { nativePublication: port },
      ),
    ).rejects.toThrow("INVALID_FINGERPRINT");
    expect(calls).toHaveLength(0);
  });

  it("invokes the injected port inside the store transaction with real current authorization", async () => {
    const root = privateDirectory("folio-maint-pub-auth-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const authority = new SharedAuthority(root);
    let head!: { epoch: string; seq: number; hash: string };
    let genesisHash!: string;
    try {
      head = authority.head();
      const genesis = authority.store.get("meta", "genesis");
      genesisHash = createHash("sha256")
        .update(canonical(genesis))
        .digest("hex");
    } finally {
      authority.close();
    }
    const snapshots: PublicationAuthorization[] = [];
    const requests: unknown[] = [];
    const port: PublicationResolutionPort = {
      inspect(request, currentAuthorization) {
        requests.push(request);
        snapshots.push(currentAuthorization());
        return contractInspection(root, head);
      },
      resolve(request, currentAuthorization) {
        requests.push(request);
        snapshots.push(currentAuthorization());
        return contractObservation(root, head);
      },
    };
    const handle = await runMaintenanceOperator(
      publicationArgs(root, tokenFile, "publication-inspect", head),
      { nativePublication: port },
    );
    try {
      const result = handle.result as PublicationResolutionInspection;
      expect(result.state).toBe("UNKNOWN");
      expect(result.preserve).toBe(true);
      expect(result.fingerprint).toBe("9".repeat(64));
    } finally {
      await handle.close();
    }
    expect(snapshots).toHaveLength(1);
    const authorization = snapshots[0];
    expect(authorization.orgId).toBe("org");
    expect(authorization.sourceRoot).toBe(root);
    expect(authorization.genesisHash).toBe(genesisHash);
    expect(authorization.cut).toEqual(head);
    expect(authorization.auth.userId).toBe("user");
    expect(authorization.auth.deviceId).toBe("device");
    expect(authorization.auth.writerId).toBe(issued.auth.writerId);
    expect(authorization.auth.sessionId).toBe(issued.auth.sessionId);
    expect(requests[0]).toEqual({ attemptId: attempt, expectedCut: head });

    const fingerprint = "f".repeat(64);
    const resolved = await runMaintenanceOperator(
      publicationArgs(root, tokenFile, "publication-resolve", head, [
        "--fingerprint",
        fingerprint,
      ]),
      { nativePublication: port },
    );
    try {
      const result = resolved.result as PublicationResolutionObservation;
      expect(result.outcome).toBe("PUBLISHED_OBSERVED");
      expect(result.preserve).toBe(true);
    } finally {
      await resolved.close();
    }
    expect(snapshots).toHaveLength(2);
    expect((requests[1] as { fingerprint: string }).fingerprint).toBe(
      fingerprint,
    );
    expect((requests[1] as { expectedCut: unknown }).expectedCut).toEqual(
      head,
    );
  });

  it("prevents the port call when the operator is not authorized for the exact cut", async () => {
    const root = privateDirectory("folio-maint-pub-stale-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const head = headOf(root);
    const calls: string[] = [];
    const port: PublicationResolutionPort = {
      inspect: () => {
        calls.push("inspect");
        throw new Error("unexpected native publication call");
      },
      resolve: () => {
        calls.push("resolve");
        throw new Error("unexpected native publication call");
      },
    };
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-inspect", {
          ...head,
          seq: head.seq + 1,
        }),
        { nativePublication: port },
      ),
    ).rejects.toThrow("RETENTION_PLAN_STALE");
    expect(calls).toHaveLength(0);
  });

  it("prevents the port call for non-owner members and revoked tokens", async () => {
    const root = privateDirectory("folio-maint-pub-forbidden-");
    const authority = new SharedAuthority(root);
    const issued = authority.bootstrap({
      orgId: "org",
      userId: "user",
      deviceId: "device",
      workspaceId: "workspace",
      documentId: "document",
      document: seedDocument(),
    });
    const head = authority.head();
    const inviteToken = authority.invite(issued.token, "org", "member-2");
    const joined = authority.join(inviteToken, "org", "device-2") as {
      token: string;
    };
    authority.close();
    const memberTokenFile = join(root, "member.json");
    writeFileSync(memberTokenFile, JSON.stringify({ token: joined.token }), {
      mode: 0o600,
    });
    chmodSync(memberTokenFile, 0o600);
    const calls: string[] = [];
    const port: PublicationResolutionPort = {
      inspect: () => {
        calls.push("inspect");
        throw new Error("unexpected native publication call");
      },
      resolve: () => {
        calls.push("resolve");
        throw new Error("unexpected native publication call");
      },
    };
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, memberTokenFile, "publication-inspect", head),
        { nativePublication: port },
      ),
    ).rejects.toThrow(/FORBIDDEN|AUTH/);
    const owner = new SharedAuthority(root);
    try {
      owner.revokeMember(issued.token, "org", "member-2");
    } finally {
      owner.close();
    }
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, memberTokenFile, "publication-inspect", head),
        { nativePublication: port },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("denies the port call when the org owner lacks all-workspace read", async () => {
    const root = privateDirectory("folio-maint-pub-workspace-");
    const authority = new SharedAuthority(root);
    const issued = authority.bootstrap({
      orgId: "org",
      userId: "user",
      deviceId: "device",
      workspaceId: "workspace",
      documentId: "document",
      document: seedDocument(),
    });
    const inviteToken = authority.invite(issued.token, "org", "member-2");
    authority.join(inviteToken, "org", "device-2");
    // Policy requires another workspace owner before self-revocation.
    authority.grant(issued.token, issued.scope, "member-2", "owner");
    authority.grant(issued.token, issued.scope, "user", null);
    // The user remains organization owner but no longer holds workspace read.
    const head = authority.head();
    authority.close();
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const calls: string[] = [];
    const port: PublicationResolutionPort = {
      inspect: () => {
        calls.push("inspect");
        throw new Error("unexpected native publication call");
      },
      resolve: () => {
        calls.push("resolve");
        throw new Error("unexpected native publication call");
      },
    };
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-inspect", head),
        { nativePublication: port },
      ),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-resolve", head, [
          "--fingerprint",
          "f".repeat(64),
        ]),
        { nativePublication: port },
      ),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an asynchronous injected port before invocation", async () => {
    const root = privateDirectory("folio-maint-pub-async-");
    const issued = bootstrap(root);
    const tokenFile = writeTokenFile(root, issued.token, issued.recoveryKey);
    const head = headOf(root);
    const port = {
      inspect: async () => ({}),
      resolve: async () => ({}),
    };
    await expect(
      runMaintenanceOperator(
        publicationArgs(root, tokenFile, "publication-inspect", head),
        { nativePublication: port as never },
      ),
    ).rejects.toThrow();
  });
});
