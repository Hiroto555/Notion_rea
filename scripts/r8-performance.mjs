import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("@playwright/test");

const runnerPath = fileURLToPath(import.meta.url);
const runnerRoot = resolve(dirname(runnerPath), "..");
const LAUNCH_SAMPLES = 5;
const WARM_SAMPLES = 20;
const WARMUPS = 2;

const USAGE = `Folio R8 reproducible performance runner

Usage:
  node scripts/r8-performance.mjs --app=<worktree path> --output=<new directory>

  --app     Existing worktree with built dist/main.cjs, dist/preload.cjs and
            dist/renderer/index.html. Electron is resolved from that worktree.
  --output  A new directory under <app>/output/ or under this runner's
            worktree output/. Existing directories are refused.

Run this only while no parent E2E or other Folio Electron process is active.
The runner launches and closes only the Electron processes it owns.
It seeds a synthetic workspace; it never opens real user data.`;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { app: undefined, output: undefined, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--app=")) args.app = arg.slice("--app=".length);
    else if (arg.startsWith("--output="))
      args.output = arg.slice("--output=".length);
    else throw new Error("Unknown argument: " + arg + "\n\n" + USAGE);
  }
  if (!args.help && (!args.app || !args.output))
    throw new Error("Both --app and --output are required.\n\n" + USAGE);
  return args;
}

function absolutePath(path) {
  return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

function existingDirectory(path, label) {
  if (!existsSync(path)) fail(label + " does not exist: " + path);
  if (!statSync(path).isDirectory()) fail(label + " is not a directory: " + path);
  return realpathSync(path);
}

function hashFile(path) {
  if (!existsSync(path)) fail("Required build file is missing: " + path);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspectApp(rawApp) {
  const appPath = existingDirectory(absolutePath(rawApp), "--app");
  const packagePath = join(appPath, "package.json");
  if (!existsSync(packagePath))
    fail("--app must contain package.json: " + appPath);
  const required = [
    join(appPath, "dist", "main.cjs"),
    join(appPath, "dist", "preload.cjs"),
    join(appPath, "dist", "renderer", "index.html"),
  ];
  for (const path of required)
    if (!existsSync(path))
      fail(
        "Build the app worktree before measuring; missing " +
          path +
          ". Run `npm run build` there.",
      );

  let electronPath;
  try {
    electronPath = createRequire(packagePath)("electron");
  } catch (error) {
    fail(
      "--app has no resolvable Electron package (" +
        String(error && error.message ? error.message : error) +
        "): " +
        appPath,
    );
  }
  if (typeof electronPath !== "string" || !existsSync(electronPath))
    fail(
      "--app Electron binary is missing; install dependencies in that worktree: " +
        String(electronPath),
    );

  return {
    appPath,
    electronPath,
    build: {
      mainSha256: hashFile(required[0]),
      preloadSha256: hashFile(required[1]),
      rendererIndexSha256: hashFile(required[2]),
    },
  };
}

function prepareOutput(rawOutput, appPath) {
  const bases = [
    join(appPath, "output"),
    join(runnerRoot, "output"),
  ];
  for (const base of bases) mkdirSync(base, { recursive: true });
  const realBases = [...new Set(bases.map((base) => realpathSync(base)))];
  const output = absolutePath(rawOutput);

  if (existsSync(output))
    fail(
      "--output must be a new directory; refusing to reuse existing path: " +
        output,
    );
  const parent = dirname(output);
  if (!existsSync(parent))
    fail(
      "--output parent must already exist; create the allowed output root first: " +
        parent,
    );
  const realParent = realpathSync(parent);
  if (!containedByAny(realParent, realBases))
    fail(
      "--output must stay under " +
        realBases.join(" or ") +
        "; refused: " +
        output,
    );

  mkdirSync(output);
  const realOutput = realpathSync(output);
  if (!containedByAny(realOutput, realBases)) {
    fail("--output resolves outside the allowed output roots: " + realOutput);
  }
  return { output, realOutput, allowedBases: realBases };
}

function containedByAny(candidate, bases) {
  return bases.some(
    (base) =>
      candidate === base ||
      candidate.startsWith(base.endsWith(sep) ? base : base + sep),
  );
}

function buildSeedModule(output) {
  const bundle = join(output, "r8-perf-seed.cjs");
  buildSync({
    entryPoints: [join(runnerRoot, "scripts", "r8-perf-seed.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const require = createRequire(import.meta.url);
  return require(bundle);
}

function makeFixture(output) {
  const seed = buildSeedModule(output);
  const fixtureRoot = join(output, "fixture");
  mkdirSync(fixtureRoot);
  const dataDir = join(fixtureRoot, "data");
  const database = join(dataDir, "workspace.sqlite");
  const manifestPath = join(fixtureRoot, "manifest.json");
  const fixtureImage = join(runnerRoot, "tests", "fixtures", "image.png");
  const manifest = seed.seedMediumWorkspace(
    database,
    manifestPath,
    fixtureImage,
  );
  return { fixtureRoot, dataDir, database, manifestPath, manifest };
}

function cloneFixture(fixtureData, destination) {
  if (existsSync(destination))
    fail("Refusing to overwrite existing sample data directory: " + destination);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(fixtureData, destination, { recursive: true });
  const marker = join(destination, "SYNTHETIC-R8-PERF");
  if (!existsSync(marker))
    fail("Cloned fixture is missing its synthetic marker: " + marker);
  return destination;
}

async function closeOwnedApp(app) {
  if (!app) return;
  let child;
  try {
    child = app.process();
  } catch {}
  let timer;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out closing the owned Electron app")),
          15_000,
        );
      }),
    ]);
  } catch {
    // Only the ChildProcess returned by this launch may be force-closed.
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function launchOwned(executablePath, appPath, dataPath) {
  const env = { ...process.env, FOLIO_DATA_DIR: dataPath };
  delete env.FOLIO_DEV_URL;
  let app;
  try {
    app = await electron.launch({
      executablePath,
      args: [join(appPath, "dist", "main.cjs")],
      cwd: appPath,
      env,
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window
      .locator(".page-title")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await window.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    return { app, window };
  } catch (error) {
    await closeOwnedApp(app);
    throw error;
  }
}

async function instrumentRequests(app) {
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain;
    const original = ipc._invokeHandlers.get("folio:request");
    if (!original) throw new Error("folio:request handler is not registered");
    const gate = (globalThis.__folioR8Perf = { counts: {}, events: [] });
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event, request) => {
      const type =
        request &&
        typeof request === "object" &&
        typeof request.type === "string"
          ? request.type
          : "unknown";
      gate.counts[type] = (gate.counts[type] ?? 0) + 1;
      const started = performance.now();
      try {
        return await original(event, request);
      } finally {
        gate.events.push({ type, ms: performance.now() - started });
        if (gate.events.length > 4000) gate.events.shift();
      }
    });
  });
}

