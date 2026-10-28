import { z } from "zod";
import { crashRecoverySnapshotSchema } from "./crash-recovery";
import { migrationPreviewRequestSchema, migrationCommitRequestSchema, migrationResolveRequestSchema } from "./legacy-migration-operation";
import { propertyPreviewRequestSchema, propertyCommitRequestSchema, propertyResolveRequestSchema } from "./property-operation";
import { validDocument } from "./validation";
import { parseAssetURL } from "./assets";
import { fileFits } from "./limits";
import { normalizeDatabaseData } from "../database/model";
import { isLosslessDatabaseData } from "../database/strict-database";
export type Doc = {
  type: string;
  schemaVersion?: number;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Doc[];
};

export const isDocument = (value: unknown): value is Doc =>
  validDocument(value);
export type Property = {
  id: string;
  name: string;
  type: "text" | "number" | "select" | "date" | "checkbox";
  options?: string[];
};
export type RecordRow = {
  id: string;
  title: string;
  values: Record<string, string | number | boolean>;
};
/** Round 3 API contracts. The v2 RecordRow remains legacy input until migration. */
export type RecordProjection = Readonly<{
  pageId: string;
  databasePageId: string;
  revision: number;
  title: string;
  icon: string;
  values: Readonly<Record<string, string | number | boolean>>;
  deletedAt: number | null;
}>;
export type RecordPatch = {
  title?: string;
  values?: Record<string, string | number | boolean | null>;
};
export type DatabaseSettings = Omit<DatabaseData, "rows">;
export type DatabaseProjection = Readonly<{
  settings: DatabaseSettings;
  records: readonly RecordProjection[];
  revision: number;
}>;
/** App owns all navigation, saves, errors and the single editor instance. */
export type DatabaseCallbacks = {
  openRecord: (pageId: string) => void;
  createRecord: (input: {
    title: string;
    values: Record<string, FilterValue>;
  }) => Promise<RecordProjection>;
  patchRecord: (
    pageId: string,
    revision: number,
    patch: RecordPatch,
  ) => Promise<RecordProjection>;
  trashRecord: (pageId: string, revision: number) => Promise<void>;
  restoreRecord: (
    pageId: string,
    revision: number,
  ) => Promise<RecordProjection>;
  duplicateRecord: (
    pageId: string,
    revision: number,
  ) => Promise<RecordProjection>;
  updateSettings: (
    revision: number,
    settings: DatabaseSettings,
  ) => Promise<DatabaseProjection>;
};
export type DatabasePresentationProps = {
  /** Stable owner identity is required even when the database has no records. */
  databasePageId: string;
  value: DatabaseProjection;
  callbacks: DatabaseCallbacks;
};
/** Wire shape: record and database settings commands are implemented. */
export type RecordRequest =
  | { type: "record:get"; pageId: string }
  | { type: "record:read"; pageId: string }
  | {
      type: "record:pageUpdate";
      pageId: string;
      databasePageId: string;
      revision: number;
      patch: RecordPagePatch;
    }
  | { type: "database:load"; databasePageId: string }
  | {
      type: "record:create";
      databasePageId: string;
      title: string;
      values: Record<string, FilterValue>;
    }
  | {
      type: "record:patch";
      pageId: string;
      databasePageId: string;
      revision: number;
      patch: RecordPatch;
    }
  | {
      type: "record:trash" | "record:restore" | "record:duplicate";
      pageId: string;
      revision: number;
    }
  | {
      type: "database:settings";
      databasePageId: string;
      revision: number;
      settings: DatabaseSettings;
    };

/** Document identity is page identity; a block reference is (pageId, blockId). */
export type EditorDocumentId = Page["id"];
export const DATABASE_SCHEMA_VERSION = 2;
export type DatabaseViewType = "table" | "board" | "calendar" | "gallery";
export type FilterOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "is_checked"
  | "is_not_checked";
