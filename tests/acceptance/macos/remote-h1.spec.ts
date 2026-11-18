import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error pure Node ESM execution guard; importing it launches nothing
import { assertMacExecution } from "../../../scripts/mac-acceptance/policy/guard.mjs";
// @ts-expect-error bounded Node metadata reader; no process is launched
import { readMetadataFile } from "../../../scripts/mac-acceptance/validate.mjs";
// @ts-ignore The remote preflight module is produced separately and may not ship declarations.
import { prepareRemoteH1 } from "../../../scripts/mac-acceptance/preflight/remote-h1.mjs";

const workspaceRoot = resolve(process.cwd());
const TITLE = "Remote H1 日本語 English";
const BODY = "合成の本文: 日本語 English remote H1 save and reopen.";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const docHash = (doc: unknown) => hash(JSON.stringify(doc));

let ownedChild: ChildProcess | undefined;

function approvedPlan() {
  const planPath = process.env.FOLIO_MAC_PLAN_PATH;
  if (!planPath)
    throw new Error(
      "FOLIO_MAC_PLAN_PATH must name the approved remote MAC-H1 plan",
    );
  const plan = assertMacExecution(
    JSON.parse(readMetadataFile(planPath).toString("utf8")),
    process.env,
  );
  if (plan.caseIds.length !== 1 || plan.caseIds[0] !== "MAC-H1")
    throw new Error("The remote suite accepts only the MAC-H1 case");
  if (plan.workers !== 1 || plan.retries !== 0)
    throw new Error("The remote suite requires workers=1 and retries=0");
  return plan;
}

async function launch(options: {
  args: string[];
  env: Record<string, string>;
}) {
  if (
    ownedChild &&
    ownedChild.exitCode === null &&
    ownedChild.signalCode === null
  )
    throw new Error("Refusing to start a second owned Electron child");
  const application = await electron.launch({
    args: [...options.args],
    env: { ...options.env },
  });
  ownedChild = application.process();
  return application;
}

