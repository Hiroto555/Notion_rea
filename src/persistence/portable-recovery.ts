import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { parseAssetURL } from "../shared/assets";
import { fileFits } from "../shared/limits";
import {
  databaseDataSchema,
  isDocument,
  requestSchema,
  type Doc,
  type FilterValue,
  type Page,
  type PagePatch,
  type DatabaseSettings,
} from "../shared/types";
import { isLosslessDatabaseData } from "../database/strict-database";
import { Store } from "./store";
import { RecordRepository } from "./record-repository";
import { markRecordStoreVersion } from "./record-version";

const idSchema = z.string().min(1).max(500);
const valuesSchema = z.custom<Record<string, FilterValue>>((value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1000 &&
    entries.every(
      ([key, cell]) =>
        key.length > 0 &&
        key.length <= 500 &&
        key !== "__proto__" &&
        (typeof cell === "string" ||
          typeof cell === "boolean" ||
          (typeof cell === "number" && Number.isFinite(cell))),
    )
  );
});
const pageSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    kind: z.enum(["page", "database"]),
    title: z.string().max(500),
    icon: z.string().max(16),
    cover: z.string().max(500),
    favorite: z.boolean(),
    doc: z.custom<Doc>(isDocument),
    database: databaseDataSchema.nullable(),
  })
  .strict();
const recoveredFromSchema = z
  .object({
    pageId: idSchema,
    recoveredAt: z.number().finite().nonnegative(),
  })
  .strict();
