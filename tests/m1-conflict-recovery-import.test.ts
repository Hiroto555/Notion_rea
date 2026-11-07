import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECOVERY_INCOMPLETE } from "../src/shared/conflict-recovery";
import { restoreRecoveryBundle } from "../src/persistence/conflict-recovery-import";
import { verifyRecoveryBundle } from "../src/persistence/conflict-recovery-verify";
import { initializeRecoveredContent } from "../src/persistence/recovered-content";
import { Store } from "../src/persistence/store";
import { canonicalJson, hashCheckpoint, MAX_CHECKPOINT_BYTES } from "../src/sync/protocol";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";

const BUDGET_SLACK_BYTES = 64 * 1024 * 1024;
const PAGE_ID = "page-jp-1";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_CONTENT = Buffer.from("添付ファイルの内容", "utf8");

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Bundle = { directory: string; checkpointHash: string; payloadBytes: number };

function makeBundle(root: string): Bundle {
  const seedDirectory = join(root, "seed");
  mkdirSync(seedDirectory);
  const seedStore = new Store(join(seedDirectory, "workspace.sqlite"));
  const base = structuredClone(buildWorkspaceCheckpoint(seedStore.db));
  seedStore.close();

  const page = {
    id: PAGE_ID,
    parentId: null,
    title: "日本語タイトル",
    icon: "",
    cover: "",
    position: 0,
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "本文の内容です。" }],
        },
      ],
    },
    kind: "page",
    database: null,
    favorite: false,
    createdAt: 1_720_000_000_000,
    updatedAt: 1_720_000_000_000,
    revision: 1,
    deletedAt: null,
  };
  const historyDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "履歴本文です。" }],
      },
    ],
  };
  const assetMetadata = {
    id: ASSET_ID,
    name: "添付ファイル.txt",
    extension: "txt",
    mime: "text/plain",
    storageName: ASSET_ID,
    size: ASSET_CONTENT.length,
    sha256: sha256(ASSET_CONTENT),
  };
  const checkpoint = base as unknown as {
    payload: { tables: Record<string, (string | number | null)[][]> };
  };
  checkpoint.payload.tables.pages = [[PAGE_ID, JSON.stringify(page)]];
  checkpoint.payload.tables.versions = [
    [1, PAGE_ID, 1_720_000_000_000, "履歴タイトル", JSON.stringify(historyDoc), null],
  ];
  checkpoint.payload.tables.assets = [[ASSET_ID, JSON.stringify(assetMetadata)]];
  (checkpoint as unknown as { assets: unknown[] }).assets = [
    { id: ASSET_ID, bytes: ASSET_CONTENT.length, sha256: sha256(ASSET_CONTENT) },
  ];

  const workspaceDirectory = join(root, "workspace");
  mkdirSync(workspaceDirectory);
  const workspaceStore = new Store(join(workspaceDirectory, "workspace.sqlite"));
  initializeRecoveredContent(workspaceStore, checkpoint as never, randomUUID());
  const sourceCheckpoint = buildWorkspaceCheckpoint(workspaceStore.db);
  workspaceStore.close();

  mkdirSync(join(workspaceDirectory, "assets"));
  for (const asset of sourceCheckpoint.assets) {
    writeFileSync(join(workspaceDirectory, "assets", String(asset.id)), ASSET_CONTENT);
  }

  const bundleDirectory = join(root, "bundle");
  mkdirSync(bundleDirectory);
  mkdirSync(join(bundleDirectory, "assets"));
  const checkpointText = canonicalJson(sourceCheckpoint, MAX_CHECKPOINT_BYTES);
  writeFileSync(join(bundleDirectory, "checkpoint.json"), checkpointText);
  for (const asset of sourceCheckpoint.assets) {
    writeFileSync(join(bundleDirectory, "assets", String(asset.id)), ASSET_CONTENT);
  }
  const manifest = {
    format: "folio-conflict-recovery",
    version: 1,
    archive: {
      source: sha256("workspace-source"),
      id: 1,
      operationId: "operation-1",
      kind: "restore",
      createdAt: 1,
      checkpointHash: hashCheckpoint(sourceCheckpoint),
    },
    checkpoint: {
      file: "checkpoint.json",
      bytes: Buffer.byteLength(checkpointText),
      sha256: sha256(checkpointText),
    },
    assets: sourceCheckpoint.assets.map((asset) => ({
      ...asset,
      file: `assets/${asset.id}`,
    })),
  };
  writeFileSync(join(bundleDirectory, "manifest.json"), JSON.stringify(manifest));

  return {
    directory: bundleDirectory,
    checkpointHash: hashCheckpoint(sourceCheckpoint),
    payloadBytes:
      Buffer.byteLength(checkpointText) +
      sourceCheckpoint.assets.reduce((total, asset) => total + asset.bytes, 0),
  };
}

function newRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-d07r1-"));
  temporaryDirectories.push(root);
  return root;
}

