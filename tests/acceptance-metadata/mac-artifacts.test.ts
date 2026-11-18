import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  snapshotFiles,
  verifySnapshot,
} from "../../scripts/mac-acceptance/preflight/artifacts.mjs";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const withRoot = (fn: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "folio-artifacts-fixture-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("artifact manifest snapshot (read-only bookkeeping)", () => {
  it("captures sorted normalized paths with a deterministic aggregate digest", () => {
    withRoot((root) => {
      mkdirSync(join(root, "nested"));
      const beta = Buffer.from("beta");
      const alpha = Buffer.from("alpha");
      writeFileSync(join(root, "b.txt"), beta);
      writeFileSync(join(root, "nested", "a.txt"), alpha);

      const forward = snapshotFiles({
        root,
        paths: ["b.txt", "nested/a.txt"],
      });
      const reverse = snapshotFiles({
        root,
        paths: ["nested/a.txt", "b.txt"],
      });

      expect(forward).toEqual({
        schemaVersion: 1,
        files: [
          { path: "b.txt", bytes: beta.length, sha256: digest(beta) },
          { path: "nested/a.txt", bytes: alpha.length, sha256: digest(alpha) },
        ],
        sha256: digest(
          Buffer.from(
            [
              JSON.stringify(["b.txt", beta.length, digest(beta)]),
              JSON.stringify(["nested/a.txt", alpha.length, digest(alpha)]),
            ]
              .map((line) => line + "\n")
              .join(""),
          ),
        ),
      });
      expect(reverse).toEqual(forward);
      expect(verifySnapshot({ root, snapshot: forward })).toEqual(forward);
      expect(Object.keys(forward).sort()).toEqual([
        "files",
        "schemaVersion",
        "sha256",
      ]);
      expect(forward).not.toHaveProperty("status");
      expect(forward).not.toHaveProperty("productResult");
      expect(readdirSync(root).sort()).toEqual(["b.txt", "nested"]);
    });
  });

  it("allows an empty manifest and zero-byte files without inventing status", () => {
    withRoot((root) => {
      writeFileSync(join(root, "empty.bin"), Buffer.alloc(0));
      expect(snapshotFiles({ root, paths: [] })).toEqual({
        schemaVersion: 1,
        files: [],
        sha256: digest(Buffer.from("")),
      });
      const snapshot = snapshotFiles({ root, paths: ["empty.bin"] });
      expect(snapshot.files).toEqual([
        { path: "empty.bin", bytes: 0, sha256: digest(Buffer.from("")) },
      ]);
      expect(verifySnapshot({ root, snapshot })).toEqual(snapshot);
    });
  });

  it("verifies unchanged files and rejects mutation, missing files and tampering", () => {
    withRoot((root) => {
      writeFileSync(join(root, "one.txt"), "one");
      const snapshot = snapshotFiles({ root, paths: ["one.txt"] });
      expect(verifySnapshot({ root, snapshot })).toEqual(snapshot);

      writeFileSync(join(root, "one.txt"), "ONE");
      expect(() => verifySnapshot({ root, snapshot })).toThrow(
        /content mismatch/,
      );

      writeFileSync(join(root, "one.txt"), "one");
      rmSync(join(root, "one.txt"));
      expect(() => verifySnapshot({ root, snapshot })).toThrow();
    });

    withRoot((root) => {
      writeFileSync(join(root, "one.txt"), "one");
      const snapshot = snapshotFiles({ root, paths: ["one.txt"] });
      for (const tampered of [
        { ...snapshot, schemaVersion: 2 },
        { ...snapshot, sha256: "0".repeat(64) },
        { ...snapshot, extra: true },
        {
          ...snapshot,
          files: [{ ...snapshot.files[0], bytes: snapshot.files[0].bytes + 1 }],
        },
        {
          ...snapshot,
          files: [{ ...snapshot.files[0], sha256: "0".repeat(64) }],
        },
        {
          ...snapshot,
          files: [{ ...snapshot.files[0], path: "../escape" }],
        },
      ])
        expect(() =>
          verifySnapshot({ root, snapshot: tampered as any }),
        ).toThrow();
    });
  });

  it.each([
    [".."],
    ["../outside.txt"],
    ["a/../../outside.txt"],
    ["./a.txt"],
    ["a//b.txt"],
    ["a/"],
    ["/absolute.txt"],
    [""],
    ["a\\b.txt"],
    ["a/./b.txt"],
    ["a/../b.txt"],
  ])("rejects non-normalized or traversing path %j", (path) => {
    withRoot((root) => {
      writeFileSync(join(root, "a.txt"), "a");
      expect(() => snapshotFiles({ root, paths: [path] })).toThrow();
    });
  });

  it("rejects duplicate, non-string and non-array path selections", () => {
    withRoot((root) => {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      expect(() => snapshotFiles({ root, paths: ["a.txt", "a.txt"] })).toThrow(
        /unique/,
      );
      expect(() =>
        snapshotFiles({ root, paths: ["a.txt", 1 as any] }),
      ).toThrow();
      expect(() => snapshotFiles({ root, paths: "a.txt" as any })).toThrow();
      expect(() => snapshotFiles({ root } as any)).toThrow();
      expect(() => snapshotFiles({ root, paths: ["missing.txt"] })).toThrow();
      expect(() => snapshotFiles({ root: "relative", paths: [] })).toThrow();
    });
  });

  it("rejects symlink, intermediate symlink, hardlink and directory paths", () => {
    withRoot((root) => {
      const outside = mkdtempSync(join(tmpdir(), "folio-artifacts-outside-"));
      try {
        writeFileSync(join(root, "real.txt"), "real");
        writeFileSync(join(outside, "secret.txt"), "secret");
        symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
        symlinkSync(outside, join(root, "escape-dir"));
        symlinkSync(join(root, "real.txt"), join(root, "inside-link.txt"));
        linkSync(join(root, "real.txt"), join(root, "hard.txt"));
        mkdirSync(join(root, "directory"));

        for (const path of [
          "escape.txt",
          "escape-dir/secret.txt",
          "inside-link.txt",
          "hard.txt",
          "directory",
        ])
          expect(() => snapshotFiles({ root, paths: [path] })).toThrow();

        rmSync(join(root, "hard.txt"));
        const snapshot = snapshotFiles({ root, paths: ["real.txt"] });
        rmSync(join(root, "real.txt"));
        symlinkSync(join(outside, "secret.txt"), join(root, "real.txt"));
        expect(() => verifySnapshot({ root, snapshot })).toThrow();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("enforces file count, per-file and total size limits", () => {
    withRoot((root) => {
      const names = Array.from({ length: 32 }, (_, index) => `f-${index}.bin`);
      for (const name of names) writeFileSync(join(root, name), "");
      expect(snapshotFiles({ root, paths: names }).files).toHaveLength(32);
      expect(() =>
        snapshotFiles({ root, paths: [...names, "extra.bin"] }),
      ).toThrow(/count/);

      writeFileSync(join(root, "too-big.bin"), Buffer.alloc(0));
      truncateSync(join(root, "too-big.bin"), 16 * 1024 * 1024 + 1);
      expect(() => snapshotFiles({ root, paths: ["too-big.bin"] })).toThrow(
        /per-file/,
      );

      const large = Array.from(
        { length: 5 },
        (_, index) => `large-${index}.bin`,
      );
      for (const name of large) {
        writeFileSync(join(root, name), Buffer.alloc(0));
        truncateSync(join(root, name), 13 * 1024 * 1024);
      }
      expect(() => snapshotFiles({ root, paths: large })).toThrow(/total/);
    });
  });

  it("rejects an aggregate digest that was not produced from sorted entries", () => {
    withRoot((root) => {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      const snapshot = snapshotFiles({ root, paths: ["b.txt", "a.txt"] });
      const reversed = {
        ...snapshot,
        files: [...snapshot.files].reverse(),
      };
      expect(() => verifySnapshot({ root, snapshot: reversed as any })).toThrow(
        /sorted/,
      );
    });
  });
});