const pageSchemaV4 = pageSchema
  .extend({
    position: z.number().finite(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    recoveredFrom: recoveredFromSchema.optional(),
  })
  .strict();
const recordSchema = z
  .object({
    pageId: idSchema,
    databasePageId: idSchema,
    position: z.number().int().safe(),
    values: valuesSchema,
  })
  .strict();
const assetSchema = z
  .object({
    id: idSchema,
    name: z.string().max(1000),
    extension: z.string().max(500),
    mime: z.string().max(500),
    size: z.number().int().min(0).max(20_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    base64: z.string(),
  })
  .strict();
const assetMetadataSchema = assetSchema
  .omit({ base64: true })
  .extend({
    storageName: idSchema,
  })
  .strict();
const bundleBase = {
  format: z.literal("folio-recovery"),
  pages: z.array(pageSchema).min(1).max(10000),
  assets: z.array(assetSchema).max(10000),
};
const bundleSchema = z.discriminatedUnion("schemaVersion", [
  z
    .object({
      ...bundleBase,
      schemaVersion: z.literal(3),
      records: z.array(recordSchema).min(1).max(10000),
    })
    .strict(),
  z
    .object({
      ...bundleBase,
      schemaVersion: z.literal(4),
      pages: z.array(pageSchemaV4).min(1).max(10000),
      records: z.array(recordSchema).max(10000),
      databaseMembers: z
        .array(
          z
            .object({
              databasePageId: idSchema,
              pageIds: z.array(idSchema).max(10000),
            })
            .strict(),
        )
        .max(10000),
    })
    .strict(),
]);
type Bundle = z.infer<typeof bundleSchema>;
type PortablePage = Bundle["pages"][number];
type PortableAsset = Bundle["assets"][number];
export type LocalRecordDraft = {
  page: Page;
  baseValues: Record<string, FilterValue>;
  /** Required by mixed v4; omitted by existing v3 callers. */
  baseRevision?: number;
  valuesPatch?: Record<string, FilterValue | null>;
};
export type LocalDatabaseSettingsDraft = {
  databasePageId: string;
  baseRevision: number;
  settings: DatabaseSettings;
};
export type LocalNormalPageDraft = { page: Page; baseRevision: number };
export type LocalOwnerPatch = { baseRevision: number; patch: PagePatch };
export type MixedRecoveryDrafts = {
  normalPages: LocalNormalPageDraft[];
  records: (LocalRecordDraft & { baseRevision: number })[];
  databaseSettings: LocalDatabaseSettingsDraft[];
  ownerPatches?: Record<string, LocalOwnerPatch>;
};
type PortableGeneration = Omit<
  MixedRecoveryDrafts,
  "records" | "ownerPatches"
> & {
  records: LocalRecordDraft[];
  ownerPatches?: Record<string, PagePatch | LocalOwnerPatch>;
};

const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const invalid = () =>
  new Error(
    "未対応または不完全な退避データです。原本と未保存変更を保持しています。",
  );
function assetId(value: string): string | null {
  if (!isInternalScheme(value, "folio-asset:")) return null;
  // Browser URL parsing normalizes case, leading whitespace and embedded
  // control characters. Do not let those alternate spellings bypass closure
  // checks or survive without being rewritten in the restored workspace.
  if (!value.startsWith("folio-asset://")) throw invalid();
  const id = parseAssetURL(value);
  if (!id || ![`folio-asset://${id}`, `folio-asset://${id}/`].includes(value))
    throw invalid();
  return id;
}
function pageTarget(value: string): string | null {
  if (!isInternalScheme(value, "folio-page:")) return null;
  if (!value.startsWith("folio-page://")) throw invalid();
  const id = value.slice("folio-page://".length);
  if (!id || value !== `folio-page://${new URL(value).hostname}`)
    throw invalid();
  return id;
}
function isInternalScheme(value: string, scheme: string): boolean {
  try {
    return new URL(value, "https://folio.invalid/").protocol === scheme;
  } catch {
    // A malformed URL that purports to use an internal scheme is unsafe.
    if (value.trimStart().toLowerCase().startsWith(scheme)) throw invalid();
    return false;
  }
}
/** Iterate every known document asset/page reference without interpreting prose. */
function references(
  page: PortablePage,
  asset: (id: string) => void,
  link: (id: string) => void,
): void {
  const coverId = assetId(page.cover);
  if (coverId) asset(coverId);
  const stack = [page.doc];
  while (stack.length) {
    const node = stack.pop()!;
    const src =
      typeof node.attrs?.src === "string" ? assetId(node.attrs.src) : null;
    if (src) asset(src);
    for (const mark of node.marks ?? []) {
      if (mark.type !== "link" || typeof mark.attrs?.href !== "string")
        continue;
      const href = mark.attrs.href,
        image = assetId(href),
        target = pageTarget(href);
      if (image) asset(image);
      if (target) link(target);
    }
    stack.push(...(node.content ?? []));
  }
}
function portablePage(page: Page, formatVersion: 3 | 4): PortablePage {
  if (
    page.documentError ||
    page.deletedAt !== null ||
    (page.schemaVersion !== undefined && page.schemaVersion !== 1)
  )
    throw invalid();
  const { id, parentId, kind, title, icon, cover, favorite, doc, database } =
    page;
  const portable = {
    id,
    parentId,
    kind,
    title,
    icon,
    cover,
    favorite,
    doc,
    database,
  };
  if (formatVersion === 3) return pageSchema.parse(portable);
  return pageSchemaV4.parse({
    ...portable,
    position: page.position,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    ...(page.recoveredFrom === undefined
      ? {}
      : { recoveredFrom: page.recoveredFrom }),
  });
}
const pageFields = new Set([
  "id",
  "schemaVersion",
  "parentId",
  "kind",
  "title",
  "icon",
  "cover",
  "favorite",
  "doc",
  "database",
  "position",
  "createdAt",
  "updatedAt",
  "revision",
  "deletedAt",
  "documentError",
  "recoveredFrom",
]);
function sameProvenance(a: unknown, b: unknown): boolean {
  const left = recoveredFromSchema.optional().safeParse(a);
  const right = recoveredFromSchema.optional().safeParse(b);
  if (!left.success || !right.success) return false;
  if (!left.data || !right.data) return left.data === right.data;
  return (
    left.data.pageId === right.data.pageId &&
    left.data.recoveredAt === right.data.recoveredAt
  );
}
function sameValues(
  base: unknown,
  actual: Readonly<Record<string, FilterValue>>,
): boolean {
  if (!valuesSchema.safeParse(base).success) return false;
  const input = base as Record<string, FilterValue>;
  const keys = Object.keys(input),
    actualKeys = Object.keys(actual);
  return (
    keys.length === actualKeys.length &&
    keys.every(
      (key) => Object.hasOwn(actual, key) && Object.is(input[key], actual[key]),
    )
  );
}
function normalizeValues(
  base: Record<string, FilterValue>,
  patch: Record<string, FilterValue | null> = {},
): Record<string, FilterValue> {
  valuesSchema.parse(base);
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(patch))
  )
    throw invalid();
  const values = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (!key || key.length > 500 || key === "__proto__") throw invalid();
    if (value === null) values.delete(key);
    else values.set(key, value);
  }
  const result = Object.fromEntries(values);
  valuesSchema.parse(result);
  return result;
}

