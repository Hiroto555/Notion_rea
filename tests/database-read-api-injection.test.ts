import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { saveFixture } from "./fixtures/r4-save-fixture";

const root = resolve(__dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}
const nodes = (root: ts.Node): ts.Node[] => [...walk(root)];
const calls = (root: ts.Node, callee: string): ts.CallExpression[] =>
  nodes(root).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText(root.getSourceFile()).replace(/\s+/g, "") ===
        callee.replace(/\s+/g, ""),
  );
const jsxAttr = (
  file: ts.SourceFile,
  tag: string,
  attr: string,
): ts.JsxAttribute[] =>
  nodes(file).filter((node): node is ts.JsxAttribute => {
    if (!ts.isJsxAttribute(node) || node.name.getText(file) !== attr)
      return false;
    const owner = node.parent?.parent;
    return (
      !!owner &&
      (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) &&
      owner.tagName.getText(file) === tag
    );
  });
const attrText = (file: ts.SourceFile, attr: ts.JsxAttribute): string =>
  attr.initializer &&
  ts.isJsxExpression(attr.initializer) &&
  attr.initializer.expression
    ? attr.initializer.expression.getText(file)
    : "";
const folioAccesses = (file: ts.SourceFile): ts.PropertyAccessExpression[] =>
  nodes(file).filter(
    (node): node is ts.PropertyAccessExpression =>
      ts.isPropertyAccessExpression(node) &&
      node.getText(file) === "window.folio",
  );
const functionNode = (file: ts.SourceFile, name: string): ts.FunctionDeclaration => {
  const declaration = nodes(file).find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.getText(file) === name,
  );
  expect(declaration).toBeDefined();
  return declaration!;
};
const functionText = (file: ts.SourceFile, name: string): string =>
  functionNode(file, name).getText(file);
const ordered = (text: string, markers: string[]): void => {
  let cursor = 0;
  for (const marker of markers) {
    const index = text.indexOf(marker, cursor);
    expect(index, `missing marker after ${cursor}: ${marker}`).toBeGreaterThanOrEqual(0);
    cursor = index + marker.length;
  }
};

const appFile = parse("src/renderer/App.tsx");
const liveFile = parse("src/renderer/LiveRecordDatabase.tsx");
const readOnlyDbFile = parse("src/renderer/RecordDatabaseReadOnly.tsx");

describe("App.openRecord: injected readRecord keeps the real ticket/selection/creatingCount/origin fence", () => {
  it("awaits appApi.workspace.readRecord(pageId) once, then re-checks the fences before the existing owner validator", () => {
    const openRecordNode = functionNode(appFile, "openRecord");
    const reads = calls(openRecordNode, "appApi.workspace.readRecord");
    expect(reads).toHaveLength(1);
    expect(reads[0].arguments).toHaveLength(1);
    expect(reads[0].arguments[0].getText(appFile)).toBe("pageId");
    const openRecord = functionText(appFile, "openRecord");
    ordered(openRecord, [
      "if (creatingCount.current || composition.current) return",
      "const originId = activeRef.current",
      "const selection = ++selectionVersion.current",
      "const ticket = ++recordOpenTicket.current",
      "await appApi.workspace.readRecord(pageId)",
      "ticket !== recordOpenTicket.current || selection !== selectionVersion.current || creatingCount.current",
      "validateRecordReadSnapshot(read, pageId, expectedOwner ?? read.record.databasePageId)",
      "sessions.current.attach(pair.page, pair.record)",
    ]);
    // The catch keeps its origin fence: only a same-ticket, same-selection
    // failure landing on the captured origin surfaces to fail().
    ordered(openRecord, [
      "catch (error)",
      "ticket === recordOpenTicket.current && selection === selectionVersion.current && activeRef.current === originId",
      "fail(error)",
    ]);
  });
});

