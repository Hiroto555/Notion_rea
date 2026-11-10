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
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { exportBackup } from "../src/collaboration/runtime/backup";
import { canonical } from "../src/collaboration/runtime/canonical";
import { runMaintenanceOperator } from "../src/collaboration/runtime/maintenance-operator";
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
