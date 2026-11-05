import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrphanMaintenance } from "../src/main/orphan-maintenance";
import { durableFs } from "../src/persistence/durable-file";

type Fixture = {
  root: string;
  workspace: string;
  assets: string;
  external: string;
  db: DatabaseSync;
  maintenance: OrphanMaintenance;
  write(name: string, data: string | Buffer): string;
  insertRegistry(id: string, data: Buffer): void;
  register(id: string, data: string | Buffer): string;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {}
  }
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function managedBytes(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += managedBytes(path);
    else if (entry.isFile()) total += fs.statSync(path).size;
  }
  return total;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(resolve("output/orphan-maintenance-"));
  const workspace = join(root, "workspace");
  const assets = join(workspace, "assets");
  const external = join(root, "external");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(external);
  const db = new DatabaseSync(join(workspace, "workspace.sqlite"));
  db.exec("CREATE TABLE assets(id TEXT PRIMARY KEY, metadata TEXT NOT NULL)");
  const maintenance = new OrphanMaintenance(db, workspace);

  const write = (name: string, data: string | Buffer): string => {
    const path = join(assets, name);
    fs.writeFileSync(path, data);
    return path;
  };
  const insertRegistry = (id: string, data: Buffer): void => {
    const metadata = {
      id,
      storageName: id,
      name: id,
      extension: "",
      mime: "application/octet-stream",
      size: data.length,
      sha256: sha256(data),
    };
    db.prepare("INSERT INTO assets(id,metadata) VALUES(?,?)").run(
      id,
      JSON.stringify(metadata),
    );
  };
  const register = (id: string, data: string | Buffer): string => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    write(id, bytes);
    insertRegistry(id, bytes);
    return join(assets, id);
  };

  const value: Fixture = {
    root,
    workspace,
    assets,
    external,
    db,
    maintenance,
    write,
    insertRegistry,
    register,
  };
  cleanups.push(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return value;
}

