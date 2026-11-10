import { useEffect, useRef, useState } from "react";
import { wellFormed } from "../../collaboration/runtime/contract";
import type {
  Json,
  Receipt,
  Scope,
} from "../../collaboration/runtime/contract";
import type { Property } from "../../shared/types";
import type { SharedRuntimeAPI } from "../../shared/shared-runtime-ipc";
import "./shared-workbench.css";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROPERTY_TYPES: ReadonlyArray<Property["type"]> = [
  "text",
  "number",
  "select",
  "date",
  "checkbox",
];

export type SharedDatabase = Readonly<{
  id: string;
  revision: number;
  properties: Property[];
  deleted: boolean;
}>;

export type SharedRecord = Readonly<{
  id: string;
  databaseId: string;
  revision: number;
  title: string;
  values: Readonly<Record<string, string | number | boolean>>;
  deleted: boolean;
}>;

export type SharedPage = Readonly<{
  id: string;
  parentId: string | null;
  order: number;
}>;

export type SharedRecordsView = Readonly<{
  databases: readonly SharedDatabase[];
  records: readonly SharedRecord[];
  pages: readonly SharedPage[];
  document: unknown;
}>;

export type PropertyDraft = Readonly<{
  key: string;
  id: string;
  name: string;
  type: Property["type"];
  optionsText: string;
}>;

export type RecordValueInput = string | boolean;

export type BuiltValues =
  | { ok: true; values: Record<string, string | number | boolean | null> }
  | { ok: false; message: string };

export type BuiltProperties =
  { ok: true; properties: Property[] } | { ok: false; message: string };

type EditingRecord = Readonly<{
  recordId: string;
  databaseId: string;
  revision: number;
  schemaRevision: number;
  scope: Scope;
  properties: Property[];
}>;

const TYPE_LABELS: Readonly<Record<Property["type"], string>> = {
  text: "テキスト",
  number: "数値",
  select: "選択",
  date: "日付",
  checkbox: "チェックボックス",
};

const ERROR_MESSAGES: Readonly<Record<string, string | undefined>> = {
  FORBIDDEN: "この操作を行う権限がありません。",
  NOT_MEMBER: "このワークスペースのメンバーではありません。",
  NOT_ADMINISTRATOR: "この操作を行う権限がありません。",
  AUTH_SCOPE_MISMATCH: "接続中の組織と操作対象が一致しません。",
  SHARED_NOT_CONFIGURED: "共有サーバーに接続されていません。",
  SHARED_DOCUMENT_NOT_OPEN: "共有文書が開かれていません。",
  STALE_SHARED_SESSION:
    "共有セッションが更新されました。画面を開き直してください。",
  STALE_DATABASE:
    "データベースの構成が更新されています。再読み込みしてからやり直してください。",
  STALE_RECORD:
    "レコードが更新されています。再読み込みしてからやり直してください。",
  STALE_SCHEMA:
    "データベースの構成が更新されています。再読み込みしてからやり直してください。",
  DATABASE_MISSING:
    "対象のデータベースが見つかりません。一覧を再読み込みしてください。",
  DATABASE_DELETED: "対象のデータベースは削除されています。",
  RECORD_MISSING:
    "対象のレコードが見つかりません。一覧を再読み込みしてください。",
  RECORD_DELETED: "対象のレコードは削除されています。",
  RECORD_ALREADY_DELETED: "対象のレコードはすでに削除されています。",
  RECORD_DOCUMENT_MISSING:
    "レコードの文書情報が見つかりません。一覧を再取得してください。",
  WORKSPACE_MISSING: "ワークスペースの文書一覧を取得できませんでした。",
  ID_EXISTS: "同じIDがすでに使われています。",
  DOCUMENT_EXISTS: "同じ文書がすでに存在します。",
  PARENT_MISSING: "指定した親ページが見つかりません。",
  SCHEMA_VALUE_LOSS:
    "既存レコードの値を失うため、この構成変更は拒否されました。",
  INVALID_TITLE: "タイトルは500文字以内で入力してください。",
  INVALID_PROPERTY_NAME: "項目名は1〜200文字で入力してください。",
  INVALID_PROPERTY_TYPE: "項目の種類が不正です。",
  INVALID_OPTIONS: "選択肢は1つ以上、重複なく入力してください。",
  INVALID_OPTION: "選択肢は1〜200文字で入力してください。",
  DUPLICATE_PROPERTY_ID: "項目IDが重複しています。",
  UNKNOWN_PROPERTY_FIELD: "項目に未対応の設定が含まれています。",
  UNKNOWN_PAYLOAD_FIELD: "送信内容に未対応の項目が含まれています。",
  INVALID_PAYLOAD: "送信内容の形式が正しくありません。",
  INVALID_VALUES: "入力値の形式が正しくありません。",
  INVALID_VALUE: "入力値が項目の種類に合いません。",
  UNKNOWN_PROPERTY: "現在の構成にない項目が含まれています。",
  INVALID_DOCUMENT: "レコード本文を作成できませんでした。",
  TRANSACTION_REQUIRED: "サーバーの状態を保存できませんでした。",
  UNAUTHORIZED_IPC_SENDER: "この画面から操作する権限がありません。",
  UI_BUSY: "別の操作を完了してからやり直してください。",
};

function fail(code: string): never {
  throw new Error(code);
}

