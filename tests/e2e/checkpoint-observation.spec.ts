// Packaged-Mac checkpoint observation capture. Runnable ONLY through the
// existing guarded batch with fresh immutable inputs:
//   npm run test:e2e:batch -- --owned-shutdown tests/e2e/checkpoint-observation.spec.ts
// Requires FOLIO_CHECKPOINT_OBSERVATION_INTENT (intent.json path),
// FOLIO_CHECKPOINT_OBSERVATION_CANDIDATE (candidate manifest path) and the
// inherited FOLIO_OWNED_SHUTDOWN_REQUEST. Normal graceful close only; the
// fixture and logs are left in place on failure.
import {test, expect, _electron as electron} from "@playwright/test";
import {realpathSync, writeFileSync} from "node:fs";
import {
  OBSERVATION_CANDIDATE_ENV,
  OBSERVATION_INTENT_ENV,
  OWNED_REQUEST_ENV,
  captureCheckpointObservationSample,
  observationCaptureContext,
  prepareCheckpointObservation,
} from "./checkpoint-observation-harness";

test("packaged Mac app exposes a read-only checkpoint observation sample", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "the packaged Mac target is required");
  test.skip(!process.env[OBSERVATION_INTENT_ENV] || !process.env[OBSERVATION_CANDIDATE_ENV],
    "a fresh immutable intent and candidate manifest are required");
  test.skip(process.env.FOLIO_GUI_TEST_OPT_IN !== "1" || !process.env[OWNED_REQUEST_ENV],
    "the existing owned-shutdown batch env is required");

  const prepared = prepareCheckpointObservation({env: process.env});
  const app = await electron.launch({
    executablePath: prepared.executablePath,
    args: [],
    env: prepared.env,
    timeout: 30000,
  });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    const userData = await app.evaluate(({app: electronApp}) => electronApp.getPath("userData"));
    expect(realpathSync(userData)).toBe(prepared.fixture.data);
    await window.getByLabel("ページタイトル", {exact: true}).fill("観測検証ノート");
    await expect(window.locator(".save-state")).toHaveText("保存済み");
    const capture = await captureCheckpointObservationSample({
      page: window,
      context: observationCaptureContext(prepared),
    });
    const sample = capture.sample;
    // VALID alone is not proof: at least one ACK_APPLIED must match its prior
    // OFFERED and carry the deliberate title edit on the seeded active page.
    const TITLE = "観測検証ノート";
    const ackEvents = (sample?.observation?.events ?? [])
      .filter((event) => event.type === "ACK_APPLIED") as Array<{
        index: number; seq: number; generation: number; snapshotJson: string;
      }>;
    const targetAck = ackEvents.find((event) => {
      const parsed = JSON.parse(event.snapshotJson) as {
        pages?: Array<{base?: {id?: string}; intents?: Array<{patch?: {title?: unknown}}>; operation?: unknown}>;
        records?: Array<{base?: {id?: string}; intents?: Array<{patch?: {title?: unknown}}>; operation?: unknown}>;
      };
      return [...(parsed.pages ?? []), ...(parsed.records ?? [])].some((entry) => {
        if (entry.base?.id !== prepared.fixture.manifest.activePage) return false;
        const operation = entry.operation as
          {patch?: {title?: unknown}; operation?: {patch?: {title?: unknown}}} | undefined;
        const candidates = [
          ...(entry.intents ?? []).map((intent) => intent?.patch),
          operation?.patch,
          operation?.operation?.patch,
        ];
        return candidates.some((patch) => (patch as {title?: unknown} | undefined)?.title === TITLE);
      });
    });
    const report = {
      runId: prepared.binding.runId,
      nonce: prepared.binding.nonce,
      sourceCandidate: prepared.binding.sourceCandidate,
      artifactSha256: prepared.binding.artifactSha256,
      fixtureSha256: prepared.fixture.fixtureSha256,
      rendererInstanceId: sample?.rendererInstanceId ?? null,
      queueEpoch: sample?.queueEpoch ?? null,
      observedSeqs: (sample?.observation?.events ?? [])
        .filter((event) => event.type === "OFFERED")
        .map((event) => (event as {seq: number}).seq),
      ackGenerations: (sample?.observation?.events ?? [])
        .filter((event) => event.type === "ACK_APPLIED")
        .map((event) => (event as {generation: number}).generation),
      status: sample?.observation?.status ?? null,
      targetAck: targetAck ?
        {index: targetAck.index, seq: targetAck.seq, generation: targetAck.generation,
          snapshotJson: targetAck.snapshotJson} : null,
      samplePath: capture.samplePath,
      sampleSha256: capture.sampleSha256,
      capturedAt: capture.capturedAt,
      verdict: capture.validation.verdict,
      problems: capture.validation.problems,
      productResult: "NOT_RUN",
      physical: "NOT_RUN",
    };
    writeFileSync(testInfo.outputPath("checkpoint-observation-report.json"),
      `${JSON.stringify(report, null, 2)}\n`, {flag: "wx"});
    expect(capture.validation.verdict).toBe("VALID");
    expect(ackEvents.length).toBeGreaterThan(0);
    expect(targetAck).toBeDefined();
  } finally {
    await app.close();
  }
});