describe("OrphanMaintenance", () => {
  it("archives a safe orphan, preserves bytes, and leaves registered assets alone", () => {
    const f = fixture();
    const orphan = f.write("orphan.bin", "orphan payload");
    const registered = f.register("registered.bin", "registered payload");
    const before = managedBytes(f.assets);

    const plan = f.maintenance.plan(orphan);
    expect(plan.name).toBe("orphan.bin");
    expect(plan.bytes).toBe("orphan payload".length);
    expect(plan.ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(orphan)).toBe(true);

    const result = f.maintenance.move(plan.ticket, f.external);
    const wrapper = dirname(result.destination);
    expect(basename(result.destination)).toBe(plan.name);
    expect(dirname(wrapper)).toBe(f.external);
    expect(basename(wrapper)).toMatch(/^folio-orphan-archive-/);
    expect(fs.statSync(wrapper).mode & 0o077).toBe(0);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readFileSync(result.destination, "utf8")).toBe("orphan payload");
    expect(managedBytes(f.assets)).toBe(before - plan.bytes);
    expect(fs.readFileSync(registered, "utf8")).toBe("registered payload");
    expect(() => f.maintenance.move(plan.ticket, f.external)).toThrow(/無効/);
  });

  it("refuses registered and UUID-addressable names even without a registry row", () => {
    const f = fixture();
    const registered = f.register("registered.bin", "registered");
    expect(() => f.maintenance.plan(registered)).toThrow(/登録済み/);

    const lower = f.write(`${randomUUID()}.bin`, "uuid");
    expect(() => f.maintenance.plan(lower)).toThrow(/UUID/);
    const upper = f.write(`${randomUUID().toUpperCase()}.TXT`, "uuid");
    expect(() => f.maintenance.plan(upper)).toThrow(/UUID/);
    const bare = f.write(randomUUID(), "uuid");
    expect(() => f.maintenance.plan(bare)).toThrow(/UUID/);
    expect(fs.readFileSync(registered, "utf8")).toBe("registered");
  });

  it("holds linked, symlinked, oversized, nested, and out-of-tree paths", () => {
    const f = fixture();
    const original = f.write("hard.bin", "hardlink");
    const hard = join(f.assets, "hard-link.bin");
    fs.linkSync(original, hard);
    expect(() => f.maintenance.plan(hard)).toThrow(/ハードリンク/);

    const target = f.write("target.bin", "target");
    const link = join(f.assets, "link.bin");
    fs.symlinkSync(target, link);
    expect(() => f.maintenance.plan(link)).toThrow(/通常ファイル/);

    const oversized = join(f.assets, "oversized.bin");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, 20_000_001);
    expect(() => f.maintenance.plan(oversized)).toThrow(/サイズ/);

    const reserved = f.write("CON.txt", "reserved");
    expect(() => f.maintenance.plan(reserved)).toThrow(/安全/);
    const trailing = f.write("trailing.", "trailing");
    expect(() => f.maintenance.plan(trailing)).toThrow(/安全/);
    const unicode = f.write("orphan-é.bin", "unicode");
    expect(() => f.maintenance.plan(unicode)).toThrow(/安全/);

    const nestedDir = join(f.assets, "nested");
    fs.mkdirSync(nestedDir);
    const nested = join(nestedDir, "orphan.bin");
    fs.writeFileSync(nested, "nested");
    expect(() => f.maintenance.plan(nested)).toThrow(/直下/);

    const outside = join(f.root, "outside.bin");
    fs.writeFileSync(outside, "outside");
    expect(() => f.maintenance.plan(outside)).toThrow(/直下/);

    const fake = join(f.root, "fake-workspace");
    fs.mkdirSync(fake);
    fs.symlinkSync(f.assets, join(fake, "assets"), "dir");
    expect(() => new OrphanMaintenance(f.db, fake)).toThrow(/assets/);
    expect(fs.existsSync(original)).toBe(true);
  });

  it("expires tickets after ten minutes without touching the source", () => {
    const f = fixture();
    const source = f.write("expire.bin", "expire");
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const plan = f.maintenance.plan(source);
      clock.mockReturnValue(now + 10 * 60 * 1000);
      expect(() => f.maintenance.move(plan.ticket, f.external)).toThrow(/期限/);
    } finally {
      clock.mockRestore();
    }
    expect(fs.readFileSync(source, "utf8")).toBe("expire");
    expect(fs.readdirSync(f.external)).toEqual([]);
  });

  it("blocks a changed payload after planning and keeps the source", () => {
    const f = fixture();
    const source = f.write("stale.bin", "before");
    const plan = f.maintenance.plan(source);
    fs.writeFileSync(source, "after!");
    expect(() => f.maintenance.move(plan.ticket, f.external)).toThrow(/変更/);
    expect(fs.readFileSync(source, "utf8")).toBe("after!");
    expect(fs.readdirSync(f.external)).toEqual([]);
  });

  it("blocks a ticket whose file becomes registered after planning", () => {
    const f = fixture();
    const source = f.write("race.bin", "race bytes");
    const plan = f.maintenance.plan(source);
    f.register("race.bin", "race bytes");
    expect(() => f.maintenance.move(plan.ticket, f.external)).toThrow(/登録済み/);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readdirSync(f.external)).toEqual([]);
  });

  it("clear invalidates unused tickets without moving files", () => {
    const f = fixture();
    const source = f.write("clear.bin", "clear");
    const plan = f.maintenance.plan(source);
    f.maintenance.clear();
    expect(() => f.maintenance.move(plan.ticket, f.external)).toThrow(/無効/);
    expect(fs.readFileSync(source, "utf8")).toBe("clear");
  });

  it("holds candidates when registry data is invalid, duplicated, or missing", () => {
    const f = fixture();
    const source = f.write("candidate.bin", "candidate");
    const emptyHash = sha256(Buffer.alloc(0));

    f.db
      .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
      .run(
        "bad.bin",
        JSON.stringify({
          id: "other.bin",
          storageName: "bad.bin",
          size: 0,
          sha256: emptyHash,
        }),
      );
    expect(() => f.maintenance.plan(source)).toThrow(/不正/);

    f.db.exec("DELETE FROM assets");
    f.insertRegistry("Case.bin", Buffer.from("a"));
    f.insertRegistry("case.bin", Buffer.from("b"));
    expect(() => f.maintenance.plan(source)).toThrow(/衝突/);

    f.db.exec("DELETE FROM assets");
    f.insertRegistry("CANDIDATE.BIN", Buffer.from("x"));
    expect(() => f.maintenance.plan(source)).toThrow(/大文字小文字/);

    f.db.exec("DELETE FROM assets");
    f.db.exec("DROP TABLE assets");
    expect(() => f.maintenance.plan(source)).toThrow(/検証/);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readdirSync(f.external)).toEqual([]);
  });

  it("holds candidates when the registry exceeds the row bound", () => {
    const f = fixture();
    const source = f.write("bound.bin", "bound");
    const emptyHash = sha256(Buffer.alloc(0));
    const insert = f.db.prepare(
      "INSERT INTO assets(id,metadata) VALUES(?,?)",
    );
    f.db.exec("BEGIN");
    try {
      for (let index = 0; index < 20_001; index++) {
        const id = `asset-${index}.bin`;
        insert.run(
          id,
          JSON.stringify({
            id,
            storageName: id,
            size: 0,
            sha256: emptyHash,
          }),
        );
      }
      f.db.exec("COMMIT");
    } catch (error) {
      f.db.exec("ROLLBACK");
      throw error;
    }
    expect(() => f.maintenance.plan(source)).toThrow(/上限/);
    expect(fs.existsSync(source)).toBe(true);
  });

  it("refuses workspace, assets, alias, and sibling data-tree destinations", () => {
    const f = fixture();
    const planFor = (name: string) => {
      const path = f.write(name, name);
      return { path, ...f.maintenance.plan(path) };
    };

    const inside = join(f.workspace, "archive");
    fs.mkdirSync(inside);
    const first = planFor("inside.bin");
    expect(() => f.maintenance.move(first.ticket, inside)).toThrow(
      /外側|データツリー/,
    );
    expect(fs.existsSync(first.path)).toBe(true);

    const second = planFor("asset-dest.bin");
    expect(() => f.maintenance.move(second.ticket, f.assets)).toThrow(
      /外側|データツリー/,
    );

    const alias = join(f.root, "workspace-alias");
    fs.symlinkSync(f.workspace, alias, "dir");
    const third = planFor("alias.bin");
    expect(() => f.maintenance.move(third.ticket, alias)).toThrow(
      /外側|データツリー/,
    );

    const session = join(f.root, "session");
    fs.mkdirSync(session);
    const fourth = planFor("session.bin");
    expect(() => f.maintenance.move(fourth.ticket, session)).toThrow(
      /データツリー/,
    );

    const sibling = join(f.root, "workspace-archive");
    fs.mkdirSync(sibling);
    const fifth = planFor("sibling.bin");
    const result = f.maintenance.move(fifth.ticket, sibling);
    const wrapper = dirname(result.destination);
    expect(dirname(wrapper)).toBe(sibling);
    expect(fs.existsSync(fifth.path)).toBe(false);
  });

  it("leaves the source on EXDEV and removes the empty wrapper", () => {
    const f = fixture();
    const source = f.write("exdev.bin", "exdev");
    const plan = f.maintenance.plan(source);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EXDEV: cross-device link"), {
        code: "EXDEV",
      });
    });

    let thrown: unknown;
    try {
      f.maintenance.move(plan.ticket, f.external);
    } catch (error) {
      thrown = error;
    } finally {
      rename.mockRestore();
    }

    expect((thrown as NodeJS.ErrnoException).code).toBe("EXDEV");
    expect((thrown as Error).message).toMatch(/同じファイルシステム/);
    expect(fs.readFileSync(source, "utf8")).toBe("exdev");
    expect(fs.readdirSync(f.external)).toEqual([]);
  });

  it("reports an archived state when a directory fsync fails after rename", () => {
    const f = fixture();
    const source = f.write("post.bin", "post");
    const plan = f.maintenance.plan(source);
    const original = durableFs.syncPath;
    const sync = vi
      .spyOn(durableFs, "syncPath")
      .mockImplementation((path: string) => {
        if (path === f.assets) throw new Error("injected fsync failure");
        original(path);
      });

    let thrown: unknown;
    try {
      f.maintenance.move(plan.ticket, f.external);
    } catch (error) {
      thrown = error;
    } finally {
      sync.mockRestore();
    }

    expect((thrown as Error).message).toMatch(/アーカイブ済み/);
    expect(fs.existsSync(source)).toBe(false);
    const wrappers = fs.readdirSync(f.external);
    expect(wrappers).toHaveLength(1);
    expect(
      fs.readFileSync(join(f.external, wrappers[0], "post.bin"), "utf8"),
    ).toBe("post");
  });

  it("reports an archived state when post-rename readback fails", () => {
    const f = fixture();
    const source = f.write("readback.bin", "original");
    const plan = f.maintenance.plan(source);
    const original = durableFs.syncPath;
    const sync = vi
      .spyOn(durableFs, "syncPath")
      .mockImplementation((path: string) => {
        if (path.startsWith(f.external + sep) && fs.statSync(path).isDirectory()) {
          for (const name of fs.readdirSync(path))
            fs.writeFileSync(join(path, name), "corrupt!");
        }
        original(path);
      });

    let thrown: unknown;
    try {
      f.maintenance.move(plan.ticket, f.external);
    } catch (error) {
      thrown = error;
    } finally {
      sync.mockRestore();
    }

    expect((thrown as Error).message).toMatch(/アーカイブ済み/);
    expect(fs.existsSync(source)).toBe(false);
    const wrappers = fs.readdirSync(f.external);
    expect(wrappers).toHaveLength(1);
    expect(
      fs.readFileSync(join(f.external, wrappers[0], "readback.bin"), "utf8"),
    ).toBe("corrupt!");
  });
});
