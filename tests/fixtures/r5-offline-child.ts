/**
 * Child fixture for tests/r5-offline-lifecycle.test.ts.
 *
 * Each invocation is a fresh Node process. Before the Store is opened, the
 * ordinary Node network entry points are replaced with throwing stubs, and
 * fetch plus TCP are self-tested. This is a child-local deny shim, not kernel
 * or OS network isolation: it makes accidental application-level network use
 * fail loudly, but a native addon or code that bypasses these shims could
 * still reach the network.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { writeRecoveryFile } from "../../src/persistence/recovery-file";
import { Store } from "../../src/persistence/store";
import {
  preparePageCreation,
  type PageOperation,
  type PageOperationResult,
} from "../../src/shared/page-operation";
import { recoveryContent } from "../../src/shared/recovery";
import type { Doc, Page } from "../../src/shared/types";

const GUARD_PREFIX = "OFFLINE_GUARD:";
const SEARCH_QUERY = "original body";
// esbuild wraps namespace imports of external builtins in getter-only objects.
// Patch the real built-in module objects so the denial cannot be silently lost.
const net = process.getBuiltinModule("node:net") as typeof import("node:net");
const http = process.getBuiltinModule(
  "node:http",
) as typeof import("node:http");
const https = process.getBuiltinModule(
  "node:https",
) as typeof import("node:https");
const http2 = process.getBuiltinModule(
  "node:http2",
) as typeof import("node:http2");
const dns = process.getBuiltinModule("node:dns") as typeof import("node:dns");
const dgram = process.getBuiltinModule(
  "node:dgram",
) as typeof import("node:dgram");
const DNS_CALLBACK_METHODS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const;

type Config = {
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

type CreateOutput = {
  phase: "create";
  pid: number;
  guard: GuardReport;
  operationId: string;
  fingerprint: string;
  status: "applied";
  pageId: string;
  title: string;
  doc: Doc;
  pageCount: number;
  receiptCount: number;
  searchIds: string[];
  operationHash: string;
  sourceHash: string;
  exportHash: string;
};

type ResolveOutput = {
  phase: "resolve";
  pid: number;
  guard: GuardReport;
  operationId: string;
  fingerprint: string;
  status: "applied";
  pageId: string;
  title: string;
  doc: Doc;
  pageCountBefore: number;
  pageCount: number;
  receiptCountBefore: number;
  receiptCount: number;
  sourceHash: string;
  sourceAfterHash: string;
  operationHash: string;
  operationAfterHash: string;
  sourceExportHash: string;
  sourceExportAfterHash: string;
  exportHash: string;
  sameAsCreateExport: boolean;
};

function deny(api: string): never {
  throw new Error(GUARD_PREFIX + api);
}

function replaceWithDenial(target: object, api: string, method: string): void {
  (target as unknown as Record<string, unknown>)[method] = (): never =>
    deny(`${api}.${method}`);
}

function replaceWithAsyncDenial(
  target: object,
  api: string,
  method: string,
): void {
  (target as unknown as Record<string, unknown>)[method] =
    async (): Promise<never> => deny(`${api}.${method}`);
}

function installOfflineGuard(): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (): never => deny("fetch"),
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: class BlockedWebSocket {
      constructor() {
        deny("WebSocket");
      }
    },
  });

  replaceWithDenial(net, "net", "connect");
  replaceWithDenial(net, "net", "createConnection");
  (net.Socket.prototype as unknown as Record<string, unknown>).connect =
    (): never => deny("net.Socket.connect");

  for (const method of ["request", "get"] as const) {
    replaceWithDenial(http, "http", method);
    replaceWithDenial(https, "https", method);
  }
  replaceWithDenial(http2, "http2", "connect");
  replaceWithDenial(dgram, "dgram", "createSocket");

  for (const method of DNS_CALLBACK_METHODS)
    replaceWithDenial(dns, "dns", method);
  for (const method of [
    "lookup",
    "lookupService",
    "resolve",
    "reverse",
  ] as const)
    replaceWithAsyncDenial(dns.promises, "dns.promises", method);

  const callbackResolver = dns.Resolver.prototype as unknown as Record<
    string,
    unknown
  >;
  for (const method of DNS_CALLBACK_METHODS) {
    if (method === "lookup" || method === "lookupService") continue;
    if (typeof callbackResolver[method] === "function")
      callbackResolver[method] = (): never => deny(`dns.Resolver.${method}`);
  }

  const PromiseResolver = (
    dns.promises as unknown as {
      Resolver?: { prototype: Record<string, unknown> };
    }
  ).Resolver;
  if (PromiseResolver) {
    for (const method of DNS_CALLBACK_METHODS) {
      if (typeof PromiseResolver.prototype[method] === "function")
        PromiseResolver.prototype[method] = async (): Promise<never> =>
          deny(`dns.promises.Resolver.${method}`);
    }
  }
}

function selfTestOfflineGuard(): GuardReport {
  let fetchBlocked = false;
  try {
    void (globalThis.fetch as unknown as (url: string) => unknown)(
      "http://127.0.0.1:9/r5-offline-self-test",
    );
  } catch (error) {
    fetchBlocked =
      error instanceof Error && error.message === `${GUARD_PREFIX}fetch`;
  }
  if (!fetchBlocked)
    throw new Error("offline guard self-test failed: fetch was not denied");

  let tcpBlocked = false;
  try {
    net.connect({ host: "127.0.0.1", port: 9 });
  } catch (error) {
    tcpBlocked =
      error instanceof Error && error.message === `${GUARD_PREFIX}net.connect`;
  }
  if (!tcpBlocked)
    throw new Error(
      "offline guard self-test failed: TCP connect was not denied",
    );

  let socketBlocked = false;
  try {
    new net.Socket().connect({ host: "127.0.0.1", port: 9 });
  } catch (error) {
    socketBlocked =
      error instanceof Error &&
      error.message === `${GUARD_PREFIX}net.Socket.connect`;
  }
  if (!socketBlocked)
    throw new Error(
      "offline guard self-test failed: Socket.connect was not denied",
    );

  return { fetch: "blocked", tcp: "blocked", socket: "blocked" };
}

function readConfig(): Config {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing child config argument");
  const config = JSON.parse(raw) as Config;
  if (!config || typeof config !== "object")
    throw new Error("invalid child config");
  if (config.mode !== "create" && config.mode !== "resolve")
    throw new Error("invalid child mode");
  for (const key of [
    "databasePath",
    "operationPath",
    "exportPath",
    "expectedTitle",
  ] as const) {
    if (typeof config[key] !== "string" || !config[key])
      throw new Error(`missing child config: ${key}`);
  }
  if (!config.expectedDoc || typeof config.expectedDoc !== "object")
    throw new Error("missing child config: expectedDoc");
  return config;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function appliedPage(result: PageOperationResult): Page {
  if (result.status !== "applied" || !result.page)
    throw new Error(
      `operation did not apply: ${result.status} ${result.message ?? ""}`,
    );
  return result.page;
}

function assertOriginalPage(page: Page, config: Config): void {
  if (!page.id || typeof page.id !== "string")
    throw new Error("resolved Page has no id");
  if (page.title !== config.expectedTitle)
    throw new Error(
      `Page title changed: ${JSON.stringify(page.title)} !== ${JSON.stringify(config.expectedTitle)}`,
    );
  if (!isDeepStrictEqual(page.doc, config.expectedDoc))
    throw new Error("Page document changed");
  if (
    page.kind !== "page" ||
    page.parentId !== null ||
    page.revision !== 0 ||
    page.deletedAt !== null
  )
    throw new Error("resolved Page is not the original ordinary root Page");
}

function assertCreateCommand(operation: PageOperation, config: Config): void {
  if (operation.command.kind !== "createPage")
    throw new Error("operation is not a createPage command");
  if (
    operation.command.parentId !== null ||
    operation.command.title !== config.expectedTitle ||
    !isDeepStrictEqual(operation.command.doc, config.expectedDoc)
  )
    throw new Error("persisted createPage command does not match the fixture");
}

function pageSource(store: Store, id: string): string {
  const source = store.handle({ type: "pageSource", id });
  if (typeof source !== "string")
    throw new Error("pageSource did not return the raw Page JSON");
  return source;
}

function receiptCount(store: Store): number {
  return (
    store.db.prepare("SELECT count(*) AS n FROM save_receipts").get() as {
      n: number;
    }
  ).n;
}

function assertSingleRecoveryPage(content: string, pageId: string): void {
  const parsed = JSON.parse(content) as { pages?: { id?: unknown }[] };
  if (
    !parsed ||
    !Array.isArray(parsed.pages) ||
    parsed.pages.length !== 1 ||
    parsed.pages[0]?.id !== pageId
  )
    throw new Error("recovery export is not the expected single Page");
}

function create(config: Config, guard: GuardReport): CreateOutput {
  const store = new Store(config.databasePath);
  try {
    const operation = preparePageCreation(
      config.expectedTitle,
      null,
      config.expectedDoc,
    );
    const operationText = JSON.stringify(operation);
    // The operation identity lives only in this temporary file, never in the
    // workspace. The Store receipt is the authoritative durable identity.
    writeFileSync(config.operationPath, operationText, {
      encoding: "utf8",
      mode: 0o600,
    });

    const result = store.handle({
      type: "page:commit",
      operation,
    }) as PageOperationResult;
    const page = appliedPage(result);
    assertOriginalPage(page, config);

    const pageCount = store.pages().length;
    if (pageCount !== 1)
      throw new Error(`expected one Page after commit, found ${pageCount}`);
    const receipts = receiptCount(store);
    if (receipts !== 1)
      throw new Error(`expected one receipt after commit, found ${receipts}`);

    const search = store.handle({
      type: "search",
      query: SEARCH_QUERY,
    }) as Page[];
    if (
      !Array.isArray(search) ||
      search.length !== 1 ||
      search[0].id !== page.id
    )
      throw new Error("search did not return exactly the created Page");

    const sourceBefore = pageSource(store, page.id);
    const exportText = recoveryContent([page], [{ id: page.id, patch: {} }]);
    writeRecoveryFile(config.exportPath, exportText);
    const sourceAfter = pageSource(store, page.id);
    if (sourceBefore !== sourceAfter)
      throw new Error("recovery export changed the Page source");

    const exportOnDisk = readFileSync(config.exportPath, "utf8");
    if (exportOnDisk !== exportText)
      throw new Error("recovery export file does not match its content");
    assertSingleRecoveryPage(exportOnDisk, page.id);

    return {
      phase: "create",
      pid: process.pid,
      guard,
      operationId: operation.operationId,
      fingerprint: result.fingerprint,
      status: "applied",
      pageId: page.id,
      title: page.title,
      doc: page.doc,
      pageCount,
      receiptCount: receipts,
      searchIds: search.map((entry) => entry.id),
      operationHash: sha256(operationText),
      sourceHash: sha256(sourceBefore),
      exportHash: sha256(exportOnDisk),
    };
  } finally {
    store.close();
  }
}

function resolve(config: Config, guard: GuardReport): ResolveOutput {
  const sourceExportPath = config.sourceExportPath;
  if (!sourceExportPath)
    throw new Error("resolve mode requires sourceExportPath");
  if (!config.expectedPageId)
    throw new Error("resolve mode requires expectedPageId");

  const operationTextBefore = readFileSync(config.operationPath, "utf8");
  const operation = JSON.parse(operationTextBefore) as PageOperation;
  assertCreateCommand(operation, config);
  const sourceExportBefore = readFileSync(sourceExportPath, "utf8");
  assertSingleRecoveryPage(sourceExportBefore, config.expectedPageId);

  const store = new Store(config.databasePath);
  try {
    const pagesBefore = store.pages();
    if (pagesBefore.length !== 1)
      throw new Error(
        `expected one Page before resolve, found ${pagesBefore.length}`,
      );
    const pageBefore = pagesBefore[0];
    if (pageBefore.id !== config.expectedPageId)
      throw new Error("reopened Store resolved a different Page");
    assertOriginalPage(pageBefore, config);
    const receiptsBefore = receiptCount(store);
    if (receiptsBefore !== 1)
      throw new Error(
        `expected one receipt before resolve, found ${receiptsBefore}`,
      );
    const sourceBefore = pageSource(store, pageBefore.id);

    const result = store.handle({
      type: "page:resolve",
      operation,
    }) as PageOperationResult;
    const resolvedPage = appliedPage(result);
    if (result.operationId !== operation.operationId)
      throw new Error("resolved a different operation id");
    assertOriginalPage(resolvedPage, config);
    if (resolvedPage.id !== pageBefore.id)
      throw new Error("resolve returned a different Page id");

    const pagesAfter = store.pages();
    if (pagesAfter.length !== 1 || pagesAfter[0].id !== pageBefore.id)
      throw new Error("resolve created or changed a Page");
    const pageAfter = store.get(pageBefore.id);
    assertOriginalPage(pageAfter, config);
    const sourceAfter = pageSource(store, pageBefore.id);
    if (sourceAfter !== sourceBefore)
      throw new Error("resolve changed the Page source");
    const receiptsAfter = receiptCount(store);
    if (receiptsAfter !== 1)
      throw new Error(
        `expected one receipt after resolve, found ${receiptsAfter}`,
      );

    const operationTextAfter = readFileSync(config.operationPath, "utf8");
    if (operationTextAfter !== operationTextBefore)
      throw new Error("resolve changed the persisted operation JSON");

    const exportText = recoveryContent(
      [pageAfter],
      [{ id: pageAfter.id, patch: {} }],
    );
    writeRecoveryFile(config.exportPath, exportText);
    const sourceExportAfter = readFileSync(sourceExportPath, "utf8");
    if (sourceExportAfter !== sourceExportBefore)
      throw new Error("local export changed the source recovery file");

    const exportOnDisk = readFileSync(config.exportPath, "utf8");
    if (exportOnDisk !== exportText)
      throw new Error("local export file does not match its content");
    assertSingleRecoveryPage(exportOnDisk, pageAfter.id);

    return {
      phase: "resolve",
      pid: process.pid,
      guard,
      operationId: operation.operationId,
      fingerprint: result.fingerprint,
      status: "applied",
      pageId: pageAfter.id,
      title: pageAfter.title,
      doc: pageAfter.doc,
      pageCountBefore: pagesBefore.length,
      pageCount: pagesAfter.length,
      receiptCountBefore: receiptsBefore,
      receiptCount: receiptsAfter,
      sourceHash: sha256(sourceBefore),
      sourceAfterHash: sha256(sourceAfter),
      operationHash: sha256(operationTextBefore),
      operationAfterHash: sha256(operationTextAfter),
      sourceExportHash: sha256(sourceExportBefore),
      sourceExportAfterHash: sha256(sourceExportAfter),
      exportHash: sha256(exportOnDisk),
      sameAsCreateExport: exportOnDisk === sourceExportBefore,
    };
  } finally {
    store.close();
  }
}

function main(): CreateOutput | ResolveOutput {
  installOfflineGuard();
  const guard = selfTestOfflineGuard();
  const config = readConfig();
  return config.mode === "create"
    ? create(config, guard)
    : resolve(config, guard);
}

try {
  process.stdout.write(JSON.stringify({ ok: true, ...main() }) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    }) + "\n",
  );
  process.exitCode = 1;
}
