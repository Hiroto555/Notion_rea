import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { validateRecoveryManifest, verifyRecoveryBundle } from "../src/persistence/conflict-recovery-verify";
import { Store } from "../src/persistence/store";
import { canonicalJson, hashCheckpoint, sha256 } from "../src/sync/protocol";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "folio-m1-recovery-verify-")));
  roots.push(directory);
  return directory;
}

function filesManifest() {
  return {
    format: "folio-conflict-recovery" as const,
    version: 1 as const,
    archive: {
      source: "a".repeat(64), id: 1, operationId: "operation-1",
      kind: "conflict-remote", createdAt: 1, checkpointHash: "c".repeat(64),
    },
    checkpoint: { file: "checkpoint.json" as const, bytes: 32, sha256: "c".repeat(64) },
    assets: [
      { id: "00000000-0000-4000-8000-000000000001", sha256: "d".repeat(64), bytes: 3,
        file: "assets/00000000-0000-4000-8000-000000000001" },
    ],
  };
}

function makeBundle(names = ["one.bin", "two.bin"]) {
  const directory = root();
  const store = new Store(join(directory, "workspace.sqlite"));
  const sourceAssets = join(directory, "workspace-assets");
  mkdirSync(sourceAssets);
  const written: { id: string; bytes: Buffer }[] = [];
  let checkpoint: ReturnType<typeof buildWorkspaceCheckpoint> | undefined;
  try {
    for (const name of names) {
      const source = join(directory, name);
      writeFileSync(source, `payload-${name}`);
      const attached = attachFile(store.db, sourceAssets, source);
      written.push({ id: attached.id, bytes: readFileSync(source) });
    }
    checkpoint = buildWorkspaceCheckpoint(store.db);
  } finally {
    store.close();
  }
  if (!checkpoint) throw new Error("checkpoint was not built");

  const checkpointJson = canonicalJson(checkpoint);
  const checkpointHash = hashCheckpoint(checkpoint);
  const manifest = {
    format: "folio-conflict-recovery" as const,
    version: 1 as const,
    archive: {
      source: "a".repeat(64), id: 1, operationId: "operation-1",
      kind: "conflict-remote", createdAt: 1, checkpointHash,
    },
    checkpoint: {
      file: "checkpoint.json" as const,
      bytes: Buffer.byteLength(checkpointJson),
      sha256: checkpointHash,
    },
    assets: checkpoint.assets.map((asset) => ({ ...asset, file: `assets/${asset.id}` })),
  };
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  mkdirSync(join(bundle, "assets"));
  writeFileSync(join(bundle, "checkpoint.json"), checkpointJson);
  for (const asset of written) writeFileSync(join(bundle, "assets", asset.id), asset.bytes);
  return { directory, bundle, checkpoint, manifest, written };
}

function writeManifest(bundle: string, manifest: unknown, pretty = false): void {
  writeFileSync(join(bundle, "manifest.json"),
    pretty ? JSON.stringify(manifest, null, 2) : canonicalJson(manifest));
}

describe("validateRecoveryManifest", () => {
  it("accepts the fixed manifest shape and rejects extra or malformed fields", () => {
    const manifest = filesManifest();
    expect(validateRecoveryManifest(manifest)).toEqual(manifest);

    expect(() => validateRecoveryManifest({ ...manifest, token: "secret" }))
      .toThrow(/invalid-recovery-manifest/);
    expect(() => validateRecoveryManifest({ ...manifest, version: 2 }))
      .toThrow(/invalid-recovery-manifest/);
    expect(() => validateRecoveryManifest({
      ...manifest,
      checkpoint: { ...manifest.checkpoint, file: "other.json" },
    })).toThrow(/invalid-recovery-manifest/);
    expect(() => validateRecoveryManifest({
      ...manifest,
      assets: [{ ...manifest.assets[0], extra: true }],
    })).toThrow(/invalid-recovery-manifest/);
  });

  it("requires exact asset files, unique ids, per-asset and total limits", () => {
    const manifest = filesManifest();
    expect(() => validateRecoveryManifest({
      ...manifest,
      assets: [{ ...manifest.assets[0], file: "assets/other" }],
    })).toThrow(/invalid-recovery-asset-file/);
    expect(() => validateRecoveryManifest({ ...manifest, assets: [manifest.assets[0], manifest.assets[0]] }))
      .toThrow(/duplicate-recovery-asset-id/);

    const oversized = Array.from({ length: 6 }, (_, index) => ({
      id: `asset-${index}`,
      sha256: "d".repeat(64),
      bytes: 20_000_000,
      file: `assets/asset-${index}`,
    }));
    expect(() => validateRecoveryManifest({ ...manifest, assets: oversized }))
      .toThrow(/recovery-asset-total-too-large/);

    const tooMany = Array.from({ length: 1001 }, (_, index) => ({
      id: `asset-${index}`,
      sha256: "d".repeat(64),
      bytes: 0,
      file: `assets/asset-${index}`,
    }));
    expect(() => validateRecoveryManifest({ ...manifest, assets: tooMany }))
      .toThrow(/invalid-recovery-manifest/);
  });
});