function plain(value: unknown, code: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    fail(code);
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (names.length !== keys.length) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !wellFormed(key)
    )
      fail(code);
  }
  return value as Record<string, unknown>;
}

function textField(
  value: unknown,
  code: string,
  max: number,
  allowEmpty = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    !wellFormed(value) ||
    (!allowEmpty && value.length === 0)
  )
    fail(code);
  return value;
}

function idField(value: unknown, code = "INVALID_ID"): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
  return value;
}

function counterField(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code);
  return Number(value);
}

function boolField(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function propertyId(value: unknown): string {
  const id = textField(value, "INVALID_PROPERTY_ID", 500, false);
  if (id === "__proto__") fail("INVALID_PROPERTY_ID");
  return id;
}

function parseProperty(value: unknown): Property {
  const item = plain(value, "INVALID_PROPERTY");
  for (const key of Object.keys(item))
    if (key !== "id" && key !== "name" && key !== "type" && key !== "options")
      fail("UNKNOWN_PROPERTY_FIELD");
  const id = propertyId(item.id);
  const name = textField(item.name, "INVALID_PROPERTY_NAME", 200, false);
  const type = item.type;
  if (
    type !== "text" &&
    type !== "number" &&
    type !== "select" &&
    type !== "date" &&
    type !== "checkbox"
  )
    fail("INVALID_PROPERTY_TYPE");
  if (type === "select") {
    if (!Array.isArray(item.options)) fail("INVALID_OPTIONS");
    if (item.options.length === 0 || item.options.length > 1000)
      fail("INVALID_OPTIONS");
    const options: string[] = [];
    const seen = new Set<string>();
    for (const option of item.options) {
      const optionText = textField(option, "INVALID_OPTION", 200, false);
      if (seen.has(optionText)) fail("INVALID_OPTIONS");
      seen.add(optionText);
      options.push(optionText);
    }
    return { id, name, type, options };
  }
  if (Object.hasOwn(item, "options")) fail("INVALID_OPTIONS");
  return { id, name, type };
}

function parseValues(
  value: unknown,
): Record<string, string | number | boolean> {
  const input = plain(value, "INVALID_VALUES");
  const values: Record<string, string | number | boolean> = {};
  for (const [key, cell] of Object.entries(input)) {
    if (key.length === 0 || key.length > 500 || key === "__proto__")
      fail("INVALID_VALUES");
    if (typeof cell === "string" || typeof cell === "boolean") {
      if (typeof cell === "string" && !wellFormed(cell)) fail("INVALID_VALUES");
      values[key] = cell;
    } else if (
      typeof cell === "number" &&
      Number.isFinite(cell) &&
      !Object.is(cell, -0) &&
      (!Number.isInteger(cell) || Number.isSafeInteger(cell))
    ) {
      values[key] = cell;
    } else {
      fail("INVALID_VALUES");
    }
  }
  return values;
}

function parseReceiptScope(value: unknown): Scope {
  const scope = plain(value, "INVALID_RECEIPT");
  return {
    orgId: idField(scope.orgId),
    workspaceId: idField(scope.workspaceId),
    documentId: idField(scope.documentId),
    incarnationId: idField(scope.incarnationId),
  };
}

export function parseReceipt(value: unknown): Receipt {
  const receipt = plain(value, "INVALID_RECEIPT");
  if (receipt.v !== 1) fail("INVALID_RECEIPT");
  const status = receipt.status;
  if (
    status !== "SERVER_ACCEPTED" &&
    status !== "REJECTED" &&
    status !== "INVALIDATED"
  )
    fail("INVALID_RECEIPT");
  const cut = plain(receipt.cut, "INVALID_RECEIPT");
  const hash = (raw: unknown): string => {
    if (typeof raw !== "string" || !HASH_PATTERN.test(raw))
      fail("INVALID_RECEIPT");
    return raw;
  };
  const code =
    receipt.code === null
      ? null
      : textField(receipt.code, "INVALID_RECEIPT", 128);
  return {
    v: 1,
    status,
    intentId: idField(receipt.intentId, "INVALID_RECEIPT"),
    intentHash: hash(receipt.intentHash),
    attemptId: idField(receipt.attemptId, "INVALID_RECEIPT"),
    attemptHash: hash(receipt.attemptHash),
    writerId: idField(receipt.writerId, "INVALID_RECEIPT"),
    scope: parseReceiptScope(receipt.scope),
    cut: {
      epoch: idField(cut.epoch, "INVALID_RECEIPT"),
      seq: counterField(cut.seq, "INVALID_RECEIPT"),
      hash: hash(cut.hash),
    },
    resultHash: hash(receipt.resultHash),
    code,
  };
}

export function parseRecordsView(value: unknown): SharedRecordsView {
  const root = plain(value, "INVALID_RECORDS_VIEW");
  if (!Array.isArray(root.databases)) fail("INVALID_RECORDS_VIEW");
  if (!Array.isArray(root.records)) fail("INVALID_RECORDS_VIEW");
  if (!Array.isArray(root.pages)) fail("INVALID_RECORDS_VIEW");
  if (!Object.hasOwn(root, "document")) fail("INVALID_RECORDS_VIEW");
  if (root.document !== null) {
    if (Array.isArray(root.document)) fail("INVALID_RECORDS_VIEW");
    plain(root.document, "INVALID_RECORDS_VIEW");
  }

  const databases: SharedDatabase[] = root.databases.map((raw) => {
    const database = plain(raw, "INVALID_DATABASE");
    if (!Array.isArray(database.properties)) fail("INVALID_DATABASE");
    return {
      id: idField(database.id, "INVALID_DATABASE"),
      revision: counterField(database.revision, "INVALID_DATABASE"),
      properties: database.properties.map(parseProperty),
      deleted: boolField(database.deleted, "INVALID_DATABASE"),
    };
  });

  const records: SharedRecord[] = root.records.map((raw) => {
    const record = plain(raw, "INVALID_RECORD");
    return {
      id: idField(record.id, "INVALID_RECORD"),
      databaseId: idField(record.databaseId, "INVALID_RECORD"),
      revision: counterField(record.revision, "INVALID_RECORD"),
      title: textField(record.title, "INVALID_RECORD", 500),
      values: parseValues(record.values),
      deleted: boolField(record.deleted, "INVALID_RECORD"),
    };
  });

  const pages: SharedPage[] = root.pages.map((raw) => {
    const page = plain(raw, "INVALID_PAGE");
    return {
      id: idField(page.id, "INVALID_PAGE"),
      parentId:
        page.parentId === null ? null : idField(page.parentId, "INVALID_PAGE"),
      order: counterField(page.order, "INVALID_PAGE"),
    };
  });

  return { databases, records, pages, document: root.document };
}

export function parseRecordIncarnation(
  value: unknown,
  workspaceId: string,
  recordId: string,
): string {
  const session = plain(value, "INVALID_WORKSPACE_LISTING");
  if (!Array.isArray(session.workspaces)) fail("INVALID_WORKSPACE_LISTING");
  let workspaceFound = false;
  for (const raw of session.workspaces) {
    const workspace = plain(raw, "INVALID_WORKSPACE_LISTING");
    if (workspace.workspaceId !== workspaceId) continue;
    workspaceFound = true;
    if (!Array.isArray(workspace.documents)) fail("INVALID_WORKSPACE_LISTING");
    for (const rawDocument of workspace.documents) {
      const document = plain(rawDocument, "INVALID_WORKSPACE_LISTING");
      const documentId = idField(
        document.documentId,
        "INVALID_WORKSPACE_LISTING",
      );
      if (documentId !== recordId) continue;
      return idField(document.incarnationId, "INVALID_WORKSPACE_LISTING");
    }
  }
  fail(workspaceFound ? "RECORD_DOCUMENT_MISSING" : "WORKSPACE_MISSING");
}

function propertyAsJson(property: Property): Json {
  const entry: { [key: string]: Json } = {
    id: property.id,
    name: property.name,
    type: property.type,
  };
  if (property.type === "select")
    entry.options = property.options === undefined ? [] : [...property.options];
  return entry;
}

function isStrictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

export type EmptyRecordDocument = {
  [key: string]: Json;
  type: string;
  content: {
    [key: string]: Json;
    type: string;
    attrs: { [key: string]: Json; id: string };
  }[];
};

export function buildEmptyRecordDocument(
  newId: () => string = () => crypto.randomUUID(),
): EmptyRecordDocument {
  return {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: newId() } }],
  };
}

