import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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
const nodes = (file: ts.SourceFile): ts.Node[] => [...walk(file)];
const calls = (file: ts.SourceFile, callee: string): ts.CallExpression[] =>
  nodes(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText(file).replace(/\s+/g, "") ===
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
  attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression
    ? attr.initializer.expression.getText(file)
    : "";
const folioAccesses = (file: ts.SourceFile): ts.PropertyAccessExpression[] =>
  nodes(file).filter(
    (node): node is ts.PropertyAccessExpression =>
      ts.isPropertyAccessExpression(node) &&
      node.getText(file) === "window.folio",
  );

const mainFile = parse("src/renderer/main.tsx");
const startupFile = parse("src/renderer/StartupApp.tsx");
const appFile = parse("src/renderer/App.tsx");
const readOnlyFile = parse("src/renderer/ReadOnlyWorkspace.tsx");

describe("main.tsx: bindings are built once, outside React", () => {
  it("creates the bindings exactly once at module scope from window.folio, before createRoot", () => {
    const factoryCalls = calls(mainFile, "createDesktopRootBindings");
    expect(factoryCalls).toHaveLength(1);
    const factory = factoryCalls[0];
    expect(factory.arguments).toHaveLength(1);
    expect(factory.arguments[0].getText(mainFile)).toBe("window.folio");
    // Module scope: walking ancestors reaches the SourceFile without a
    // function, JSX or render boundary.
    let node: ts.Node | undefined = factory;
    while (node && !ts.isSourceFile(node)) {
      expect(ts.isFunctionLike(node)).toBe(false);
      expect(ts.isJsxElement(node)).toBe(false);
      node = node.parent;
    }
    expect(node && ts.isSourceFile(node)).toBe(true);
    const renderCall = nodes(mainFile).find(
      (candidate): candidate is ts.CallExpression =>
        ts.isCallExpression(candidate) &&
        candidate.expression.getText(mainFile).includes("createRoot"),
    );
    expect(renderCall).toBeDefined();
    expect(factory.getStart()).toBeLessThan(renderCall!.getStart());
    expect(calls(mainFile, "createRoot")).toHaveLength(1);
    expect(read("src/renderer/main.tsx")).toContain("React.StrictMode");
  });

  it("passes the bindings as the required desktop prop to StartupApp", () => {
    const attrs = jsxAttr(mainFile, "StartupApp", "desktop");
    expect(attrs).toHaveLength(1);
    expect(attrText(mainFile, attrs[0])).toBe("desktop");
  });
});

describe("StartupApp.tsx: startup status and fan-out through injected bindings", () => {
  it("reads the startup status through readOnly.workspace.startupStatus() with no window access", () => {
    const statusCalls = calls(
      startupFile,
      "desktop.readOnly.workspace.startupStatus",
    );
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0].arguments).toHaveLength(0);
    expect(folioAccesses(startupFile)).toHaveLength(0);
    expect(startupFile.getText()).toContain("DesktopRootBindings");
  });

  it("passes only the read-only API to the read-only branch", () => {
    const apis = jsxAttr(startupFile, "ReadOnlyWorkspace", "api");
    expect(apis).toHaveLength(1);
    expect(attrText(startupFile, apis[0])).toBe("desktop.readOnly");
    const statuses = jsxAttr(startupFile, "ReadOnlyWorkspace", "status");
    expect(attrText(startupFile, statuses[0])).toBe("status");
  });

  it("passes the writable API and separate compat prop to the writable App", () => {
    const apis = jsxAttr(startupFile, "App", "api");
    expect(apis).toHaveLength(1);
    expect(attrText(startupFile, apis[0])).toBe("desktop.writable");
    const compats = jsxAttr(startupFile, "App", "desktopCompatibility");
    expect(compats).toHaveLength(1);
    expect(attrText(startupFile, compats[0])).toBe("desktop.compatibility");
    const syncs = jsxAttr(startupFile, "App", "syncMessage");
    expect(attrText(startupFile, syncs[0])).toBe("status.syncMessage");
  });
});

