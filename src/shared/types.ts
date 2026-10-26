import { z } from "zod";
import { validDocument } from "./validation";
import { parseAssetURL } from "./assets";
import { fileFits } from "./limits";
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
export type DatabaseData = {
  properties: Property[];
  rows: RecordRow[];
  view: "table" | "board" | "calendar" | "gallery";
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
export type Snapshot = { pages: Page[]; settings: Record<string, string> };
export type Version = {
  id: number;
  pageId: string;
  createdAt: number;
  title: string;
  doc: Doc;
  database?: DatabaseData | null;
};
export const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("load") }),
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
        database: z
          .object({
            properties: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                type: z.enum(["text", "number", "select", "date", "checkbox"]),
                options: z.array(z.string()).optional(),
              }),
            ),
            rows: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                values: z.record(
                  z.union([z.string(), z.number().finite(), z.boolean()]),
                ),
              }),
            ),
            view: z.enum(["table", "board", "calendar", "gallery"]),
            filter: z.string(),
            sort: z.string(),
          })
          .nullable()
          .optional(),
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
    type: z.literal("restoreVersion"),
    id: z.string(),
    versionId: z.number().int(),
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
  view: "table",
  filter: "",
  sort: "",
});
