import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";

// The W2 verifier is implemented by a separate owner. These focused create
// tests exercise the frozen verifier seam with a read-only inspection of the
// actual snapshot; they do not replace real verifier integration checks.
const control = vi.hoisted(() => ({
  verifyError: undefined as string | undefined,
  inspectCalls: 0,
  verifyCalls: 0,
  lastVerifyOptions: undefined as { allowIncomplete?: boolean } | undefined,
}));

vi.mock("../src/persistence/full-backup-verify", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");

  function collect(
    directory: string,
    root: string,
    found: { path: string; bytes: number; sha256: string }[] = [],
  ) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink())
        throw new Error("test inspector refuses symlink");
      if (info.isDirectory()) collect(file, root, found);
      else if (info.isFile()) {
        const bytes = fs.readFileSync(file);
        found.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  return {
    inspectWorkspaceSnapshot(directory: string) {
      control.inspectCalls++;
      const database = new DatabaseSync(
        path.join(directory, "workspace.sqlite"),
        { readOnly: true },
      );
      try {
        const storeVersion = (
          database.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version;
        const table = (name: string) =>
          !!database
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(name);
        const count = (name: string) =>
          table(name)
            ? Number(
                (
                  database.prepare(`SELECT count(*) AS n FROM ${name}`).get() as {
                    n: number;
                  }
                ).n,
              )
            : 0;
        const inventory = {
          pages: count("pages"),
          recordDatabases: count("record_databases"),
          records: count("record_memberships"),
          versions: count("versions"),
          settings: count("settings"),
          saveReceipts: count("save_receipts"),
          registeredAssets: count("assets"),
        };
        const assetsDirectory = path.join(directory, "assets");
        const assets = fs.existsSync(assetsDirectory)
          ? collect(assetsDirectory, assetsDirectory)
          : [];
        const logicalSha256 = crypto
          .createHash("sha256")
          .update(JSON.stringify({ storeVersion, inventory, assets }))
          .digest("hex");
        return { storeVersion, inventory, logicalSha256, assets };
      } finally {
        database.close();
      }
    },
    verifyFullBackup(
      directory: string,
      options: { allowIncomplete?: boolean } = {},
    ) {
      control.verifyCalls++;
      control.lastVerifyOptions = options;
      if (control.verifyError) throw new Error(control.verifyError);
      const marker = path.join(directory, "FOLIO-RECOVERY-INCOMPLETE");
      if (!options.allowIncomplete && fs.existsSync(marker))
        throw new Error("test verifier refuses an incomplete directory");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
      );
      const bytes = fs.readFileSync(path.join(directory, "workspace.sqlite"));
      if (
        manifest.format !== "folio-workspace-backup" ||
        manifest.version !== 1 ||
        manifest.database?.path !== "workspace.sqlite" ||
        manifest.database?.bytes !== bytes.length ||
        manifest.database?.sha256 !==
          crypto.createHash("sha256").update(bytes).digest("hex")
      )
        throw new Error("test verifier rejected the manifest");
      return {
        directory,
        manifest,
        fingerprint: crypto
          .createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex"),
      };
    },
  };
});

import { createFullBackup } from "../src/persistence/full-backup-create";