describe("restoreRecoveryBundle", () => {
  it("restores Japanese content, history and attachments from a verified bundle", () => {
    const root = newRoot();
    const bundle = makeBundle(root);
    const verified = verifyRecoveryBundle(bundle.directory);
    const admissions: number[] = [];
    const destination = join(root, "restored");
    const sourceFiles = ["manifest.json", "checkpoint.json", `assets/${ASSET_ID}`].map((name) =>
      readFileSync(join(bundle.directory, name)),
    );

    const restored = restoreRecoveryBundle(verified, destination, {
      admitBytes: (bytes) => admissions.push(bytes),
    });

    ["manifest.json", "checkpoint.json", `assets/${ASSET_ID}`].forEach((name, index) => {
      expect(readFileSync(join(bundle.directory, name)).equals(sourceFiles[index])).toBe(true);
    });

    expect(admissions).toEqual([bundle.payloadBytes * 4 + BUDGET_SLACK_BYTES]);
    expect(restored.directory).toBe(destination);
    expect(restored.checkpointHash).toBe(bundle.checkpointHash);
    expect(restored.recoveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(false);

    const reopened = new Store(join(destination, "workspace.sqlite"), { readOnly: true });
    try {
      const db = reopened.db;
      const page = db.prepare("SELECT data, body FROM pages WHERE id=?").get(PAGE_ID) as {
        data: string;
        body: string;
      };
      expect(JSON.parse(page.data).doc.content[0].content[0].text).toBe("本文の内容です。");
      expect(page.body).toContain("本文の内容です。");
      const version = db.prepare("SELECT title, doc FROM versions WHERE pageId=?").get(PAGE_ID) as {
        title: string;
        doc: string;
      };
      expect(version.title).toBe("履歴タイトル");
      expect(JSON.parse(version.doc).content[0].content[0].text).toBe("履歴本文です。");
      const asset = db.prepare("SELECT metadata FROM assets WHERE id=?").get(ASSET_ID) as {
        metadata: string;
      };
      expect(JSON.parse(asset.metadata).sha256).toBe(sha256(ASSET_CONTENT));
      expect(hashCheckpoint(buildWorkspaceCheckpoint(db))).toBe(restored.checkpointHash);
    } finally {
      reopened.close();
    }

    const savedCopy = join(root, "saved-copy");
    cpSync(destination, savedCopy, { recursive: true });
    const writable = new Store(join(savedCopy, "workspace.sqlite"));
    try {
      writable.transaction(() => {
        writable.db
          .prepare("UPDATE pages SET body=? WHERE id=?")
          .run("通常保存した本文です。", PAGE_ID);
      });
    } finally {
      writable.close();
    }
    const saved = new Store(join(savedCopy, "workspace.sqlite"), { readOnly: true });
    try {
      const row = saved.db.prepare("SELECT body FROM pages WHERE id=?").get(PAGE_ID) as {
        body: string;
      };
      expect(row.body).toBe("通常保存した本文です。");
    } finally {
      saved.close();
    }
  });

  it("rejects a destination inside the source bundle before admitting bytes", () => {
    const root = newRoot();
    const bundle = makeBundle(root);
    const verified = verifyRecoveryBundle(bundle.directory);
    const admissions: number[] = [];

    expect(() =>
      restoreRecoveryBundle(verified, join(bundle.directory, "nested"), {
        admitBytes: (bytes) => admissions.push(bytes),
      }),
    ).toThrow();
    expect(admissions).toEqual([]);
    expect(existsSync(join(bundle.directory, "nested"))).toBe(false);
  });

  it("rejects an existing destination before admitting bytes", () => {
    const root = newRoot();
    const bundle = makeBundle(root);
    const verified = verifyRecoveryBundle(bundle.directory);
    const destination = join(root, "existing");
    mkdirSync(destination);
    const admissions: number[] = [];

    expect(() =>
      restoreRecoveryBundle(verified, destination, {
        admitBytes: (bytes) => admissions.push(bytes),
      }),
    ).toThrow();
    expect(admissions).toEqual([]);
  });

  it("rejects a source that changed after verification", () => {
    const root = newRoot();
    const bundle = makeBundle(root);
    const verified = verifyRecoveryBundle(bundle.directory);
    writeFileSync(join(bundle.directory, "assets", ASSET_ID), "差し替え");
    const destination = join(root, "changed");
    const admissions: number[] = [];

    expect(() =>
      restoreRecoveryBundle(verified, destination, {
        admitBytes: (bytes) => admissions.push(bytes),
      }),
    ).toThrow();
    expect(admissions).toEqual([]);
    expect(existsSync(destination)).toBe(false);
  });

  it("keeps the incomplete destination when completion fails", () => {
    const root = newRoot();
    const bundle = makeBundle(root);
    const verified = verifyRecoveryBundle(bundle.directory);
    const destination = join(root, "failed");

    expect(() =>
      restoreRecoveryBundle(verified, destination, {
        admitBytes: () => undefined,
        fault: (stage) => {
          if (stage === "before-complete") throw new Error("injected-before-complete");
        },
      }),
    ).toThrow("injected-before-complete");

    expect(existsSync(join(destination, RECOVERY_INCOMPLETE))).toBe(true);
    expect(existsSync(join(destination, "workspace.sqlite"))).toBe(true);
    expect(existsSync(join(destination, "checkpoint.json"))).toBe(true);
    expect(existsSync(join(destination, "assets", ASSET_ID))).toBe(true);
  });

  it("does not create a destination when the budget is refused", () => {
    const root = newRoot();
    const bundle = makeBundle(root);
    const verified = verifyRecoveryBundle(bundle.directory);
    const destination = join(root, "refused");

    expect(() =>
      restoreRecoveryBundle(verified, destination, {
        admitBytes: () => {
          throw new Error("simulated-enospc");
        },
      }),
    ).toThrow("simulated-enospc");
    expect(existsSync(destination)).toBe(false);
  });
});