export type FilterValue = string | number | boolean;
export type FilterCondition = {
  kind: "condition";
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value?: FilterValue;
};
export type FilterGroup = {
  kind: "group";
  id: string;
  conjunction: "and" | "or";
  conditions: FilterNode[];
};
export type FilterNode = FilterCondition | FilterGroup;
export type SortDirection = "asc" | "desc";
export type SortRule = {
  id: string;
  propertyId: string;
  direction: SortDirection;
};
export type GroupRule = {
  propertyId: string;
  direction: SortDirection;
};
export type DatabaseView = {
  id: string;
  name: string;
  type: DatabaseViewType;
  filterText: string;
  filter: FilterGroup;
  sorts: SortRule[];
  groupBy: GroupRule | null;
};
export type DatabaseData = {
  schemaVersion: typeof DATABASE_SCHEMA_VERSION;
  properties: Property[];
  rows: RecordRow[];
  views: DatabaseView[];
  activeViewId: string;
  /** @deprecated Compatibility projection of the active view's type. */
  view: DatabaseViewType;
  /** @deprecated Compatibility projection of the active view's text filter. */
  filter: string;
  /** @deprecated Compatibility projection of the active view's first sort. */
  sort: string;
};
export type LegacyDatabaseData = {
  schemaVersion?: 1;
  properties: Property[];
  rows: RecordRow[];
  view: DatabaseViewType;
  filter: string;
  sort: string;
};

export type Page = {
  id: string;
  schemaVersion?: number;
  parentId: string | null;
  title: string;
  icon: string;
  cover: string;
  position: number;
  doc: Doc;
  kind: "page" | "database";
  database: DatabaseData | null;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  deletedAt: number | null;
  documentError?: string;
  recoveredFrom?: { pageId: string; recoveredAt: number };
};
export type PagePatch = Partial<
  Pick<Page, "title" | "icon" | "cover" | "doc" | "database" | "favorite">
>;
/** A record Page update never replaces its owner's database or its values. */
export type RecordPagePatch = Omit<PagePatch, "database">;
export type Snapshot = {
  pages: Page[];
  settings: Record<string, string>;
  records?: RecordProjection[];
  recordDatabaseIds?: string[];
};
export type Version = {
  id: number;
  pageId: string;
  createdAt: number;
  title: string;
  doc: Doc;
  database?: DatabaseData | null;
};
/**
 * Accepts both the pre-v2 single view shape and the v2 multi-view shape and
 * returns an independent, normalized v2 value. Unknown, malformed, or lossy
 * structures fail closed before transformation so callers preserve the input.
 */
