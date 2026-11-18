import fs from 'node:fs';
import { _electron, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  OBSERVATION_CANDIDATE_ENV,
  OBSERVATION_INTENT_ENV,
  OWNED_REQUEST_ENV,
  prepareCheckpointObservation,
} from './checkpoint-observation-harness';
import {
  MANUAL_SEGMENT_WAIT_MS,
  MANUAL_TEST_TIMEOUT_MS,
  awaitManualCommand,
  closeOwnedApp,
  emitManualStep,
  publishManualReady,
  readUiStatus,
  requestLoad,
  writeImmutableEvidence,
} from './mac-trial-packaged-session';
import { openR8Page } from './r8-acceptance/r8-fixture';
import * as ed from './mac-trial-editor-cases';

type Status = 'NOT_RUN' | 'HOLD' | 'FAIL' | 'AWAITING_HUMAN_AND_MONITOR_CORRELATION';

interface StepRecord {
  seq: number;
  slug: string;
  instruction: string;
  at: string;
  command?: { action: string; at?: string | null; path?: string | null; sha256?: string | null };
  invalid?: number;
  verdict?: unknown;
  facts?: Record<string, unknown>;
}

interface CommandResult {
  kind: string;
  path?: string;
  sha256?: string;
  command?: { action?: string; at?: string };
  error?: string;
  at?: string;
}

interface Snap {
  settings?: { activePage?: string };
  pages?: ed.SnapshotPage[];
}

interface Report {
  runId: string | null;
  nonce: string | null;
  source: string;
  packaged: string | null;
  candidate: string | null;
  artifactSha256: string | null;
  fixtureSha256: string | null;
  fixture: Record<string, unknown>;
  case: string | null;
  steps: StepRecord[];
  observations: Record<string, unknown>[];
  closes: Record<string, unknown>[];
  status: Status;
  detail: string;
}