async function stopOwnedChild() {
  const child = ownedChild;
  ownedChild = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill("SIGKILL");
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

test.afterEach(async () => {
  await stopOwnedChild();
});

async function readPages(window: Page): Promise<any[]> {
  return window.evaluate(
    async () =>
      (await globalThis.window.folio.request<any>({ type: "load" })).pages,
  );
}

async function readPageByTitle(window: Page, title: string) {
  const pages = await readPages(window);
  const matches = pages.filter((page) => page.title === title);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function fingerprint(page: any) {
  return {
    id: page.id,
    revision: page.revision,
    revisionSha256: hash(String(page.revision)),
    contentSha256: docHash(page.doc),
  };
}

async function runtime(app: ElectronApplication) {
  return app.evaluate(({ app }) => ({
    pid: process.pid,
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    mockKeychainSwitch: app.commandLine.hasSwitch("use-mock-keychain"),
  }));
}

async function quitNormally(app: ElectronApplication, child: ChildProcess) {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, {
      timeout: 15000,
    })
    .toBe(true);
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
}

function writeDiagnostic(prepared: any, diagnostic: Record<string, unknown>) {
  const bytes = JSON.stringify(
    {
      schemaVersion: 1,
      kind: "folio-remote-h1-diagnostic-observation",
      evidenceSchema: "NOT_PRODUCED",
      productResult: "NOT_RUN",
      note: "Diagnostic observations only. This is not an evidenceSchema report and not a MAC acceptance PASS.",
      ...diagnostic,
    },
    null,
    2,
  );
  const output = test.info().outputPath("remote-h1-diagnostics.json");
  writeFileSync(output, bytes, { mode: 0o600 });
  const evidenceRoot = prepared.sandbox?.evidence;
  const evidence =
    typeof evidenceRoot === "string"
      ? join(evidenceRoot, "remote-h1-diagnostic.json")
      : undefined;
  if (evidence) writeFileSync(evidence, bytes, { mode: 0o600 });
  return { output, evidence };
}

test("MAC-H1 saves a synthetic Japanese/English page, exits normally and reopens the same artifact/data", async () => {
  const plan = approvedPlan();
  const prepared = await prepareRemoteH1(plan, {
    env: process.env,
    workspaceRoot,
  });
  if (
    !prepared?.electron ||
    !Array.isArray(prepared.electron.args) ||
    !prepared.electron.env ||
    typeof prepared.electron.env !== "object"
  )
    throw new Error("prepareRemoteH1 returned invalid Electron launch options");
  if (typeof prepared.artifactPath !== "string")
    throw new Error("prepareRemoteH1 did not return an artifact path");

  const options = {
    args: [...prepared.electron.args],
    env: { ...prepared.electron.env },
  };
  const dataRoot = options.env.FOLIO_DATA_DIR;
  if (typeof dataRoot !== "string" || !dataRoot)
    throw new Error("The remote preflight did not isolate FOLIO_DATA_DIR");
  if (
    typeof prepared.sandbox?.data === "string" &&
    dataRoot !== prepared.sandbox.data
  )
    throw new Error(
      "The remote preflight data root is not the allocated sandbox",
    );

  try {
    const first = await launch(options);
    const firstRuntime = await runtime(first);
    let window = await first.firstWindow();
    await expect(window.locator(".page-title")).toBeVisible();
    await expect(window.locator(".folio-editor")).toBeVisible();

    await window.getByLabel("ページタイトル", { exact: true }).fill(TITLE);
    await window.locator(".folio-editor").fill(BODY);
    await expect
      .poll(
        async () => {
          const page = (await readPages(window)).find(
            (candidate) => candidate.title === TITLE,
          );
          return page ? JSON.stringify(page.doc) : "";
        },
        { timeout: 15000, intervals: [100, 250, 500] },
      )
      .toContain("日本語");
    await expect(window.locator(".save-state")).toHaveText("保存済み");
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue(TITLE);

    const beforePage = await readPageByTitle(window, TITLE);
    expect(JSON.stringify(beforePage.doc)).toContain("English");
    const before = fingerprint(beforePage);
    const firstChild = first.process();
    const startPid = firstChild.pid;
    expect(startPid).toBe(firstRuntime.pid);
    await quitNormally(first, firstChild);
    ownedChild = undefined;

    const second = await launch(options);
    const secondChild = second.process();
    const secondRuntime = await runtime(second);
    expect(secondRuntime.pid).not.toBe(startPid);
    window = await second.firstWindow();
    await expect(window.locator(".page-title")).toBeVisible();
    const after = fingerprint(await readPageByTitle(window, TITLE));

    expect(after.id).toBe(before.id);
    expect(after.revision).toBe(before.revision);
    expect(after.contentSha256).toBe(before.contentSha256);

    const effectivePlan = prepared.plan ?? plan;
    writeDiagnostic(prepared, {
      runId: effectivePlan.runId,
      caseId: "MAC-H1",
      caseIds: effectivePlan.caseIds,
      artifactPath: prepared.artifactPath,
      artifactSha256: effectivePlan.provenance?.artifactSha256 ?? null,
      sandbox: {
        root: prepared.sandbox?.root ?? null,
        data: prepared.sandbox?.data ?? dataRoot,
        evidence: prepared.sandbox?.evidence ?? null,
      },
      launch: { args: options.args, dataRoot },
      start: { runtime: firstRuntime, document: before },
      restart: { runtime: secondRuntime, document: after },
      normalExit: { code: firstChild.exitCode, signal: firstChild.signalCode },
      assertions: {
        idsMatch: after.id === before.id,
        revisionsMatch: after.revision === before.revision,
        contentHashesMatch: after.contentSha256 === before.contentSha256,
        newPid: secondRuntime.pid !== startPid,
      },
      keychain: {
        effectiveMockSwitchObserved: {
          start: firstRuntime.mockKeychainSwitch,
          restart: secondRuntime.mockKeychainSwitch,
        },
        realKeychainReadiness: "NOT_RUN",
        detail:
          "MAC-H1 does not exercise safeStorage or a real private Keychain. The observed commandLine switch is diagnostic and does not establish Keychain isolation or absence.",
      },
    });
    await quitNormally(second, secondChild);
    ownedChild = undefined;
  } finally {
    await stopOwnedChild();
  }
});
