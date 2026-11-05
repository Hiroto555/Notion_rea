/**
 * R5 offline lifecycle regression.
 *
 * Two separate child Node processes exercise one prepared Page operation:
 * process 1 commits it to a temporary SQLite workspace, searches and writes a
 * local recovery export; process 2 reopens that workspace, resolves the same
 * operation, verifies one Page and one receipt, then writes another local
 * export and proves the source bytes did not change. No GUI, Electron, network,
 * user workspace, or real Folio data is used.
 *
 * The child-local deny guard is not kernel network isolation. It blocks the
 * ordinary Node fetch/WebSocket/socket APIs used by this test and self-tests
 * fetch plus TCP, but it cannot stop a native addon that bypasses those shims.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import type { PageOperation } from "../src/shared/page-operation";
import type { Doc, Page } from "../src/shared/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "r5-offline-child.ts");
const EXPECTED_TITLE = "R5 offline lifecycle";
const EXPECTED_DOC: Doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "R5 offline original body" }],
    },
  ],
};

type ChildConfig = {
  mode: "create" | "resolve";
  databasePath: string;
  operationPath: string;
  exportPath: string;
  expectedTitle: string;
  expectedDoc: Doc;
  sourceExportPath?: string;
  expectedPageId?: string;
};

type GuardReport = {
  fetch: "blocked";
  tcp: "blocked";
  socket: "blocked";
};

type ChildOutput = {
  ok: true;
  phase: "create" | "resolve";
  pid: number;
  guard: GuardReport;
  operationId: string;
  fingerprint: string;
  status: "applied";
  pageId: string;
  title: string;
  doc: Doc;
  pageCount: number;
  pageCountBefore?: number;
  receiptCount: number;
  receiptCountBefore?: number;
  searchIds?: string[];
  operationHash: string;
  operationAfterHash?: string;
  sourceHash: string;
  sourceAfterHash?: string;
  sourceExportHash?: string;
  sourceExportAfterHash?: string;
  exportHash: string;
  sameAsCreateExport?: boolean;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runChild(
  root: string,
  bundlePath: string,
  config: ChildConfig,
): ChildOutput {
  const result = spawnSync(
    process.execPath,
    [bundlePath, JSON.stringify(config)],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: root,
        LANG: "C",
        LC_ALL: "C",
        NODE_NO_WARNINGS: "1",
      },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine ?? "");
  } catch {
    throw new Error(
      `child did not output JSON (status=${result.status}, signal=${result.signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (
    result.error ||
    result.status !== 0 ||
    !parsed ||
    (parsed as { ok?: unknown }).ok !== true
  )
    throw new Error(
      `child failed (status=${result.status}, signal=${result.signal}): ${JSON.stringify(parsed)}\nstderr:\n${stderr}`,
    );
  return parsed as ChildOutput;
}

it("resumes one offline Page operation without a duplicate or GUI", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-r5-offline-")));
  try {
    const bundlePath = join(root, "r5-offline-child.cjs");
    buildSync({
      stdin: {
        contents: readFileSync(FIXTURE_PATH, "utf8"),
        resolveDir: dirname(FIXTURE_PATH),
        sourcefile: FIXTURE_PATH,
        loader: "ts",
      },
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
      external: ["node:sqlite"],
    });

    const databasePath = join(root, "workspace.sqlite");
    const operationPath = join(root, "operation.json");
    const createExportPath = join(root, "create-recovery.json");
    const resolveExportPath = join(root, "resolve-recovery.json");
    const shared = {
      databasePath,
      operationPath,
      expectedTitle: EXPECTED_TITLE,
      expectedDoc: EXPECTED_DOC,
    };

    const created = runChild(root, bundlePath, {
      ...shared,
      mode: "create",
      exportPath: createExportPath,
    });
    expect(created.guard).toEqual({
      fetch: "blocked",
      tcp: "blocked",
      socket: "blocked",
    });
    expect(created).toMatchObject({
      ok: true,
      phase: "create",
      status: "applied",
      title: EXPECTED_TITLE,
      doc: EXPECTED_DOC,
      pageCount: 1,
      receiptCount: 1,
    });
    expect(created.pid).not.toBe(process.pid);
    expect(created.pageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(created.searchIds).toEqual([created.pageId]);
    expect(created.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.exportHash).toMatch(/^[a-f0-9]{64}$/);

    const operationText = readFileSync(operationPath, "utf8");
    const operation = JSON.parse(operationText) as PageOperation;
    expect(operation.operationId).toBe(created.operationId);
    expect(operation.command).toEqual({
      kind: "createPage",
      parentId: null,
      title: EXPECTED_TITLE,
      doc: EXPECTED_DOC,
    });
    expect(created.operationHash).toBe(sha256(operationText));

    const resolved = runChild(root, bundlePath, {
      ...shared,
      mode: "resolve",
      exportPath: resolveExportPath,
      sourceExportPath: createExportPath,
      expectedPageId: created.pageId,
    });
    expect(resolved.guard).toEqual({
      fetch: "blocked",
      tcp: "blocked",
      socket: "blocked",
    });
    expect(resolved).toMatchObject({
      ok: true,
      phase: "resolve",
      status: "applied",
      operationId: operation.operationId,
      fingerprint: created.fingerprint,
      pageId: created.pageId,
      title: EXPECTED_TITLE,
      doc: EXPECTED_DOC,
      pageCountBefore: 1,
      pageCount: 1,
      receiptCountBefore: 1,
      receiptCount: 1,
      sourceHash: created.sourceHash,
      sourceAfterHash: created.sourceHash,
      operationHash: created.operationHash,
      operationAfterHash: created.operationHash,
      sourceExportHash: created.exportHash,
      sourceExportAfterHash: created.exportHash,
      exportHash: created.exportHash,
      sameAsCreateExport: true,
    });
    expect(resolved.pid).not.toBe(process.pid);
    expect(resolved.pid).not.toBe(created.pid);
    expect(readFileSync(operationPath, "utf8")).toBe(operationText);

    const firstExport = JSON.parse(readFileSync(createExportPath, "utf8")) as {
      pages: Page[];
    };
    const secondExport = JSON.parse(
      readFileSync(resolveExportPath, "utf8"),
    ) as { pages: Page[] };
    for (const exported of [firstExport, secondExport]) {
      expect(exported.pages).toHaveLength(1);
      expect(exported.pages[0]).toMatchObject({
        id: created.pageId,
        title: EXPECTED_TITLE,
        doc: EXPECTED_DOC,
        kind: "page",
      });
    }
    expect(readFileSync(resolveExportPath, "utf8")).toBe(
      readFileSync(createExportPath, "utf8"),
    );

    // Independent parent-side check: the durable workspace has exactly one
    // original Page and exactly one applied receipt for this operation.
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const pages = db.prepare("SELECT id,data FROM pages").all() as {
        id: string;
        data: string;
      }[];
      const receipts = db
        .prepare("SELECT operation_id,result_json FROM save_receipts")
        .all() as { operation_id: string; result_json: string }[];
      expect(pages).toHaveLength(1);
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(pages[0].data)).toMatchObject({
        id: created.pageId,
        title: EXPECTED_TITLE,
        doc: EXPECTED_DOC,
        kind: "page",
        parentId: null,
        revision: 0,
        deletedAt: null,
      });
      expect(receipts[0].operation_id).toBe(operation.operationId);
      expect(JSON.parse(receipts[0].result_json)).toMatchObject({
        status: "applied",
        operationId: operation.operationId,
        page: {
          id: created.pageId,
          title: EXPECTED_TITLE,
          doc: EXPECTED_DOC,
        },
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
