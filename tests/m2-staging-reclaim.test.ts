import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reclaimAppliedStaging } from "../src/sync/workspace-blobs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-stage-reclaim-"));
  roots.push(root);
  const staging = join(root, "staging"),
    active = join(root, "active");
  mkdirSync(staging);
  mkdirSync(active);
  const bytes = Buffer.from("confirmed applied content");
  const asset = {
    id: randomUUID() + ".bin",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  writeFileSync(join(staging, asset.id), bytes);
  writeFileSync(join(active, asset.id), bytes);
  return { root, staging, active, bytes, asset };
}
it("reclaims only a named staged copy after an independent verified active copy exists", () => {
  const f = fixture();
  writeFileSync(join(f.staging, "unknown.part"), "retain");
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 1,
    held: 0,
  });
  expect(existsSync(join(f.staging, f.asset.id))).toBe(false);
  expect(readFileSync(join(f.active, f.asset.id))).toEqual(f.bytes);
  expect(readFileSync(join(f.staging, "unknown.part"), "utf8")).toBe("retain");
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 0,
  });
});
it("keeps staging when the active copy is missing or corrupt", () => {
  const f = fixture();
  rmSync(join(f.active, f.asset.id));
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 1,
  });
  writeFileSync(join(f.active, f.asset.id), "wrong");
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 1,
  });
  expect(readFileSync(join(f.staging, f.asset.id))).toEqual(f.bytes);
});
it("keeps corrupt staging and never changes the good active copy", () => {
  const f = fixture();
  writeFileSync(join(f.staging, f.asset.id), "bad");
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 1,
  });
  expect(readFileSync(join(f.staging, f.asset.id), "utf8")).toBe("bad");
  expect(readFileSync(join(f.active, f.asset.id))).toEqual(f.bytes);
});
it("refuses symlinks and shared inodes without removing either reference", () => {
  const f = fixture(),
    source = join(f.staging, f.asset.id),
    target = join(f.active, f.asset.id);
  rmSync(source);
  symlinkSync(target, source);
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 1,
  });
  rmSync(source);
  linkSync(target, source);
  expect(reclaimAppliedStaging(f.staging, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 1,
  });
  expect(readFileSync(source)).toEqual(f.bytes);
  expect(readFileSync(target)).toEqual(f.bytes);
});
it("refuses identical directories", () => {
  const f = fixture();
  expect(reclaimAppliedStaging(f.active, f.active, [f.asset])).toEqual({
    removed: 0,
    held: 1,
  });
  expect(readFileSync(join(f.active, f.asset.id))).toEqual(f.bytes);
});