/** Captures already-merged local pages and value patches, never reloading over a stale local draft.
 * No files are written and no pending edits are acknowledged by this function. */
export function exportPortableRecordRecovery(
  store: Store,
  assetsPath: string,
  drafts: LocalRecordDraft[],
  ownerPatches: Record<string, PagePatch> = {},
): string {
  return exportPortableGeneration(
    store,
    assetsPath,
    {
      normalPages: [],
      records: drafts,
      databaseSettings: [],
      ownerPatches,
    },
    3,
  );
}

/** Experimental format 4 (not SQLite user_version): one caller-frozen generation.
 * Caller must prevent concurrent database and asset writes during the capture;
 * this experimental API cannot enforce exclusive workspace ownership. */
export function exportMixedPortableRecovery(
  store: Store,
  assetsPath: string,
  generation: MixedRecoveryDrafts,
): string {
  if (
    !generation ||
    Object.keys(generation).some(
      (key) =>
        ![
          "normalPages",
          "records",
          "databaseSettings",
          "ownerPatches",
        ].includes(key),
    )
  )
    throw invalid();
  const capture = () =>
    exportPortableGeneration(store, assetsPath, generation, 4);
  // Keep membership, pages and metadata on one SQLite snapshot. The caller
  // must still exclude workspace/asset writes and freeze pending edits; this
  // read transaction is not a workspace-wide lock.
  if (store.db.isTransaction)
    throw new Error("未確定 transaction 内では復旧データを出力できません。");
  store.db.exec("BEGIN");
  try {
    const content = capture();
    store.db.exec("COMMIT");
    return content;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function exportPortableGeneration(
  store: Store,
  assetsPath: string,
  generation: PortableGeneration,
  formatVersion: 3 | 4,
): string {
  const {
    normalPages,
    records: drafts,
    databaseSettings,
    ownerPatches = {},
  } = generation;
  if (
    !Array.isArray(normalPages) ||
    !Array.isArray(drafts) ||
    !Array.isArray(databaseSettings) ||
    !ownerPatches ||
    typeof ownerPatches !== "object" ||
    Array.isArray(ownerPatches) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(ownerPatches)) ||
    normalPages.length +
      drafts.length +
      databaseSettings.length +
      Object.keys(ownerPatches).length ===
      0 ||
    (formatVersion === 3 && !drafts.length) ||
    normalPages.length + drafts.length + databaseSettings.length > 10000
  )
    throw invalid();
  const pages = new Map<string, PortablePage>(),
    records: Bundle["records"] = [],
    assetIds = new Set<string>();
  const recordIds = new Set(drafts.map((d) => d.page.id));
  if (recordIds.size !== drafts.length) throw invalid();
  const dbIds = new Set<string>();
  const repo = new RecordRepository(store);
  const assertRawDatabaseSafe = (id: string) => {
    const row = store.db
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw invalid();
    let raw: unknown;
    try {
      raw = JSON.parse(row.data);
    } catch {
      throw invalid();
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    if (
      formatVersion === 4 &&
      Object.keys(raw).some((key) => !pageFields.has(key))
    )
      throw invalid();
    if (
      formatVersion === 4 &&
      !recoveredFromSchema
        .optional()
        .safeParse((raw as Record<string, unknown>).recoveredFrom).success
    )
      throw invalid();
    if (formatVersion === 4) {
      const source = raw as Record<string, unknown>;
      const timestamp = z.number().finite().nonnegative();
      if (
        !timestamp.safeParse(source.createdAt).success ||
        !timestamp.safeParse(source.updatedAt).success
      )
        throw invalid();
    }
    const database = (raw as Record<string, unknown>).database;
    if (database !== null && !isLosslessDatabaseData(database)) throw invalid();
  };
  const hasTable = !!store.db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
    )
    .get();
  const supplied = new Set<string>();
  for (const draft of normalPages) {
    if (
      !draft ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(draft)) ||
      !Object.hasOwn(draft, "page") ||
      !Object.hasOwn(draft, "baseRevision") ||
      Object.keys(draft).some(
        (key) => !["page", "baseRevision"].includes(key),
      ) ||
      !Number.isSafeInteger(draft.baseRevision) ||
      draft.baseRevision < 0 ||
      !draft.page
    )
      throw invalid();
    const page = draft.page;
    if (
      supplied.has(page.id) ||
      Object.keys(page).some((key) => !pageFields.has(key))
    )
      throw invalid();
    supplied.add(page.id);
    assertRawDatabaseSafe(page.id);
    const canonical = store.get(page.id);
    const member =
      hasTable &&
      store.db
        .prepare("SELECT 1 FROM record_memberships WHERE page_id=?")
        .get(page.id);
    if (
      canonical.id !== page.id ||
      canonical.kind !== "page" ||
      canonical.database !== null ||
      canonical.documentError ||
      canonical.deletedAt !== null ||
      member ||
      page.kind !== "page" ||
      page.database !== null ||
      page.position !== canonical.position ||
      page.parentId !== canonical.parentId ||
      page.createdAt !== canonical.createdAt ||
      page.updatedAt !== canonical.updatedAt ||
      !sameProvenance(page.recoveredFrom, canonical.recoveredFrom) ||
      page.revision !== draft.baseRevision ||
      canonical.revision !== draft.baseRevision
    )
      throw invalid();
    pages.set(page.id, portablePage(page, formatVersion));
  }
  const settingsById = new Map<string, LocalDatabaseSettingsDraft>();
  for (const draft of databaseSettings) {
    if (
      !draft ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(draft)) ||
      !["databasePageId", "baseRevision", "settings"].every((key) =>
        Object.hasOwn(draft, key),
      ) ||
      Object.keys(draft).some(
        (key) => !["databasePageId", "baseRevision", "settings"].includes(key),
      ) ||
      !Number.isSafeInteger(draft.baseRevision) ||
      draft.baseRevision < 0 ||
      !draft.databasePageId ||
      settingsById.has(draft.databasePageId) ||
      supplied.has(draft.databasePageId)
    )
      throw invalid();
    const parsed = requestSchema.parse({
      type: "database:settings",
      databasePageId: draft.databasePageId,
      revision: 0,
      settings: draft.settings,
    });
    if (parsed.type !== "database:settings") throw invalid();
    settingsById.set(draft.databasePageId, {
      ...draft,
      settings: parsed.settings,
    });
    supplied.add(draft.databasePageId);
  }
  const addOwner = (id: string) => {
    if (dbIds.has(id)) return;
    assertRawDatabaseSafe(id);
    const db = store.get(id);
    if (
      db.id !== id ||
      db.kind !== "database" ||
      !db.database ||
      db.documentError ||
      db.deletedAt !== null ||
      db.database.rows.length ||
      !hasTable ||
      (formatVersion === 4 &&
        !store.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(id))
    )
      throw invalid();
    const settingsDraft = settingsById.get(id);
    if (settingsDraft && settingsDraft.baseRevision !== db.revision)
      throw invalid();
    const hasOwnerPatch = Object.hasOwn(ownerPatches, id);
    const suppliedOwner = hasOwnerPatch ? ownerPatches[id] : undefined;
    if (formatVersion === 4 && hasOwnerPatch && suppliedOwner === undefined)
      throw invalid();
    let patch: PagePatch = {};
    if (formatVersion === 4 && suppliedOwner !== undefined) {
      const draft = suppliedOwner as LocalOwnerPatch;
      if (
        !draft ||
        typeof draft !== "object" ||
        Array.isArray(draft) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(draft)) ||
        !Object.hasOwn(draft, "baseRevision") ||
        !Object.hasOwn(draft, "patch") ||
        Object.keys(draft).some(
          (key) => !["baseRevision", "patch"].includes(key),
        ) ||
        !Number.isSafeInteger(draft.baseRevision) ||
        draft.baseRevision < 0 ||
        draft.baseRevision !== db.revision ||
        !draft.patch
      )
        throw invalid();
      patch = draft.patch;
    } else if (suppliedOwner != null) patch = suppliedOwner as PagePatch;
    const parsed = requestSchema.parse({
      type: "update",
      id,
      revision: db.revision,
      patch,
    });
    if (parsed.type !== "update" || parsed.patch.database !== undefined)
      throw invalid();
    const settings = settingsDraft?.settings;
    const owner = portablePage(
      {
        ...db,
        ...parsed.patch,
        database: settings ? { ...settings, rows: [] } : db.database,
      },
      formatVersion,
    );
    pages.set(id, owner);
    dbIds.add(id);
  };
  for (const id of settingsById.keys()) addOwner(id);
  if (formatVersion === 4)
    for (const id of Object.keys(ownerPatches)) addOwner(id);
  for (const draft of drafts) {
    if (formatVersion === 4 && draft && !Object.hasOwn(draft, "baseRevision"))
      throw new Error(
        "レコードの観測 revision がありません。未保存変更を保持しています。",
      );
    if (
      !draft ||
      (formatVersion === 4 &&
        (![Object.prototype, null].includes(Object.getPrototypeOf(draft)) ||
          !["page", "baseValues", "baseRevision"].every((key) =>
            Object.hasOwn(draft, key),
          ) ||
          Object.keys(draft).some(
            (key) =>
              !["page", "baseValues", "valuesPatch", "baseRevision"].includes(
                key,
              ),
          ))) ||
      !draft.page ||
      supplied.has(draft.page.id) ||
      (formatVersion === 4 &&
        Object.keys(draft.page).some((key) => !pageFields.has(key)))
    )
      throw invalid();
    supplied.add(draft.page.id);
    assertRawDatabaseSafe(draft.page.id);
    const page = portablePage(draft.page, formatVersion),
      canonical = store.get(page.id),
      projection = repo.projection(page.id);
    if (
      formatVersion === 4 &&
      (!Number.isSafeInteger(draft.baseRevision) ||
        draft.baseRevision !== projection.revision ||
        draft.page.revision !== draft.baseRevision ||
        !sameValues(draft.baseValues, projection.values))
    )
      throw new Error(
        "レコードの観測値または revision が一致しません。未保存変更を保持しています。",
      );
    if (
      canonical.id !== page.id ||
      canonical.kind !== "page" ||
      page.kind !== "page" ||
      page.database !== null ||
      canonical.documentError ||
      canonical.deletedAt !== null ||
      (formatVersion === 4 && draft.page.position !== canonical.position) ||
      (formatVersion === 4 && draft.page.parentId !== canonical.parentId) ||
      (formatVersion === 4 &&
        (draft.page.createdAt !== canonical.createdAt ||
          draft.page.updatedAt !== canonical.updatedAt)) ||
      (formatVersion === 4 &&
        !sameProvenance(draft.page.recoveredFrom, canonical.recoveredFrom)) ||
      projection.deletedAt !== null
    )
      throw invalid();
    const db = store.get(projection.databasePageId);
    assertRawDatabaseSafe(db.id);
    if (
      db.kind !== "database" ||
      !db.database ||
      db.documentError ||
      db.deletedAt !== null
    )
      throw invalid();
    addOwner(db.id);
    pages.set(page.id, page);
    const row = store.db
      .prepare(
        "SELECT position FROM record_memberships WHERE page_id=? AND database_page_id=?",
      )
      .get(page.id, db.id) as { position: number } | undefined;
    if (!row) throw invalid();
    records.push({
      pageId: page.id,
      databasePageId: db.id,
      position: row.position,
      values: normalizeValues(draft.baseValues, draft.valuesPatch),
    });
  }
  for (const ownerId of Object.keys(ownerPatches))
    if (!dbIds.has(ownerId)) throw invalid();
  const databaseMembers: { databasePageId: string; pageIds: string[] }[] = [];
  if (formatVersion === 4) {
    // A restored owner must never look complete when one of its records was
    // omitted. This includes trashed members: the current format cannot encode
    // their trash state, so the caller must retain the draft and fail closed.
    const capturedByOwner = new Map<string, Set<string>>();
    for (const row of records) {
      const captured =
        capturedByOwner.get(row.databasePageId) ?? new Set<string>();
      captured.add(row.pageId);
      capturedByOwner.set(row.databasePageId, captured);
    }
    for (const ownerId of dbIds) {
      const members = store.db
        .prepare(
          "SELECT page_id FROM record_memberships WHERE database_page_id=?",
        )
        .all(ownerId) as { page_id: string }[];
      const captured = capturedByOwner.get(ownerId) ?? new Set<string>();
      if (
        captured.size !== members.length ||
        members.some((row) => !captured.has(row.page_id))
      )
        throw new Error(
          "データベースの全レコードを安全に退避できません。原本と未保存変更を保持しています。",
        );
      databaseMembers.push({
        databasePageId: ownerId,
        pageIds: members.map((row) => row.page_id).sort(),
      });
    }
  }
  // Follow normal page links and parents so copied links never resolve to a
  // coincidentally matching unrelated ID in the destination workspace.
  const seen = new Set<string>();
  while (seen.size < pages.size) {
    const page = [...pages.values()].find((p) => !seen.has(p.id))!;
    seen.add(page.id);
    const includePage = (id: string) => {
      if (pages.has(id)) return;
      if (recordIds.has(id)) throw invalid();
      const p = store.get(id);
      assertRawDatabaseSafe(id);
      const belongs =
        hasTable &&
        store.db
          .prepare("SELECT 1 FROM record_memberships WHERE page_id=?")
          .get(id);
      if (p.id !== id || p.kind !== "page" || p.database !== null || belongs)
        throw new Error(
          "外部データベースや未選択レコードへの参照は安全に復旧できません。",
        );
      pages.set(id, portablePage(p, formatVersion));
    };
    if (page.parentId) includePage(page.parentId);
    references(page, (id) => assetIds.add(id), includePage);
  }
  const assets: PortableAsset[] = [];
  for (const id of assetIds) {
    const row = store.db
      .prepare("SELECT metadata FROM assets WHERE id=?")
      .get(id) as { metadata: string } | undefined;
    if (!row)
      throw new Error("参照する添付の情報がありません。原本は保持しています。");
    let meta: any;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      throw invalid();
    }
    if (
      !meta ||
      meta.id !== id ||
      meta.storageName !== id ||
      (formatVersion === 4 && !assetMetadataSchema.safeParse(meta).success)
    )
      throw invalid();
    const path = join(assetsPath, id),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20_000_000)
      throw invalid();
    const data = readFileSync(path);
    if (meta.size !== data.length || meta.sha256 !== digest(data))
      throw invalid();
    assets.push(
      assetSchema.parse({
        id,
        name: meta.name,
        extension: meta.extension,
        mime: meta.mime,
        size: data.length,
        sha256: meta.sha256,
        base64: data.toString("base64"),
      }),
    );
  }
  const content = JSON.stringify({
    format: "folio-recovery",
    schemaVersion: formatVersion,
    pages: [...pages.values()],
    records,
    assets,
    ...(formatVersion === 4 ? { databaseMembers } : {}),
  });
  parsePortableRecordRecovery(content);
  return content;
}

