// MT11 packaged-Mac functional driver for the mac-trial fixture. Runnable
// ONLY through the existing guarded batch with fresh immutable inputs:
//   npm run test:e2e:batch -- --owned-shutdown tests/e2e/mac-trial-packaged-functional.spec.ts
// Requires FOLIO_CHECKPOINT_OBSERVATION_INTENT, FOLIO_CHECKPOINT_OBSERVATION_CANDIDATE
// and the inherited FOLIO_OWNED_SHUTDOWN_REQUEST (same gate as
// checkpoint-observation.spec.ts). The .app is launched exactly as
// executablePath = prepared.executablePath, args = [], env = prepared.env.
// Normal graceful close only; fixture, evidence and logs are left in place.
// The planned edits are frozen with wx BEFORE any UI action; the post-edit
// oracle freezes only the runtime-generated docs AFTER their intended plain
// structure/text is verified — everything else compares against the original
// seed manifest, never a re-captured workspace.
import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {dirname, join, resolve} from "node:path";
import type {Doc} from "../../src/shared/types";
import type {MacTrialManifest} from "../../scripts/mac-trial-seed";
import {
  OBSERVATION_CANDIDATE_ENV,
  OBSERVATION_INTENT_ENV,
  OWNED_REQUEST_ENV,
  captureCheckpointObservationSample,
  observationCaptureContext,
  prepareCheckpointObservation,
} from "./checkpoint-observation-harness";
import {
  MANUAL_TEST_TIMEOUT_MS,
  PLANNED_ACTIVE_PAGE_BODY,
  PLANNED_RECORD_BODY,
  PLANNED_RECORD_NOTE,
  closeOwnedApp,
  docPlainParagraphText,
  fixtureAssetProblems,
  fixtureComparisonProblems,
  limitsStorageProblems,
  readDatabaseProjection,
  readRecordPage,
  requestLoad,
  restoredCopyEnv,
  verifyExportFile,
  writeImmutableEvidence,
  writePlannedEdits,
} from "./mac-trial-packaged-session";
import {
  backupAction,
  findBackupManifests,
  findLatestBackupCall,
  findWorkspaceRoots,
  installBackupRecorder,
  installNativeDialogStub,
  openBackupSurface,
  openPageMenu,
  openR8Database,
  openR8Page,
  openR8Record,
  r8Saved,
  setNativePaths,
  waitForNewBackup,
  waitForRestoredWorkspace,
  workspaceState,
} from "./r8-acceptance/r8-fixture";

// NEED_SOURCE: the HTML/JSON page-menu labels are assumed to follow the
// Markdown pattern used by r9-markdown.spec.ts ("Markdownを書き出す"). If the
// owning page-menu source names them differently, update only this map.
const EXPORT_BUTTONS = {
  md: "Markdownを書き出す",
  html: "HTMLを書き出す",
  json: "JSONを書き出す",
} as const;

/** snapshot.load may exclude record page bodies: every record is verified
 * through record:read so all 20 bodies AND values are compared. */
async function readAllRecords(
  window: Page,
  manifest: MacTrialManifest,
): Promise<
  Map<string, {doc?: Doc; values?: Record<string, string | number | boolean>}>
> {
  const reads = new Map<
    string,
    {doc?: Doc; values?: Record<string, string | number | boolean>}
  >();
  for (const record of manifest.records) {
    const read = await readRecordPage(window, record.id);
    expect(read.page.id).toBe(record.id);
    expect(read.record.pageId).toBe(record.id);
    reads.set(record.id, {doc: read.page.doc, values: {...read.record.values}});
  }
  return reads;
}

