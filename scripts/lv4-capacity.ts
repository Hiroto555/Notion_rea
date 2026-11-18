import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/persistence/store";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { buildWorkspaceCheckpoint, validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { canonicalJson, hashCheckpoint, MAX_CHECKPOINT_BYTES } from "../src/sync/protocol";

const scenarios = [
  {name: "pages-10", pages: 10, bodyBytes: 256, edits: 0},
  {name: "pages-100", pages: 100, bodyBytes: 256, edits: 0},
  {name: "bodies-10x8k", pages: 10, bodyBytes: 8192, edits: 0},
  {name: "history-20x8k", pages: 1, bodyBytes: 8192, edits: 20},
  {name: "over-limit-130x8k", pages: 130, bodyBytes: 8192, edits: 0},
];
const fileBytes = (path: string) => {try {return statSync(path).size;} catch {return 0;}};
const rows = [];
for (const scenario of scenarios) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-capacity-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace); mkdirSync(join(workspace, "assets"));
  const store = new Store(join(workspace, "workspace.sqlite"));
  try {
    let selected = store.create(null, "page", "page 0");
    for (let i = 1; i < scenario.pages; i++) store.create(null, "page", `page ${i}`);
    for (const page of store.pages()) store.update(page.id, page.revision, {doc: {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "x".repeat(scenario.bodyBytes)}]}]}});
    selected = store.get(selected.id);
    for (let i = 0; i < scenario.edits; i++) selected = store.update(selected.id, selected.revision, {title: `edit ${i}`});
    const start = performance.now(); const checkpoint = buildWorkspaceCheckpoint(store.db); const buildMs = performance.now() - start;
    const encodeStart = performance.now(); const encoded = canonicalJson(checkpoint); const checkpointBytes = Buffer.byteLength(encoded);
    let hash: string | null = null, rejection: string | null = null;
    try { hash = hashCheckpoint(checkpoint); } catch (error) { rejection = error instanceof Error ? error.message : "unknown"; }
    const encodeHashMs = performance.now() - encodeStart;
    const validateStart = performance.now(); const valid = validateWorkspaceCheckpoint(checkpoint); const validateMs = performance.now() - validateStart;
    const backupStart = performance.now(); const backup = createFullBackup(store.db, workspace, join(root, "backup")); const backupMs = performance.now() - backupStart;
    rows.push({...scenario, versions: Number((store.db.prepare("SELECT count(*) AS count FROM versions").get() as {count: number}).count), checkpointBytes, buildMs, encodeHashMs, validateMs, valid, hashPrefix: hash?.slice(0, 8) ?? null, rejection, dbBytes: fileBytes(store.path), walBytes: fileBytes(store.path + "-wal"), backupDbBytes: fileBytes(join(backup.directory, "workspace.sqlite")), backupMs});
  } finally {store.close(); rmSync(root, {recursive: true, force: true});}
}
console.log(JSON.stringify({node: process.version, checkpointLimitBytes: MAX_CHECKPOINT_BYTES, methodology: "synthetic Store data; one run per case; no network; backup DB only", rows}, null, 2));