async function readRequestCounts(app) {
  return app.evaluate(() => {
    const gate = globalThis.__folioR8Perf;
    return {
      counts: { ...gate.counts },
      events: gate.events.map((event) => ({ ...event })),
    };
  });
}

async function resetRequestCounts(app) {
  await app.evaluate(() => {
    const gate = globalThis.__folioR8Perf;
    gate.counts = {};
    gate.events = [];
  });
}

async function waitForRequestCount(app, type, minimum, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const counts = (await readRequestCounts(app)).counts;
    last = counts[type] ?? 0;
    if (last >= minimum) return last;
    await new Promise((done) => setTimeout(done, 100));
  }
  fail(
    "Timed out waiting for " +
      type +
      " request count >= " +
      minimum +
      "; last observed " +
      last,
  );
}

function median(sorted) {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    min: round(sorted[0]),
    median: round(median(sorted)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

function emptyCounts() {
  return {
    "database:read": 0,
    "record:read": 0,
    "database:settings": 0,
    "database:commit": 0,
    "save:commit": 0,
    search: 0,
    load: 0,
  };
}

function countOf(counts, type) {
  return counts[type] ?? 0;
}

async function measureSearch(window, query, expectedCount) {
  for (let index = 0; index < WARMUPS; index++) {
    const count = await window.evaluate(async (searchQuery) => {
      const rows = await window.folio.request({
        type: "search",
        query: searchQuery,
      });
      return rows.length;
    }, query);
    if (count !== expectedCount)
      fail(
        "Warm-up search returned " +
          count +
          " rows; expected " +
          expectedCount +
          " for query " +
          query,
      );
  }

  const samples = [];
  for (let index = 0; index < WARM_SAMPLES; index++) {
    const measured = await window.evaluate(async (searchQuery) => {
      const started = performance.now();
      const rows = await window.folio.request({
        type: "search",
        query: searchQuery,
      });
      return { ms: performance.now() - started, count: rows.length };
    }, query);
    if (measured.count !== expectedCount)
      fail(
        "Search returned " +
          measured.count +
          " rows; expected " +
          expectedCount +
          " for query " +
          query,
      );
    samples.push(measured.ms);
  }
  return summarize(samples);
}

async function measureDatabaseRead(window, databasePageId, expectedRecords) {
  for (let index = 0; index < WARMUPS; index++) {
    const count = await window.evaluate(async (id) => {
      const read = await window.folio.request({
        type: "database:read",
        databasePageId: id,
      });
      return read.database.records.length;
    }, databasePageId);
    if (count !== expectedRecords)
      fail(
        "Warm-up database:read returned " +
          count +
          " records; expected " +
          expectedRecords,
      );
  }

  const samples = [];
  for (let index = 0; index < WARM_SAMPLES; index++) {
    const measured = await window.evaluate(async (id) => {
      const started = performance.now();
      const read = await window.folio.request({
        type: "database:read",
        databasePageId: id,
      });
      return {
        ms: performance.now() - started,
        records: read.database.records.length,
        activeViewId: read.database.settings.activeViewId,
      };
    }, databasePageId);
    if (measured.records !== expectedRecords)
      fail(
        "database:read returned " +
          measured.records +
          " records; expected " +
          expectedRecords,
      );
    samples.push(measured.ms);
  }
  return summarize(samples);
}

async function measureRendererBacklinks(window, targetPageId, expectedBacklinks) {
  const measured = await window.evaluate(async (targetId) => {
    const loadedAt = performance.now();
    const snapshot = await window.folio.request({ type: "load" });
    const loadMs = performance.now() - loadedAt;
    const linked = (doc) =>
      !!doc.marks?.some(
        (mark) =>
          mark.type === "link" &&
          mark.attrs?.href === "folio-page://" + targetId,
      ) ||
      !!doc.content?.some((node) => linked(node));
    const started = performance.now();
    const backlinks = snapshot.pages.filter(
      (page) =>
        !page.documentError &&
        page.id !== targetId &&
        linked(page.doc),
    );
    return {
      ms: performance.now() - started,
      loadMs,
      pagesScanned: snapshot.pages.length,
      backlinks: backlinks.length,
    };
  }, targetPageId);
  if (measured.backlinks !== expectedBacklinks)
    fail(
      "Renderer backlink scan found " +
        measured.backlinks +
        "; expected " +
        expectedBacklinks,
    );
  return measured;
}

async function measureBoardSwitch(app, window, manifest) {
  const boardName =
    manifest.database.views.find((view) => view.type === "board")?.name ??
    "ボード";
  const tableName =
    manifest.database.views.find((view) => view.type === "table")?.name ??
    "テーブル";
  const settingsRegion = window.getByRole("region", {
    name: "データベースの表示設定",
    exact: true,
  });
  const trigger = settingsRegion.locator(
    '[data-settings-menu-trigger="view-options"]',
  );
  const openSettings = async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true")
      await trigger.click();
  };

  await resetRequestCounts(app);
  await window.getByTitle(manifest.database.title, { exact: true }).first().click();
  await window
    .getByRole("region", { name: "レコード一覧", exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
  await waitForRequestCount(
    app,
    "record:read",
    manifest.records.length,
    180_000,
  );
  await window.waitForTimeout(250);
  const initial = await readRequestCounts(app);

  await resetRequestCounts(app);
  await openSettings();
  await settingsRegion
    .getByRole("tab", { name: "ビュー: " + boardName, exact: true })
    .click();
  await window.waitForFunction(
    (expected) =>
      document.querySelectorAll(
        '.r3-db-scroll[data-view-type="board"] .r3-card-open',
      ).length === expected,
    manifest.records.length,
    { timeout: 120_000 },
  );
  await waitForRequestCount(app, "database:commit", 1, 30_000);
  await window.waitForTimeout(250);
  const board = await readRequestCounts(app);

  await resetRequestCounts(app);
  await openSettings();
  await settingsRegion
    .getByRole("tab", { name: "ビュー: " + tableName, exact: true })
    .click();
  await window.waitForFunction(
    () => !!document.querySelector('.r3-db-scroll[data-record-table-scroll]'),
    null,
    { timeout: 120_000 },
  );
  await waitForRequestCount(app, "database:commit", 1, 30_000);
  await window.waitForTimeout(250);
  const table = await readRequestCounts(app);

  return {
    initialCounts: { ...emptyCounts(), ...initial.counts },
    boardCounts: { ...emptyCounts(), ...board.counts },
    tableCounts: { ...emptyCounts(), ...table.counts },
    recordReads: {
      initialOpen: countOf(initial.counts, "record:read"),
      boardSwitch: countOf(board.counts, "record:read"),
      tableSwitch: countOf(table.counts, "record:read"),
      expectedInitialOpen: manifest.records.length,
    },
    databaseReads: {
      boardSwitch: countOf(board.counts, "database:read"),
      tableSwitch: countOf(table.counts, "database:read"),
    },
    databaseCommits: {
      boardSwitch: {
        databaseCommit: countOf(board.counts, "database:commit"),
        databaseSettings: countOf(board.counts, "database:settings"),
      },
      tableSwitch: {
        databaseCommit: countOf(table.counts, "database:commit"),
        databaseSettings: countOf(table.counts, "database:settings"),
      },
    },
  };
}

function environmentInfo() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    loadAverageStart: os.loadavg(),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const app = inspectApp(args.app);
  const allowed = prepareOutput(args.output, app.appPath);
  const output = allowed.output;
  const startedAt = new Date().toISOString();
  const environment = environmentInfo();

  console.log("Synthetic fixture: seeding " + app.appPath);
  const fixture = makeFixture(output);
  console.log(
    "Synthetic fixture: " +
      fixture.manifest.checks.regularPages +
      " regular pages, " +
      fixture.manifest.checks.records +
      " records",
  );

  // Five fresh Electron processes. Each launch reads a new clone of the
  // fixture, so samples never share application state.
  const launchSamples = [];
  for (let index = 0; index < LAUNCH_SAMPLES; index++) {
    const name = "launch-" + String(index + 1).padStart(2, "0");
    const data = cloneFixture(
      fixture.dataDir,
      join(output, "samples", name, "data"),
    );
    const started = performance.now();
    const launched = await launchOwned(
      app.electronPath,
      app.appPath,
      data,
    );
    launchSamples.push(performance.now() - started);
    await closeOwnedApp(launched.app);
    console.log(
      "Launch sample " +
        (index + 1) +
        "/" +
        LAUNCH_SAMPLES +
        ": " +
        round(launchSamples[launchSamples.length - 1]) +
        " ms",
    );
  }

  const measureData = cloneFixture(
    fixture.dataDir,
    join(output, "samples", "warm", "data"),
  );
  let appHandle;
  let search;
  let databaseRead;
  let boardSwitch;
  let rendererBacklinks;
  let electronVersion;
  try {
    const launched = await launchOwned(
      app.electronPath,
      app.appPath,
      measureData,
    );
    appHandle = launched.app;
    const window = launched.window;
    electronVersion = await appHandle.evaluate(
      () => process.versions.electron,
    );
    await instrumentRequests(appHandle);

    console.log("Warm search IPC samples: " + WARM_SAMPLES);
    search = await measureSearch(
      window,
      fixture.manifest.search.queries.find(
        (query) => query.kind === "broad",
      ).query,
      fixture.manifest.search.broadExpectedCount,
    );

    console.log("Warm database:read samples: " + WARM_SAMPLES);
    databaseRead = await measureDatabaseRead(
      window,
      fixture.manifest.database.id,
      fixture.manifest.records.length,
    );

    console.log("Board switch request counts");
    boardSwitch = await measureBoardSwitch(
      appHandle,
      window,
      fixture.manifest,
    );

    rendererBacklinks = await measureRendererBacklinks(
      window,
      fixture.manifest.pages[fixture.manifest.pages.length - 1].id,
      fixture.manifest.checks.internalLinks,
    );
  } finally {
    await closeOwnedApp(appHandle);
  }

  const result = {
    format: "folio-r8-perf-result-v1",
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    app: {
      path: app.appPath,
      electronPath: app.electronPath,
      electronVersion,
      build: app.build,
    },
    output: {
      path: allowed.realOutput,
      allowedBases: allowed.allowedBases,
    },
    seed: {
      fixtureData: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      marker: fixture.manifest.marker,
      markerFile: fixture.manifest.markerFile,
      databaseId: fixture.manifest.database.id,
      operationCount: fixture.manifest.operations.length,
      checks: fixture.manifest.checks,
      search: fixture.manifest.search,
    },
    environment: {
      ...environment,
      loadAverageEnd: os.loadavg(),
    },
    samples: {
      launch: {
        note:
          "Fresh Electron process per sample, each reading a new fixture clone. " +
          "OS page cache is uncontrolled; these are not physical cold-cache measurements.",
        ...summarize(launchSamples),
      },
      search: {
        request: "search",
        query: fixture.manifest.search.queries.find(
          (query) => query.kind === "broad",
        ).query,
        expectedResults: fixture.manifest.search.broadExpectedCount,
        warmups: WARMUPS,
        ...search,
      },
      databaseRead: {
        request: "database:read",
        expectedRecords: fixture.manifest.records.length,
        warmups: WARMUPS,
        ...databaseRead,
      },
      boardSwitch,
      rendererBacklinks: {
        note:
          "Informational renderer-context scan mirroring the App's inline recursive link check. " +
          "The IPC load time is reported separately and is not part of the scan time.",
        targetPageId:
          fixture.manifest.pages[fixture.manifest.pages.length - 1].id,
        expectedBacklinks: fixture.manifest.checks.internalLinks,
        ...rendererBacklinks,
      },
    },
    statistics: {
      median: "average of the two middle samples for an even sample count",
      p95: "nearest rank: ceil(0.95 * n), clamped to the last sample",
    },
    interpretation: {
      launchCache:
        "OS page cache is uncontrolled. Launch samples report real Electron launch-to-ready time on this host, not physical cold-cache timing.",
      thresholds:
        "No latency pass/fail threshold is defined. The values are descriptive samples only.",
      boardSwitch:
        "record:read counts are invocations observed by the owned Electron main process handler during the measured switch.",
      physicalIme: "NOT_RUN",
    },
    limitations: [
      "Synthetic data only; no real workspace or user data is read.",
      "Page IDs come from the real Store per seed; counts, titles, search terms and link/asset topology are fixed.",
      "Single host and single run of 20 warm samples; not a general performance guarantee.",
      "Physical Japanese IME latency, Notion comparison and physical cold-cache startup are NOT_RUN.",
      "The runner must not be started while a parent E2E or another Folio Electron instance is active.",
    ],
  };

  const resultPath = join(output, "result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log("");
  console.log("R8 performance sample complete");
  console.log("  fixture: " + fixture.dataDir);
  console.log("  result:  " + resultPath);
  console.log(
    "  launch median/p95: " +
      result.samples.launch.median +
      " / " +
      result.samples.launch.p95 +
      " ms",
  );
  console.log(
    "  search median/p95: " +
      result.samples.search.median +
      " / " +
      result.samples.search.p95 +
      " ms",
  );
  console.log(
    "  database:read median/p95: " +
      result.samples.databaseRead.median +
      " / " +
      result.samples.databaseRead.p95 +
      " ms",
  );
  console.log(
    "  record:read during board switch: " +
      result.samples.boardSwitch.recordReads.boardSwitch +
      " (initial open: " +
      result.samples.boardSwitch.recordReads.initialOpen +
      ")",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      "R8 performance runner failed: " +
        (error && error.stack ? error.stack : String(error)),
    );
    process.exitCode = 1;
  });
}
