import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyRecoveryAsset } from "../src/persistence/conflict-recovery-assets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "folio-m1-assets-")));
  roots.push(root);
  const source = join(root, "source"), destination = join(root, "destination");
  mkdirSync(source); mkdirSync(destination);
  mkdirSync(join(source, "assets")); mkdirSync(join(destination, "assets"));
  return { root, source, destination };
}

function manifest(bytes: Buffer) {
  return { id: `${randomUUID()}.bin`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function put(root: string, asset: { id: string }, bytes: Buffer, prefix = "assets") {
  writeFileSync(join(root, prefix, asset.id), bytes);
}

it("copies exact bytes into a new independent file and survives source replacement", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.from("recovery attachment payload"), asset = manifest(bytes);
  put(source, asset, bytes);
  copyRecoveryAsset(source, destination, asset);
  const output = join(destination, "assets", asset.id);
  expect(readFileSync(output).equals(bytes)).toBe(true);
  expect(statSync(output).ino).not.toBe(statSync(join(source, "assets", asset.id)).ino);
  writeFileSync(join(source, "assets", asset.id), "replaced after copy");
  expect(readFileSync(output).equals(bytes)).toBe(true);
});

it("copies a zero byte asset", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.alloc(0), asset = manifest(bytes);
  put(source, asset, bytes);
  copyRecoveryAsset(source, destination, asset);
  expect(readFileSync(join(destination, "assets", asset.id)).length).toBe(0);
});

it("honors source and destination prefixes", () => {
  const { source, destination } = fixture();
  mkdirSync(join(source, "incoming")); mkdirSync(join(destination, "bundle"));
  const bytes = Buffer.from("prefixed bytes"), asset = manifest(bytes);
  put(source, asset, bytes, "incoming");
  copyRecoveryAsset(source, destination, asset, { sourcePrefix: "incoming", destinationPrefix: "bundle" });
  expect(readFileSync(join(destination, "bundle", asset.id)).equals(bytes)).toBe(true);
});

it("never overwrites an existing destination", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.from("new bytes"), asset = manifest(bytes);
  put(source, asset, bytes);
  writeFileSync(join(destination, "assets", asset.id), "existing");
  expect(() => copyRecoveryAsset(source, destination, asset)).toThrow();
  expect(readFileSync(join(destination, "assets", asset.id), "utf8")).toBe("existing");
});

it("refuses to follow a symlink already present at the destination", () => {
  const { root, source, destination } = fixture();
  const bytes = Buffer.from("payload"), asset = manifest(bytes);
  put(source, asset, bytes);
  const target = join(root, "outside");
  writeFileSync(target, "outside");
  symlinkSync(target, join(destination, "assets", asset.id));
  expect(() => copyRecoveryAsset(source, destination, asset)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("outside");
});

it("does not create a missing destination assets directory", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.from("payload"), asset = manifest(bytes);
  put(source, asset, bytes);
  rmSync(join(destination, "assets"), { recursive: true });
  expect(() => copyRecoveryAsset(source, destination, asset)).toThrow();
  expect(existsSync(join(destination, "assets"))).toBe(false);
});

it("rejects a source size that differs from the manifest before writing output", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.from("short");
  const asset = { id: `${randomUUID()}.bin`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length + 1 };
  put(source, asset, bytes);
  expect(() => copyRecoveryAsset(source, destination, asset)).toThrow("recovery-asset-size-mismatch");
  expect(existsSync(join(destination, "assets", asset.id))).toBe(false);
});

it("stops on input hash mismatch and retains the written output", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.from("tampered manifest hash");
  const asset = { id: `${randomUUID()}.bin`, sha256: "0".repeat(64), bytes: bytes.length };
  put(source, asset, bytes);
  expect(() => copyRecoveryAsset(source, destination, asset)).toThrow("recovery-asset-hash-mismatch");
  const output = join(destination, "assets", asset.id);
  expect(existsSync(output)).toBe(true);
  expect(readFileSync(output).equals(bytes)).toBe(true);
});

it("retains output when a fault is raised after fsync", () => {
  const { source, destination } = fixture();
  const bytes = Buffer.from("fault retention"), asset = manifest(bytes);
  put(source, asset, bytes);
  expect(() => copyRecoveryAsset(source, destination, asset,
    { fault: stage => { if (stage === "after-file-sync") throw new Error("injected-fault"); } })).toThrow("injected-fault");
  expect(readFileSync(join(destination, "assets", asset.id)).equals(bytes)).toBe(true);
});

it("rejects unsafe asset ids without creating output", () => {
  const { source, destination } = fixture();
  for (const id of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
    const asset = { id, sha256: "0".repeat(64), bytes: 0 };
    expect(() => copyRecoveryAsset(source, destination, asset)).toThrow("unsafe-recovery-asset-id");
  }
});

it("rejects a symlink or hardlinked source", () => {
  const { root, source, destination } = fixture();
  const bytes = Buffer.from("link source");
  const symlinkAsset = { id: `${randomUUID()}.bin`, sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length };
  writeFileSync(join(root, "real.bin"), bytes);
  symlinkSync(join(root, "real.bin"), join(source, "assets", symlinkAsset.id));
  expect(() => copyRecoveryAsset(source, destination, symlinkAsset)).toThrow();
  expect(existsSync(join(destination, "assets", symlinkAsset.id))).toBe(false);

  const hardlinkAsset = { id: `${randomUUID()}.bin`, sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length };
  linkSync(join(root, "real.bin"), join(source, "assets", hardlinkAsset.id));
  expect(() => copyRecoveryAsset(source, destination, hardlinkAsset)).toThrow();
  expect(existsSync(join(destination, "assets", hardlinkAsset.id))).toBe(false);
});

it("rejects missing sources, oversized declarations, and non-canonical roots", () => {
  const { root, source, destination } = fixture();
  const missing = { id: `${randomUUID()}.bin`, sha256: "0".repeat(64), bytes: 1 };
  expect(() => copyRecoveryAsset(source, destination, missing)).toThrow();
  expect(existsSync(join(destination, "assets", missing.id))).toBe(false);

  const oversized = { id: `${randomUUID()}.bin`, sha256: "0".repeat(64), bytes: 20_000_001 };
  expect(() => copyRecoveryAsset(source, destination, oversized)).toThrow("invalid-recovery-asset-bytes");

  const bytes = Buffer.from("canonical"), asset = manifest(bytes);
  put(source, asset, bytes);
  symlinkSync(destination, join(root, "destination-link"));
  expect(() => copyRecoveryAsset(source, join(root, "destination-link"), asset)).toThrow("unsafe-recovery-directory");
  symlinkSync(source, join(root, "source-link"));
  expect(() => copyRecoveryAsset(join(root, "source-link"), destination, asset)).toThrow("unsafe-recovery-directory");
  expect(existsSync(join(destination, "assets", asset.id))).toBe(false);
});