describe("App.tsx: compat closure, root-owned loads and C04 continuity", () => {
  it("uses the stable injected compat closure instead of a module-level window adapter", () => {
    expect(calls(appFile, "createDiagnosticRequest")).toHaveLength(0);
    expect(read("src/renderer/App.tsx")).not.toContain(
      "import { createDiagnosticRequest",
    );
    const declarations = nodes(appFile).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(appFile) === "api" &&
        !!node.initializer &&
        node.initializer.getText(appFile) === "desktopCompatibility.request",
    );
    expect(declarations).toHaveLength(1);
    // The compat closure is the function's first statement so every C04 ref
    // and closure created after it keeps the same receiver-bound reference.
    const appFunction = nodes(appFile).find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.getText(appFile) === "App",
    );
    expect(appFunction).toBeDefined();
    expect(declarations[0].getStart()).toBeGreaterThan(
      appFunction!.getStart(),
    );
    expect(appFunction!.body && ts.isBlock(appFunction!.body)).toBe(true);
    const firstStatement = (appFunction!.body as ts.Block).statements[0];
    expect(firstStatement.getText(appFile)).toContain(
      "desktopCompatibility.request",
    );
  });

  it("takes required props with no default-object fallback", () => {
    const source = read("src/renderer/App.tsx");
    expect(source).toContain("api: appApi");
    expect(source).toContain("desktopCompatibility");
    expect(source).toContain("desktopCompatibility: DesktopCompatibility");
    expect(source).toContain("api: AppApi");
    expect(source).not.toMatch(/\}\s*=\s*\{\}\)\s*\{/);
  });

  it("routes the three root-owned loads through appApi.workspace.load()", () => {
    expect(calls(appFile, "appApi.workspace.load")).toHaveLength(3);
    const loadLiterals = nodes(appFile).filter(
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        node.name.getText(appFile) === "type" &&
        node.initializer.getText(appFile) === '"load"',
    );
    expect(loadLiterals).toHaveLength(0);
  });

  it("hands SharedWorkbench the injected shared reference exactly", () => {
    const apis = jsxAttr(appFile, "SharedWorkbench", "api");
    expect(apis).toHaveLength(1);
    expect(attrText(appFile, apis[0])).toBe("appApi.shared");
  });

  it("hands StructuralDatabaseDialog the injected workspace and structure ports", () => {
    const workspaces = jsxAttr(appFile, "StructuralDatabaseDialog", "workspace");
    expect(workspaces).toHaveLength(1);
    expect(attrText(appFile, workspaces[0])).toBe("appApi.workspace");
    const structures = jsxAttr(appFile, "StructuralDatabaseDialog", "structure");
    expect(structures).toHaveLength(1);
    expect(attrText(appFile, structures[0])).toBe("appApi.structure");
  });

  it("injects the purpose bridges into the two owned coordinators and the standalone DB lane", () => {
    const source = read("src/renderer/App.tsx");
    expect(calls(appFile, "createPurposeBridges")).toHaveLength(1);
    expect(source).toContain("createPurposeBridges(appApi)");
    expect(source).toContain("new EditSessionCoordinator(purpose.save");
    expect(source).toContain("new DatabaseSessionCoordinator(purpose.database");
    expect(source).toContain("sendDatabaseOperation(operation, purpose.database)");
    expect(source).toContain(
      "resolveDatabaseOperation(pending.operation, purpose.database)",
    );
  });

  it("keeps the only window.folio touch as the read-only environment guard", () => {
    const accesses = folioAccesses(appFile);
    expect(accesses).toHaveLength(1);
    const guard = accesses[0].parent;
    expect(guard && ts.isPrefixUnaryExpression(guard)).toBe(true);
    expect(
      (guard as ts.PrefixUnaryExpression).operator ===
        ts.SyntaxKind.ExclamationToken,
    ).toBe(true);
  });

  it("keeps the backup-hold entry → after-await guard → send ordering intact", () => {
    const source = read("src/renderer/App.tsx");
    for (const marker of [
      "createBackupWriteHold()",
      "createBackupWriteEntry(hold, deps)",
      "send: api",
      "deps.prepare = prepareWorkspaceBackup",
      "deps.prepareFailure = latchedRecoveryError",
      "latchedRecoveryError()",
      "backupHold={backupWriteHold}",
      "backupCloseReleaseAllowed(backupWriteHold)",
      'api({type: "workspaceBackup:release"})',
    ])
      expect(source).toContain(marker);
    const compatIndex = source.indexOf("desktopCompatibility.request");
    const holdIndex = source.indexOf("createBackupWriteHold()");
    const entryIndex = source.indexOf("createBackupWriteEntry(hold, deps)");
    expect(compatIndex).toBeGreaterThanOrEqual(0);
    expect(compatIndex).toBeLessThan(holdIndex);
    expect(holdIndex).toBeLessThan(entryIndex);
    expect(source).toContain("recoveryGuardedRequest");
    expect(source).toContain("workspaceBackup:create");
    // No new await was inserted between the release guard and the release send.
    const guardIndex = source.indexOf(
      "backupCloseReleaseAllowed(backupWriteHold)",
    );
    const releaseIndex = source.indexOf('api({type: "workspaceBackup:release"})');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(guardIndex);
  });
});