export function newPropertyDraft(name = ""): PropertyDraft {
  return {
    key: crypto.randomUUID(),
    id: crypto.randomUUID(),
    name,
    type: "text",
    optionsText: "",
  };
}

export function buildProperties(
  drafts: readonly PropertyDraft[],
): BuiltProperties {
  if (drafts.length === 0)
    return { ok: false, message: "項目を1つ以上追加してください。" };
  const properties: Property[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const id = draft.id;
    if (
      id.length === 0 ||
      id.length > 500 ||
      !wellFormed(id) ||
      id === "__proto__"
    )
      return {
        ok: false,
        message: "項目IDが不正です。項目を追加し直してください。",
      };
    if (seen.has(id))
      return {
        ok: false,
        message: "項目IDが重複しています。項目を追加し直してください。",
      };
    seen.add(id);
    if (
      draft.name.length === 0 ||
      draft.name.length > 200 ||
      !wellFormed(draft.name)
    )
      return { ok: false, message: "項目名は1〜200文字で入力してください。" };
    if (!PROPERTY_TYPES.includes(draft.type))
      return { ok: false, message: "項目の種類が不正です。" };
    if (draft.type === "select") {
      const tokens = draft.optionsText
        .split(/[,、\n]/)
        .map((token) => token.trim());
      if (tokens.length === 0 || tokens.some((token) => token.length === 0))
        return { ok: false, message: "選択肢を1つ以上入力してください。" };
      if (tokens.length > 1000)
        return { ok: false, message: "選択肢が多すぎます。" };
      const options: string[] = [];
      const optionSeen = new Set<string>();
      for (const token of tokens) {
        if (token.length > 200 || !wellFormed(token))
          return {
            ok: false,
            message: "選択肢は1〜200文字で入力してください。",
          };
        if (optionSeen.has(token))
          return { ok: false, message: "同じ選択肢が重複しています。" };
        optionSeen.add(token);
        options.push(token);
      }
      properties.push({ id, name: draft.name, type: "select", options });
    } else {
      properties.push({ id, name: draft.name, type: draft.type });
    }
  }
  return { ok: true, properties };
}

