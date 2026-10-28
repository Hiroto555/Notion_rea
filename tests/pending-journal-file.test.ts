import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertExternalOutput } from "../src/persistence/output-path";
import { writePendingJournalFile, type PendingJournalWriteOptions } from "../src/persistence/pending-journal-file";

function fixture() {
  const root = fs.mkdtempSync(resolve("output/pending-journal-test-"));
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  fs.mkdirSync(workspace);
  fs.mkdirSync(external);
  const target = join(external, "未保存.json");
  const stage = join(external, ".未保存.json.folio-journal-fixed.tmp");
  const options: PendingJournalWriteOptions = {
    validate(content) {
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || !("draft" in value))
        throw new Error("Invalid fixture journal");
    },
    checkDestination(path) { assertExternalOutput(workspace, path); },
    temporaryId: () => "fixed",
  };
  return { root, workspace, external, target, stage, options,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const content = JSON.stringify({ draft: "未保存 あ😀", values: { status: "保留" } });

describe("pending journal file publication", () => {
  it("validates twice, checks the boundary twice, fsyncs and publishes UTF-8 with no overwrite", () => {
    const f = fixture();
    try {
      let checked = 0, validated = 0, syncs = 0;
      const result = writePendingJournalFile(f.target, content, {
        ...f.options,
        validate(value) { validated++; f.options.validate(value); },
        checkDestination(path) { checked++; f.options.checkDestination(path); },
        operations: { fsyncSync(fd) { syncs++; fs.fsyncSync(fd); } },
      });
      expect(result).toEqual({ path: f.target, stagingPath: f.stage });
      expect(validated).toBe(2);
      expect(checked).toBe(2);
      expect(syncs).toBe(3); // data, staging directory, published directory
      expect(fs.readFileSync(f.target, "utf8")).toBe(content);
      expect(fs.readFileSync(f.stage, "utf8")).toBe(content);
      expect(fs.statSync(f.target).ino).toBe(fs.statSync(f.stage).ino);
      expect(fs.statSync(f.target).mode & 0o777).toBe(0o600);
      expect(() => writePendingJournalFile(f.target, content, f.options)).toThrow();
      expect(fs.readFileSync(f.target, "utf8")).toBe(content);
    } finally { f.cleanup(); }
  });

  it("rejects invalid content and workspace paths before opening a staging file", () => {
    const f = fixture();
    try {
      expect(() => writePendingJournalFile(f.target, "{", f.options)).toThrow();
      expect(fs.existsSync(f.stage)).toBe(false);
      const protectedPath = join(f.workspace, "db.sqlite");
      fs.writeFileSync(protectedPath, "original");
      expect(() => writePendingJournalFile(protectedPath, content, f.options)).toThrow();
      expect(fs.readFileSync(protectedPath, "utf8")).toBe("original");
      const asyncValidator = { ...f.options, validate: () => Promise.resolve() };
      expect(() => writePendingJournalFile(f.target, content, asyncValidator)).toThrow("synchronous");
      expect(fs.existsSync(f.stage)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("preserves an existing destination, dangling symlink and pre-existing staging collision", () => {
    const f = fixture();
    try {
      fs.writeFileSync(f.target, "other output");
      expect(() => writePendingJournalFile(f.target, content, f.options)).toThrow();
      expect(fs.readFileSync(f.target, "utf8")).toBe("other output");
      fs.unlinkSync(f.target);
      fs.symlinkSync(join(f.workspace, "missing"), f.target);
      expect(() => writePendingJournalFile(f.target, content, f.options)).toThrow();
      expect(fs.lstatSync(f.target).isSymbolicLink()).toBe(true);
      fs.unlinkSync(f.target);
      fs.writeFileSync(f.stage, "someone else's staging");
      expect(() => writePendingJournalFile(f.target, content, f.options)).toThrow();
      expect(fs.readFileSync(f.stage, "utf8")).toBe("someone else's staging");
      expect(fs.existsSync(f.target)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("rejects same-inode, same-length tampering before publication and leaves staging untouched", () => {
    const f = fixture();
    try {
      let calls = 0;
      const changed = Buffer.alloc(Buffer.byteLength(content), 0x78);
      expect(() => writePendingJournalFile(f.target, content, {
        ...f.options,
        checkDestination(path) {
          f.options.checkDestination(path);
          if (++calls === 2) fs.writeFileSync(f.stage, changed);
        },
      })).toThrow("content changed");
      expect(fs.existsSync(f.target)).toBe(false);
      expect(fs.readFileSync(f.stage)).toEqual(changed);
    } finally { f.cleanup(); }
  });

  it("rejects an exchanged staging symlink without deleting either file", () => {
    const f = fixture();
    try {
      const original = join(f.workspace, "protected");
      const detached = join(f.external, "original-staging");
      fs.writeFileSync(original, "protected bytes");
      let calls = 0;
      expect(() => writePendingJournalFile(f.target, content, {
        ...f.options,
        checkDestination(path) {
          f.options.checkDestination(path);
          if (++calls === 2) {
            fs.renameSync(f.stage, detached);
            fs.symlinkSync(original, f.stage);
          }
        },
      })).toThrow();
      expect(fs.lstatSync(f.stage).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(original, "utf8")).toBe("protected bytes");
      expect(fs.readFileSync(detached, "utf8")).toBe(content);
      expect(fs.existsSync(f.target)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("rejects a parent directory exchanged for a workspace symlink", () => {
    const f = fixture();
    try {
      const moved = join(f.root, "original-exports");
      const original = join(f.workspace, "protected");
      fs.writeFileSync(original, "untouched");
      let calls = 0;
      expect(() => writePendingJournalFile(f.target, content, {
        ...f.options,
        checkDestination(path) {
          f.options.checkDestination(path);
          if (++calls === 2) {
            fs.renameSync(f.external, moved);
            fs.symlinkSync(f.workspace, f.external);
          }
        },
      })).toThrow();
      expect(fs.readFileSync(original, "utf8")).toBe("untouched");
      expect(fs.readFileSync(join(moved, ".未保存.json.folio-journal-fixed.tmp"), "utf8")).toBe(content);
      expect(fs.existsSync(join(f.workspace, "未保存.json"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("does not replace a destination created during the last boundary check", () => {
    const f = fixture();
    try {
      let calls = 0;
      expect(() => writePendingJournalFile(f.target, content, {
        ...f.options,
        checkDestination(path) {
          f.options.checkDestination(path);
          if (++calls === 2) fs.writeFileSync(path, "concurrent output", { flag: "wx" });
        },
      })).toThrow();
      expect(fs.readFileSync(f.target, "utf8")).toBe("concurrent output");
      expect(fs.readFileSync(f.stage, "utf8")).toBe(content);
    } finally { f.cleanup(); }
  });

  it("detects same-size mutation during publication and does not delete either name", () => {
    const f = fixture();
    try {
      const changed = Buffer.alloc(Buffer.byteLength(content), 0x78);
      expect(() => writePendingJournalFile(f.target, content, {
        ...f.options,
        operations: {
          linkSync(a, b) {
            fs.linkSync(a, b);
            fs.writeFileSync(f.stage, changed);
          },
        },
      })).toThrow("published content changed");
      expect(fs.readFileSync(f.stage)).toEqual(changed);
      expect(fs.readFileSync(f.target)).toEqual(changed);
    } finally { f.cleanup(); }
  });

  it("does not publish on a write, readback, file fsync or file close failure", () => {
    for (const fault of ["write", "read", "fsync", "close"] as const) {
      const f = fixture();
      try {
        let closed = false;
        const operations: PendingJournalWriteOptions["operations"] = {
          writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
            if (fault === "write") throw new Error("write failure");
            return fs.writeFileSync(...args);
          }) as typeof fs.writeFileSync,
          readSync: ((...args: Parameters<typeof fs.readSync>) => {
            if (fault === "read") return 0;
            return fs.readSync(...args);
          }) as typeof fs.readSync,
          fsyncSync(fd) { if (fault === "fsync") throw new Error("fsync failure"); fs.fsyncSync(fd); },
          closeSync(fd) {
            fs.closeSync(fd);
            if (fault === "close" && !closed) { closed = true; throw new Error("close failure"); }
          },
        };
        expect(() => writePendingJournalFile(f.target, content, { ...f.options, operations })).toThrow();
        expect(fs.existsSync(f.target)).toBe(false);
        // No auto-unlink: even a partial or replaced staging file is preserved.
        expect(fs.existsSync(f.stage)).toBe(true);
      } finally { f.cleanup(); }
    }
  });

  it("retains both names when link or directory sync fails after publication", () => {
    for (const fault of ["link-after", "directory-sync", "directory-close"] as const) {
      const f = fixture();
      try {
        let syncs = 0, closes = 0;
        const operations: PendingJournalWriteOptions["operations"] = {
          linkSync(a, b) {
            fs.linkSync(a, b);
            if (fault === "link-after") throw new Error("link outcome unknown");
          },
          fsyncSync(fd) {
            syncs++;
            if (fault === "directory-sync" && syncs === 3) throw new Error("directory sync failure");
            fs.fsyncSync(fd);
          },
          closeSync(fd) {
            fs.closeSync(fd);
            if (fault === "directory-close" && ++closes === 4) throw new Error("directory close failure");
          },
        };
        expect(() => writePendingJournalFile(f.target, content, { ...f.options, operations })).toThrow();
        expect(fs.readFileSync(f.target, "utf8")).toBe(content);
        expect(fs.readFileSync(f.stage, "utf8")).toBe(content);
      } finally { f.cleanup(); }
    }
  });
});
