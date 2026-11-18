// MT12 packaged-Mac bounded manual drivers. Runnable ONLY through the
// existing guarded batch with fresh immutable inputs:
//   npm run test:e2e:batch -- --owned-shutdown tests/e2e/mac-trial-packaged-manual.spec.ts
// Required env (inherited unchanged): FOLIO_GUI_TEST_OPT_IN=1,
// FOLIO_LOCAL_GUI_BATCH=1, FOLIO_LOCAL_GUI_DATA_ROOT, FOLIO_OWNED_SHUTDOWN_REQUEST,
// FOLIO_CHECKPOINT_OBSERVATION_INTENT, FOLIO_CHECKPOINT_OBSERVATION_CANDIDATE.
// Scenario selector (selects which test runs; NEVER authorizes a launch):
//   FOLIO_MANUAL_MODE=physical | quit-interrupt
// Each test is hard-bounded at 210s (segment waits at 180s); the existing
// 240s/default/300s monitor envelope and request TTL are untouched.
// Commands under <evidenceDir>/command-NNNN.json are wx declarations for the
// human operator — they are never physical proof and never produce
// PHYSICAL_PASS. The root correlates the real human reply separately.
import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import {realpathSync, writeFileSync} from "node:fs";
import {
  OBSERVATION_CANDIDATE_ENV,
  OBSERVATION_INTENT_ENV,
  OWNED_REQUEST_ENV,
  captureCheckpointObservationSample,
  observationCaptureContext,
  prepareCheckpointObservation,
} from "./checkpoint-observation-harness";
import {
  INTERRUPT_HELD_TITLE,
  INTERRUPT_LATEST_BODY,
  INTERRUPT_LATEST_TITLE,
  MANUAL_MODE_ENV,
  MANUAL_SEGMENT_WAIT_MS,
  MANUAL_TEST_TIMEOUT_MS,
  PHYSICAL_BODY_LINE_1,
  PHYSICAL_BODY_LINE_2,
  ackAppliedEvents,
  ackSnapshotMatchesGoal,
  closeOwnedApp,
  docOrderedPlainParagraphs,
  emitManualStep,
  hasCompleteRecorderInterval,
  installPostCommitHold,
  installQuitAttemptCounter,
  installRequestRecorder,
  manualCommandGate,
  auditOldOperationCalls,
  awaitManualCommand,
  manualMode,
  publishManualReady,
  readObservationPort,
  readRequestCalls,
  readSessionAttempt,
  readUiStatus,
  receiptStatus,
  requestLoad,
  sleep,
  waitForHeld,
  waitForQuitAttempt,
} from "./mac-trial-packaged-session";

import {
  compareRecoveryRead,
  heldQuitDisposition,
  interruptOwnedChild,
  normalQuitReady,
  selectRecoveryAcks,
  waitForOwnedChildExit,
} from "./mac-trial-manual-observation";
const mode = manualMode(process.env);
const batchSkips = () => {
  test.skip(process.platform !== "darwin", "the packaged Mac target is required");
  test.skip(
    !process.env[OBSERVATION_INTENT_ENV] || !process.env[OBSERVATION_CANDIDATE_ENV],
    "a fresh immutable intent and candidate manifest are required",
  );
  test.skip(
    process.env.FOLIO_GUI_TEST_OPT_IN !== "1" || !process.env[OWNED_REQUEST_ENV],
    "the existing owned-shutdown batch env is required",
  );
};