const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function fixture() {
  const root = mkdtempSync(resolve("output/r8-backup-create-")),
    source = join(root, "workspace");
  mkdirSync(source, { recursive: true });
  const store = new Store(join(source, "workspace.sqlite")),
    assets = join(source, "assets");
  mkdirSync(assets, { recursive: true });
  const page = store.create(null, "page", "Original");
  let current = store.update(page.id, page.revision, {
    title: "Second revision",
  });
  store.handle({ type: "setting", key: "theme", value: "dark" });
  const receipt = store.commitSave({
    operationId: randomUUID(),
    sessionId: randomUUID(),
    seq: 1,
    pageId: current.id,
    databasePageId: null,
    revision: current.revision,
    patch: { title: "Saved by receipt" },
  });
  if (receipt.status !== "applied" || !receipt.page)
    throw new Error("fixture save was not applied");
  current = store.update(receipt.page.id, receipt.page.revision, {
    title: "Latest title",
  });
  const input = join(root, "attachment.txt");
  writeFileSync(input, Buffer.from("attachment bytes\n"));
  const attachment = attachFile(store.db, assets, input);
  const extraName = "12345678-1234-1234-1234-123456789abc.txt";
  writeFileSync(join(assets, extraName), Buffer.from([0, 255, 13, 10]));
  store.db.exec(
    "CREATE TABLE r8_extra(value TEXT); INSERT INTO r8_extra(value) VALUES('kept')",
  );
  return {
    root,
    source,
    assets,
    store,
    pageId: current.id,
    attachment,
    extraName,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("creates a verified snapshot with all tables, history, receipts, settings and regular assets", () => {
  const f = fixture();
  try {
    const destination = join(f.root, "backup"),
      sourceDbHash = hash(join(f.source, "workspace.sqlite")),
      sourceAttachment = readFileSync(
        join(f.assets, f.attachment.storageName),
      ),
      sourceExtra = readFileSync(join(f.assets, f.extraName));
    const result = createFullBackup(f.store.db, f.source, destination);

    expect(control.lastVerifyOptions).toEqual({ allowIncomplete: true });
    expect(result.directory).toBe(destination);
    expect(result.manifest).toMatchObject({
      format: "folio-workspace-backup",
      version: 1,
      database: {
        path: "workspace.sqlite",
        bytes: readFileSync(join(destination, "workspace.sqlite")).length,
        sha256: hash(join(destination, "workspace.sqlite")),
      },
    });
    expect(result.manifest.inventory).toMatchObject({
      pages: 1,
      versions: 3,
      settings: 1,
      saveReceipts: 1,
      registeredAssets: 1,
    });
    expect(result.manifest.assets.map((asset) => asset.path)).toEqual(
      [f.attachment.storageName, f.extraName].sort(),
    );
    expect(existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(
      false,
    );
    expect(
      JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")),
    ).toEqual(result.manifest);
    expect(
      readdirSync(destination).filter((name) => name.startsWith(".manifest-")),
    ).toEqual([]);
    expect(existsSync(join(destination, "workspace.sqlite-wal"))).toBe(false);
    expect(existsSync(join(destination, "workspace.sqlite-shm"))).toBe(false);

    const copy = new DatabaseSync(join(destination, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        (copy.prepare("SELECT value FROM r8_extra").get() as { value: string })
          .value,
      ).toBe("kept");
      expect(
        (
          copy.prepare("SELECT count(*) AS n FROM versions").get() as {
            n: number;
          }
        ).n,
      ).toBe(3);
      expect(
        (
          copy.prepare("SELECT count(*) AS n FROM save_receipts").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
      expect(
        (
          copy.prepare("SELECT count(*) AS n FROM assets").get() as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      copy.close();
    }
    expect(readFileSync(join(destination, "assets", f.attachment.storageName))).toEqual(
      sourceAttachment,
    );
    expect(readFileSync(join(destination, "assets", f.extraName))).toEqual(
      sourceExtra,
    );

    expect(hash(join(f.source, "workspace.sqlite"))).toBe(sourceDbHash);
    expect(readFileSync(join(f.assets, f.attachment.storageName))).toEqual(
      sourceAttachment,
    );
    expect(readFileSync(join(f.assets, f.extraName))).toEqual(sourceExtra);
    expect(f.store.get(f.pageId).title).toBe("Latest title");
  } finally {
    f.dispose();
  }
});

it("allows a new child under source/backups and leaves the source readable", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.source, "backups"));
    const destination = join(f.source, "backups", "snapshot");
    const result = createFullBackup(f.store.db, f.source, destination);
    expect(result.directory).toBe(destination);
    expect(f.store.get(f.pageId).title).toBe("Latest title");
    expect(readFileSync(join(destination, "assets", f.extraName))).toEqual(
      Buffer.from([0, 255, 13, 10]),
    );
  } finally {
    f.dispose();
  }
});

it("refuses existing destinations, symlinks, source assets and the source database", () => {
  const f = fixture();
  try {
    const existing = join(f.root, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "sentinel"), "keep");
    expect(() => createFullBackup(f.store.db, f.source, existing)).toThrow(
      /既に存在/,
    );
    expect(readFileSync(join(existing, "sentinel"), "utf8")).toBe("keep");

    const actual = join(f.root, "actual");
    mkdirSync(actual);
    writeFileSync(join(actual, "sentinel"), "keep");
    const link = join(f.root, "link");
    symlinkSync(actual, link);
    expect(() => createFullBackup(f.store.db, f.source, link)).toThrow(
      /既に存在/,
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(actual, "sentinel"), "utf8")).toBe("keep");

    const inAssets = join(f.assets, "backup");
    expect(() => createFullBackup(f.store.db, f.source, inAssets)).toThrow(
      /添付フォルダ/,
    );
    expect(existsSync(inAssets)).toBe(false);
    expect(() =>
      createFullBackup(
        f.store.db,
        f.source,
        join(f.source, "workspace.sqlite"),
      ),
    ).toThrow(/既に存在/);
  } finally {
    f.dispose();
  }
});

it("requires an idle database and creates nothing when the transaction check fails", () => {
  const f = fixture();
  try {
    const destination = join(f.root, "backup");
    f.store.db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => createFullBackup(f.store.db, f.source, destination)).toThrow(
        /トランザクション/,
      );
    } finally {
      f.store.db.exec("ROLLBACK");
    }
    expect(existsSync(destination)).toBe(false);
    expect(f.store.get(f.pageId).title).toBe("Latest title");
  } finally {
    f.dispose();
  }
});

