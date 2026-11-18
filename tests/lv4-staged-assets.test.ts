import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publishCheckpointAssetsFromStaging } from "../src/sync/workspace-blobs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-lv4-assets-")); roots.push(root);
  const staging = join(root, "staging"), active = join(root, "assets");
  mkdirSync(staging); mkdirSync(active);
  const bytes = Buffer.from("verified incoming bytes");
  const asset = { id: randomUUID() + ".bin", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  writeFileSync(join(staging, asset.id), bytes);
  return { staging, active, bytes, asset };
}
it("publishes offline and does not share an inode with staging", () => {
  const { staging, active, bytes, asset } = fixture();
  const admit = vi.fn();
  publishCheckpointAssetsFromStaging(staging, active, [asset], admit);
  expect(readFileSync(join(active, asset.id))).toEqual(bytes);
  expect(admit).toHaveBeenCalledWith(bytes.length);
  writeFileSync(join(staging, asset.id), Buffer.alloc(bytes.length, 1));
  expect(readFileSync(join(active, asset.id))).toEqual(bytes);
});
it("refuses corrupt staging or an existing conflicting asset without overwriting", () => {
  const { staging, active, asset } = fixture();
  writeFileSync(join(active, asset.id), "different");
  expect(() => publishCheckpointAssetsFromStaging(staging, active, [asset])).toThrow("asset-id-hash-conflict");
  expect(readFileSync(join(active, asset.id), "utf8")).toBe("different");
  rmSync(join(active, asset.id));
  writeFileSync(join(staging, asset.id), "bad");
  expect(() => publishCheckpointAssetsFromStaging(staging, active, [asset])).toThrow();
  expect(existsSync(join(active, asset.id))).toBe(false);
});
it("rejects identical staging and active directories and admission failures", () => {
  const { staging, active, asset } = fixture();
  expect(() => publishCheckpointAssetsFromStaging(staging, staging, [asset])).toThrow("asset-staging-directory-conflict");
  expect(() => publishCheckpointAssetsFromStaging(staging, active, [asset], () => { throw new Error("full"); })).toThrow("full");
  expect(existsSync(join(active, asset.id))).toBe(false);
});