/** Strictly validate a portable file, including referenced bytes and target closure. */
export function parsePortableRecordRecovery(content: string): Bundle {
  if (!fileFits(content))
    throw new Error("退避ファイルの上限はUTF-8で30,000,000 bytesです");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw invalid();
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as any).pages) ||
    (raw as any).pages.some(
      (p: any) => p?.database !== null && !isLosslessDatabaseData(p?.database),
    )
  )
    throw invalid();
  const bundle = bundleSchema.parse(raw),
    pages = new Map(bundle.pages.map((p) => [p.id, p])),
    records = new Set<string>(),
    assets = new Map<string, Buffer>();
  if (pages.size !== bundle.pages.length) throw invalid();
  const owners = new Set(bundle.records.map((row) => row.databasePageId));
  for (const page of bundle.pages)
    if (
      page.kind === "database" &&
      (!page.database ||
        page.database.rows.length ||
        (bundle.schemaVersion === 3 && !owners.has(page.id)))
    )
      throw invalid();
  for (const row of bundle.records) {
    const page = pages.get(row.pageId),
      owner = pages.get(row.databasePageId);
    if (
      records.has(row.pageId) ||
      !page ||
      page.kind !== "page" ||
      page.database !== null ||
      !owner ||
      owner.kind !== "database" ||
      !owner.database ||
      owner.database.rows.length
    )
      throw invalid();
    records.add(row.pageId);
  }
  if (bundle.schemaVersion === 4) {
    const manifests = new Map<string, Set<string>>();
    for (const entry of bundle.databaseMembers) {
      const owner = pages.get(entry.databasePageId),
        members = new Set(entry.pageIds);
      if (
        !owner ||
        owner.kind !== "database" ||
        manifests.has(entry.databasePageId) ||
        members.size !== entry.pageIds.length
      )
        throw invalid();
      manifests.set(entry.databasePageId, members);
    }
    for (const page of bundle.pages)
      if (page.kind === "database" && !manifests.has(page.id)) throw invalid();
    const actual = new Map<string, Set<string>>();
    for (const row of bundle.records) {
      const members = actual.get(row.databasePageId) ?? new Set<string>();
      members.add(row.pageId);
      actual.set(row.databasePageId, members);
    }
    for (const [id, members] of manifests) {
      const included = actual.get(id) ?? new Set<string>();
      if (
        members.size !== included.size ||
        [...members].some((member) => !included.has(member))
      )
        throw invalid();
    }
  }
  for (const asset of bundle.assets) {
    if (
      parseAssetURL(`folio-asset://${asset.id}`) !== asset.id ||
      assets.has(asset.id)
    )
      throw invalid();
    const bytes = Buffer.from(asset.base64, "base64");
    if (
      bytes.length !== asset.size ||
      bytes.toString("base64") !== asset.base64 ||
      digest(bytes) !== asset.sha256
    )
      throw invalid();
    assets.set(asset.id, bytes);
  }
  for (const p of bundle.pages) {
    if (
      (p.kind === "database") !== (p.database !== null) ||
      (p.parentId !== null && !pages.has(p.parentId))
    )
      throw invalid();
    references(
      p,
      (id) => {
        if (!assets.has(id)) throw invalid();
      },
      (id) => {
        if (!pages.has(id)) throw invalid();
      },
    );
  }
  // Reject parent cycles before writing any output.
  for (const p of bundle.pages) {
    const seen = new Set<string>();
    let current: PortablePage | undefined = p;
    while (current) {
      if (seen.has(current.id)) throw invalid();
      seen.add(current.id);
      current = current.parentId ? pages.get(current.parentId) : undefined;
    }
  }
  return bundle;
}