it("rejects changed or missing registered attachment bytes with a marked partial output", () => {
  const f = fixture();
  try {
    const attachmentPath = join(f.assets, f.attachment.storageName),
      sourceDbHash = hash(join(f.source, "workspace.sqlite"));
    writeFileSync(attachmentPath, "changed after registration");
    const changed = join(f.root, "changed-bytes");
    expect(() => createFullBackup(f.store.db, f.source, changed)).toThrow(
      /一致しません/,
    );
    expect(existsSync(join(changed, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
    expect(existsSync(join(changed, "manifest.json"))).toBe(false);

    rmSync(attachmentPath);
    const missing = join(f.root, "missing-bytes");
    expect(() => createFullBackup(f.store.db, f.source, missing)).toThrow(
      /存在しません/,
    );
    expect(existsSync(join(missing, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
    expect(existsSync(join(missing, "manifest.json"))).toBe(false);
    expect(hash(join(f.source, "workspace.sqlite"))).toBe(sourceDbHash);
  } finally {
    f.dispose();
  }
});

it("leaves a marked partial destination on copy or verification failure without changing source", () => {
  const f = fixture();
  try {
    const sourceDbHash = hash(join(f.source, "workspace.sqlite")),
      sentinel = join(f.root, "outside-sentinel");
    writeFileSync(sentinel, "outside");
    const link = join(f.assets, "0000-link");
    symlinkSync(sentinel, link);
    const failedCopy = join(f.root, "failed-copy");
    expect(() => createFullBackup(f.store.db, f.source, failedCopy)).toThrow(
      /シンボリックリンク/,
    );
    expect(existsSync(join(failedCopy, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(
      true,
    );
    expect(existsSync(join(failedCopy, "manifest.json"))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(hash(join(f.source, "workspace.sqlite"))).toBe(sourceDbHash);

    rmSync(link);
    control.verifyError = "simulated verification failure";
    const failedVerify = join(f.root, "failed-verify");
    expect(() => createFullBackup(f.store.db, f.source, failedVerify)).toThrow(
      /simulated verification failure/,
    );
    expect(existsSync(join(failedVerify, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(
      true,
    );
    expect(existsSync(join(failedVerify, "manifest.json"))).toBe(true);
    expect(
      existsSync(join(failedVerify, "workspace.sqlite")),
    ).toBe(true);
    expect(hash(join(f.source, "workspace.sqlite"))).toBe(sourceDbHash);
  } finally {
    control.verifyError = undefined;
    f.dispose();
  }
});