export const databaseDataSchema = z
  .custom<unknown>((value) => isLosslessDatabaseData(value), {
    message: "データベースの構造が不正か、未対応または損失のあるデータです。",
  })
  .transform((value): DatabaseData => {
    const result = normalizeDatabaseData(value);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
const recordValuePatchSchema = z.custom<Record<string, FilterValue | null>>(
  (value) => {
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
          (cell === null ||
            typeof cell === "string" ||
            typeof cell === "boolean" ||
            (typeof cell === "number" && Number.isFinite(cell))),
      ) &&
      fileFits(JSON.stringify(value))
    );
  },
  "Invalid record values",
);
export const databaseSettingsSchema = z.custom<DatabaseSettings>((value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.hasOwn(value, "rows") ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const data = { ...value, rows: [] } as Record<string, unknown>;
  if (
    data.schemaVersion !== DATABASE_SCHEMA_VERSION ||
    !["properties", "views", "activeViewId", "view", "filter", "sort"].every(
      (key) => Object.hasOwn(data, key),
    )
  )
    return false;
  return isLosslessDatabaseData(data) && fileFits(JSON.stringify(data));
}, "Invalid database settings");
/** R4 mutation identity includes the exact displayed revision and input generation. */
export const saveOperationSchema = z.object({
  operationId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  seq: z.number().int().positive().safe(),
  pageId: z.string().min(1).max(500),
  databasePageId: z.string().min(1).max(500).nullable(),
  revision: z.number().int().nonnegative().safe().max(Number.MAX_SAFE_INTEGER - 1),
  patch: z.object({
    title: z.string().max(500).optional(),
    icon: z.string().max(16).optional(),
    cover: z.string().max(500).optional(),
    doc: z.custom<Doc>(isDocument, "Invalid or excessively nested document").optional(),
    database: databaseDataSchema.nullable().optional(),
    favorite: z.boolean().optional(),
  }).strict(),
  values: recordValuePatchSchema.optional(),
}).strict().refine((operation) =>
  (Object.keys(operation.patch).length > 0 || Object.keys(operation.values ?? {}).length > 0) &&
  Object.values(operation.patch).every((value) => value !== undefined) &&
  (operation.databasePageId !== null || operation.values === undefined) &&
  (operation.databasePageId === null || operation.patch.database === undefined),
  "Invalid, empty or unbound save operation",
);
const ownerPagePatchSchema = z.object({
  title: z.string().max(500).optional(), icon: z.string().max(16).optional(),
  cover: z.string().max(500).optional(), favorite: z.boolean().optional(),
  doc: z.custom<Doc>(isDocument, "Invalid document").optional(),
}).strict().refine((patch) => Object.values(patch).every((value) => value !== undefined), "Undefined owner patch");
export const databaseOperationSchema = z.object({
  operationId: z.string().min(1).max(100), sessionId: z.string().min(1).max(100),
  seq: z.number().int().positive().safe(),
  command: z.discriminatedUnion("kind", [
    z.object({kind: z.literal("createDatabase"), parentId: z.string().min(1).max(500).nullable(),
      title: z.string().max(500), settings: databaseSettingsSchema}).strict(),
    z.object({kind: z.literal("createRecord"), databasePageId: z.string().min(1).max(500),
      revision: z.number().int().nonnegative().safe(), title: z.string().max(500),
      values: recordValuePatchSchema.refine((values) => Object.values(values).every((value) => value !== null), "Null initial value")}).strict(),
    z.object({kind: z.literal("updateDatabase"), databasePageId: z.string().min(1).max(500),
      revision: z.number().int().nonnegative().safe().max(Number.MAX_SAFE_INTEGER - 1),
      patch: ownerPagePatchSchema, settings: databaseSettingsSchema}).strict(),
  ]),
}).strict();
export const requestSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("recovery:read")}).strict(),
  z.object({type: z.literal("recovery:write"), expectedGeneration: z.number().int().nonnegative().safe(), snapshot: crashRecoverySnapshotSchema}).strict(),
  z.object({type: z.literal("recovery:copy"), recoveryId: z.string().regex(/^[a-zA-Z0-9:_-]{1,200}$/),
    input: z.object({title: z.string().max(500), doc: z.custom<Doc>(isDocument).optional(), sourcePageId: z.string().max(500).optional(), payload: z.unknown()}).strict()}).strict(),
  migrationPreviewRequestSchema, migrationCommitRequestSchema, migrationResolveRequestSchema,
  propertyPreviewRequestSchema, propertyCommitRequestSchema, propertyResolveRequestSchema,
  z.object({type: z.literal("database:commit"), operation: databaseOperationSchema}).strict(),
  z.object({type: z.literal("database:resolve"), operation: databaseOperationSchema}).strict(),
  z.object({type: z.literal("database:read"), databasePageId: z.string().min(1).max(500)}).strict(),
  z.object({type: z.literal("save:commit"), operation: saveOperationSchema}).strict(),
  z.object({type: z.literal("save:resolve"), operation: saveOperationSchema}).strict(),
  z.object({ type: z.literal("load") }),
  z
    .object({
      type: z.literal("record:get"),
      pageId: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("record:read"),
      pageId: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("record:pageUpdate"),
      pageId: z.string().min(1).max(500),
      databasePageId: z.string().min(1).max(500),
      revision: z
        .number()
        .int()
        .nonnegative()
        .safe()
        .max(Number.MAX_SAFE_INTEGER - 1),
      patch: z
        .object({
          title: z.string().max(500).optional(),
          icon: z.string().max(16).optional(),
          cover: z.string().max(500).optional(),
          doc: z
            .custom<Doc>(isDocument, "Invalid or excessively nested document")
            .optional(),
          favorite: z.boolean().optional(),
        })
        .strict()
        .refine(
          (patch) =>
            Object.keys(patch).length > 0 &&
            Object.values(patch).every((value) => value !== undefined),
          "Empty or undefined record Page patch",
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("database:load"),
      databasePageId: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("database:settings"),
      databasePageId: z.string().min(1).max(500),
      revision: z.number().int().nonnegative().safe(),
      settings: databaseSettingsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("record:create"),
      databasePageId: z.string().min(1).max(500),
      title: z.string().max(500),
      values: recordValuePatchSchema.refine(
        (values) => Object.values(values).every((value) => value !== null),
        "Record creation values cannot be null",
      ),
    })
    .strict(),
  z
    .object({
      type: z.enum(["record:trash", "record:restore", "record:duplicate"]),
      pageId: z.string().min(1).max(500),
      revision: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      type: z.literal("record:patch"),
      pageId: z.string().min(1).max(500),
      databasePageId: z.string().min(1).max(500),
      revision: z.number().int().nonnegative().safe(),
      patch: z
        .object({
          title: z.string().max(500).optional(),
          values: recordValuePatchSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({
    type: z.literal("create"),
    parentId: z.string().nullable(),
    kind: z.enum(["page", "database"]),
    title: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("update"),
    id: z.string(),
    revision: z.number().int(),
    patch: z
      .object({
        title: z.string().max(500).optional(),
        icon: z.string().max(16).optional(),
        cover: z.string().max(500).optional(),
        doc: z
          .custom<Doc>(isDocument, "Invalid or excessively nested document")
          .optional(),
        database: databaseDataSchema.nullable().optional(),
        favorite: z.boolean().optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal("move"),
    id: z.string(),
    parentId: z.string().nullable(),
    beforeId: z.string().nullable(),
  }),
  z.object({ type: z.enum(["duplicate", "trash", "restore"]), id: z.string() }),
  z.object({
    type: z.literal("setting"),
    key: z.enum(["activePage", "theme", "sidebar", "expanded"]),
    value: z.string().max(50000),
  }),
  z.object({ type: z.literal("search"), query: z.string().max(500) }),
  z.object({ type: z.literal("versions"), id: z.string() }),
  z.object({ type: z.literal("pageSource"), id: z.string() }),
  z.object({ type: z.literal("recover") }),
  z.object({
    type: z.literal("exportRecovery"),
    content: z
      .string()
      .refine(
        fileFits,
        "退避の上限はUTF-8で30,000,000 bytesです。未保存変更を保持しています。",
      ),
  }),
  z.object({
    type: z.literal("exportPendingJournal"),
    content: z.string().refine(
      fileFits,
      "未保存変更の記録はUTF-8で30,000,000 bytesまでです。変更は保持しています。",
    ),
  }).strict(),
  z.object({
    type: z.literal("restoreVersion"),
    id: z.string(),
    versionId: z.number().int(),
    revision: z.number().int().nonnegative().safe().optional(),
  }),
  z.object({ type: z.literal("backup") }),
  z.object({ type: z.literal("attach") }),
  z.object({
    type: z.literal("downloadAttachment"),
    url: z
      .string()
      .refine((value) => parseAssetURL(value) !== null, "Invalid asset URL"),
  }),
  z.object({
    type: z.literal("openExternal"),
    url: z
      .string()
      .url()
      .refine((s) => /^https?:\/\//.test(s)),
  }),
  z.object({
    type: z.literal("export"),
    name: z.string().max(500),
    format: z.enum(["md", "html", "json"]),
    content: z
      .string()
      .refine(fileFits, "書き出しの上限はUTF-8で30,000,000 bytesです"),
  }),
  z.object({ type: z.literal("import") }),
]);
export type Request = z.infer<typeof requestSchema>;
export interface FolioAPI {
  request<T = unknown>(request: Request): Promise<T>;
}
declare global {
  interface Window {
    folio: FolioAPI;
  }
}
export const blankDoc = (): Doc => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
// Inline marks never change text. Hard breaks and block boundaries are one LF.
export function textOf(node: Doc): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text")
    return typeof node.text === "string" ? node.text : "";
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  return node.content
    .map(textOf)
    .join(
      ["paragraph", "heading", "codeBlock", "detailsSummary"].includes(
        node.type,
      )
        ? ""
        : "\n",
    );
}
export const emptyDatabase = (): DatabaseData => ({
  schemaVersion: DATABASE_SCHEMA_VERSION,
  properties: [
    {
      id: "status",
      name: "ステータス",
      type: "select",
      options: ["未着手", "進行中", "完了"],
    },
    { id: "date", name: "期日", type: "date" },
  ],
  rows: [],
  views: [
    {
      id: "view-default",
      name: "テーブル",
      type: "table",
      filterText: "",
      filter: {
        kind: "group",
        id: "filter-default",
        conjunction: "and",
        conditions: [],
      },
      sorts: [],
      groupBy: null,
    },
  ],
  activeViewId: "view-default",
  view: "table",
  filter: "",
  sort: "",
});