test("physical: real human IME input then a real human Cmd+Q, verified by exact ACK and child exit", async ({}, testInfo) => {
  test.setTimeout(MANUAL_TEST_TIMEOUT_MS);
  batchSkips();
  test.skip(mode !== "physical", "FOLIO_MANUAL_MODE=physical selects this scenario");

  const prepared = prepareCheckpointObservation({env: process.env});
  const deadlineAt = new Date(Date.now() + MANUAL_TEST_TIMEOUT_MS).toISOString();
  const report: Record<string, unknown> = {
    runId: prepared.binding.runId,
    nonce: prepared.binding.nonce,
    mode: "physical",
    sourceCandidate: prepared.binding.sourceCandidate,
    artifactSha256: prepared.binding.artifactSha256,
    fixtureSha256: prepared.fixture.fixtureSha256,
    productResult: "HOLD",
    physical: "NOT_RUN",
    launches: [] as unknown[],
    commands: [] as unknown[],
    closes: [] as unknown[],
  };

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      // The mode selector is passed through verbatim for evidence only; the
      // owned-shutdown request remains the sole launch authority.
      env: {...prepared.env, [MANUAL_MODE_ENV]: "physical"},
      timeout: 30000,
    });
    (report.launches as unknown[]).push({
      lane: "human",
      pid: app.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    expect(
      realpathSync(
        await app.evaluate(({app: electronApp}) => electronApp.getPath("userData")),
      ),
    ).toBe(prepared.fixture.data);
    const child = app.process();
    expect(child.pid).toBeGreaterThan(0);

    // Focus ONLY this unique own window/title and the active editor. The
    // nonce-tagged document title makes the target unambiguous for the human.
    const windowTitle = `folio-manual-${prepared.binding.nonce}`;
    await window.evaluate((title) => {
      document.title = title;
    }, windowTitle);
    await window.bringToFront();
    await window.locator(".folio-editor").click();
    const ready = publishManualReady(prepared.fixture, prepared.binding, {
      pid: child.pid as number,
      executablePath: prepared.executablePath,
      windowTitle,
      deadlineAt,
    });
    report.readyPath = ready.path;

    const inputStep = emitManualStep(prepared.fixture, prepared.binding, "awaiting-physical-input", {
      instruction:
        `In the focused window only, replace the active editor body with ` +
        `「${PHYSICAL_BODY_LINE_1}」, press Enter once, then type ` +
        `「${PHYSICAL_BODY_LINE_2}」. Physical keyboard/IME only — this test ` +
        `never types Japanese itself. Reply to the root when done.`,
      activePage: prepared.fixture.manifest.activePage,
    });

    // The EXTERNAL root-written command-0001.json is the trigger: the root
    // writes "sample" only after the real human reply (or "cancel"). This
    // spec never issues commands itself; absent/invalid/cancel is NOT_RUN.
    const first = await awaitManualCommand(prepared.fixture, prepared.binding, {
      seq: 1,
      actions: ["sample", "cancel"],
      timeoutMs: MANUAL_SEGMENT_WAIT_MS,
      deadlineAt,
    });
    report.commandWait = {seq: 1, kind: first.kind};
    if (first.kind === "invalid") {
      emitManualStep(prepared.fixture, prepared.binding, "sample-invalid", {
        wait: first,
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    if (first.kind !== "received" || first.command.action === "cancel") {
      emitManualStep(prepared.fixture, prepared.binding, "sample-not-confirmed", {
        wait: first,
      });
      report.physical = "NOT_RUN";
      report.productResult = "NOT_RUN";
      return;
    }
    (report.commands as unknown[]).push(first.path);
    const firstGate = manualCommandGate(first.command, inputStep.at);
    if (firstGate.kind !== "OK") {
      emitManualStep(prepared.fixture, prepared.binding, "stale-first-command", {
        wait: first,
        stepAt: inputStep.at,
        gate: firstGate,
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }

    // The command is only a declaration: verify the VISIBLE expected human
    // text, the real read-port ACK and the main save indicator separately.
    const reportExtra = report;
    const observedText = await window.locator(".folio-editor").innerText();
    const visibleOk =
      observedText.includes(PHYSICAL_BODY_LINE_1) &&
      observedText.includes(PHYSICAL_BODY_LINE_2);
    emitManualStep(prepared.fixture, prepared.binding, "input-observed", {
      observedText,
    });
    if (!visibleOk) {
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }

    const deadlineMs =
      typeof deadlineAt === "string" ? Date.parse(deadlineAt) : Number(deadlineAt);
    const remainingMs = () => Math.max(0, deadlineMs - Date.now() - 30000);

    // Poll the real read port for the exact matching ACK on the active page.
    const ackDeadline = Date.now() + Math.min(60000, remainingMs());
    let targetAck:
      | {index: number; seq?: number; generation?: number; snapshotJson: string | null}
      | undefined;
    while (Date.now() < ackDeadline && !targetAck) {
      const raw = await readObservationPort(window);
      targetAck = ackAppliedEvents(raw).find((event) =>
        ackSnapshotMatchesGoal(event.snapshotJson, {
          pageId: prepared.fixture.manifest.activePage,
          bodyTexts: [PHYSICAL_BODY_LINE_1, PHYSICAL_BODY_LINE_2],
        }),
      );
      if (!targetAck) await sleep(300);
    }
    emitManualStep(prepared.fixture, prepared.binding, "ack-poll", {
      found: targetAck !== undefined,
    });

    // Immutable capture of the same validated sample: the ACK must come from
    // THIS capture and the main save indicator must independently read
    // "saved" before a normal quit is announced.
    const capture = await captureCheckpointObservationSample({
      page: window,
      context: observationCaptureContext(prepared),
      basename: "manual-physical-sample.json",
    });
    const ack = ackAppliedEvents(capture.sample).find((event) =>
      ackSnapshotMatchesGoal(event.snapshotJson, {
        pageId: prepared.fixture.manifest.activePage,
        bodyTexts: [PHYSICAL_BODY_LINE_1, PHYSICAL_BODY_LINE_2],
      }),
    );
    report.samplePath = capture.samplePath;
    report.verdict = capture.validation.verdict;
    report.targetAck = ack
      ? {index: ack.index, seq: ack.seq, generation: ack.generation}
      : null;
    // Bounded poll for the main save indicator — never a one-shot read.
    let uiBeforeQuit = await readUiStatus(window);
    const savedDeadline = Date.now() + Math.min(30000, remainingMs());
    while (uiBeforeQuit?.dataState !== "saved" && Date.now() < savedDeadline) {
      await sleep(300);
      uiBeforeQuit = await readUiStatus(window);
    }
    const readyToQuit = normalQuitReady(
      capture.validation.verdict === "VALID" && ack !== undefined,
      uiBeforeQuit?.dataState ?? null,
    );
    const visibleBeforeQuit = await window
      .locator(".folio-editor")
      .innerText()
      .catch(() => null);
    emitManualStep(prepared.fixture, prepared.binding, "pre-quit-state", {
      dataState: uiBeforeQuit?.dataState ?? null,
      ackFound: ack !== undefined,
      visibleOk:
        visibleBeforeQuit !== null &&
        visibleBeforeQuit.includes(PHYSICAL_BODY_LINE_1) &&
        visibleBeforeQuit.includes(PHYSICAL_BODY_LINE_2),
    });
    if (
      !readyToQuit ||
      visibleBeforeQuit === null ||
      !visibleBeforeQuit.includes(PHYSICAL_BODY_LINE_1) ||
      !visibleBeforeQuit.includes(PHYSICAL_BODY_LINE_2)
    ) {
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }

    // Arm the ORIGINAL-child exit observer BEFORE announcing: an already
    // exited child is HOLD, and only the real exit event time is recorded —
    // never a fabricated later-poll time.
    if (child.exitCode !== null || child.signalCode !== null) {
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }
    // Record the ORIGINAL monitor session binding and a positive owned PID
    // BEFORE announcing the normal Cmd+Q — a later session directory can
    // then never satisfy the first receipt.
    const firstSession = readSessionAttempt(String(prepared.request.runRoot), {
      expectedRunId: prepared.request.runId,
    });
    reportExtra.firstSessionBinding = firstSession;
    if (firstSession.status !== "ok" || (child.pid ?? 0) <= 0) {
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }
    // The exit subscription stays inside the remaining action budget — no
    // extra segment window beyond remainingMs().
    const exitWait = waitForOwnedChildExit(child, remainingMs());
    const quitStep = emitManualStep(prepared.fixture, prepared.binding, "awaiting-human-cmd-q", {
      instruction: "Press the real Cmd+Q once to quit the app.",
    });
    // The EXTERNAL command-0002.json confirms the human actually quit (or
    // cancels); this spec never issues commands itself. An invalid reply is
    // HOLD; a genuine absence or an explicit cancel is NOT_RUN.
    const second = await awaitManualCommand(prepared.fixture, prepared.binding, {
      seq: 2,
      actions: ["sample", "cancel"],
      timeoutMs: Math.min(MANUAL_SEGMENT_WAIT_MS, remainingMs()),
      deadlineAt,
    });
    reportExtra.commandWait2 = {seq: 2, kind: second.kind};
    if (second.kind === "invalid") {
      emitManualStep(prepared.fixture, prepared.binding, "quit-invalid", {
        wait: second,
      });
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }
    if (second.kind !== "received" || second.command.action === "cancel") {
      emitManualStep(prepared.fixture, prepared.binding, "quit-not-confirmed", {
        wait: second,
      });
      report.physical = "NOT_RUN";
      reportExtra.productResult = "NOT_RUN";
      return;
    }
    const secondGate = manualCommandGate(second.command, quitStep.at);
    if (secondGate.kind !== "OK") {
      emitManualStep(prepared.fixture, prepared.binding, "quit-stale-command", {
        wait: second,
        stepAt: quitStep.at,
        gate: secondGate,
      });
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }
    (report.commands as unknown[]).push(second.path);

    // Only the real ORIGINAL child exit counts — a nonzero code or a signal
    // is never a normal human quit. The monitor receipt belongs to the outer
    // wrapper, never to this file.
    const exit = await exitWait;
    // An exit whose REAL event time precedes the announced Cmd+Q step can
    // never be attributed to the human — HOLD, never a fabricated cause.
    if (exit.kind === "EXITED" && exit.exitedAt < Date.parse(quitStep.at)) {
      emitManualStep(prepared.fixture, prepared.binding, "pre-announce-exit", {
        ...exit,
        stepAt: quitStep.at,
      });
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }
    const exitFacts =
      exit.kind === "EXITED"
        ? {
            exited: true,
            exitCode: exit.exit.code,
            signalCode: exit.exit.signal,
            at: new Date(exit.exitedAt).toISOString(),
          }
        : {
            exited: false,
            exitCode: null,
            signalCode: null,
            at: null,
          };
    emitManualStep(prepared.fixture, prepared.binding, "child-exit", {...exit});
    report.firstSession = {
      lane: "human",
      method: "physical-CmdQ",
      pid: child.pid,
      exit: exitFacts,
      monitor: "AWAITING_OUTER_MONITOR",
    };
    if (exit.kind !== "EXITED" || exit.exit.code !== 0 || exit.exit.signal !== null) {
      if (exit.kind === "EXITED") {
        report.physical = "OBSERVED_ABNORMAL_EXIT";
        reportExtra.productResult = "FAIL";
        throw new Error("abnormal original-child exit after confirmed Cmd+Q");
      }
      // Confirmed Cmd+Q but no provable exit: unknown, never silent NOT_RUN.
      report.physical = "HOLD";
      reportExtra.productResult = "HOLD";
      return;
    }
    // Raw observed fact only — the root correlates the real human reply and
    // the existing monitor receipt; this file never emits PHYSICAL_PASS or
    // COMPLETED from an exit alone.
    report.physical = "OBSERVED";

    // AUTOMATION lane (recorded separately from the FIRST human Cmd+Q):
    // reopen the SAME verified .app on the SAME data and compare.
    app = undefined;
    const app2 = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      env: prepared.env,
      timeout: 30000,
    });
    app = app2;
    (report.launches as unknown[]).push({
      lane: "automation-reopen",
      pid: app2.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    try {
      const child2 = app2.process();
      expect(
        child2.pid,
        "the reopened child must have a distinct positive owned pid",
      ).toBeGreaterThan(0);
      expect(child2.pid).not.toBe(child.pid);
      expect(
        realpathSync(
          await app2.evaluate(({app: electronApp}) => electronApp.getPath("userData")),
        ),
      ).toBe(prepared.fixture.data);
      // Independently record the SECOND monitor session on the same real
      // data — a distinct session- directory under the same runRoot.
      const secondSession = readSessionAttempt(String(prepared.request.runRoot), {
        expectedRunId: prepared.request.runId,
        excludeDir: firstSession.dir,
      });
      reportExtra.secondSessionBinding = secondSession;
      if (secondSession.status !== "ok") {
        report.physical = "HOLD";
        reportExtra.productResult = "HOLD";
        return;
      }
      const window2 = await app2.firstWindow();
      await window2.waitForSelector(".page-title");
      // Authoritative reopen oracle: the persisted Snapshot from the
      // read-only load port, verified against the exact ordered
      // plain-paragraph Doc semantic — never a DOM substring scan.
      let persisted;
      try {
        persisted = await requestLoad(window2);
      } catch (error) {
        reportExtra.persistedReadError = String(error);
        report.physical = "HOLD";
        reportExtra.productResult = "HOLD";
        return;
      }
      const persistedPage = persisted.pages.find(
        (page) => page.id === persisted.settings.activePage,
      );
      const persistedMatch =
        persisted.settings.activePage === prepared.fixture.manifest.activePage &&
        persistedPage !== undefined &&
        docOrderedPlainParagraphs(persistedPage.doc, [
          PHYSICAL_BODY_LINE_1,
          PHYSICAL_BODY_LINE_2,
        ]);
      if (!persistedMatch) {
        // An explicitly valid but contradicting persisted read is a real FAIL
        // — the raw reply is recorded even though the mismatch throws.
        reportExtra.persistedMismatch = {
          activePage: persisted.settings.activePage,
          doc: persistedPage?.doc ?? null,
        };
        report.physical = "FAIL";
        reportExtra.productResult = "FAIL";
        throw new Error("persisted content contradicts the confirmed Cmd+Q");
      }
      // Visible DOM text stays as supplemental observation only.
      const text = await window2.locator(".folio-editor").innerText();
      expect(text).toContain(PHYSICAL_BODY_LINE_1);
      expect(text).toContain(PHYSICAL_BODY_LINE_2);
      report.reopenVerified = true;
    } finally {
      const close = await closeOwnedApp(app2);
      (report.closes as unknown[]).push({
        lane: "reopen-verify",
        kind: "AUTOMATION",
        ...close,
      });
      if (app === app2) app = undefined;
      expect(
        close.normal,
        "the AUTOMATION reopen close must be a real normal app.close exit",
      ).toBe(true);
    }
    report.productResult = "AWAITING_OUTER_MONITOR";
  } finally {
    report.cleanup = await closeOwnedApp(app);
    writeFileSync(
      testInfo.outputPath("mac-trial-manual-physical-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      {flag: "wx"},
    );
  }
});

test("quit-interrupt: held post-COMMIT ACK, real Cmd+Q, owned SIGKILL, same-data recovery", async ({}, testInfo) => {
  test.setTimeout(MANUAL_TEST_TIMEOUT_MS);
  batchSkips();
  test.skip(
    mode !== "quit-interrupt",
    "FOLIO_MANUAL_MODE=quit-interrupt selects this scenario",
  );

  // The outer batch runs this only after the existing packaged observer
  // spec passed on the same candidate; each run still seeds a fresh fixture.
  const prepared = prepareCheckpointObservation({env: process.env});
  const manifest = prepared.fixture.manifest;
  const deadlineAt = new Date(Date.now() + MANUAL_TEST_TIMEOUT_MS).toISOString();
  const report: Record<string, unknown> = {
    runId: prepared.binding.runId,
    nonce: prepared.binding.nonce,
    mode: "quit-interrupt",
    sourceCandidate: prepared.binding.sourceCandidate,
    artifactSha256: prepared.binding.artifactSha256,
    fixtureSha256: prepared.fixture.fixtureSha256,
    productResult: "HOLD",
    physical: "UNKNOWN",
    launches: [] as unknown[],
    commands: [] as unknown[],
    closes: [] as unknown[],
  };

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      env: {...prepared.env, [MANUAL_MODE_ENV]: "quit-interrupt"},
      timeout: 30000,
    });
    (report.launches as unknown[]).push({
      lane: "human",
      pid: app.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    expect(
      realpathSync(
        await app.evaluate(({app: electronApp}) => electronApp.getPath("userData")),
      ),
    ).toBe(prepared.fixture.data);
    const child = app.process();
    expect(child.pid).toBeGreaterThan(0);

    // Post-COMMIT hold on BOTH request channels. The real registered handler
    // (authorization, args, COMMIT, applied result) always runs first; only
    // the already-produced reply of the first save:commit for the active
    // page is held. No synthetic applied ACK is ever produced.
    await installPostCommitHold(app, {pageId: manifest.activePage});
    const title = window.getByLabel("ページタイトル", {exact: true});
    await title.fill(INTERRUPT_HELD_TITLE);
    const held = await waitForHeld(app, 60000);
    expect(receiptStatus(held.result)).toBe("applied");
    report.heldChannel = held.channel;
    report.heldOperationId = held.operation?.operationId ?? null;

    // Later title/body input lands as pending intents while the reply is held.
    await title.fill(INTERRUPT_LATEST_TITLE);
    // The frozen active guide starts as heading + empty paragraph, so a bare
    // fill would leave the heading and the ACK goal's one-plain-paragraph doc
    // unreachable: select-all + Backspace resets ProseMirror to the default
    // paragraph first, exactly as in the functional driver.
    const interruptEditor = window.locator(".folio-editor");
    await interruptEditor.click();
    await window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await window.keyboard.press("Backspace");
    await interruptEditor.fill(INTERRUPT_LATEST_BODY);

    // The exact ACK carrying the held operation AND the later pending
    // intents, via the read port, BEFORE the human is told the scenario is
    // ready. INIT/UI/file-existence are never used as proof.
    const heldOperationId = held.operation?.operationId ?? null;
    if (heldOperationId === null) {
      emitManualStep(
        prepared.fixture,
        prepared.binding,
        "held-precondition-missing",
        {heldOperationId},
      );
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    const goal = {
      pageId: manifest.activePage,
      operationId: heldOperationId,
      operation: held.operation,
      title: INTERRUPT_LATEST_TITLE,
      bodyTexts: [INTERRUPT_LATEST_BODY],
    };
    const ackDeadline = Date.now() + 60000;
    let finalAck:
      | {index: number; seq: number; generation: number; snapshotJson: string}
      | undefined;
    while (Date.now() < ackDeadline && !finalAck) {
      const raw = await readObservationPort(window);
      finalAck = ackAppliedEvents(raw).find((event) =>
        ackSnapshotMatchesGoal(event.snapshotJson, goal),
      );
      if (!finalAck) await sleep(300);
    }
    if (finalAck === undefined) {
      // A missing pre-target in the validated sample authorizes nothing —
      // HOLD before any prompt instead of a thrown dead NOT_RUN.
      emitManualStep(prepared.fixture, prepared.binding, "target-ack-missing", {});
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    const preQuit = await captureCheckpointObservationSample({
      page: window,
      context: observationCaptureContext(prepared),
      basename: "manual-pre-quit-sample.json",
    });
    report.preQuitSample = {
      path: preQuit.samplePath,
      verdict: preQuit.validation.verdict,
    };
    if (preQuit.validation.verdict !== "VALID") {
      emitManualStep(prepared.fixture, prepared.binding, "prequit-not-valid", {
        verdict: preQuit.validation.verdict,
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }

    // The raw poll above is only a wait on the OLD renderer — the prompt may
    // only be armed on the SAME held target found inside the immutable VALID
    // pre-quit sample; a VALID+INIT-only sample authorizes nothing.
    const preTarget = ackAppliedEvents(preQuit.sample).find((event) =>
      ackSnapshotMatchesGoal(event.snapshotJson, goal),
    );
    report.preTargetAck =
      preTarget === undefined
        ? null
        : {index: preTarget.index, seq: preTarget.seq, generation: preTarget.generation};
    if (preTarget === undefined) {
      emitManualStep(
        prepared.fixture,
        prepared.binding,
        "held-precondition-missing",
        {heldOperationId, verdict: preQuit.validation.verdict},
      );
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    await installQuitAttemptCounter(app);
    const windowTitle = `folio-manual-${prepared.binding.nonce}`;
    await window.evaluate((value) => {
      document.title = value;
    }, windowTitle);
    await window.bringToFront();
    // BEFORE the held Cmd+Q is announced: the immutable pre-target ACK
    // captured from the VALID sample, the current pending/error main state,
    // the visible expected contents and a live owned original child must all
    // hold — otherwise HOLD, no prompt is emitted.
    const uiPreAnnounce = await readUiStatus(window);
    const visiblePreAnnounce = await window
      .locator(".folio-editor")
      .innerText()
      .catch(() => null);
    const announceReady =
      preQuit.validation.verdict === "VALID" &&
      preTarget !== undefined &&
      (uiPreAnnounce?.dataState === "pending" || uiPreAnnounce?.dataState === "error") &&
      visiblePreAnnounce !== null &&
      visiblePreAnnounce.includes(INTERRUPT_LATEST_BODY) &&
      (child.pid ?? 0) > 0 &&
      child.exitCode === null &&
      child.signalCode === null;
    if (!announceReady) {
      emitManualStep(prepared.fixture, prepared.binding, "pre-announce-insufficient", {
        verdict: preQuit.validation.verdict,
        ackFound: preTarget !== undefined,
        dataState: uiPreAnnounce?.dataState ?? null,
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    // Bind the FIRST-session monitor identity while only the original owned
    // child is live: distinct binding/request runIds, request runRoot, PID,
    // observation time and the unique session- directory — a later normal
    // close can then never satisfy the first receipt. Ambiguous => HOLD.
    const reportExtra = report;
    const initialSession = readSessionAttempt(String(prepared.request.runRoot), {
      expectedRunId: prepared.request.runId,
    });
    reportExtra.monitorBinding = {
      bindingRunId: prepared.binding.runId,
      requestRunId: prepared.request.runId,
      runRoot: prepared.request.runRoot,
      pid: child.pid,
      observedAt: new Date().toISOString(),
      session: initialSession,
      monitor: "BOOTSTRAP_OBSERVER",
    };
    // The owned monitor nonce and the observing intent nonce are separate
    // namespaces — never compared to the manual binding nonce. Any missing,
    // invalid or ambiguous session binding is HOLD, no first prompt.
    if (initialSession.status !== "ok") {
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    publishManualReady(prepared.fixture, prepared.binding, {
      pid: child.pid as number,
      executablePath: prepared.executablePath,
      windowTitle,
      deadlineAt,
    });
    const heldStep = emitManualStep(prepared.fixture, prepared.binding, "awaiting-human-cmd-q", {
      instruction:
        "Press the real Cmd+Q once. The app is expected to stay alive with " +
        "retained pending input — do not force-quit, do not click save.",
    });

    // Concurrently: the real close attempt AND the EXTERNAL seq-1
    // interrupt/cancel declaration that exists only after the person's
    // action. Any actual original-child exit during a confirmed hold —
    // including one that landed before the declaration arrived — is FAIL.
    const deadlineMs =
      typeof deadlineAt === "string" ? Date.parse(deadlineAt) : Number(deadlineAt);
    const remainingMs = () => Math.max(0, deadlineMs - Date.now() - 30000);
    // The real close attempt AND the EXTERNAL seq-1 interrupt/cancel
    // declaration run concurrently under the common deadline; BOTH outcomes
    // always feed the disposition — an early original-child exit is never
    // returned early on, and a refusal/cancel can never cause a signal.
    const [quit, command] = await Promise.all([
      waitForQuitAttempt(app, Math.min(MANUAL_SEGMENT_WAIT_MS, remainingMs())),
      awaitManualCommand(prepared.fixture, prepared.binding, {
        seq: 1,
        actions: ["interrupt", "cancel"],
        timeoutMs: Math.min(MANUAL_SEGMENT_WAIT_MS, remainingMs()),
        deadlineAt,
      }),
    ]);
    report.quitObservation = quit;
    report.commandWait = {seq: 1, kind: command.kind};
    // Raw ORIGINAL-child facts (exitCode/signalCode/close events/pid) prove
    // the actual exit — never a failed process lookup.
    const postAttemptExit = await waitForOwnedChildExit(
      child,
      Math.min(2000, remainingMs()),
    );
    const uiBeforeKill = await readUiStatus(window);
    const windowAlive = await window
      .evaluate(
        (probe) =>
          document.title === probe.title &&
          document.visibilityState === "visible" &&
          (document.querySelector(".folio-editor")?.textContent ?? "").includes(
            probe.body,
          ),
        {title: windowTitle, body: INTERRUPT_LATEST_BODY},
      )
      .catch(() => null);
    const exitFacts =
      quit.kind === "exited"
        ? {code: quit.exitCode, signal: quit.signalCode}
        : postAttemptExit.kind === "EXITED"
          ? {code: postAttemptExit.exit.code, signal: postAttemptExit.exit.signal}
          : null;
    // ISO-time ordering gate BEFORE the received command is classified as a
    // demonstrated interrupt: a stale, future-issued or expired command can
    // never promote an unrelated original-child exit to FAIL.
    const commandGate =
      command.kind === "received"
        ? manualCommandGate(command.command, heldStep.at)
        : null;
    const confirmedInterrupt =
      command.kind === "received" &&
      command.command.action === "interrupt" &&
      commandGate !== null &&
      commandGate.kind === "OK";
    const disposition = heldQuitDisposition({
      attempt:
        command.kind !== "received"
          ? command.kind === "invalid"
            ? "invalid"
            : "absent"
          : command.command.action === "cancel"
            ? "cancelled"
            : command.command.action !== "interrupt" || commandGate?.kind !== "OK"
              ? "invalid"
              : "performed",
      closeObserved: quit.kind === "retained",
      childExited: quit.kind === "exited" || postAttemptExit.kind === "EXITED",
      childExit: exitFacts,
      windowOwnedAlive: windowAlive,
      saveState: uiBeforeKill?.dataState ?? null,
      preCheckpointValid:
        preQuit.validation.verdict === "VALID" && finalAck !== undefined,
    });
    reportExtra.quitDisposition = disposition;
    if (confirmedInterrupt) {
      (report.commands as unknown[]).push(command.path);
    }
    if (disposition.kind === "NOT_RUN") {
      emitManualStep(
        prepared.fixture,
        prepared.binding,
        "interrupt-not-confirmed",
        {wait: command},
      );
      report.physical = "NOT_RUN";
      report.productResult = "NOT_RUN";
      return;
    }
    if (disposition.kind === "FAIL") {
      emitManualStep(prepared.fixture, prepared.binding, "held-quit-exited", {
        ...disposition,
      });
      report.physical = "FAIL";
      report.productResult = "FAIL";
      throw new Error("the original child exited during the confirmed held quit");
    }
    if (disposition.kind !== "INTERRUPT_ELIGIBLE") {
      emitManualStep(prepared.fixture, prepared.binding, "held-quit-ambiguous", {
        ...disposition,
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }

    // Latest VALIDATED immutable sample: the terminal absolute ACK and the
    // exact goal-matching target via the real read port — never INIT/UI.
    const finalCapture = await captureCheckpointObservationSample({
      page: window,
      context: observationCaptureContext(prepared),
      basename: "manual-final-ack-sample.json",
    });
    const selection = selectRecoveryAcks(
      {verdict: preQuit.validation.verdict, read: preQuit.sample},
      {verdict: finalCapture.validation.verdict, read: finalCapture.sample},
      (event) =>
        event.type === "ACK_APPLIED" &&
        ackSnapshotMatchesGoal(event.snapshotJson, goal),
    );
    reportExtra.finalSample = {
      path: finalCapture.samplePath,
      verdict: finalCapture.validation.verdict,
    };
    reportExtra.ackSelection =
      selection.kind === "READY"
        ? {
            kind: "READY",
            target: selection.target,
            terminal: selection.terminal,
            intervening: selection.intervening,
            subsequent: selection.subsequent,
            outstanding: selection.outstanding,
            status: selection.status,
            binding: selection.binding,
          }
        : selection;
    if (selection.kind !== "READY") {
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    report.finalAck = {
      index: selection.terminal.index,
      seq: selection.terminal.seq,
      generation: selection.terminal.generation,
    };
    const sampledAt = new Date().toISOString();
    // INTERRUPT_ELIGIBLE proves intent, not the union: only a received
    // interrupt command carries the issuance fields — fail closed.
    if (command.kind !== "received" || command.command.action !== "interrupt") {
      emitManualStep(prepared.fixture, prepared.binding, "interrupt-not-received", {
        kind: command.kind,
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    // Immutable issuance budget at the instant of issue: the external command
    // expiry, the owned-shutdown request expiry, the run deadline and the
    // remaining action budget must all be positive — otherwise HOLD, no send.
    const issueAt = Date.now();
    const commandExpiresAt = Date.parse(command.command.expiresAt);
    const requestExpiresAt = Date.parse(prepared.request.expiresAt);
    if (
      !Number.isFinite(commandExpiresAt) ||
      commandExpiresAt <= issueAt ||
      !Number.isFinite(requestExpiresAt) ||
      requestExpiresAt <= issueAt ||
      Date.parse(command.command.at) < Date.parse(heldStep.at) ||
      remainingMs() <= 0
    ) {
      emitManualStep(prepared.fixture, prepared.binding, "interrupt-budget-exhausted", {
        commandExpiresAt,
        requestExpiresAt,
        remainingMs: remainingMs(),
      });
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    // An exit that is positively known BEFORE the intentional signal is still
    // a FAIL — the hold did not survive to the confirmed interrupt.
    const preSignalExit = await waitForOwnedChildExit(child, 0);
    if (preSignalExit.kind === "EXITED") {
      emitManualStep(prepared.fixture, prepared.binding, "pre-signal-exit", {
        ...preSignalExit,
      });
      report.physical = "FAIL";
      report.productResult = "FAIL";
      throw new Error("the original child exited before the intentional signal");
    }
    // The actual send budget is measured ONCE at the last possible instant:
    // the 20s cap, the action budget, the command expiry and the request
    // expiry. An already-elapsed budget returns HOLD without any signal sent.
    const signalBudgetMs = Math.min(
      20000,
      remainingMs(),
      Date.parse(command.command.expiresAt) - Date.now(),
      Date.parse(prepared.request.expiresAt) - Date.now(),
    );
    const interrupt = await interruptOwnedChild(child, signalBudgetMs);
    report.interrupt = {
      commandPath: confirmedInterrupt ? command.path : null,
      sampledAt,
      uiStatus: uiBeforeKill,
      result: interrupt,
    };
    if (interrupt.kind !== "INTERRUPTED") {
      // Timeout, refused, wrong or missing signal => HOLD; no fresh app.
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    // The killed first session intentionally keeps NO_ACCEPTED_QUIT/UNKNOWN
    // and the wrapper's nonzero status; nothing here rewrites monitor,
    // physical or macro status. No new input is added after the final
    // sample — the unobserved interval stays UNKNOWN.
    report.firstSession = {
      termination: "SIGKILL",
      monitor: "AWAITING_OUTER_MONITOR",
      expectedQuitReceipt: "NO_ACCEPTED_QUIT",
      quitReceipt: "UNKNOWN",
      pid: child.pid,
    };

    // Reopen the SAME verified .app on the SAME data inside the SAME owned
    // runRoot — workspace path identity preserved, no relocation.
    const app2 = await electron.launch({
      executablePath: prepared.executablePath,
      args: [],
      env: {...prepared.env, [MANUAL_MODE_ENV]: "quit-interrupt"},
      timeout: 30000,
    });
    app = app2;
    (report.launches as unknown[]).push({
      lane: "automation-recovery",
      pid: app2.process().pid ?? null,
      executablePath: prepared.executablePath,
    });
    // Owned recovery child identity BEFORE any read/mutation: distinct
    // positive pid AND the exact same userData realpath.
    const child2 = app2.process();
    expect(
      child2.pid,
      "the recovery child must have a distinct positive owned pid",
    ).toBeGreaterThan(0);
    expect(child2.pid).not.toBe(child.pid);
    expect(
      realpathSync(
        await app2.evaluate(({app: electronApp}) => electronApp.getPath("userData")),
      ),
    ).toBe(prepared.fixture.data);
    // The reopened session binds independently and must be distinct from the
    // initial session directory on the same real data.
    const recoverySession = readSessionAttempt(String(prepared.request.runRoot), {
      expectedRunId: prepared.request.runId,
      excludeDir: initialSession.dir,
    });
    reportExtra.recoverySession = recoverySession;
    if (recoverySession.status !== "ok") {
      report.physical = "HOLD";
      report.productResult = "HOLD";
      return;
    }
    let recorderCoverage:
      | Awaited<ReturnType<typeof installRequestRecorder>>
      | undefined;
    // The expected-scope precondition is measured for the finally report on
    // every outcome — the latest terminal may omit the old operation.
    let terminalIsHeld = false;
    try {
      // Earliest recorder hook on the fresh app2 — BEFORE the first renderer
      // attaches so arrivals are bounded from the reported install time; a
      // renderer already present marks coverage LATE, never a whole-launch zero.
      recorderCoverage = await installRequestRecorder(app2);
      reportExtra.recorderCoverage = recorderCoverage;
      const callsBefore = await readRequestCalls(app2);
      const window2 = await app2.firstWindow();
      // Recovery compared EXACTLY against the validated terminal ACK of the
      // final captured sample — same generation and a deep-equal snapshot via
      // canonical JSON; never INIT/UI/file-existence, never a chosen loss
      // tolerance, never an older matched snapshot.
      const read = await window2.evaluate(() =>
        (globalThis as any).window.folio.request({type: "recovery:read"}),
      );
      const recoveryRead = {
        status:
          read !== null &&
          typeof read === "object" &&
          typeof (read as {status?: unknown}).status === "string"
            ? ((read as {status?: string}).status as string)
            : null,
        generation:
          read !== null &&
          typeof read === "object" &&
          typeof (read as {generation?: unknown}).generation === "number"
            ? ((read as {generation?: number}).generation as number)
            : null,
        snapshotJson:
          read !== null && typeof read === "object" && "snapshot" in read
            ? JSON.stringify((read as {snapshot?: unknown}).snapshot)
            : null,
        raw: read,
      };
      const comparison = compareRecoveryRead(selection.terminal, recoveryRead);
      reportExtra.recoveryComparison = comparison;
      if (comparison.kind === "FAIL") {
        report.productResult = "FAIL";
        throw new Error("recovery read contradicts the validated terminal ACK");
      }
      if (comparison.kind !== "MATCH") {
        report.physical = "HOLD";
        report.productResult = "HOLD";
        report.recovery = {resolvedOnce: false, pending: "comparison", comparison};
        return;
      }
      report.recoveryGeneration = comparison.generation;
      // The held-operation precondition is the EXACT same goal predicate as
      // the initial target match — never substring/leaf occurrence.
      terminalIsHeld = ackSnapshotMatchesGoal(selection.terminal.snapshotJson, goal);
      if (terminalIsHeld) {
        const dialog = window2.getByRole("dialog", {
          name: "前回の入力を復旧",
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole("button", {name: "入力を復元", exact: true})
          .click();
        await expect(dialog).toBeHidden();
        await expect(
          window2.getByLabel("ページタイトル", {exact: true}),
        ).toHaveValue(INTERRUPT_LATEST_TITLE);
        await expect(window2.locator(".folio-editor")).toContainText(
          INTERRUPT_LATEST_BODY,
        );
        // Bounded wait for the expected old resolve arrival before audit.
        const resolveDeadline = Date.now() + Math.min(15000, remainingMs());
        let midAudit = auditOldOperationCalls(
          await readRequestCalls(app2),
          heldOperationId,
        );
        while (
          midAudit.kind === "HOLD" &&
          midAudit.reason === "OLD_RESOLVE_MISSING" &&
          Date.now() < resolveDeadline
        ) {
          await sleep(250);
          midAudit = auditOldOperationCalls(
            await readRequestCalls(app2),
            heldOperationId,
          );
        }
      }
      const callsAfter = await readRequestCalls(app2);
      const audit = auditOldOperationCalls(callsAfter, heldOperationId);
      reportExtra.requestCalls = {
        installedAt: recorderCoverage.installedAt,
        sampledBefore: callsBefore.calls.length,
        sampledAfter: callsAfter.calls.length,
        channelsWrapped: recorderCoverage.channelsWrapped,
        channelsMissing: recorderCoverage.channelsMissing,
        rendererAlreadyPresent: recorderCoverage.rendererAlreadyPresent,
        audit,
      };
      if (audit.kind === "FAIL") {
        report.productResult = "FAIL";
        throw new Error("an old save/database commit re-arrived after recovery");
      }
      // Positive scoped facts survive coverage gaps explicitly; the whole-run
      // claim stays HOLD forever — only the measured interval is ever known.
      if (audit.kind === "OK") {
        reportExtra.scopedAppliedResolve = audit.appliedResolve;
      }
      reportExtra.wholeRunResend = "HOLD";
      if (!hasCompleteRecorderInterval(recorderCoverage, callsAfter)) {
        report.physical = "HOLD";
        report.productResult = "HOLD";
        report.recovery = {
          resolvedOnce: false,
          pending: "recorder-coverage",
          coverageBound: recorderCoverage.installedAt,
        };
        return;
      }
      if (!terminalIsHeld) {
        report.physical = "HOLD";
        report.productResult = "HOLD";
        report.recovery = {resolvedOnce: false, pending: "precondition"};
        return;
      }
      if (audit.kind !== "OK") {
        report.physical = "HOLD";
        report.productResult = "HOLD";
        report.recovery = {resolvedOnce: false, pending: audit.reason};
        return;
      }
      report.recovery = {
        resolvedOnce: true,
        duplicateCommitsInInterval: 0,
        measuredInterval: {from: recorderCoverage.installedAt, to: callsAfter.readAt},
      };
    } finally {
      // The LAST available recorder read/audit and the second normal close
      // run on EVERY outcome (missing dialog, timeout, HOLD, FAIL): a
      // conclusively arrived old commit overrides a HOLD anywhere, while a
      // known FAIL stays FAIL. Only the measured interval is ever reported;
      // the pre-hook gap and the post-read tail stay UNKNOWN.
      const finalCalls = await readRequestCalls(app2).catch(() => null);
      const finalCallsAvailable = finalCalls?.available === true;
      const finalAudit =
        finalCalls === null ? null : auditOldOperationCalls(finalCalls, heldOperationId);
      reportExtra.finalRequestCalls = {
        available: finalCallsAvailable,
        installedAt: recorderCoverage?.installedAt ?? null,
        readAt: finalCalls?.readAt ?? null,
        audit: finalAudit,
      };
      const recoveryClose = await closeOwnedApp(app2);
      (report.closes as unknown[]).push({
        lane: "recovery",
        kind: "AUTOMATION",
        ...recoveryClose,
      });
      if (app === app2) app = undefined;
      report.secondSession = {
        close: recoveryClose.method,
        normal: recoveryClose.normal,
        pid: child2.pid ?? null,
        monitor: "AWAITING_OUTER_MONITOR",
      };
      // The DEFINITIVE scoped verdict is computed here — not inside the
      // try — from the final audit, the explicit terminal-scope precondition
      // and the returned normal close (and PID). An earlier scoped success
      // survives only as historic evidence, never as the final claim.
      const observedAppliedResolve =
        finalAudit !== null && finalAudit.kind === "OK"
          ? finalAudit.appliedResolve
          : null;
      // Definitive resolvedOnce===true requires ALL of: full original-channel
      // recorder coverage over the recorded interval, the held terminal
      // precondition after a proven matching recovery, an AVAILABLE final
      // read audited OK, and a normal close on the recovery child PID.
      // Anything less is unconfirmed — positive facts are still recorded.
      const scopedChannelsReady = hasCompleteRecorderInterval(
        recorderCoverage,
        finalCalls,
      );
      const scopedCloseOk =
        recoveryClose.normal === true &&
        recoveryClose.pid !== null &&
        recoveryClose.pid !== undefined &&
        recoveryClose.pid > 0 &&
        recoveryClose.pid === child2.pid;
      const scopedPending = !scopedChannelsReady
        ? "RECORDER_COVERAGE"
        : !terminalIsHeld
          ? "PRECONDITION"
          : !finalCallsAvailable || finalAudit === null
            ? "FINAL_READ_UNAVAILABLE"
            : finalAudit.kind !== "OK"
              ? finalAudit.reason
              : !scopedCloseOk
                ? "RECOVERY_CLOSE"
                : null;
      report.scopedRecovery =
        scopedPending === null && finalAudit !== null && finalAudit.kind === "OK"
          ? {
              resolvedOnce: true,
              observedAppliedResolve,
              calls: finalCalls === null ? null : finalCalls.calls.length,
              measuredInterval: {
                from: recorderCoverage?.installedAt ?? null,
                to: finalCalls?.readAt ?? null,
              },
              preconditionHeld: terminalIsHeld,
              normalClose: recoveryClose.normal,
              closePid: recoveryClose.pid ?? null,
              historicAppliedResolve: reportExtra.scopedAppliedResolve ?? null,
              preHookInterval: "UNKNOWN",
              postReadInterval: "UNKNOWN",
              wholeRunResend: "HOLD",
            }
          : {
              resolvedOnce: null,
              unconfirmed: scopedPending ?? "UNCONFIRMED",
              observedAppliedResolve,
              preconditionHeld: terminalIsHeld,
              normalClose: recoveryClose.normal,
              closePid: recoveryClose.pid ?? null,
              channelsWrapped: recorderCoverage?.channelsWrapped ?? [],
              channelsMissing: recorderCoverage?.channelsMissing ?? [],
              measuredInterval: {
                from: recorderCoverage?.installedAt ?? null,
                to: finalCalls?.readAt ?? null,
              },
              historicAppliedResolve: reportExtra.scopedAppliedResolve ?? null,
              preHookInterval: "UNKNOWN",
              postReadInterval: "UNKNOWN",
              wholeRunResend: "HOLD",
            };
      // The intermediate report.recovery written inside the try can never
      // surface as a stale definitive verdict — overwrite it consistently.
      report.recovery = report.scopedRecovery;
      if (
        finalAudit !== null &&
        finalAudit.kind === "FAIL" &&
        report.productResult !== "FAIL"
      ) {
        report.physical = "FAIL";
        report.productResult = "FAIL";
        throw new Error(
          "an old save/database commit arrived before the recovery-session close",
        );
      }
    }
    // No AWAITING_OUTER_MONITOR promotion: that claim belongs to the NORMAL
    // Cmd+Q lane only. The startup pre-hook and post-last-read windows stay
    // UNKNOWN, so this interrupt run remains HOLD unless a proven FAIL threw
    // above or a genuine absent/cancel was already reported NOT_RUN.
  } finally {
    report.cleanup = await closeOwnedApp(app);
    writeFileSync(
      testInfo.outputPath("mac-trial-manual-quit-interrupt-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      {flag: "wx"},
    );
  }
});
