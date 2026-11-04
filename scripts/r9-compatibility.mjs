import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect } from "@playwright/test";
const root = process.cwd(),
  baseline = resolve(process.argv[2] ?? "../Folio-r8-integration");
const output = resolve(process.argv[3] ?? "output/r9-compatibility");
const rel = relative(join(root, "output"), output);
if (!rel || rel.startsWith(".." + sep) || rel === ".." || existsSync(output))
  throw new Error("Use a new output directory in this worktree");
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
function bundle(base, label) {
  const path = join(output, label + ".cjs");
  buildSync({
    stdin: {
      contents: `export {Store} from ${JSON.stringify(join(base, "src/persistence/store.ts"))}; export {createFullBackup} from ${JSON.stringify(join(base, "src/persistence/full-backup-create.ts"))}; export {verifyFullBackup} from ${JSON.stringify(join(base, "src/persistence/full-backup-verify.ts"))}; export {restoreFullBackup} from ${JSON.stringify(join(base, "src/persistence/full-backup-restore.ts"))};`,
      resolveDir: root,
      loader: "ts",
    },
    outfile: path,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  return require(path);
}
const current = bundle(root, "w3"),
  old = bundle(baseline, "w2");
const source = join(output, "source");
mkdirSync(join(source, "assets"), { recursive: true });
const store = new current.Store(join(source, "workspace.sqlite"));
const page = store.create(null, "page", "W3 compatibility source");
const legacy = store.create(null, "page", "W2 compatible legacy");
const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const doc = {
  type: "doc",
  schemaVersion: 2,
  content: [
    {
      type: "callout",
      attrs: { tone: "warning", id: "callout-fixed" },
      content: [paragraph("旧版でも原本を保持")],
    },
    {
      type: "table",
      attrs: { id: "table-fixed" },
      content: [
        {
          type: "tableRow",
          attrs: { id: "row-fixed" },
          content: [
            {
              type: "tableCell",
              attrs: {
                id: "cell-fixed",
                colspan: 1,
                rowspan: 1,
                colwidth: null,
              },
              content: [paragraph("表も保持")],
            },
          ],
        },
      ],
    },
  ],
};
const operation = {
  operationId: "r9-compat-save",
  sessionId: "r9-compat-session",
  seq: 1,
  pageId: page.id,
  databasePageId: null,
  revision: 0,
  patch: { doc },
};
if (store.commitSave(operation).status !== "applied")
  throw new Error("Fixture save failed");
store.update(page.id, 1, { title: "W3 compatibility source updated" });
store.handle({ type: "setting", key: "activePage", value: page.id });
const backup = join(output, "backup");
current.createFullBackup(store.db, source, backup);
store.close();
const verified = old.verifyFullBackup(backup);
const destination = join(output, "old-reader-copy");
current.restoreFullBackup(backup, destination);
const oldStore = new old.Store(join(destination, "workspace.sqlite"));
const raw = oldStore.handle({ type: "pageSource", id: page.id });
if (
  !oldStore.get(page.id).documentError ||
  oldStore.get(legacy.id).documentError
)
  throw new Error("Old schema recognition boundary failed");
let refused = false;
try {
  oldStore.update(page.id, 2, { title: "must not overwrite" });
} catch {
  refused = true;
}
if (!refused || oldStore.handle({ type: "pageSource", id: page.id }) !== raw)
  throw new Error("Old writer changed unknown document");
oldStore.close();
const app = await electron.launch({
  args: [join(baseline, "dist/main.cjs")],
  cwd: baseline,
  env: { ...process.env, FOLIO_DATA_DIR: destination },
});
try {
  const window = await app.firstWindow();
  await expect(
    window.locator('.document[data-document-error="true"]'),
  ).toBeVisible();
  await expect(window.locator(".folio-editor")).toHaveCount(0);
  const source = await window.evaluate(
    (id) => window.folio.request({ type: "pageSource", id }),
    page.id,
  );
  if (source !== raw) throw new Error("Old app changed raw document");
  await window.screenshot({ path: join(output, "W2-read-only.png") });
} finally {
  await app.close();
}
const db = new DatabaseSync(join(destination, "workspace.sqlite"), {
  readOnly: true,
});
try {
  const row = db.prepare("SELECT data FROM pages WHERE id=?").get(page.id);
  if (row.data !== raw)
    throw new Error("Raw document changed after old app restart");
} finally {
  db.close();
}
const result = {
  oldVerifierAcceptsRawBackup: true,
  oldStoreRejectsRichDocument: true,
  oldStorePreservesRawBytes: true,
  oldAppReadOnly: true,
  legacyDocumentReadable: true,
  backupFingerprint: verified.fingerprint,
  baseline,
  source,
  backup,
  destination,
};
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