export function buildRecordValues(
  properties: readonly Property[],
  inputs: Readonly<Record<string, RecordValueInput>>,
  mode: "create" | "patch",
): BuiltValues {
  const values: Record<string, string | number | boolean | null> = {};
  for (const property of properties) {
    const raw = inputs[property.id];
    switch (property.type) {
      case "text": {
        const value = typeof raw === "string" ? raw : "";
        if (!wellFormed(value))
          return {
            ok: false,
            message: "テキストに未対応の文字が含まれています。",
          };
        values[property.id] = value;
        break;
      }
      case "number": {
        const source = typeof raw === "string" ? raw.trim() : "";
        if (source === "") {
          if (mode === "patch") values[property.id] = null;
          break;
        }
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source))
          return {
            ok: false,
            message: `「${property.name}」は数値で入力してください。`,
          };
        const value = Number(source);
        if (
          !Number.isFinite(value) ||
          Object.is(value, -0) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value))
        )
          return {
            ok: false,
            message: `「${property.name}」は安全な数値で入力してください。`,
          };
        values[property.id] = value;
        break;
      }
      case "select": {
        const value = typeof raw === "string" ? raw : "";
        if (!wellFormed(value))
          return {
            ok: false,
            message: "選択値に未対応の文字が含まれています。",
          };
        if (value !== "" && !(property.options ?? []).includes(value))
          return {
            ok: false,
            message: `「${property.name}」は選択肢から選んでください。`,
          };
        values[property.id] = value;
        break;
      }
      case "date": {
        const value = typeof raw === "string" ? raw : "";
        if (!wellFormed(value) || (value !== "" && !isStrictDate(value)))
          return {
            ok: false,
            message: `「${property.name}」は正しい日付で入力してください。`,
          };
        values[property.id] = value;
        break;
      }
      case "checkbox": {
        if (raw === undefined) {
          values[property.id] = false;
        } else if (typeof raw === "boolean") {
          values[property.id] = raw;
        } else {
          return {
            ok: false,
            message: `「${property.name}」はチェックの有無で入力してください。`,
          };
        }
        break;
      }
    }
  }
  return { ok: true, values };
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    error.message.length <= 128 &&
    wellFormed(error.message)
    ? error.message
    : "";
}

function describeError(error: unknown, fallback: string): string {
  const code = errorCode(error);
  const mapped = code === "" ? undefined : ERROR_MESSAGES[code];
  if (mapped !== undefined) return mapped;
  if (code !== "") return `操作を完了できませんでした（${code}）。`;
  return fallback;
}

function describeReceiptRejection(receipt: Receipt): string {
  const mapped =
    receipt.code === null ? undefined : ERROR_MESSAGES[receipt.code];
  const reason = mapped ?? (receipt.code === null ? "理由不明" : receipt.code);
  return `サーバーが変更を拒否しました（${reason}）。入力内容は保持しています。`;
}

function formatRecordValue(
  property: Property,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  if (!Object.hasOwn(values, property.id)) return "—";
  const value = values[property.id];
  if (property.type === "checkbox") return value === true ? "はい" : "いいえ";
  if (typeof value === "string") return value.length === 0 ? "—" : value;
  if (typeof value === "number") return String(value);
  return "—";
}

function valuesForEditing(
  properties: readonly Property[],
  values: Readonly<Record<string, string | number | boolean>>,
): Record<string, RecordValueInput> {
  const next: Record<string, RecordValueInput> = {};
  for (const property of properties) {
    const value = values[property.id];
    if (property.type === "checkbox") next[property.id] = value === true;
    else if (typeof value === "string" || typeof value === "number")
      next[property.id] = String(value);
    else next[property.id] = "";
  }
  return next;
}

export type SharedDatabasePanelProps = {
  api: SharedRuntimeAPI;
  scope: Scope;
  generation: number;
  onChanged: () => void;
  onOpen: (scope: Scope) => void;
};