describe("ReadOnlyWorkspace.tsx: original, salvage and capability reads run through injected ports", () => {
  it("loads through the injected workspace port exactly once", () => {
    expect(calls(readOnlyFile, "api.workspace.load")).toHaveLength(1);
    const source = read("src/renderer/ReadOnlyWorkspace.tsx");
    expect(source).toContain("api: ReadOnlyAppApi");
  });

  it("migrates pageSource / export / storage:rawSalvage to the readonly ports with no legacy request", () => {
    expect(calls(readOnlyFile, "window.folio.request")).toHaveLength(0);
    expect(folioAccesses(readOnlyFile)).toHaveLength(0);
    expect(calls(readOnlyFile, "api.original.readOriginal")).toHaveLength(1);
    expect(calls(readOnlyFile, "api.original.exportOriginal")).toHaveLength(1);
    expect(calls(readOnlyFile, "api.recovery.salvageRaw")).toHaveLength(1);
    const source = read("src/renderer/ReadOnlyWorkspace.tsx");
    for (const type of [
      '"pageSource"',
      '"export"',
      '"storage:rawSalvage"',
    ])
      expect(source).not.toContain(type);
  });

  it("reads capabilities once on mount behind the active fence and never before an action", () => {
    const source = read("src/renderer/ReadOnlyWorkspace.tsx");
    expect(calls(readOnlyFile, "api.capabilities.read")).toHaveLength(1);
    expect(source).toContain("let active = true");
    expect(source).toContain("fileExportNotice");
    expect(source).not.toMatch(/await\s+api\.capabilities/);
  });
});

describe("shared/app-api.ts and renderer/desktop-api.ts stay inside the contract", () => {
  it("app-api is type-only and carries no generic transport, channel or handle", () => {
    const source = read("src/shared/app-api.ts");
    for (const marker of [
      "export interface WorkspaceReadPort",
      "startupStatus(): Promise<StartupStatus>",
      "load(): Promise<Snapshot>",
      "readDatabase(databasePageId: string): Promise<DatabaseReadSnapshot>",
      "loadDatabase(databasePageId: string): Promise<DatabaseProjection>",
      "readRecord(pageId: string): Promise<RecordReadSnapshot>",
      "export interface EditingPort",
      "commitSave(operation: SaveOperation): Promise<SaveResult>",
      "resolveSave(operation: SaveOperation): Promise<SaveResult>",
      "commitDatabase(operation: DatabaseOperation): Promise<DatabaseOperationResult>",
      "resolveDatabase(operation: DatabaseOperation): Promise<DatabaseOperationResult>",
      "export interface StructurePort",
      "previewMigration(databasePageId: string): Promise<LegacyMigrationPreview>",
      "previewProperty(",
      "commitMigration(operation: LegacyMigrationOperation): Promise<LegacyMigrationResult>",
      "resolveMigration(operation: LegacyMigrationOperation): Promise<LegacyMigrationResult>",
      "commitProperty(operation: PropertyOperation): Promise<PropertyOperationResult>",
      "resolveProperty(operation: PropertyOperation): Promise<PropertyOperationResult>",
      "export interface ReadOnlyAppApi",
      "readonly workspace: WorkspaceReadPort",
      "export interface OriginalReadPort",
      "readOriginal(pageId: string): Promise<string>",
      "exportOriginal(",
      "export interface RecoverySalvagePort",
      "salvageRaw(): Promise<RawSalvageResult | null>",
      "export interface CapabilitiesReadPort",
      "read(): Promise<DesktopCapabilities | null>",
      "export interface StorageReadPort",
      "readPressure(): Promise<StoragePressureSnapshot>",
      "readonly original: OriginalReadPort",
      "readonly recovery: RecoverySalvagePort",
      "readonly capabilities: CapabilitiesReadPort",
      "export interface AppApi extends ReadOnlyAppApi",
      "readonly editing: EditingPort",
      "readonly structure: StructurePort",
      "readonly shared: SharedRuntimeAPI | undefined",
      "readonly storage: StorageReadPort",
    ])
      expect(source).toContain(marker);
    expect(source).not.toMatch(/\bRequest\b/);
    expect(source).not.toMatch(/channel|credential|handle/i);
    expect(source).not.toMatch(/export\s+(const|let|var|function|class)\b/);
  });

  it("desktop-api is pure DI: no window, IPC channel or preload discovery", () => {
    const source = read("src/renderer/desktop-api.ts");
    expect(source).toContain("export function createDesktopRootBindings");
    expect(source).toContain("createDiagnosticRequest");
    for (const marker of [
      '{ type: "database:read", databasePageId }',
      '{ type: "database:load", databasePageId }',
      '{ type: "record:read", pageId }',
    ])
      expect(source).toContain(marker);
    expect(source).not.toMatch(/\bwindow\b/);
    expect(source).not.toMatch(/ipcRenderer|folio:request|require\(/);
    expect(source).not.toMatch(/from\s+["']electron["']/);
  });
});