test("packaged mac-trial fixture: planned edits, reopen, backup/restore and exports match the seed oracle", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "the packaged Mac target is required");
  test.skip(
    !process.env[OBSERVATION_INTENT_ENV] || !process.env[OBSERVATION_CANDIDATE_ENV],
    "a fresh immutable intent and candidate manifest are required",
  );
  test.skip(
    process.env.FOLIO_GUI_TEST_OPT_IN !== "1" || !process.env[OWNED_REQUEST_ENV],
    "the existing owned-shutdown batch env is required",
  );
  test.setTimeout(MANUAL_TEST_TIMEOUT_MS);

  const prepared = prepareCheckpointObservation({env: process.env});
  const manifest = prepared.fixture.manifest;
  const firstRecord = manifest.records[0];
  // The note field is the seed's text property (named メモ in the R-series
  // conventions); fall back to the first text property if it is renamed.
  const noteProperty =
    manifest.database.properties.find(
      (property) => property.name === "メモ" && property.type === "text",
    ) ?? manifest.database.properties.find((property) => property.type === "text");
  if (!noteProperty)
    throw new Error(
      "NEED_SOURCE: seed manifest has no text property for the planned note edit",
    );

  const planned = writePlannedEdits(prepared.fixture, prepared.binding, {
    activePageId: manifest.activePage,
    recordPageId: firstRecord.id,
    notePropertyId: noteProperty.id,
    notePropertyName: noteProperty.name,
  });

  const report: Record<string, unknown> = {
    runId: prepared.binding.runId,
    nonce: prepared.binding.nonce,
    sourceCandidate: prepared.binding.sourceCandidate,
    artifactSha256: prepared.binding.artifactSha256,
    fixtureSha256: prepared.fixture.fixtureSha256,
    plannedEditsPath: planned.path,
    plannedEditsSha256: planned.sha256,
    pickerStub:
      "native path picker STUBBED via installNativeDialogStub — explicitly NOT real picker proof",
    productResult: "NOT_RUN",
    physical: "NOT_RUN",
    launches: [] as unknown[],
    closes: [] as unknown[],
  };

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      env: prepared.env,
      timeout: 30000,
    });
    (report.launches as unknown[]).push({
      lane: "source-first",
      pid: app.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    const userData = await app.evaluate(({app: electronApp}) =>
      electronApp.getPath("userData"),
    );
    expect(realpathSync(userData)).toBe(prepared.fixture.data);

    // Baseline: the packaged app reads the frozen seed back exactly.
    const baselineProblems = fixtureComparisonProblems({
      manifest,
      snapshot: await requestLoad(window),
      database: await readDatabaseProjection(window, manifest.database.id),
      recordReads: await readAllRecords(window, manifest),
    });
    expect(baselineProblems).toEqual([]);

    // The three planned edits (fixed by planned-edits.json before any action).
    // The guide doc starts as heading + empty paragraph, so a bare fill only
    // rewrites the trailing paragraph: select-all + Backspace first resets
    // ProseMirror to a single default paragraph, then fill produces the
    // planned one-plain-paragraph document.
    const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
    const body = window.locator(".folio-editor");
    await body.click();
    await window.keyboard.press(selectAll);
    await window.keyboard.press("Backspace");
    await body.fill(PLANNED_ACTIVE_PAGE_BODY);
    await r8Saved(window);
    await openR8Database(window, manifest.database.title);
    await openR8Record(window, firstRecord.title);
    const record = window.locator(".r3-record-page");
    const recordBody = record.locator(".folio-editor");
    await recordBody.click();
    await window.keyboard.press(selectAll);
    await window.keyboard.press("Backspace");
    await recordBody.fill(PLANNED_RECORD_BODY);
    await record
      .getByLabel(noteProperty.name, {exact: true})
      .fill(PLANNED_RECORD_NOTE);
    await r8Saved(window);
    await record.getByRole("button", {name: "レコードを閉じる", exact: true}).click();

    // Closing the record leaves the database page active; return explicitly
    // to the original guide and wait until activePage is persisted before
    // the unchanged-settings comparison — navigation delta is never ignored.
    await openR8Page(
      window,
      manifest.pages.find((page) => page.id === manifest.activePage)!.title,
    );
    await expect
      .poll(async () => (await requestLoad(window)).settings.activePage)
      .toBe(manifest.activePage);

    // Post-edit oracle: validate the exact intended plain structure/text
    // first, only THEN freeze the actual docs (runtime block IDs included).
    const edited = await requestLoad(window);
    const activePage = edited.pages.find((page) => page.id === manifest.activePage);
    expect(activePage).toBeDefined();
    expect(docPlainParagraphText(activePage!.doc)).toBe(PLANNED_ACTIVE_PAGE_BODY);
    const firstRead = await readRecordPage(window, firstRecord.id);
    expect(docPlainParagraphText(firstRead.page.doc)).toBe(PLANNED_RECORD_BODY);
    const expectedRecordValues = {
      ...firstRecord.values,
      [noteProperty.id]: PLANNED_RECORD_NOTE,
    };
    expect({...firstRead.record.values}).toEqual(expectedRecordValues);
    const oracle = writeImmutableEvidence(
      prepared.fixture,
      "post-edit-oracle.json",
      {
        v: 1,
        schema: "folio.post-edit-oracle.v1",
        runId: prepared.binding.runId,
        nonce: prepared.binding.nonce,
        activePageDoc: activePage!.doc,
        recordPageId: firstRecord.id,
        recordDoc: firstRead.page.doc,
        recordValues: firstRead.record.values,
        capturedAt: new Date().toISOString(),
      },
    );
    report.oraclePath = oracle.path;
    report.oracleSha256 = oracle.sha256;

    const overrides = {
      docs: new Map<string, Doc>([
        [manifest.activePage, activePage!.doc],
        [firstRecord.id, firstRead.page.doc],
      ]),
      values: new Map<string, Record<string, string | number | boolean>>([
        [firstRecord.id, expectedRecordValues],
      ]),
    };
    const verifyAll = async (win: Page) =>
      fixtureComparisonProblems({
        manifest,
        snapshot: await requestLoad(win),
        database: await readDatabaseProjection(win, manifest.database.id),
        recordReads: await readAllRecords(win, manifest),
        overrides,
      });
    expect(await verifyAll(window)).toEqual([]);

    // Exports through the real page-menu buttons; the native path picker is
    // the stub only (labelled above, never claimed as real picker proof).
    await installNativeDialogStub(app);
    await openR8Page(window, activePage!.title);
    const exportsReport: Record<string, unknown> = {};
    for (const format of ["md", "html", "json"] as const) {
      const target = join(prepared.fixture.evidenceDir, `export-active.${format}`);
      await setNativePaths(app, {save: target});
      await openPageMenu(window);
      await window
        .getByRole("button", {name: EXPORT_BUTTONS[format], exact: true})
        .click();
      await expect.poll(() => existsSync(target), {timeout: 20000}).toBe(true);
      // Owning completion order is await api(export) → setNotice →
      // setMenu(false): the file lands BEFORE the UI finishes closing the
      // page menu. Wait for the trigger's real aria-expanded=false so the
      // next iteration's openPageMenu never observes a stale "true" that an
      // in-flight close then flips mid-click.
      await expect(
        window.getByRole("button", {name: "ページメニュー", exact: true}),
      ).toHaveAttribute("aria-expanded", "false");
      const otherPage = manifest.pages.find(
        (page) => page.id !== manifest.activePage,
      )!;
      const verified = verifyExportFile({
        format,
        path: target,
        title: activePage!.title,
        mustContain: [PLANNED_ACTIVE_PAGE_BODY],
        mustNotContain: [firstRecord.title, otherPage.title],
        expectedPage: {id: manifest.activePage, doc: activePage!.doc},
        expectedBody: PLANNED_ACTIVE_PAGE_BODY,
      });
      exportsReport[format] = {scope: "activePage", path: target, ...verified};
      expect(verified.problems).toEqual([]);
    }
    report.exports = exportsReport;

    // Graceful bounded close of the tracked handle, then reopen the SAME
    // verified .app on the SAME data.
    const firstClose = await closeOwnedApp(app);
    (report.closes as unknown[]).push({lane: "source-first", ...firstClose});
    app = undefined;
    expect(
      firstClose.normal,
      "the planned source close must be a real normal app.close exit (code 0, no signal)",
    ).toBe(true);
    app = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      env: prepared.env,
      timeout: 30000,
    });
    (report.launches as unknown[]).push({
      lane: "source-reopen",
      pid: app.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    const window2 = await app.firstWindow();
    await window2.waitForSelector(".page-title");
    expect(
      realpathSync(
        await app.evaluate(({app: electronApp}) => electronApp.getPath("userData")),
      ),
    ).toBe(prepared.fixture.data);
    expect(await verifyAll(window2)).toEqual([]);

    // Backup through the real UI: create → choose-verify → restore into an
    // ABSENT separate target under the same owned fixture root. The backup
    // implementation itself is never stubbed or replaced. The native path
    // stub is process-local and must be installed in THIS fresh process —
    // the app1 stub state does not cross the process boundary.
    await installNativeDialogStub(app);
    await installBackupRecorder(app);
    const backupTarget = join(prepared.fixture.root, "backup-target");
    // The real restore picker selects an EXISTING parent directory; the
    // product itself then creates the destination as an entirely new, absent
    // `Folio-restored-*` child inside it — the parent is created fresh here
    // (same contract as the R8 spec's mkdir before the picker).
    const restoreParent = join(prepared.fixture.root, "restored-parent");
    mkdirSync(restoreParent, {mode: 0o700});
    const backupsBefore = new Set(
      findBackupManifests(prepared.fixture.root).map((backup) => backup.root),
    );
    await openR8Page(window2, activePage!.title);
    await openBackupSurface(window2);
    await setNativePaths(app, {save: backupTarget, open: backupTarget});
    await (await backupAction(window2, "バックアップを作成")).click();
    const created = await waitForNewBackup(prepared.fixture.root, backupsBefore);
    expect(created.manifest.format).toBe("folio-workspace-backup");
    expect(created.manifest.version).toBe(1);
    expect(existsSync(created.databasePath)).toBe(true);

    await setNativePaths(app, {save: created.root, open: created.root});
    await (await backupAction(window2, "バックアップを選んで検証")).click();
    const restoreButton = await backupAction(window2, "新しいフォルダーへ復元");
    await expect(restoreButton).toBeEnabled({timeout: 20000});
    const verification = await findLatestBackupCall(app, "choose");
    if (verification?.result)
      expect(resolve(verification.result.directory)).toBe(resolve(created.root));

    const workspacesBefore = new Set(findWorkspaceRoots(prepared.fixture.root));
    // The picked parent exists and is still empty until the real restore
    // runs: service.restore joins a brand-new absent child under it.
    expect(readdirSync(restoreParent)).toEqual([]);
    await setNativePaths(app, {save: restoreParent, open: restoreParent});
    await restoreButton.click();
    const restored = await waitForRestoredWorkspace(app, {
      root: prepared.fixture.root,
      sourceDir: prepared.fixture.data,
      backupDir: created.root,
      target: restoreParent,
      before: workspacesBefore,
    });
    expect(existsSync(join(restored, "workspace.sqlite"))).toBe(true);
    // The returned workspace is the new child the product created — never
    // the picked parent itself and never a pre-existing directory.
    const restoredReal = realpathSync(restored);
    const parentReal = realpathSync(restoreParent);
    expect(restoredReal).not.toBe(parentReal);
    expect(dirname(restoredReal)).toBe(parentReal);
    report.backup = {
      root: created.root,
      manifestPath: created.manifestPath,
      restoreParent,
      restored,
    };

    // Complete source vs restored compare — pages, settings, attachment
    // registry and bytes. workspaceState opens workspace.sqlite with
    // readOnly:true; nothing migrates or writes after the app's own save.
    const sourceState = workspaceState(prepared.fixture.data);
    const restoredState = workspaceState(restored);
    expect(restoredState.pages).toEqual(sourceState.pages);
    expect(restoredState.settings).toEqual(sourceState.settings);
    expect(restoredState.assets).toEqual(sourceState.assets);
    // Per-asset oracle on BOTH trees against the ORIGINAL manifest — registry
    // rows + byte length + sha256 + url resolution — read-only.
    expect(
      fixtureAssetProblems(
        manifest.databaseFile,
        manifest.workspaceDirectory,
        manifest,
      ),
    ).toEqual([]);
    expect(
      fixtureAssetProblems(
        join(restored, "workspace.sqlite"),
        restored,
        manifest,
      ),
    ).toEqual([]);
    expect(limitsStorageProblems(sourceState.settings, manifest.limits)).toEqual([]);
    expect(limitsStorageProblems(restoredState.settings, manifest.limits)).toEqual([]);

    // Final read-only observation sample while the SOURCE app still runs;
    // verdict VALID is required before the bounded close. The source handle
    // closes BEFORE the restored copy launches — no simultaneous
    // original/restored windows, one tracked mutable handle throughout.
    const capture = await captureCheckpointObservationSample({
      page: window2,
      context: observationCaptureContext(prepared),
      basename: "functional-observation-sample.json",
    });
    report.samplePath = capture.samplePath;
    report.sampleSha256 = capture.sampleSha256;
    report.verdict = capture.validation.verdict;
    report.problems = capture.validation.problems;
    expect(capture.validation.verdict).toBe("VALID");
    const sourceClose = await closeOwnedApp(app);
    (report.closes as unknown[]).push({lane: "source-reopen", ...sourceClose});
    app = undefined;
    expect(
      sourceClose.normal,
      "the planned source-reopen close must be a real normal app.close exit",
    ).toBe(true);

    // The restored copy opens through THIS spec's owned launch of the same
    // verified executable — never via the UI "復元先を開く" path, which would
    // spawn an uncaptured extra process. Observation is OFF for the copy and
    // a fresh private vault is pinned inside the same fixture root.
    const restoredEnv = restoredCopyEnv(prepared, restored);
    app = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      env: restoredEnv,
      timeout: 30000,
    });
    (report.launches as unknown[]).push({
      lane: "restored-copy",
      pid: app.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    try {
      const window3 = await app.firstWindow();
      await window3.waitForSelector(".page-title");
      expect(
        realpathSync(
          await app.evaluate(({app: electronApp}) =>
            electronApp.getPath("userData"),
          ),
        ),
      ).toBe(realpathSync(restored));
      expect(await verifyAll(window3)).toEqual([]);
    } finally {
      const restoredClose = await closeOwnedApp(app);
      (report.closes as unknown[]).push({lane: "restored-copy", ...restoredClose});
      app = undefined;
      expect(
        restoredClose.normal,
        "the planned restored-copy close must be a real normal app.close exit",
      ).toBe(true);
    }
    report.productResult = "COMPLETED";
  } finally {
    report.cleanup = await closeOwnedApp(app);
    writeFileSync(
      testInfo.outputPath("mac-trial-functional-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      {flag: "wx"},
    );
  }
});
