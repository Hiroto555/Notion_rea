/**
 * Product-facing child process for tests/sync-level4.test.ts.
 *
 * The child owns its own Store, assets directory, client id and binding id.
 * It performs only public Store/product operations and the frozen
 * `openWorkspaceSync` API.  The parent never shares a SQLite handle or a
 * JavaScript object with this process; the only channel is JSON in/out and
 * files used as explicit fault barriers.
 *
 * This fixture intentionally does not import integration source by name: the
 * test builds a generated entry that imports the real Codex modules and passes
 * the concrete API object to `runProductChild`.  That keeps the baseline
 * TypeScript check independent of modules another lane still owns.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Level4Api, Level4Store, Level4Sync } from "./sync-level4-support";

type Config = {
  databasePath: string;
  assetsPath: string;
  baseUrl: string;
  token: string;
  workspaceId: string;
  clientId: string;
  bindingId: string;
  canApply?: boolean;
  timeoutMs?: number;
  steps: any[];
  outputPath: string;
};

type Execution = {
  store: Level4Store | undefined;
  sync: Level4Sync | undefined;
  sessionId: string;
  seq: number;
  vars: Record<string, any>;
};

const result: {
  ok: boolean;
  error?: string;
  stack?: string;
  steps: any[];
  vars: Record<string, any>;
} = { ok: false, steps: [], vars: {} };

function resolvePath(source: any, path: string): any {
  let value = source;
  for (const part of path.split(".")) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

/** Replace "${var.path}" strings with values captured by a previous step. */
function resolveRefs(value: any, vars: Record<string, any>): any {
  if (typeof value === "string") {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_.]*)\}$/.exec(value);
    return match ? resolvePath(vars, match[1]) : value;
  }
  if (Array.isArray(value))
    return value.map((entry) => resolveRefs(entry, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveRefs(entry, vars),
      ]),
    );
  }
  return value;
}

function requireStore(execution: Execution): Level4Store {
  if (!execution.store) throw new Error("step requires an open Store");
  return execution.store;
}

function requireSync(execution: Execution): Level4Sync {
  if (!execution.sync) throw new Error("step requires an open workspace sync");
  return execution.sync;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(sync: Level4Sync | undefined): any {
  if (!sync) return null;
  try {
    return sync.status();
  } catch (error) {
    return { error: errorText(error) };
  }
}

function pageOf(store: Level4Store, id: string): any {
  return store.get(id);
}

function currentRevision(store: Level4Store, id: string): number {
  return store.get(id).revision;
}

async function drive(sync: Level4Sync, maxCalls = 24): Promise<any> {
  let previous = "";
  let status = sync.status();
  for (let index = 0; index < maxCalls; index++) {
    status = await sync.syncOnce();
    const key = JSON.stringify(status);
    if (status.conflict) return status;
    if (!status.pending && key === previous) return status;
    previous = key;
  }
  return status;
}

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rejectPromise(new Error(`timed out waiting for ${path}`));
      }
    }, 20);
    timer.unref?.();
  });
}

function blockForever(): never {
  // A parent that fails to deliver SIGKILL makes the test time out instead of
  // silently continuing into a false success.
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0);
  throw new Error("killed-child barrier was released without SIGKILL");
}