export function SharedDatabasePanel({
  api,
  scope,
  generation,
  onChanged,
  onOpen,
}: SharedDatabasePanelProps) {
  const [view, setView] = useState<SharedRecordsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [recoveryText, setRecoveryText] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string | null>(
    null,
  );
  const [databaseLabel, setDatabaseLabel] = useState("");
  const [localLabels, setLocalLabels] = useState<Record<string, string>>({});
  const [propertyDrafts, setPropertyDrafts] = useState<PropertyDraft[]>(() => [
    newPropertyDraft("名前"),
  ]);
  const [recordTitle, setRecordTitle] = useState("");
  const [recordValues, setRecordValues] = useState<
    Record<string, RecordValueInput>
  >({});
  const [editing, setEditing] = useState<EditingRecord | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editValues, setEditValues] = useState<
    Record<string, RecordValueInput>
  >({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmTrashId, setConfirmTrashId] = useState<string | null>(null);

  const mounted = useRef(true);
  const epochRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const activeRef = useRef(0);

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    activeRef.current += 1;
    if (mounted.current) setBusy(true);
    const run = queueRef.current.then(work, work);
    queueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    const settle = () => {
      activeRef.current = Math.max(0, activeRef.current - 1);
      if (mounted.current && activeRef.current === 0) setBusy(false);
    };
    run.then(settle, settle);
    return run;
  }

  function isCurrent(epoch: number): boolean {
    return mounted.current && epoch === epochRef.current;
  }

  function resetTransientMessages() {
    setNotice("");
    setActionError("");
    setRecoveryVisible(false);
    setRecoveryText("");
    setRecoveryError("");
    setConfirmTrashId(null);
  }

  async function refreshRecordsInternal(epoch: number): Promise<void> {
    try {
      const raw = await api.request<unknown>({
        type: "admin",
        command: { action: "records", scope },
      });
      if (!isCurrent(epoch)) return;
      setView(parseRecordsView(raw));
      setLoadError("");
    } catch (error) {
      if (!isCurrent(epoch)) return;
      setLoadError(
        describeError(
          error,
          "一覧の再取得に失敗しました。再読み込みしてください。",
        ),
      );
    }
  }

  function loadRecords(): Promise<void> {
    const epoch = epochRef.current;
    setLoading(true);
    setLoadError("");
    return enqueue(async () => {
      try {
        const raw = await api.request<unknown>({
          type: "admin",
          command: { action: "records", scope },
        });
        if (!isCurrent(epoch)) return;
        setView(parseRecordsView(raw));
      } catch (error) {
        if (!isCurrent(epoch)) return;
        setLoadError(
          describeError(
            error,
            "共有データベースを取得できませんでした。再読み込みしてください。",
          ),
        );
      } finally {
        if (isCurrent(epoch)) setLoading(false);
      }
    });
  }

  async function resolveIncarnation(
    recordId: string,
    epoch: number,
  ): Promise<string> {
    const raw = await api.request<unknown>({ type: "list" });
    if (!isCurrent(epoch)) fail("STALE_SHARED_SESSION");
    return parseRecordIncarnation(raw, scope.workspaceId, recordId);
  }

  async function submitResource(options: {
    action: string;
    targetScope: Scope;
    payload: Json;
    successMessage: string;
    onSuccess: () => void;
    epoch: number;
  }): Promise<void> {
    try {
      const raw = await api.request<unknown>({
        type: "resource",
        generation,
        scope: options.targetScope,
        command: {
          kind: "resource",
          action: options.action,
          payload: options.payload,
        },
      });
      if (!isCurrent(options.epoch)) return;
      let receipt: Receipt;
      try {
        receipt = parseReceipt(raw);
      } catch {
        setActionError(
          "サーバーの受付結果を確認できません。入力内容は保持しています。復旧の操作で受付状態を確認してください。",
        );
        setRecoveryVisible(true);
        return;
      }
      if (receipt.status !== "SERVER_ACCEPTED") {
        setActionError(describeReceiptRejection(receipt));
        return;
      }
      options.onSuccess();
      setNotice(options.successMessage);
      try {
        onChanged();
      } catch {
        setNotice(`${options.successMessage} 親画面の更新に失敗しました。`);
      }
      await refreshRecordsInternal(options.epoch);
    } catch (error) {
      if (!isCurrent(options.epoch)) return;
      setActionError(
        describeError(
          error,
          "サーバーの受付状態を確認できません。入力内容は保持しています。",
        ),
      );
      setRecoveryVisible(true);
    }
  }

  function startMutation(
    action: string,
    targetScope: Scope,
    payload: Json,
    successMessage: string,
    onSuccess: () => void,
  ): void {
    if (activeRef.current > 0) {
      setActionError("別の操作を完了してからやり直してください。");
      return;
    }
    const epoch = epochRef.current;
    resetTransientMessages();
    void enqueue(() =>
      submitResource({
        action,
        targetScope,
        payload,
        successMessage,
        onSuccess,
        epoch,
      }),
    );
  }

  async function openRecord(record: SharedRecord): Promise<void> {
    if (activeRef.current > 0) {
      setActionError("別の操作を完了してからやり直してください。");
      return;
    }
    const epoch = epochRef.current;
    setOpeningId(record.id);
    setActionError("");
    try {
      await enqueue(async () => {
        try {
          const incarnationId = await resolveIncarnation(record.id, epoch);
          if (!isCurrent(epoch)) return;
          onOpen({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            documentId: record.id,
            incarnationId,
          });
        } catch (error) {
          if (!isCurrent(epoch)) return;
          setActionError(
            describeError(
              error,
              "レコードを開けませんでした。一覧を再取得してください。",
            ),
          );
        }
      });
    } finally {
      if (mounted.current) setOpeningId(null);
    }
  }

  async function beginEditing(
    record: SharedRecord,
    database: SharedDatabase,
  ): Promise<void> {
    if (activeRef.current > 0) {
      setActionError("別の操作を完了してからやり直してください。");
      return;
    }
    const epoch = epochRef.current;
    setActionError("");
    setNotice("");
    await enqueue(async () => {
      try {
        const incarnationId = await resolveIncarnation(record.id, epoch);
        if (!isCurrent(epoch)) return;
        setEditing({
          recordId: record.id,
          databaseId: database.id,
          revision: record.revision,
          schemaRevision: database.revision,
          scope: {
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            documentId: record.id,
            incarnationId,
          },
          properties: database.properties.map((property) => ({ ...property })),
        });
        setEditTitle(record.title);
        setEditValues(valuesForEditing(database.properties, record.values));
      } catch (error) {
        if (!isCurrent(epoch)) return;
        setActionError(
          describeError(
            error,
            "レコードの編集を開始できませんでした。一覧を再取得してください。",
          ),
        );
      }
    });
  }

  function requestTrash(record: SharedRecord): void {
    if (activeRef.current > 0) return;
    setConfirmTrashId(record.id);
    setActionError("");
    setNotice("");
  }

  function performTrash(record: SharedRecord): void {
    if (activeRef.current > 0) {
      setActionError("別の操作を完了してからやり直してください。");
      return;
    }
    const epoch = epochRef.current;
    setConfirmTrashId(null);
    resetTransientMessages();
    void enqueue(async () => {
      let incarnationId: string | null = null;
      try {
        incarnationId = await resolveIncarnation(record.id, epoch);
      } catch (error) {
        if (!isCurrent(epoch)) return;
        setActionError(
          describeError(
            error,
            "レコードを削除できませんでした。一覧を再取得してください。",
          ),
        );
        return;
      }
      if (!isCurrent(epoch) || incarnationId === null) return;
      const targetScope: Scope = {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        documentId: record.id,
        incarnationId,
      };
      await submitResource({
        action: "record.trash",
        targetScope,
        payload: {
          databaseId: record.databaseId,
          revision: record.revision,
        },
        successMessage: "レコードを削除しました。",
        epoch,
        onSuccess: () => {
          setEditing((current) =>
            current?.recordId === record.id ? null : current,
          );
        },
      });
    });
  }

  function createDatabase(): void {
    const built = buildProperties(propertyDrafts);
    if (!built.ok) {
      setActionError(built.message);
      return;
    }
    const databaseId = crypto.randomUUID();
    const label = databaseLabel.trim();
    if (label.length > 200 || (label.length > 0 && !wellFormed(label))) {
      setActionError("表示名は200文字以内で入力してください。");
      return;
    }
    startMutation(
      "db.create",
      scope,
      {
        databaseId,
        revision: 0,
        properties: built.properties.map(propertyAsJson),
      },
      "データベースを作成しました。",
      () => {
        setPropertyDrafts([newPropertyDraft("名前")]);
        setDatabaseLabel("");
        setSelectedDatabaseId(databaseId);
        if (label.length > 0)
          setLocalLabels((current) => ({ ...current, [databaseId]: label }));
        setRecordTitle("");
        setRecordValues({});
        setEditing(null);
      },
    );
  }

  function createRecord(database: SharedDatabase): void {
    const built = buildRecordValues(
      database.properties,
      recordValues,
      "create",
    );
    if (!built.ok) {
      setActionError(built.message);
      return;
    }
    if (recordTitle.length > 500 || !wellFormed(recordTitle)) {
      setActionError("タイトルは500文字以内で入力してください。");
      return;
    }
    const recordId = crypto.randomUUID();
    const targetScope: Scope = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      documentId: recordId,
      incarnationId: crypto.randomUUID(),
    };
    startMutation(
      "record.create",
      targetScope,
      {
        databaseId: database.id,
        revision: database.revision,
        title: recordTitle,
        values: built.values,
        document: buildEmptyRecordDocument(),
      },
      "レコードを作成しました。一覧から開けます。",
      () => {
        setRecordTitle("");
        setRecordValues({});
      },
    );
  }

  function saveEditing(): void {
    if (editing === null) return;
    const built = buildRecordValues(editing.properties, editValues, "patch");
    if (!built.ok) {
      setActionError(built.message);
      return;
    }
    if (editTitle.length > 500 || !wellFormed(editTitle)) {
      setActionError("タイトルは500文字以内で入力してください。");
      return;
    }
    const snapshot = editing;
    startMutation(
      "record.patch",
      snapshot.scope,
      {
        databaseId: snapshot.databaseId,
        revision: snapshot.revision,
        schemaRevision: snapshot.schemaRevision,
        title: editTitle,
        values: built.values,
      },
      "レコードを更新しました。",
      () => {
        setEditing(null);
        setEditTitle("");
        setEditValues({});
      },
    );
  }

  function runRecovery(kind: "resourceReconcile" | "resourceRecover"): void {
    if (activeRef.current > 0) {
      setRecoveryError("別の操作を完了してからやり直してください。");
      return;
    }
    const epoch = epochRef.current;
    setRecoveryError("");
    setRecoveryText("");
    setNotice("");
    void enqueue(async () => {
      try {
        const raw = await api.request<unknown>({ type: kind, generation });
        if (!isCurrent(epoch)) return;
        if (kind === "resourceRecover") {
          if (typeof raw === "string" && raw.length > 0 && wellFormed(raw)) {
            setRecoveryText(raw);
          } else {
            setRecoveryError(
              "復元用の内容を取得できませんでした。表示中の入力内容は保持しています。",
            );
          }
          return;
        }
        setNotice("受付状態を再確認しました。");
        try {
          onChanged();
        } catch {
          setNotice("受付状態を再確認しました。親画面の更新に失敗しました。");
        }
        await refreshRecordsInternal(epoch);
      } catch (error) {
        if (!isCurrent(epoch)) return;
        setRecoveryError(
          describeError(
            error,
            "受付状態を確認できませんでした。入力内容は保持しています。",
          ),
        );
      }
    });
  }

  function updateDraft(key: string, patch: Partial<PropertyDraft>): void {
    setPropertyDrafts((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft,
      ),
    );
  }

  function updateRecordValue(property: Property, raw: string): void {
    const value: RecordValueInput =
      property.type === "checkbox" ? raw === "true" : raw;
    setRecordValues((current) => ({ ...current, [property.id]: value }));
  }

  function updateEditValue(property: Property, raw: string): void {
    const value: RecordValueInput =
      property.type === "checkbox" ? raw === "true" : raw;
    setEditValues((current) => ({ ...current, [property.id]: value }));
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    epochRef.current += 1;
    setView(null);
    setLoadError("");
    setLoading(true);
    setSelectedDatabaseId(null);
    setDatabaseLabel("");
    setLocalLabels({});
    setPropertyDrafts([newPropertyDraft("名前")]);
    setRecordTitle("");
    setRecordValues({});
    setEditing(null);
    setEditTitle("");
    setEditValues({});
    setOpeningId(null);
    resetTransientMessages();
    void loadRecords();
    // Scope identity and generation are the cancellation fence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    generation,
    scope.orgId,
    scope.workspaceId,
    scope.documentId,
    scope.incarnationId,
  ]);

  const selectedDatabase =
    view === null
      ? null
      : (view.databases.find(
          (database) => database.id === selectedDatabaseId,
        ) ?? null);
  const databaseRecords =
    view === null || selectedDatabase === null
      ? []
      : view.records.filter(
          (record) => record.databaseId === selectedDatabase.id,
        );
  const editingStale =
    editing !== null &&
    view !== null &&
    (view.databases.find((database) => database.id === editing.databaseId)
      ?.revision ?? editing.schemaRevision) !== editing.schemaRevision;

  function renderValueInput(
    property: Property,
    value: RecordValueInput | undefined,
    onChange: (raw: string) => void,
    disabled: boolean,
  ) {
    if (property.type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) =>
            onChange(event.target.checked ? "true" : "false")
          }
          disabled={disabled}
        />
      );
    }
    if (property.type === "select") {
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          <option value="">（未設定）</option>
          {(property.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        type={property.type === "date" ? "date" : "text"}
        inputMode={property.type === "number" ? "decimal" : undefined}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
      />
    );
  }

  return (
    <section className="shared-workspace-panel" aria-label="共有データベース">
      <header>
        <h2>共有データベース</h2>
        <button
          type="button"
          onClick={() => void loadRecords()}
          disabled={busy || loading}
        >
          {loading ? "読み込んでいます…" : "一覧を再読み込み"}
        </button>
      </header>

      <p>
        この共有データベースの初期版は、テキスト・数値・選択・日付・チェックボックスの5種類の項目に対応しています。複数ビュー、ページ本文の複製、数式などプライベートのデータベースのすべての機能は利用できません。
      </p>
      <p>
        実行可否はサーバーが判定します。画面の権限表示だけで操作を許可したことにはしません。
      </p>

      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => void loadRecords()}
            disabled={busy}
          >
            再読み込み
          </button>
        </div>
      )}
      {loading && view === null && <p>共有データベースを読み込んでいます…</p>}
      {busy && <p role="status">処理中です。入力内容は保持しています。</p>}
      {notice && <p role="status">{notice}</p>}
      {actionError && (
        <p role="alert">{actionError} 入力内容はこの画面に保持しています。</p>
      )}

      <section aria-label="データベース一覧">
        <h3>データベース</h3>
        {view !== null && view.databases.length === 0 && (
          <p>
            データベースはまだありません。下のフォームから作成してください。
          </p>
        )}
        {view?.databases.map((database) => {
          const selected = database.id === selectedDatabaseId;
          const label = localLabels[database.id];
          return (
            <article key={database.id}>
              <h4>
                {label && label.length > 0 ? `${label} ` : ""}
                <code>{database.id}</code>
                {database.deleted ? "（削除済み）" : ""}
              </h4>
              <p>
                構成リビジョン: {database.revision}／項目:{" "}
                {database.properties.length}件
              </p>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setSelectedDatabaseId(database.id);
                  setRecordTitle("");
                  setRecordValues({});
                  setEditing(null);
                  setActionError("");
                  setNotice("");
                  setConfirmTrashId(null);
                }}
                disabled={busy}
              >
                {selected ? "選択中" : "このデータベースを選択"}
              </button>
            </article>
          );
        })}
      </section>

      <section aria-label="データベースの作成">
        <h3>データベースを作成</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createDatabase();
          }}
        >
          <fieldset disabled={busy}>
            <legend>新しいデータベース</legend>
            <label>
              表示名（この画面のみ。サーバーには保存されません）
              <input
                value={databaseLabel}
                onChange={(event) => setDatabaseLabel(event.target.value)}
                maxLength={200}
                autoComplete="off"
              />
            </label>
            <p>項目（{propertyDrafts.length}件）</p>
            {propertyDrafts.map((draft, index) => (
              <fieldset key={draft.key} aria-label={`項目${index + 1}`}>
                <legend>項目{index + 1}</legend>
                <label>
                  項目名
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      updateDraft(draft.key, { name: event.target.value })
                    }
                    maxLength={200}
                    autoComplete="off"
                  />
                </label>
                <label>
                  種類
                  <select
                    value={draft.type}
                    onChange={(event) =>
                      updateDraft(draft.key, {
                        type: event.target.value as Property["type"],
                      })
                    }
                  >
                    {PROPERTY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.type === "select" && (
                  <label>
                    選択肢（カンマまたは改行区切り）
                    <textarea
                      value={draft.optionsText}
                      onChange={(event) =>
                        updateDraft(draft.key, {
                          optionsText: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setPropertyDrafts((current) =>
                      current.length <= 1
                        ? current
                        : current.filter((item) => item.key !== draft.key),
                    )
                  }
                  disabled={propertyDrafts.length <= 1}
                >
                  この項目を削除
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() =>
                setPropertyDrafts((current) => [...current, newPropertyDraft()])
              }
            >
              項目を追加
            </button>
            <button type="submit">データベースを作成</button>
          </fieldset>
        </form>
      </section>

      {selectedDatabase !== null && (
        <section aria-label="レコード">
          <h3>
            レコード: {localLabels[selectedDatabase.id] ?? selectedDatabase.id}
          </h3>
          <p>
            構成リビジョン: {selectedDatabase.revision}／項目:{" "}
            {selectedDatabase.properties.length}件
          </p>

          <section aria-label="レコードの作成">
            <h4>レコードを作成</h4>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                createRecord(selectedDatabase);
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  タイトル
                  <input
                    value={recordTitle}
                    onChange={(event) => setRecordTitle(event.target.value)}
                    maxLength={500}
                    autoComplete="off"
                  />
                </label>
                {selectedDatabase.properties.map((property) => (
                  <label key={property.id}>
                    {property.name}（{TYPE_LABELS[property.type]}）
                    {renderValueInput(
                      property,
                      recordValues[property.id],
                      (raw) => updateRecordValue(property, raw),
                      busy,
                    )}
                  </label>
                ))}
                <button type="submit" disabled={busy}>
                  レコードを作成
                </button>
              </fieldset>
            </form>
          </section>

          <section aria-label="レコード一覧">
            <h4>レコード一覧</h4>
            {databaseRecords.length === 0 && <p>レコードはまだありません。</p>}
            {databaseRecords.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th scope="col">タイトル</th>
                    {selectedDatabase.properties.map((property) => (
                      <th scope="col" key={property.id}>
                        {property.name}（{TYPE_LABELS[property.type]}）
                      </th>
                    ))}
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {databaseRecords.map((record) => (
                    <tr key={record.id}>
                      <td>
                        {record.title.length === 0 ? "無題" : record.title}
                        {record.deleted ? "（削除済み）" : ""}
                      </td>
                      {selectedDatabase.properties.map((property) => (
                        <td key={property.id}>
                          {formatRecordValue(property, record.values)}
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          onClick={() => void openRecord(record)}
                          disabled={busy || record.deleted}
                        >
                          {openingId === record.id ? "開いています…" : "開く"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void beginEditing(record, selectedDatabase)
                          }
                          disabled={busy || record.deleted}
                        >
                          編集
                        </button>
                        {!record.deleted &&
                          (confirmTrashId === record.id ? (
                            <span role="group" aria-label="削除の確認">
                              <button
                                type="button"
                                onClick={() => performTrash(record)}
                                disabled={busy}
                              >
                                削除する
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmTrashId(null)}
                                disabled={busy}
                              >
                                取り消す
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => requestTrash(record)}
                              disabled={busy}
                            >
                              削除
                            </button>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {editing !== null && (
            <section aria-label="レコードの編集">
              <h4>レコードを編集</h4>
              {editingStale && (
                <p role="status">
                  データベースの構成が更新されています。保存するとサーバーが拒否する場合があります。編集をやり直す場合は一覧から編集を選び直してください。
                </p>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  saveEditing();
                }}
              >
                <fieldset disabled={busy}>
                  <label>
                    タイトル
                    <input
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      maxLength={500}
                      autoComplete="off"
                    />
                  </label>
                  {editing.properties.map((property) => (
                    <label key={property.id}>
                      {property.name}（{TYPE_LABELS[property.type]}）
                      {renderValueInput(
                        property,
                        editValues[property.id],
                        (raw) => updateEditValue(property, raw),
                        busy,
                      )}
                    </label>
                  ))}
                  <button type="submit" disabled={busy}>
                    変更を保存
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setEditTitle("");
                      setEditValues({});
                      setActionError("");
                    }}
                    disabled={busy}
                  >
                    編集をやめる
                  </button>
                </fieldset>
              </form>
            </section>
          )}
        </section>
      )}

      {selectedDatabaseId !== null &&
        view !== null &&
        selectedDatabase === null && (
          <p role="alert">
            選択中のデータベースが見つかりません。一覧を再読み込みしてください。
          </p>
        )}

      {recoveryVisible && (
        <section aria-label="復旧">
          <h3>受付状態の確認と復旧</h3>
          <p>
            サーバーの受付状態を確認できません。自動での再送信や破棄は行いません。入力内容は保持しています。
          </p>
          <button
            type="button"
            onClick={() => runRecovery("resourceReconcile")}
            disabled={busy}
          >
            受付状態を再確認
          </button>
          <button
            type="button"
            onClick={() => runRecovery("resourceRecover")}
            disabled={busy}
          >
            復元用の内容を表示
          </button>
          {recoveryError && <p role="alert">{recoveryError}</p>}
          {recoveryText.length > 0 && (
            <section aria-label="復元用の内容">
              <h4>復元用の内容</h4>
              <pre>{recoveryText}</pre>
            </section>
          )}
        </section>
      )}
    </section>
  );
}