describe("LiveRecordDatabase.tsx: mandatory port and the two cancelled/owner-validated effects", () => {
  const source = read("src/renderer/LiveRecordDatabase.tsx");

  it("takes a mandatory WorkspaceReadPort and issues exactly one readDatabase plus one readRecord through it", () => {
    expect(source).toContain("workspace: WorkspaceReadPort");
    expect(source).not.toContain("workspace?:");
    expect(calls(liveFile, "workspace.readDatabase")).toHaveLength(1);
    const recordReads = calls(liveFile, "workspace.readRecord");
    expect(recordReads).toHaveLength(1);
    expect(recordReads[0].arguments[0].getText(liveFile)).toBe("record.pageId");
  });

  it("keeps both effects cancelled-guarded with the owner validators before attach", () => {
    const effects = calls(liveFile, "useEffect");
    expect(effects).toHaveLength(2);
    for (const effect of effects)
      expect(effect.getText(liveFile)).toContain("cancelled");
    expect(source.match(/let cancelled = false/g)).toHaveLength(2);
    // Effect 1: database:read → owner Page id check → databases.attach.
    ordered(source, [
      "workspace.readDatabase(databasePageId)",
      "if (cancelled) return",
      "value.page.id !== databasePageId",
      "databases.attach(value.page, value.database)",
    ]);
    // Effect 2: record:read per record → cancelled → captured-owner validator
    // → sessions.attach. A delayed result never lands on a new owner.
    ordered(source, [
      "workspace.readRecord(record.pageId)",
      "if (cancelled) return",
      "validateRecordReadSnapshot(read, record.pageId, databasePageId)",
      "sessions.attach(pair.page, pair.record)",
    ]);
  });

  it("carries no window.folio or generic request path — the port is the only read lane", () => {
    expect(folioAccesses(liveFile)).toHaveLength(0);
    expect(source).not.toMatch(/\.request\s*\(|createDiagnosticRequest|api\(\{/);
  });
});

describe("RecordDatabaseReadOnly.tsx: unmounted definition keeps the mandatory read-only port", () => {
  const source = read("src/renderer/RecordDatabaseReadOnly.tsx");

  it("requires WorkspaceReadPort, loads once through loadDatabase and keeps cancelled + all-records owner check", () => {
    expect(source).toContain("workspace: WorkspaceReadPort");
    expect(source).not.toContain("workspace?:");
    const loads = calls(readOnlyDbFile, "workspace.loadDatabase");
    expect(loads).toHaveLength(1);
    expect(loads[0].arguments[0].getText(readOnlyDbFile)).toBe("databasePageId");
    ordered(source, [
      "let cancelled",
      ".loadDatabase(databasePageId)",
      "if (cancelled) return",
      "record.databasePageId !== databasePageId",
    ]);
    expect(folioAccesses(readOnlyDbFile)).toHaveLength(0);
  });

  it("stays unmounted: App never renders it and injects no workspace into it", () => {
    const usages = nodes(appFile).filter(
      (node) =>
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(appFile) === "RecordDatabaseReadOnly",
    );
    expect(usages).toHaveLength(0);
  });
});

describe("App root: the same appApi.workspace reaches LiveRecordDatabase and nothing else is injected", () => {
  it("passes workspace={appApi.workspace} — the identical port openRecord reads through", () => {
    const attrs = jsxAttr(appFile, "LiveRecordDatabase", "workspace");
    expect(attrs).toHaveLength(1);
    expect(attrText(appFile, attrs[0])).toBe("appApi.workspace");
    // No write/shared/compat surface is newly injected into the read branch.
    for (const attr of ["api", "shared", "desktopCompatibility"])
      expect(jsxAttr(appFile, "LiveRecordDatabase", attr)).toHaveLength(0);
  });
});

describe("existing fixture: the store produces exactly the three discriminants the injected callers send", () => {
  it("database:read / database:load / record:read return the shapes the callers validate", () => {
    const f = saveFixture();
    try {
      const databaseRead = f.store.handle({
        type: "database:read",
        databasePageId: f.owner.id,
      });
      expect(databaseRead).toMatchObject({
        page: { id: f.owner.id, kind: "database" },
      });
      const databaseLoad = f.store.handle({
        type: "database:load",
        databasePageId: f.owner.id,
      });
      expect(databaseLoad).toMatchObject({ revision: expect.any(Number) });
      const recordRead = f.store.handle({
        type: "record:read",
        pageId: f.record.pageId,
      });
      expect(recordRead).toMatchObject({
        page: { id: f.record.pageId, kind: "page" },
        record: { pageId: f.record.pageId, databasePageId: f.owner.id },
      });
    } finally {
      f.dispose();
    }
  });
});
