import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Opt in only to outputs built in an owned temporary directory. These tests
// inspect PE/bundle bytes; they never launch Windows helpers or native dialogs.
const buildRoot = process.env.FOLIO_WINDOWS_HELPER_BUILD_ROOT;
const runtime = process.env.FOLIO_WINDOWS_HELPER_BUILD_RUNTIME ?? "win-x64";
const signature = Buffer.from("8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae", "hex");
type Entry = {offset: number; size: number; compressedSize: number; type: number; path: string};

/** The SDK's version-6 single-file manifest, read without executing its apphost. */
function bundle(bytes: Buffer): Entry[] {
  const marker = bytes.indexOf(signature);
  expect(marker).toBeGreaterThanOrEqual(8);
  const offset = Number(bytes.readBigUInt64LE(marker - 8));
  expect(Number.isSafeInteger(offset) && offset > 0 && offset < bytes.length).toBe(true);
  let cursor = offset;
  const u32 = () => { const result = bytes.readUInt32LE(cursor); cursor += 4; return result; };
  const u64 = () => { const result = Number(bytes.readBigUInt64LE(cursor)); cursor += 8; expect(Number.isSafeInteger(result)).toBe(true); return result; };
  const string = () => {
    let length = 0, shift = 0;
    for (let count = 0; count < 5; count++) {
      const part = bytes[cursor++];
      expect(part).toBeDefined();
      length += (part & 0x7f) * 2 ** shift;
      if (!(part & 0x80)) {
        expect(length).toBeLessThanOrEqual(65_536);
        expect(cursor + length).toBeLessThanOrEqual(bytes.length);
        const result = new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(cursor, cursor + length));
        cursor += length; return result;
      }
      shift += 7;
    }
    throw new Error("INVALID_BUNDLE_STRING");
  };
  expect(u32()).toBe(6); // SDK format version, not the application/.NET version.
  expect(u32()).toBe(0);
  const count = u32(); expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(256);
  expect(string().length).toBeGreaterThan(0);
  u64(); u64(); u64(); u64(); // Embedded deps/runtimeconfig locations.
  const flags = u64(); expect(flags & 1).toBe(0); // No managed app extraction.
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    const entry = {offset: u64(), size: u64(), compressedSize: u64(), type: bytes[cursor++], path: string()};
    expect(entry.offset).toBeGreaterThan(0);
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.compressedSize).toBe(0); // This build deliberately does not compress.
    expect(entry.offset + entry.size).toBeLessThanOrEqual(offset);
    entries.push(entry);
  }
  return entries;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!buildRoot)("actual Windows helper single-file package (build only)", () => {
  for (const [directory, name] of [["probe", "PrivateRootProbe"], ["owned", "OwnedNodeJob"]]) {
    it(`${name} has the requested PE architecture and embeds the exact app assembly`, () => {
      const output = join(buildRoot!, directory), exe = name + ".exe";
      expect(readdirSync(output)).toEqual([exe]);
      const bytes = readFileSync(join(output, exe));
      expect(bytes.subarray(0, 2).toString()).toBe("MZ");
      const pe = bytes.readUInt32LE(0x3c);
      expect(bytes.subarray(pe, pe + 4)).toEqual(Buffer.from([0x50, 0x45, 0, 0]));
      expect(bytes.readUInt16LE(pe + 4)).toBe(runtime === "win-arm64" ? 0xaa64 : 0x8664);
      const entries = bundle(bytes), application = entries.find(entry => entry.path === name + ".dll");
      expect(application?.type).toBe(1); // Assembly, loaded from the pinned bundle.
      expect(entries.some(entry => entry.path === name + ".deps.json")).toBe(true);
      expect(entries.some(entry => entry.path === name + ".runtimeconfig.json")).toBe(true);
      const sourceAssembly = readFileSync(join(buildRoot!, directory + "-obj", "Release", "net10.0", runtime, name + ".dll"));
      expect(sha256(bytes.subarray(application!.offset, application!.offset + application!.size))).toBe(sha256(sourceAssembly));
    });
  }
});
