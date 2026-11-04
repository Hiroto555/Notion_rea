#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const prefix = `--${name}=`;
  const found = args.find((argument) => argument.startsWith(prefix));
  return found ? resolve(found.slice(prefix.length)) : fallback;
};
const data = option("data", join(root, "output/r7-demo/data"));
const manifestPath = option("manifest", join(root, "output/r7-demo/manifest.json"));

const fail = (message) => {
  throw new Error("R7 workspace verification failed: " + message);
};
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
};
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
const docText = (node) => {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  return Array.isArray(node.content) ? node.content.map(docText).join(" ") : "";
};
const marks = (node, collected = []) => {
  if (!node || typeof node !== "object") return collected;
  if (Array.isArray(node.marks)) collected.push(...node.marks);
  if (Array.isArray(node.content))
    for (const child of node.content) marks(child, collected);
  return collected;
};
const images = (node, collected = []) => {
  if (!node || typeof node !== "object") return collected;
  if (node.type === "image") collected.push(node);
  if (Array.isArray(node.content))
    for (const child of node.content) images(child, collected);
  return collected;
};
const pageData = (db, id) => {
  const row = db.prepare("SELECT data FROM pages WHERE id=?").get(id);
  if (!row) fail(`page ${id} is missing`);
  return JSON.parse(row.data);
};

if (!existsSync(manifestPath)) fail(`manifest is missing at ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
equal(manifest.format, "folio-r7-demo-manifest-v1", "manifest format");
equal(manifest.seedVersion, 1, "manifest seed version");
equal(manifest.marker, "Folio R7 synthetic demo", "manifest marker");
const marker = join(dirname(data), "SYNTHETIC-R7-DEMO");
if (
  !existsSync(marker) ||
  readFileSync(marker, "utf8") !== "Folio R7 synthetic demo\n"
)
  fail("synthetic marker is missing or does not match");
if (!existsSync(join(data, manifest.databaseFile)))
  fail(`database is missing at ${join(data, manifest.databaseFile)}`);

const db = new DatabaseSync(join(data, manifest.databaseFile), {
  readOnly: true,
});
try {
  equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok", "integrity");
  equal(db.prepare("PRAGMA user_version").get()?.user_version, 4, "user_version");
  for (const table of [
    "record_databases",
    "record_memberships",
    "record_value_versions",
    "folio_record_schema",
    "save_receipts",
    "assets",
  ])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      fail(`table ${table} is missing`);

  const owner = pageData(db, manifest.database.id);
  equal(owner.kind, "database", "owner kind");
  equal(owner.title, manifest.database.title, "owner title");
  equal(owner.database.rows.length, 0, "owner legacy rows");
  equal(owner.database.views.length, 4, "view count");
  equal(
    owner.database.properties.map((property) => property.type).sort(),
    ["checkbox", "date", "number", "select", "text"],
    "property types",
  );
  equal(owner.database.properties, manifest.database.properties, "properties");
  equal(
    owner.database.views.map(({ id, name, type }) => ({ id, name, type })),
    manifest.database.views,
    "views",
  );
  equal(owner.database.activeViewId, manifest.database.activeViewId, "active view");
  const nestedFilter = owner.database.views
    .flatMap((view) => view.filter.conditions)
    .find((node) => node.kind === "group");
  if (!nestedFilter || nestedFilter.conditions.length !== 2)
    fail("table view must retain a nested filter group");
  const sortedView = owner.database.views.find(
    (view) => view.sorts.length > 1,
  );
  if (!sortedView) fail("at least one view must retain multiple sorts");

  if (
    !db
      .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
      .get(owner.id)
  )
    fail("owner is not registered as a record database");
  equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM record_memberships WHERE database_page_id=?")
      .get(owner.id).count,
    manifest.records.length,
    "record count",
  );

  for (const record of manifest.records) {
    const member = db
      .prepare("SELECT values_json FROM record_memberships WHERE page_id=? AND database_page_id=?")
      .get(record.pageId, owner.id);
    if (!member) fail(`record ${record.pageId} is missing from its owner`);
    equal(
      canonical(JSON.parse(member.values_json)),
      canonical(record.values),
      `record ${record.title} values`,
    );
    const page = pageData(db, record.pageId);
    equal(page.title, record.title, `record ${record.title} title`);
    if (!docText(page.doc).includes(record.body))
      fail(`record ${record.title} body is not the expected Japanese body`);
  }

  const byRole = Object.fromEntries(
    manifest.pages.map((page) => [page.role, page]),
  );
  const home = pageData(db, byRole.home.id);
  const nested = pageData(db, byRole.nested.id);
  const regular = pageData(db, byRole.regular.id);
  equal(nested.parentId, home.id, "nested parent");
  equal(regular.parentId, null, "regular parent");
  const homeLinks = marks(home.doc)
    .filter((mark) => mark.type === "link")
    .map((mark) => mark.attrs?.href);
  for (const target of byRole.home.internalLinkTargets)
    if (!homeLinks.includes("folio-page://" + target))
      fail(`home is missing internal link to ${target}`);
  const allLinks = [home, nested, regular]
    .flatMap((page) => marks(page.doc))
    .filter(
      (mark) =>
        mark.type === "link" &&
        typeof mark.attrs?.href === "string" &&
        mark.attrs.href.startsWith("folio-page://"),
    );
  equal(allLinks.length, manifest.checks.internalLinks, "internal link count");
  const nestedImages = images(nested.doc);
  equal(nestedImages.length, 1, "nested image count");
  equal(nestedImages[0].attrs.src, manifest.asset.url, "nested image source");
  const regularImages = images(regular.doc);
  equal(regularImages.length, 1, "regular image count");
  equal(regularImages[0].attrs.src, manifest.asset.url, "regular image source");

  const assetRow = db.prepare("SELECT metadata FROM assets WHERE id=?").get(manifest.asset.id);
  if (!assetRow) fail("asset registry entry is missing");
  const metadata = JSON.parse(assetRow.metadata);
  equal(metadata.sha256, manifest.asset.sha256, "asset sha256");
  equal(metadata.size, manifest.asset.size, "asset size");
  const assetPath = join(data, manifest.asset.storagePath);
  if (!existsSync(assetPath)) fail("asset file is missing");
  equal(statSync(assetPath).size, manifest.asset.size, "asset file size");
  equal(
    createHash("sha256").update(readFileSync(assetPath)).digest("hex"),
    manifest.asset.sha256,
    "asset file sha256",
  );

  equal(
    db.prepare("SELECT value FROM settings WHERE key='activePage'").get()?.value,
    home.id,
    "activePage setting",
  );

  for (const operation of manifest.operations) {
    const receipt = db
      .prepare("SELECT result_json FROM save_receipts WHERE operation_id=?")
      .get(operation.operationId);
    if (!receipt) fail(`receipt for ${operation.operationId} is missing`);
    equal(JSON.parse(receipt.result_json).status, "applied", `receipt ${operation.operationId}`);
  }
} finally {
  db.close();
}

console.log(
  `R7 synthetic workspace OK: ${data} (${manifest.checks.views} views, ` +
    `${manifest.checks.properties} properties, ${manifest.checks.records} records, ` +
    `${manifest.checks.internalLinks} internal links, ${manifest.checks.assets} asset)`,
);