/**
 * Restore into a NEW dedicated workspace only. Incomplete workspaces are left
 * marked rather than deleting files without an ownership proof. This API is
 * not connected to normal App recovery: a complete cross-filesystem
 * crash-recovery journal and production integration are not enabled.
 */
export function restorePortableRecordRecoveryToNewWorkspace(
  content: string,
  destination: string,
  onPhase?: (phase: "assets" | "database" | "before-complete") => void,
): {
  path: string;
  pageIds: Record<string, string>;
  assetIds: Record<string, string>;
} {
  const bundle = parsePortableRecordRecovery(content);
  if (!isAbsolute(destination) || existsSync(destination))
    throw new Error("復旧先には存在しない絶対パスを指定してください。");
  mkdirSync(destination, { mode: 0o700 });
  const incomplete = join(destination, "FOLIO-RECOVERY-INCOMPLETE");
  writeFileSync(
    incomplete,
    "Recovery incomplete; do not open this workspace.\n",
    { flag: "wx", mode: 0o600 },
  );
  syncPath(incomplete);
  syncPath(destination);
  const assetsDir = join(destination, "assets");
  mkdirSync(assetsDir, { mode: 0o700 });
  const assetIds = new Map<string, string>(),
    pageIds = new Map<string, string>();
  let store: Store | undefined;
  try {
    for (const asset of bundle.assets) {
      const bytes = Buffer.from(asset.base64, "base64"),
        id = randomUUID();
      const path = join(assetsDir, id);
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      syncPath(path);
      assetIds.set(asset.id, id);
    }
    syncPath(assetsDir);
    onPhase?.("assets");
    store = new Store(join(destination, "workspace.sqlite"), {
      allowIncompleteRecovery: true,
    });
    store.transaction(() => {
      const reserved = new Set<string>();
      for (const page of bundle.pages)
        pageIds.set(page.id, store!.allocatePageId(randomUUID, reserved));
      const repo = new RecordRepository(store!);
      repo.createSchema();
      for (const asset of bundle.assets) {
        const id = assetIds.get(asset.id)!;
        const metadata = {
          id,
          name: asset.name,
          extension: asset.extension,
          mime: asset.mime,
          storageName: id,
          size: asset.size,
          sha256: asset.sha256,
        };
        store!.db
          .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
          .run(id, JSON.stringify(metadata));
      }
      for (const original of bundle.pages) {
        const page = rewritePortablePage(original, pageIds, assetIds);
        const now = Date.now();
        store!.write(
          {
            ...page,
            schemaVersion: 1,
            position: "position" in original ? original.position : 0,
            createdAt: "createdAt" in original ? original.createdAt : now,
            updatedAt: "updatedAt" in original ? original.updatedAt : now,
            revision: 0,
            deletedAt: null,
            recoveredFrom:
              "recoveredFrom" in original && original.recoveredFrom
                ? original.recoveredFrom
                : { pageId: original.id, recoveredAt: now },
          },
          true,
        );
      }
      // A v4 bundle may contain an empty or settings-only record database.
      // Mark every owner in the same transaction as its page and memberships.
      for (const original of bundle.pages)
        if (original.kind === "database")
          repo.registerDatabase(pageIds.get(original.id)!);
      for (const row of bundle.records)
        repo.attachForMigration(
          pageIds.get(row.pageId)!,
          pageIds.get(row.databasePageId)!,
          row.position,
          row.values,
        );
      markRecordStoreVersion(store!.db);
      onPhase?.("database");
    });
    const integrity = store.db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok")
      throw new Error("復旧先の整合性を検証できません。");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
    store = undefined;
    syncPath(join(destination, "workspace.sqlite"));
    syncPath(assetsDir);
    syncPath(destination);
    onPhase?.("before-complete");
    writeFileSync(
      join(destination, "FOLIO-RECOVERY-COMPLETE"),
      JSON.stringify({
        format: "folio-portable-recovery",
        schemaVersion: bundle.schemaVersion,
      }),
      { flag: "wx", mode: 0o600 },
    );
    syncPath(join(destination, "FOLIO-RECOVERY-COMPLETE"));
    // Store checks the marker, but this is not a completed crash journal and
    // remains an isolated API rather than a production recovery path.
    unlinkSync(incomplete);
    syncPath(destination);
    return {
      path: destination,
      pageIds: Object.fromEntries(pageIds),
      assetIds: Object.fromEntries(assetIds),
    };
  } finally {
    store?.close();
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function rewritePortablePage(
  page: PortablePage,
  pages: Map<string, string>,
  assets: Map<string, string>,
): Pick<
  Page,
  | "id"
  | "parentId"
  | "kind"
  | "title"
  | "icon"
  | "cover"
  | "favorite"
  | "doc"
  | "database"
> {
  const copy = structuredClone(page);
  const rewriteAsset = (value: string) => {
    const id = assetId(value);
    if (!id) return value;
    const next = assets.get(id);
    if (!next) throw invalid();
    return `folio-asset://${next}`;
  };
  copy.cover = rewriteAsset(copy.cover);
  const stack = [copy.doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node.attrs?.src === "string")
      node.attrs.src = rewriteAsset(node.attrs.src);
    for (const mark of node.marks ?? []) {
      if (mark.type !== "link" || typeof mark.attrs?.href !== "string")
        continue;
      const value = mark.attrs.href,
        target = pageTarget(value);
      if (target) {
        const id = pages.get(target);
        if (!id) throw invalid();
        mark.attrs.href = `folio-page://${id}`;
      } else mark.attrs.href = rewriteAsset(value);
    }
    stack.push(...(node.content ?? []));
  }
  const id = pages.get(page.id);
  if (!id) throw invalid();
  return {
    ...copy,
    id,
    parentId: page.parentId ? pages.get(page.parentId)! : null,
  };
}