describe("verifyRecoveryBundle", () => {
  it("verifies every checkpoint field, asset byte and canonical fingerprint", () => {
    const fixture = makeBundle();
    const manifest = {
      ...fixture.manifest,
      assets: [...fixture.manifest.assets].reverse(),
    };
    writeManifest(fixture.bundle, manifest, true);

    const verified = verifyRecoveryBundle(fixture.bundle);
    expect(verified.directory).toBe(fixture.bundle);
    expect(verified.checkpoint).toEqual(fixture.checkpoint);
    expect(verified.manifest).toEqual(manifest);
    expect(verified.fingerprint).toBe(sha256(canonicalJson(manifest)));
  });

  it("rejects the incomplete marker by default and still verifies when allowed", () => {
    const fixture = makeBundle();
    writeManifest(fixture.bundle, fixture.manifest);
    writeFileSync(join(fixture.bundle, "FOLIO-RECOVERY-INCOMPLETE"), "pending");

    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-incomplete/);
    expect(verifyRecoveryBundle(fixture.bundle, { allowIncomplete: true }).checkpoint)
      .toEqual(fixture.checkpoint);
  });

  it("rejects missing, extra, altered and symlinked asset files", () => {
    const fixture = makeBundle(["one.bin"]);
    writeManifest(fixture.bundle, fixture.manifest);
    const asset = fixture.written[0];
    const path = join(fixture.bundle, "assets", asset.id);

    writeFileSync(path, "tampered");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-asset-mismatch/);

    writeFileSync(path, asset.bytes);
    writeFileSync(join(fixture.bundle, "assets", "extra"), "extra");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-assets-mismatch/);

    unlinkSync(join(fixture.bundle, "assets", "extra"));
    unlinkSync(path);
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-assets-mismatch/);

    const outside = join(fixture.directory, "outside");
    writeFileSync(outside, asset.bytes);
    symlinkSync(outside, path);
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow();
  });

  it("rejects extra root entries, malformed manifests and incomplete workspaces", () => {
    const fixture = makeBundle([]);
    writeManifest(fixture.bundle, fixture.manifest);
    writeFileSync(join(fixture.bundle, "token.txt"), "secret");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/unexpected-recovery-entry/);

    unlinkSync(join(fixture.bundle, "token.txt"));
    writeFileSync(join(fixture.bundle, "manifest.json"), "{");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/invalid-recovery-manifest-json/);

    const empty = { format: "folio-checkpoint/v1", name: "empty", version: 1, payload: {}, assets: [] };
    const emptyJson = canonicalJson(empty);
    writeFileSync(join(fixture.bundle, "checkpoint.json"), emptyJson);
    writeManifest(fixture.bundle, {
      ...fixture.manifest,
      archive: {...fixture.manifest.archive,checkpointHash:hashCheckpoint(empty as never)},
      checkpoint: { ...fixture.manifest.checkpoint, bytes: Buffer.byteLength(emptyJson),
        sha256: hashCheckpoint(empty as never) },
    });
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/invalid-recovery-checkpoint/);
  });

  it("rejects checkpoint byte, hash and manifest asset mismatches", () => {
    const fixture = makeBundle(["one.bin"]);
    writeManifest(fixture.bundle, fixture.manifest);

    writeManifest(fixture.bundle, {
      ...fixture.manifest,
      checkpoint: { ...fixture.manifest.checkpoint, bytes: fixture.manifest.checkpoint.bytes + 1 },
    });
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-checkpoint-bytes/);

    writeManifest(fixture.bundle, {
      ...fixture.manifest,
      archive: {...fixture.manifest.archive,checkpointHash:"f".repeat(64)},
      checkpoint: { ...fixture.manifest.checkpoint, sha256: "f".repeat(64) },
    });
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-checkpoint-hash/);

    writeManifest(fixture.bundle, { ...fixture.manifest, assets: [] });
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-asset-manifest-mismatch/);
  });
});

it("rejects an archive hash that does not identify the bundled checkpoint", () => {
  const manifest=filesManifest();manifest.archive.checkpointHash="e".repeat(64);
  expect(()=>validateRecoveryManifest(manifest)).toThrow("recovery-archive-hash-mismatch");
});