async function execute(
  api: Level4Api,
  config: Config,
  execution: Execution,
  step: any,
): Promise<any> {
  switch (step.kind) {
    case "open": {
      const store = new api.Store(config.databasePath);
      let sync: Level4Sync;
      try {
        sync = await api.openWorkspaceSync({
          store,
          baseUrl: config.baseUrl,
          token: config.token,
          workspaceId: config.workspaceId,
          clientId: config.clientId,
          bindingId: config.bindingId,
          ...(step.mode ? { mode: step.mode } : {}),
          canApply: () => config.canApply !== false,
          timeoutMs: config.timeoutMs ?? 5_000,
        });
      } catch (error) {
        store.close();
        throw error;
      }
      execution.store = store;
      execution.sync = sync;
      return {
        status: sync.status(),
        epoch: sync.writeEpoch(),
      };
    }
    case "createPage": {
      const store = requireStore(execution);
      const page = store.create(
        step.parentId ?? null,
        step.kindOfPage === "database" ? "database" : "page",
        step.title ?? "無題",
        step.doc === undefined ? undefined : structuredClone(step.doc),
      );
      return page;
    }
    case "save": {
      const store = requireStore(execution);
      const pageId = step.pageId;
      const before = pageOf(store, pageId);
      const patch: any = {};
      if (step.title !== undefined) patch.title = step.title;
      if (step.doc !== undefined) patch.doc = structuredClone(step.doc);
      if (step.favorite !== undefined) patch.favorite = step.favorite;
      const saveResult = store.commitSave({
        operationId: randomUUID(),
        sessionId: execution.sessionId,
        seq: ++execution.seq,
        pageId,
        databasePageId: step.databasePageId ?? null,
        revision: step.revision ?? before.revision,
        patch,
        ...(step.values === undefined ? {} : { values: step.values }),
      });
      if (saveResult.status !== "applied") {
        throw new Error(
          `save was ${saveResult.status}: ${saveResult.message ?? ""}`,
        );
      }
      return saveResult;
    }
    case "saveRecord": {
      const store = requireStore(execution);
      const repository = new api.RecordRepository(store);
      const projection = repository.projection(step.pageId);
      const record = repository.patch(
        step.pageId,
        step.databasePageId,
        step.revision ?? projection.revision,
        {
          ...(step.title === undefined ? {} : { title: step.title }),
          ...(step.values === undefined ? {} : { values: step.values }),
        },
      );
      return record;
    }
    case "createDatabase": {
      const store = requireStore(execution);
      const { rows: _rows, ...defaults } = api.emptyDatabase();
      const settings = {
        ...defaults,
        ...(step.settings ?? {}),
      };
      const operation = api.prepareDatabaseCreation(
        step.title ?? "Database",
        step.parentId ?? null,
        settings,
      );
      const created = api.commitDatabaseOperation(store, operation);
      if (created.status !== "applied") {
        throw new Error(
          `database creation was ${created.status}: ${created.message ?? ""}`,
        );
      }
      return created;
    }
    case "createRecord": {
      const store = requireStore(execution);
      return new api.RecordRepository(store).create(
        step.databasePageId,
        step.title ?? "Record",
        step.values ?? {},
      );
    }
    case "readDatabase": {
      const store = requireStore(execution);
      return api.readDatabaseSnapshot(store, step.databasePageId);
    }
    case "readRecord": {
      const store = requireStore(execution);
      return new api.RecordRepository(store).projection(step.pageId);
    }
    case "attach": {
      const store = requireStore(execution);
      return api.attachFile(store.db, config.assetsPath, step.file);
    }
    case "resolveAsset": {
      const store = requireStore(execution);
      const resolved = api.resolveAsset(store.db, config.assetsPath, step.url);
      return {
        ...resolved,
        bytes: readFileSync(resolved.path).length,
        sha256: createHash("sha256")
          .update(readFileSync(resolved.path))
          .digest("hex"),
      };
    }
    case "trash":
      requireStore(execution).trash(step.pageId);
      return pageOf(requireStore(execution), step.pageId);
    case "restore":
      requireStore(execution).restore(step.pageId);
      return pageOf(requireStore(execution), step.pageId);
    case "trashRecord": {
      const store = requireStore(execution);
      const revision =
        step.revision ??
        new api.RecordRepository(store).projection(step.pageId).revision;
      new api.RecordLifecycle(store).trashRecord(step.pageId, revision);
      return new api.RecordRepository(store).projection(step.pageId);
    }
    case "restoreRecord": {
      const store = requireStore(execution);
      const revision =
        step.revision ??
        new api.RecordRepository(store).projection(step.pageId).revision;
      return new api.RecordLifecycle(store).restoreRecord(
        step.pageId,
        revision,
      );
    }
    case "trashDatabase": {
      const store = requireStore(execution);
      const revision =
        step.revision ?? pageOf(store, step.databasePageId).revision;
      new api.RecordLifecycle(store).trashDatabase(
        step.databasePageId,
        revision,
      );
      return pageOf(store, step.databasePageId);
    }
    case "restoreDatabase": {
      const store = requireStore(execution);
      const revision =
        step.revision ?? pageOf(store, step.databasePageId).revision;
      return new api.RecordLifecycle(store).restoreDatabase(
        step.databasePageId,
        revision,
      );
    }
    case "versions":
      return requireStore(execution).versions(step.pageId);
    case "pages":
      return requireStore(execution).pages();
    case "page":
      return pageOf(requireStore(execution), step.pageId);
    case "schemaVersion": {
      const row = requireStore(execution)
        .db.prepare("PRAGMA user_version")
        .get();
      return Number(row.user_version);
    }
    case "sync":
      return drive(requireSync(execution), step.maxCalls ?? 24);
    case "syncExpectError": {
      const sync = requireSync(execution);
      try {
        return { status: await drive(sync, step.maxCalls ?? 4) };
      } catch (error) {
        return { error: errorText(error), status: statusOf(sync) };
      }
    }
    case "status":
      return requireSync(execution).status();
    case "writeEpoch":
      return requireSync(execution).writeEpoch();
    case "assertWritable": {
      try {
        requireSync(execution).assertWritable(step.epoch);
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: errorText(error) };
      }
    }
    case "conflict":
      return requireSync(execution).conflict();
    case "resolve":
      return await requireSync(execution).resolveConflict(
        step.choice,
        step.expectedRevision,
      );
    case "resolveExpectError": {
      const sync = requireSync(execution);
      try {
        return {
          status: await sync.resolveConflict(
            step.choice,
            step.expectedRevision,
          ),
        };
      } catch (error) {
        return {
          error: errorText(error),
          status: statusOf(sync),
          conflict: sync.conflict(),
        };
      }
    }
    case "writeFile":
      writeFileSync(step.path, String(step.content ?? ""), { mode: 0o600 });
      return { path: step.path };
    case "waitFile":
      await waitForFile(step.path, step.timeoutMs ?? 20_000);
      return { path: step.path };
    case "sleep":
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, step.ms ?? 100),
      );
      return { slept: step.ms ?? 100 };
    case "hold": {
      writeFileSync(step.readyPath, "ready", { mode: 0o600 });
      blockForever();
    }
    case "close":
      execution.store?.close();
      execution.store = undefined;
      execution.sync = undefined;
      return { closed: true };
    default:
      throw new Error(`unknown step kind: ${String(step.kind)}`);
  }
}

export async function runProductChild(
  api: Level4Api,
  configPath: string,
): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  const execution: Execution = {
    store: undefined,
    sync: undefined,
    sessionId: randomUUID(),
    seq: 0,
    vars: {},
  };
  try {
    for (const rawStep of config.steps) {
      const step = resolveRefs(rawStep, execution.vars);
      const value = await execute(api, config, execution, step);
      result.steps.push({ kind: step.kind, value });
      if (step.saveAs) execution.vars[step.saveAs] = value;
    }
    result.ok = true;
  } catch (error) {
    result.error = errorText(error);
    result.stack = error instanceof Error ? error.stack : undefined;
    process.exitCode = 1;
  } finally {
    try {
      execution.sync?.close?.();
    } catch {
      // The API does not require a close; a failure here must not hide the test result.
    }
    try {
      execution.store?.close();
    } catch {
      // Closing twice or an already closed Store is not a product failure here.
    }
    result.vars = execution.vars;
    writeFileSync(config.outputPath, JSON.stringify(result), { mode: 0o600 });
  }
}