test('packaged physical editor case on a bound synthetic fixture', async () => {
  test.setTimeout(MANUAL_TEST_TIMEOUT_MS);
  test.skip(process.platform !== 'darwin', 'packaged editor case requires darwin');
  test.skip(process.env.FOLIO_GUI_TEST_OPT_IN !== '1', 'requires FOLIO_GUI_TEST_OPT_IN=1');
  for (const name of [OWNED_REQUEST_ENV, OBSERVATION_INTENT_ENV, OBSERVATION_CANDIDATE_ENV]) {
    test.skip(!String(process.env[name] ?? '').trim(), `missing ${name}: no bound editor run selected`);
  }

  const prepared = prepareCheckpointObservation({ env: process.env });
  const { binding, fixture, executablePath, env } = prepared;
  const manifest: ed.TrialManifest = {
    activePage: fixture.manifest.activePage,
    database: fixture.manifest.database,
    records: [...fixture.manifest.records],
    pages: [...fixture.manifest.pages],
  };
  const totalDeadlineMs = Date.now() + MANUAL_TEST_TIMEOUT_MS;
  const deadlineAt = new Date(totalDeadlineMs).toISOString();
  const reserveMs = Math.max(0, MANUAL_TEST_TIMEOUT_MS - MANUAL_SEGMENT_WAIT_MS);
  const actionDeadlineMs = totalDeadlineMs - reserveMs;

  const report: Report = {
    runId: binding.runId ?? null,
    nonce: binding.nonce ?? null,
    source: 'tests/e2e/mac-trial-packaged-editor.spec.ts',
    packaged: executablePath ?? null,
    candidate: binding.sourceCandidate ?? null,
    artifactSha256: binding.artifactSha256 ?? null,
    fixtureSha256: binding.fixtureSha256 ?? null,
    fixture: {
      root: fixture.root,
      data: fixture.data,
      vault: fixture.vault,
      evidenceDir: fixture.evidenceDir,
      bindingDataDir: binding.dataDir ?? null,
      bindingVaultDir: binding.vaultDir ?? null,
    },
    case: null,
    steps: [],
    observations: [],
    closes: [],
    status: 'NOT_RUN',
    detail: 'no operator sample received',
  };

  let app: ElectronApplication | undefined;
  let appPid = 0;
  let caught: unknown;

  const writeReport = (): void => {
    writeImmutableEvidence(fixture, 'packaged-editor-case-report.json', report);
  };

  const closeApp = async (label: string): Promise<Record<string, unknown> | undefined> => {
    if (!app) return undefined;
    const handle = app;
    app = undefined;
    let r: Record<string, unknown>;
    try {
      r = { ...(await closeOwnedApp(handle)) } as Record<string, unknown>;
    } catch (err) {
      r = { normal: false, error: String(err) };
    }
    report.closes.push({ label, launchedPid: appPid, ...r });
    return r;
  };

  const launchOwned = async (label: string): Promise<{ page: Page; pid: number }> => {
    const electron = await _electron.launch({ executablePath, args: [], env, timeout: 30_000 });
    app = electron;
    const pid = electron.process().pid ?? 0;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      await closeApp(`${label}-reject-pid`);
      throw new Error(`unusable owned pid ${pid} from packaged launch`);
    }
    appPid = pid;
    const userData = await electron.evaluate(({ app: a }) => a.getPath('userData'));
    const realUser = fs.realpathSync(userData);
    const realData = fs.realpathSync(fixture.data);
    if (realUser !== realData) {
      await closeApp(`${label}-reject-userdata`);
      throw new Error(`userData ${realUser} is not the frozen data dir ${realData}`);
    }
    const page = await electron.firstWindow();
    await page.waitForSelector('.page-title', { timeout: 15_000 });
    await page.bringToFront();
    report.observations.push({ kind: 'launch', label, pid, userData: realUser });
    return { page, pid };
  };

  const lastStep = (): StepRecord => report.steps[report.steps.length - 1];

  const snapNow = async (pg: Page): Promise<Snap> => (await requestLoad(pg)) as Snap;

  const awaitActivePage = async (pg: Page, pageId: string, label: string): Promise<boolean> => {
    const until = Math.min(actionDeadlineMs, Date.now() + 15_000);
    while (Date.now() < until) {
      const snap = await snapNow(pg);
      if (snap.settings?.activePage === pageId) return true;
      await pg.waitForTimeout(300);
    }
    report.observations.push({ kind: 'active-page-miss', label, expected: pageId });
    return false;
  };

  const awaitSample = async (
    seq: number,
    slug: string,
    instruction: string,
  ): Promise<{ action: 'sample'; path?: string; at?: string } | null> => {
    const localAt = new Date().toISOString();
    const published = (await emitManualStep(fixture, binding, `${slug}-s${seq}`, {
      seq,
      instruction,
    })) as { at?: string; path?: string; sha256?: string } | undefined;
    let stepAt = published?.at;
    if (typeof stepAt !== 'string' && published?.path) {
      try {
        stepAt = (JSON.parse(fs.readFileSync(published.path, 'utf8')) as { at?: string }).at;
      } catch {
        // immutable step file unreadable; fall back to local stamp
      }
    }
    if (!Number.isFinite(Date.parse(String(stepAt ?? '')))) stepAt = localAt;
    const step: StepRecord = { seq, slug, instruction, at: String(stepAt) };
    report.steps.push(step);
    report.observations.push({
      kind: 'step-published',
      slug,
      path: published?.path ?? null,
      at: step.at,
    });
    test.info().annotations.push({ type: 'manual-step', description: `${slug}: ${instruction}` });
    while (Date.now() < actionDeadlineMs) {
      const timeoutMs = Math.min(MANUAL_SEGMENT_WAIT_MS, actionDeadlineMs - Date.now());
      const res = (await awaitManualCommand(fixture, binding, {
        seq,
        actions: ['sample', 'cancel'],
        timeoutMs,
        deadlineAt,
      })) as CommandResult;
      if (res.kind === 'received' && res.command) {
        const action = String(res.command.action ?? '');
        step.command = {
          action,
          at: res.command.at ?? null,
          path: res.path ?? null,
          sha256: res.sha256 ?? null,
        };
        if (action === 'cancel') {
          report.detail = `operator cancelled during ${slug}`;
          return null;
        }
        if (action === 'sample') {
          if (ed.isStaleAffirmative(step.at, res.command.at)) {
            report.status = 'HOLD';
            report.detail = `stale or untrusted affirmative for ${slug} (command.at=${res.command.at ?? 'missing'})`;
            report.observations.push({
              kind: 'stale-command',
              slug,
              stepAt: step.at,
              commandAt: res.command.at ?? null,
              path: res.path ?? null,
            });
            return null;
          }
          return { action: 'sample', path: res.path, at: res.command.at };
        }
      } else if (res.kind === 'invalid') {
        report.status = 'HOLD';
        report.detail = `invalid command evidence for ${slug}: ${res.error ?? res.path ?? 'unknown'}`;
        report.observations.push({
          kind: 'invalid-command',
          slug,
          path: res.path ?? null,
          error: res.error ?? null,
        });
        return null;
      } else if (res.kind === 'timeout') {
        report.detail = `timeout awaiting operator sample for ${slug}`;
        return null;
      } else {
        step.invalid = (step.invalid ?? 0) + 1;
      }
    }
    report.detail = `deadline reached awaiting ${slug}`;
    return null;
  };

  const stage = async (
    pg: Page,
    pageId: string,
    seq: number,
    slug: string,
    instruction: string,
  ): Promise<{ action: 'sample'; path?: string; at?: string } | null> => {
    if (!(await awaitActivePage(pg, pageId, slug))) {
      report.status = 'HOLD';
      report.detail = `active page not bound before ${slug}`;
      return null;
    }
    return awaitSample(seq, slug, instruction);
  };

  const failWith = (v: ed.Verdict, prefix: string): void => {
    report.status = 'FAIL';
    report.detail = `${prefix}: ${String(v.reason)}`;
  };

  try {
    const parsed = ed.parseEditorRunId(binding.runId);
    if (!parsed) {
      report.detail = 'binding.runId is not a bound editor-case run; launch suppressed';
      return;
    }
    report.case = parsed.caseId;
    const pages = manifest.pages;
    ed.assertManifestShape(manifest);
    const baselineIds = ed.collectManifestBlockIds(manifest);

    const pageDocOf = (list: { id: string; doc: ed.PmNode }[], pageId: string): ed.PmNode => {
      const hit = list.find((p) => p.id === pageId);
      if (!hit) throw new Error(`snapshot is missing page ${pageId}`);
      return hit.doc;
    };

    const projectNow = async (
      pg: Page,
    ): Promise<{ snap: Snap; proj: ed.Verdict & { pages?: ed.SnapshotPage[] } }> => {
      const snap = await snapNow(pg);
      return { snap, proj: ed.projectOrdinaryPages(snap.pages ?? [], manifest) };
    };

    const ensureOpen = async (pg: Page, target: ed.SeedPage): Promise<void> => {
      const parent = target.parentId ? pages.find((p) => p.id === target.parentId) : undefined;
      if (parent?.title) {
        const toggle = pg.getByRole('button', { name: `${parent.title} を展開`, exact: true });
        try {
          if ((await toggle.getAttribute('aria-expanded', { timeout: 2_000 })) !== 'true') {
            await toggle.click({ timeout: 2_000 });
          }
        } catch {
          // toggle absent or already expanded; openR8Page performs its own fallback
        }
      }
      await openR8Page(pg, String(target.title ?? target.id));
      if (!(await awaitActivePage(pg, target.id, 'navigate'))) {
        throw new Error(`could not activate page ${target.id} ('${String(target.title)}')`);
      }
    };

    interface ObservedRead {
      at: string;
      activePage: string | null;
      state: string | null;
      pages?: ed.SnapshotPage[];
    }

    type Confirmed =
      | { result: 'match'; pages: ed.SnapshotPage[]; observed: ObservedRead }
      | {
          result: 'mismatch' | 'pending';
          verdict?: ed.Verdict;
          state?: string | null;
          active?: boolean;
          observed?: ObservedRead;
        };

    const awaitConfirmed = async (
      pg: Page,
      pageId: string,
      oracle: (ordinary: ed.SnapshotPage[]) => ed.Verdict,
    ): Promise<Confirmed> => {
      const samples: ed.PollSample[] = [];
      const until = Math.min(actionDeadlineMs, Date.now() + 12_000);
      let lastVerdict: ed.Verdict | undefined;
      let lastObserved: ObservedRead | undefined;
      while (Date.now() < until) {
        const ui = await Promise.resolve(readUiStatus(pg, 1_000)).catch(() => null);
        const state = ui?.dataState ?? null;
        let verdict: ed.Verdict | undefined;
        let ordinary: ed.SnapshotPage[] | undefined;
        let activePage: string | null = null;
        let readable = false;
        try {
          const snap = await snapNow(pg);
          activePage = snap.settings?.activePage ?? null;
          const proj = ed.projectOrdinaryPages(snap.pages ?? [], manifest);
          if (proj.ok && proj.pages) {
            ordinary = proj.pages;
            verdict = oracle(ordinary);
          } else {
            verdict = proj;
          }
          readable = true;
        } catch {
          verdict = undefined;
        }
        lastVerdict = verdict ?? lastVerdict;
        if (readable || !lastObserved) {
          lastObserved = { at: new Date().toISOString(), activePage, state, pages: ordinary };
        }
        samples.push({
          saved: state === 'saved',
          active: readable && activePage === pageId,
          match: readable && verdict ? verdict.ok : null,
          missKey:
            ordinary && verdict?.ok === false
              ? ed.mismatchKeyOf(ordinary, pageId, verdict)
              : undefined,
        });
        if (state === 'saved' && activePage === pageId && verdict?.ok && ordinary) {
          return { result: 'match', pages: ordinary, observed: lastObserved };
        }
        await pg.waitForTimeout(400);
      }
      const cls = ed.classifyPoll(samples);
      if (cls === 'mismatch') {
        return {
          result: 'mismatch',
          verdict: lastVerdict,
          state: lastObserved?.state ?? null,
          active: lastObserved?.activePage === pageId,
          observed: lastObserved,
        };
      }
      return {
        result: 'pending',
        verdict: lastVerdict,
        state: lastObserved?.state ?? null,
        active: lastObserved?.activePage === pageId,
        observed: lastObserved,
      };
    };

    const stepFacts = (outcome: Confirmed, pageId: string): void => {
      const obs = outcome.observed;
      const source = outcome.result === 'match' ? outcome.pages : (obs?.pages ?? undefined);
      const offending =
        'verdict' in outcome && typeof outcome.verdict?.pageId === 'string'
          ? outcome.verdict.pageId
          : pageId;
      let doc: ed.PmNode | undefined;
      let docPageId = pageId;
      if (source) {
        docPageId = source.some((p) => p.id === offending) ? offending : pageId;
        try {
          doc = pageDocOf(source, docPageId);
        } catch {
          doc = undefined;
        }
      }
      lastStep().facts = {
        pid: appPid,
        observedAt: obs?.at ?? null,
        activePage: obs?.activePage ?? null,
        dataState: obs?.state ?? null,
        touchedPageId: pageId,
        docPageId,
        blockIds: doc ? ed.blockIdsOf(doc) : null,
        doc: doc ?? null,
      };
    };

    const closeForReopen = async (
      frozen: ed.SnapshotPage[],
      pageId: string,
      label: string,
    ): Promise<void> => {
      report.observations.push({ kind: 'frozen-docs', label, pages: frozen });
      const pidBefore = appPid;
      const src = await closeApp(`${label}-source`);
      if (!src || src.normal !== true || src.pid !== pidBefore) {
        report.status = 'HOLD';
        report.detail = 'source app close was not observed as normal';
        return;
      }
      const second = await launchOwned(`${label}-reopen`);
      try {
        if (second.pid === pidBefore) {
          report.status = 'HOLD';
          report.detail = 'reopened instance reused the source pid; not a distinct instance';
          return;
        }
        const snap = await snapNow(second.page);
        report.observations.push({
          kind: 'reopen-active',
          label,
          active: snap.settings?.activePage ?? null,
          expected: pageId,
        });
        if (!(await awaitActivePage(second.page, pageId, 'reopen'))) {
          report.status = 'HOLD';
          report.detail = 'reopened app did not restore the touched page as active';
          return;
        }
        const { proj } = await projectNow(second.page);
        if (proj.ok && proj.pages) {
          report.observations.push({ kind: 'reopen-docs', label, pages: proj.pages });
        }
        const m = proj.ok && proj.pages ? ed.comparePagesExact(frozen, proj.pages) : proj;
        report.observations.push({ kind: 'reopen-compare', label, verdict: m });
        if (!m.ok) {
          report.status = 'FAIL';
          report.detail = `reopened snapshot mismatch: ${String(m.reason)}`;
          return;
        }
        report.status = 'AWAITING_HUMAN_AND_MONITOR_CORRELATION';
        report.detail = 'frozen persisted oracle matched on reopen; awaiting correlation';
      } finally {
        const r2 = await closeApp(`${label}-reopen`);
        if (!r2 || r2.normal !== true || r2.pid !== second.pid) {
          report.observations.push({
            kind: 'reopen-close-abnormal',
            result: r2 ?? null,
            expectedPid: second.pid,
          });
          if (report.status === 'AWAITING_HUMAN_AND_MONITOR_CORRELATION') {
            report.status = 'HOLD';
            report.detail = 'reopened app close was not a normal receipt for its own pid';
          }
        }
      }
    };

    const liveFinish = async (label: string, pid: number): Promise<void> => {
      const r = await closeApp(`${label}-final`);
      if ((!r || r.normal !== true || r.pid !== pid) && report.status === 'AWAITING_HUMAN_AND_MONITOR_CORRELATION') {
        report.status = 'HOLD';
        report.detail = 'final close was not observed as normal for the original pid';
      }
    };

    const first = await launchOwned('source');
    const firstPid = first.pid;
    const page = first.page;
    await page.evaluate((t) => {
      document.title = t;
    }, `folio-editor-${binding.nonce}`);
    await page.bringToFront();
    const windowTitle = await page.title();
    report.observations.push({ kind: 'nonce-title', windowTitle });
    await publishManualReady(fixture, binding, {
      pid: firstPid,
      executablePath,
      windowTitle,
      deadlineAt,
    });

    const runEnter = async (pg: Page): Promise<void> => {
      const pos = ed.describePosition(pages, ed.GUIDE_BLOCKS.blank);
      const seedDoc = pageDocOf(pages, pos.pageId);
      await ensureOpen(pg, pages.find((p) => p.id === pos.pageId) as ed.SeedPage);
      const cmd = await stage(
        pg,
        pos.pageId,
        1,
        'enter-split',
        `On page '${pos.pageTitle}', click into the empty paragraph (${pos.human}). ` +
          `Type and IME-commit 「${ed.TEXT_UPPER}」, press Enter once, then type and IME-commit 「${ed.TEXT_LOWER}」. ` +
          'Change nothing else, then send sample.',
      );
      if (!cmd) return;
      const outcome = await awaitConfirmed(pg, pos.pageId, (ordinary) => {
        const v = ed.validateEnterResult(
          seedDoc,
          pageDocOf(ordinary, pos.pageId),
          ed.GUIDE_BLOCKS.blank,
          baselineIds,
        );
        if (!v.ok) return v;
        const expectedDoc = ed.expectedAfterEnter(
          seedDoc,
          ed.GUIDE_BLOCKS.blank,
          String(v.insertedId),
        );
        const m = ed.compareProjection(pages, ordinary, { pageId: pos.pageId, expectedDoc });
        return m.ok ? v : m;
      });
      lastStep().verdict = outcome.result === 'match' ? 'match' : (outcome.verdict ?? outcome.result);
      stepFacts(outcome, pos.pageId);
      if (outcome.result === 'mismatch') {
        return failWith(outcome.verdict as ed.Verdict, 'enter persisted state rejected');
      }
      if (outcome.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `enter oracle not confirmed saved (state=${outcome.state ?? 'none'})`;
        return;
      }
      await closeForReopen(outcome.pages, pos.pageId, 'enter');
    };

    const runSoftbreak = async (pg: Page): Promise<void> => {
      const pos = ed.describePosition(pages, ed.GUIDE_BLOCKS.blank);
      const seedDoc = pageDocOf(pages, pos.pageId);
      await ensureOpen(pg, pages.find((p) => p.id === pos.pageId) as ed.SeedPage);
      const cmd = await stage(
        pg,
        pos.pageId,
        1,
        'softbreak-ime',
        `On page '${pos.pageTitle}', click into the empty paragraph (${pos.human}). ` +
          `Type and IME-commit 「${ed.TEXT_UPPER}」, press Shift+Enter once, then type and IME-commit 「${ed.TEXT_LOWER}」. ` +
          'Change nothing else, then send sample.',
      );
      if (!cmd) return;
      const expectedDoc = ed.expectedAfterSoftbreak(seedDoc, ed.GUIDE_BLOCKS.blank);
      const outcome = await awaitConfirmed(pg, pos.pageId, (ordinary) => {
        const v = ed.validateSoftbreakResult(
          seedDoc,
          pageDocOf(ordinary, pos.pageId),
          ed.GUIDE_BLOCKS.blank,
        );
        if (!v.ok) return v;
        return ed.compareProjection(pages, ordinary, { pageId: pos.pageId, expectedDoc });
      });
      lastStep().verdict = outcome.result === 'match' ? 'match' : (outcome.verdict ?? outcome.result);
      stepFacts(outcome, pos.pageId);
      if (outcome.result === 'mismatch') {
        return failWith(outcome.verdict as ed.Verdict, 'softbreak persisted state rejected');
      }
      if (outcome.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `softbreak oracle not confirmed saved (state=${outcome.state ?? 'none'})`;
        return;
      }
      await closeForReopen(outcome.pages, pos.pageId, 'softbreak');
    };

    const runUndo = async (pg: Page): Promise<void> => {
      const pos = ed.describePosition(pages, ed.GUIDE_BLOCKS.blank);
      const seedDoc = pageDocOf(pages, pos.pageId);
      const editedDoc = ed.expectedAfterBlankEdit(seedDoc, ed.GUIDE_BLOCKS.blank, ed.UNDO_WORD);
      await ensureOpen(pg, pages.find((p) => p.id === pos.pageId) as ed.SeedPage);
      const oracleFor = (expectedDoc: ed.PmNode) => (ordinary: ed.SnapshotPage[]) =>
        ed.compareProjection(pages, ordinary, { pageId: pos.pageId, expectedDoc });

      const cmd1 = await stage(
        pg,
        pos.pageId,
        1,
        'undo-commit',
        `On page '${pos.pageTitle}', click into the empty paragraph (${pos.human}) and type and IME-commit 「${ed.UNDO_WORD}」. ` +
          'Change nothing else, then send sample.',
      );
      if (!cmd1) return;
      const o1 = await awaitConfirmed(pg, pos.pageId, oracleFor(editedDoc));
      lastStep().verdict = o1.result === 'match' ? 'match' : (o1.verdict ?? o1.result);
      stepFacts(o1, pos.pageId);
      if (o1.result === 'mismatch') {
        return failWith(o1.verdict as ed.Verdict, 'undo committed state rejected');
      }
      if (o1.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `undo committed oracle not confirmed saved (state=${o1.state ?? 'none'})`;
        return;
      }

      const cmd2 = await stage(
        pg,
        pos.pageId,
        2,
        'undo-press',
        'Press Cmd+Z once in the same window, then send sample.',
      );
      if (!cmd2) return;
      const o2 = await awaitConfirmed(pg, pos.pageId, oracleFor(seedDoc));
      lastStep().verdict = o2.result === 'match' ? 'match' : (o2.verdict ?? o2.result);
      stepFacts(o2, pos.pageId);
      if (o2.result === 'mismatch') {
        return failWith(o2.verdict as ed.Verdict, 'undo did not restore the baseline');
      }
      if (o2.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `undo restore oracle not confirmed saved (state=${o2.state ?? 'none'})`;
        return;
      }

      const cmd3 = await stage(
        pg,
        pos.pageId,
        3,
        'redo-press',
        'Press Cmd+Shift+Z once in the same window, then send sample.',
      );
      if (!cmd3) return;
      const o3 = await awaitConfirmed(pg, pos.pageId, oracleFor(editedDoc));
      lastStep().verdict = o3.result === 'match' ? 'match' : (o3.verdict ?? o3.result);
      stepFacts(o3, pos.pageId);
      if (o3.result === 'mismatch') {
        return failWith(o3.verdict as ed.Verdict, 'redo did not restore the committed edit');
      }
      if (o3.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `redo oracle not confirmed saved (state=${o3.state ?? 'none'})`;
        return;
      }
      report.status = 'AWAITING_HUMAN_AND_MONITOR_CORRELATION';
      report.detail = 'undo/redo live oracles matched; awaiting correlation';
      await liveFinish('undo', firstPid);
    };

    const runBlank = async (pg: Page, caseId: ed.BlankCase): Promise<void> => {
      const target = ed.BLANK_CASE_TARGETS[caseId];
      const pos = ed.describePosition(pages, target.blockId);
      const seedDoc = pageDocOf(pages, pos.pageId);
      await ensureOpen(pg, pages.find((p) => p.id === pos.pageId) as ed.SeedPage);
      const cmd = await stage(
        pg,
        pos.pageId,
        1,
        `blank-${caseId}`,
        `On page '${pos.pageTitle}', click into the empty paragraph (${pos.human}) and type and IME-commit 「${target.marker}」. ` +
          'Do not touch any other paragraph or page, then send sample.',
      );
      if (!cmd) return;
      const expectedDoc = ed.expectedAfterBlankEdit(seedDoc, target.blockId, target.marker);
      const outcome = await awaitConfirmed(pg, pos.pageId, (ordinary) =>
        ed.compareProjection(pages, ordinary, { pageId: pos.pageId, expectedDoc }),
      );
      lastStep().verdict = outcome.result === 'match' ? 'match' : (outcome.verdict ?? outcome.result);
      stepFacts(outcome, pos.pageId);
      if (outcome.result === 'mismatch') {
        return failWith(outcome.verdict as ed.Verdict, 'blank persisted state rejected');
      }
      if (outcome.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `blank oracle not confirmed saved (state=${outcome.state ?? 'none'})`;
        return;
      }
      await closeForReopen(outcome.pages, pos.pageId, caseId);
    };

    const runHandle = async (pg: Page): Promise<void> => {
      const introPos = ed.describePosition(pages, ed.GUIDE_BLOCKS.intro);
      const seedDoc = pageDocOf(pages, introPos.pageId);
      const introText = ed.blockText(ed.findSingleOwner(pages, ed.GUIDE_BLOCKS.intro).block);
      const linksText = ed.blockText(ed.findSingleOwner(pages, ed.GUIDE_BLOCKS.links).block);
      await ensureOpen(pg, pages.find((p) => p.id === introPos.pageId) as ed.SeedPage);
      const cmd1 = await stage(
        pg,
        introPos.pageId,
        1,
        'handle-select',
        `On page '${introPos.pageTitle}', use the left block handle to select only the paragraph ${introPos.human} ` +
          `(its text begins 「${introText}」). Do not drag. Then send sample.`,
      );
      if (!cmd1) return;
      const handles = await pg
        .locator('.block-handle')
        .evaluateAll((els: Element[]) =>
          els.map((el: Element) => ({
            blockId: el.getAttribute('data-block-id'),
            selected: el.classList.contains('selected'),
          })),
        );
      const v1 = ed.validateSingleHandleSelection(handles, ed.GUIDE_BLOCKS.intro);
      lastStep().verdict = v1;
      report.observations.push({
        kind: 'handle-selection',
        selected: handles.filter((h) => h.selected).map((h) => h.blockId),
        seen: handles,
      });
      if (!v1.ok) return failWith(v1, 'handle selection rejected');

      const cmd2 = await stage(
        pg,
        introPos.pageId,
        2,
        'handle-drag',
        `Drag that selected paragraph by its left handle so it lands immediately below the paragraph 「${linksText}」 ` +
          'and immediately above the trailing empty paragraph. Then send sample.',
      );
      if (!cmd2) return;
      const expectedDoc = ed.expectedAfterReorder(
        seedDoc,
        ed.GUIDE_BLOCKS.intro,
        ed.GUIDE_BLOCKS.blank,
      );
      const outcome = await awaitConfirmed(pg, introPos.pageId, (ordinary) => {
        const v = ed.validateHandleReorder(
          seedDoc,
          pageDocOf(ordinary, introPos.pageId),
          ed.GUIDE_BLOCKS.intro,
          ed.GUIDE_BLOCKS.blank,
        );
        if (!v.ok) return v;
        const m = ed.compareProjection(pages, ordinary, { pageId: introPos.pageId, expectedDoc });
        return m.ok ? v : m;
      });
      lastStep().verdict =
        outcome.result === 'match' ? 'match' : (outcome.verdict ?? outcome.result);
      stepFacts(outcome, introPos.pageId);
      if (outcome.result === 'match') {
        report.observations.push({
          kind: 'handle-order',
          order: ed.blockIdsOf(pageDocOf(outcome.pages, introPos.pageId)),
        });
      }
      if (outcome.result === 'mismatch') {
        return failWith(outcome.verdict as ed.Verdict, 'handle drag result rejected');
      }
      if (outcome.result !== 'match') {
        report.status = 'HOLD';
        report.detail = `handle drag oracle not confirmed saved (state=${outcome.state ?? 'none'})`;
        return;
      }

      const cmd3 = await stage(
        pg,
        introPos.pageId,
        3,
        'handle-observation',
        'An external human observer must now file a report outside this test stating whether an unexpected ' +
          'all-handle list or perimeter focus appeared while selecting or dragging. Send sample once filed.',
      );
      if (!cmd3) return;
      report.observations.push({
        kind: 'handle-visual-request',
        receipt: { action: cmd3.action, path: cmd3.path ?? null },
        note: 'outer human report is the sole judge for all-handle/perimeter focus anomalies',
      });
      report.status = 'AWAITING_HUMAN_AND_MONITOR_CORRELATION';
      report.detail = 'handle move oracle matched; awaiting outer human visual report and monitor correlation';
      await liveFinish('handle', firstPid);
    };

    switch (parsed.caseId) {
      case 'enter':
        await runEnter(page);
        break;
      case 'softbreak':
        await runSoftbreak(page);
        break;
      case 'undo':
        await runUndo(page);
        break;
      case 'handle':
        await runHandle(page);
        break;
      default:
        if (ed.isBlankCase(parsed.caseId)) await runBlank(page, parsed.caseId);
        else {
          report.status = 'HOLD';
          report.detail = `unhandled editor case ${parsed.caseId}`;
        }
    }
  } catch (err) {
    caught = err;
    if (report.status !== 'FAIL') {
      report.status = 'HOLD';
      report.detail = `harness error: ${err instanceof Error ? err.message : String(err)}`;
    }
  } finally {
    await closeApp('final');
    writeReport();
  }
  if (report.status === 'FAIL') {
    throw new Error(`editor case ${report.case ?? 'unknown'}: ${report.detail}`);
  }
  if (caught) throw caught;
});
