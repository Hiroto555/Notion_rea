import {
  isDocument,
  requestSchema,
  type DatabaseProjection,
  type DatabaseSettings,
  type Page,
  type PagePatch,
} from "../shared/types";
import { PendingEdits } from "./pending-edits";
import {
  applySettingsIntent,
  canonicalSettings,
  sameSettingsValue,
  type SettingsIntent,
} from "./settings-intent";

export type SettingsSaveRequest = {
  type: "database:settings";
  databasePageId: string;
  revision: number;
  settings: DatabaseSettings;
};
type Install = {
  token: object;
  kind: "settings" | "page";
  before: Page;
  revision: number;
  settings: DatabaseSettings;
  page?: Page;
  seq: number;
  through: number;
  captured: unknown;
  generation: number;
};
type Lane = {
  revision: number;
  settings: DatabaseSettings;
  failure?: Error;
  ownerPage?: Page;
  install?: Install;
};

/** UI-independent prototype. App owns this instance and PendingEdits for its
 * lifetime. App must serialize every flush and every other owner Page write in
 * its existing queue; it must not replace its Page/doc/record state with the
 * projection returned by the transport. No App integration is included. */
export class SettingsSaveCoordinator {
  private lanes = new Map<string, Lane>();
  private active = false;
  constructor(
    private readonly edits: PendingEdits,
    private readonly send: (
      request: SettingsSaveRequest,
    ) => Promise<DatabaseProjection>,
  ) {}

  /** Install an initial trusted, owner-bound database:load snapshot before
   * accepting input. This is not a refresh/rebase or a conflict resolution API. */
  initialize(ownerId: string, value: DatabaseProjection): void {
    if (
      !validId(ownerId) ||
      !value ||
      !validRevision(value.revision) ||
      !Array.isArray(value.records) ||
      value.records.some(
        (record) => !record || record.databasePageId !== ownerId,
      ) ||
      this.active ||
      this.lanes.has(ownerId) ||
      this.edits.hasAny(ownerId) ||
      this.edits.failed.has(ownerId)
    )
      throw new Error(
        "Cannot initialize settings with pending or existing state",
      );
    this.lanes.set(ownerId, {
      revision: value.revision,
      settings: canonicalSettings(value.settings),
    });
  }

  /** Bind the separately loaded Page to a trusted owner projection. Call only
   * before input, under App's shared queue; this does not rebase any draft. */
  bindOwnerPage(ownerId: string, page: Page): void {
    const lane = this.lanes.get(ownerId);
    if (
      !lane ||
      lane.failure ||
      lane.ownerPage ||
      lane.install ||
      this.active ||
      this.edits.hasAny(ownerId) ||
      this.edits.failed.has(ownerId)
    )
      throw new Error("Cannot bind owner Page with pending or existing state");
    validateOwnerPage(page, ownerId, lane.revision, lane.settings);
    lane.ownerPage = structuredClone(page);
  }

  /** Capture a Page input immediately, including an untrusted/stale input. */
  submitPage(
    ownerId: string,
    observedRevision: number,
    patch: PagePatch,
  ): number {
    if (!validId(ownerId) || !validRevision(observedRevision))
      throw new Error("Invalid owner Page identity or revision");
    const lane = this.lanes.get(ownerId);
    const known =
      !!lane?.ownerPage &&
      !lane.failure &&
      !lane.install &&
      !this.edits.failed.has(ownerId) &&
      observedRevision === lane.revision;
    const seq = this.edits.addObservedPage(
      ownerId,
      observedRevision,
      patch,
      known,
      ownerId,
      "database",
    );
    if (!known)
      this.fail(
        ownerId,
        new Error("Unknown owner Page revision; pending changes retained"),
      );
    return seq;
  }

  /** Retain input immediately even if its revision is unknown or a prior write
   * failed. A stale or unknown input is never silently promoted on retry. */
  submit(
    ownerId: string,
    observedRevision: number,
    intent: SettingsIntent,
  ): number {
    if (!validId(ownerId) || !validRevision(observedRevision))
      throw new Error("Invalid settings identity or revision");
    const lane = this.lanes.get(ownerId);
    const known =
      !!lane &&
      !lane.failure &&
      !lane.install &&
      !this.edits.failed.has(ownerId) &&
      observedRevision === lane.revision;
    const seq = this.edits.addSettingsIntent(
      ownerId,
      observedRevision,
      intent,
      known,
    );
    if (!known)
      this.fail(
        ownerId,
        new Error("Unknown settings revision; pending changes retained"),
      );
    return seq;
  }

  /** Pure display overlay; never a persisted ACK or a recovery file. */
  overlay(ownerId: string): DatabaseSettings {
    const lane = this.lanes.get(ownerId);
    if (!lane) throw new Error("Settings lineage unavailable");
    return this.edits
      .snapshotSettingsIntents(ownerId)
      .reduce(
        (settings, entry) => applySettingsIntent(settings, entry.intent),
        structuredClone(lane.settings),
      );
  }
  revision(ownerId: string): number | undefined {
    return this.lanes.get(ownerId)?.revision;
  }
  error(ownerId: string): Error | undefined {
    return this.lanes.get(ownerId)?.failure;
  }

  /** One explicit action scheduled in App's shared queue. A send exception is
   * an unknown outcome, not an invitation to retry/rebase on a newer revision.
   * Without bindOwnerPage this remains the old UI-independent settings-only
   * behavior, which is not sufficient for safe App Page integration. */
  async flush(
    ownerId: string,
    seq: number,
  ): Promise<{
    revision: number;
    settings: DatabaseSettings;
    installToken?: object;
  }> {
    let lane = this.lanes.get(ownerId);
    try {
      if (!validId(ownerId) || !Number.isSafeInteger(seq) || seq < 1 || !lane)
        throw new Error("Settings lineage unavailable");
      if (this.active)
        throw new Error(
          "Settings flush must run in the App serialization queue",
        );
      if (lane.failure) throw lane.failure;
      if (lane.install)
        throw new Error("Owner Page installation not confirmed");
      if (this.edits.failed.has(ownerId))
        throw new Error("Owner has failed edits; pending changes retained");
      const entry = this.edits.snapshotSettingsIntents(ownerId, seq)[0];
      if (!entry || entry.seq !== seq || !entry.observedKnown)
        throw new Error("Settings intent order or revision conflict");
      if (entry.observedRevision > lane.revision)
        throw new Error("Settings revision lineage conflict");
      if (
        this.edits.has(ownerId, seq - 1) ||
        this.edits.hasValues(ownerId, seq - 1) ||
        this.edits.hasRecord(ownerId, seq - 1) ||
        this.edits
          .snapshotSettings()
          .some((e) => e.id === ownerId && e.seq < seq)
      )
        throw new Error("Earlier owner edit is pending");
      const expected = applySettingsIntent(lane.settings, entry.intent);
      const request: SettingsSaveRequest = {
        type: "database:settings",
        databasePageId: ownerId,
        revision: lane.revision,
        settings: expected,
      };
      const priorRevision = lane.revision;
      this.active = true;
      let response: DatabaseProjection;
      try {
        response = await this.send(structuredClone(request));
      } finally {
        this.active = false;
      }
      const current = this.edits.snapshotSettingsIntents(ownerId, seq)[0];
      if (
        !current ||
        current.seq !== seq ||
        !sameSettingsValue(current, entry) ||
        this.lanes.get(ownerId) !== lane ||
        lane.revision !== priorRevision ||
        !!lane.failure ||
        this.edits.failed.has(ownerId) ||
        !response ||
        !validRevision(response.revision) ||
        response.revision !== priorRevision + 1 ||
        !sameSettingsValue(canonicalSettings(response.settings), expected)
      )
        throw new Error("Invalid settings ACK; pending changes retained");
      if (lane.ownerPage) {
        const token = {};
        lane.install = {
          token,
          kind: "settings",
          before: structuredClone(lane.ownerPage),
          revision: response.revision,
          settings: structuredClone(expected),
          seq,
          through: seq,
          captured: structuredClone(entry),
          generation: this.edits.sequenceFor(ownerId),
        };
        return {
          revision: response.revision,
          settings: structuredClone(expected),
          installToken: token,
        };
      }
      this.edits.ackSettingsIntent(ownerId, seq);
      if (lane.failure) this.edits.failed.add(ownerId);
      lane.revision = response.revision;
      lane.settings = structuredClone(expected);
      return {
        revision: lane.revision,
        settings: structuredClone(lane.settings),
      };
    } catch (failure) {
      this.fail(ownerId, failure);
      throw failure;
    }
  }

  /** Send one owner Page generation from App's shared queue. The ACK is staged
   * and does not discard the draft until the installed Page is re-read. */
  async flushOwnerPage(
    ownerId: string,
    through: number,
    sendPage: (request: {
      type: "update";
      id: string;
      revision: number;
      patch: PagePatch;
    }) => Promise<Page>,
  ): Promise<{ page: Page; installToken: object }> {
    const lane = this.lanes.get(ownerId);
    try {
      if (
        !lane?.ownerPage ||
        lane.failure ||
        lane.install ||
        this.active ||
        this.edits.failed.has(ownerId) ||
        !Number.isSafeInteger(through) ||
        through < 1
      )
        throw new Error(
          "Owner Page lineage unavailable; pending changes retained",
        );
      const entries = this.edits
        .snapshotPages()
        .filter((e) => e.id === ownerId && e.seq <= through);
      if (
        !entries.length ||
        entries[entries.length - 1].seq !== through ||
        entries.some(
          (e) =>
            e.observedKnown !== true ||
            !validRevision(e.observedRevision!) ||
            e.observedRevision! > lane.revision,
        ) ||
        this.edits.hasSettings(ownerId, through) ||
        this.edits.hasRecord(ownerId, through) ||
        this.edits.hasValues(ownerId, through)
      )
        throw new Error(
          "Owner Page generation or revision conflict; pending changes retained",
        );
      const patch = this.edits.patch(ownerId, through);
      if (Object.hasOwn(patch, "database"))
        throw new Error("Owner Page cannot replace database settings");
      const request = requestSchema.parse({
        type: "update",
        id: ownerId,
        revision: lane.revision,
        patch,
      });
      if (request.type !== "update" || !sameSettingsValue(request.patch, patch))
        throw new Error("Invalid owner Page patch");
      const before = structuredClone(lane.ownerPage),
        prior = lane.revision;
      this.active = true;
      let response: Page;
      try {
        response = await sendPage(structuredClone(request));
      } finally {
        this.active = false;
      }
      const current = this.edits
        .snapshotPages()
        .filter((e) => e.id === ownerId && e.seq <= through);
      if (
        this.lanes.get(ownerId) !== lane ||
        lane.revision !== prior ||
        lane.failure ||
        this.edits.failed.has(ownerId) ||
        !sameSettingsValue(current, entries)
      )
        throw new Error(
          "Owner Page input changed during write; pending changes retained",
        );
      validateOwnerPage(response, ownerId, prior + 1, lane.settings);
      assertOwnerTransition(before, response, request.patch, lane.settings);
      const token = {};
      lane.install = {
        token,
        kind: "page",
        before,
        page: structuredClone(response),
        revision: response.revision,
        settings: structuredClone(lane.settings),
        seq: through,
        through,
        captured: structuredClone(entries),
        generation: this.edits.sequenceFor(ownerId),
      };
      return { page: structuredClone(response), installToken: token };
    } catch (failure) {
      this.fail(ownerId, failure);
      throw failure;
    }
  }

  /** The caller installs the Page, then provides an authoritative final read.
   * A changed revision, any intervening input, a mismatched Page or a read
   * failure retains every draft and permanently blocks the lane. The caller
   * must serialize and own the workspace; this does not lock external writers. */
  async confirmOwnerInstall(
    ownerId: string,
    token: object,
    installed: Page,
    readCurrent: () => Promise<Page>,
  ): Promise<Page> {
    const lane = this.lanes.get(ownerId),
      install = lane?.install;
    // A late callback for a different ticket has no authority to poison the
    // current installation. Reject it without changing the active lane.
    if (!lane || !install || install.token !== token)
      throw new Error("Owner installation ticket mismatch");
    if (this.active) throw new Error("Owner installation already in progress");
    try {
      if (
        lane.failure ||
        this.edits.failed.has(ownerId) ||
        this.edits.sequenceFor(ownerId) !== install.generation
      )
        throw new Error("Owner installation ticket or generation mismatch");
      validateOwnerPage(installed, ownerId, install.revision, install.settings);
      if (install.kind === "page") {
        if (!sameSettingsValue(installed, install.page))
          throw new Error("Installed Page differs from ACK");
      } else
        assertOwnerTransition(install.before, installed, {}, install.settings);
      this.active = true;
      let latest: Page;
      try {
        latest = await readCurrent();
      } finally {
        this.active = false;
      }
      if (
        this.lanes.get(ownerId) !== lane ||
        lane.install !== install ||
        lane.failure ||
        this.edits.failed.has(ownerId) ||
        this.edits.sequenceFor(ownerId) !== install.generation
      )
        throw new Error("Owner installation changed during verification");
      validateOwnerPage(latest, ownerId, install.revision, install.settings);
      if (!sameSettingsValue(latest, installed))
        throw new Error("Owner Page changed during installation");
      if (install.kind === "settings") {
        const entry = this.edits.snapshotSettingsIntents(
          ownerId,
          install.seq,
        )[0];
        if (!entry || !sameSettingsValue(entry, install.captured))
          throw new Error("Settings generation changed");
        this.edits.ackSettingsIntent(ownerId, install.seq);
      } else {
        const entries = this.edits
          .snapshotPages()
          .filter((e) => e.id === ownerId && e.seq <= install.through);
        if (!sameSettingsValue(entries, install.captured))
          throw new Error("Owner Page generation changed");
        this.edits.ack(ownerId, install.through);
      }
      lane.revision = install.revision;
      lane.settings = structuredClone(install.settings);
      lane.ownerPage = structuredClone(latest);
      lane.install = undefined;
      return structuredClone(latest);
    } catch (failure) {
      this.fail(ownerId, failure);
      throw failure;
    }
  }

  private fail(ownerId: string, failure: unknown): void {
    const error =
      failure instanceof Error ? failure : new Error(String(failure));
    const lane = this.lanes.get(ownerId);
    if (lane) lane.failure = lane.failure ?? error;
    if (validId(ownerId)) this.edits.failed.add(ownerId);
  }
}
export function validateOwnerPage(
  page: Page,
  ownerId: string,
  revision: number,
  settings: DatabaseSettings,
): void {
  const keys = new Set([
    "id",
    "schemaVersion",
    "parentId",
    "title",
    "icon",
    "cover",
    "position",
    "doc",
    "kind",
    "database",
    "favorite",
    "createdAt",
    "updatedAt",
    "revision",
    "deletedAt",
    "documentError",
    "recoveredFrom",
  ]);
  const time = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (
    !page ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    Object.keys(page).some((key) => !keys.has(key)) ||
    page.id !== ownerId ||
    page.kind !== "database" ||
    !validRevision(revision) ||
    !validRevision(page.revision) ||
    page.revision !== revision ||
    (page.schemaVersion !== undefined && page.schemaVersion !== 1) ||
    !(page.parentId === null || validId(page.parentId)) ||
    typeof page.title !== "string" ||
    page.title.length > 500 ||
    typeof page.icon !== "string" ||
    page.icon.length > 16 ||
    typeof page.cover !== "string" ||
    page.cover.length > 500 ||
    typeof page.position !== "number" ||
    !Number.isFinite(page.position) ||
    !isDocument(page.doc) ||
    typeof page.favorite !== "boolean" ||
    !time(page.createdAt) ||
    !time(page.updatedAt) ||
    page.deletedAt !== null ||
    page.documentError !== undefined ||
    !page.database ||
    !Array.isArray(page.database.rows) ||
    page.database.rows.length !== 0 ||
    (page.recoveredFrom !== undefined &&
      (!page.recoveredFrom ||
        !validId(page.recoveredFrom.pageId) ||
        !time(page.recoveredFrom.recoveredAt) ||
        Object.keys(page.recoveredFrom).some(
          (key) => !["pageId", "recoveredAt"].includes(key),
        )))
  )
    throw new Error("Invalid owner Page; pending changes retained");
  const { rows: _rows, ...actual } = page.database;
  if (!sameSettingsValue(canonicalSettings(actual), settings))
    throw new Error("Owner Page settings mismatch; pending changes retained");
}
export function assertOwnerTransition(
  before: Page,
  after: Page,
  patch: PagePatch,
  settings: DatabaseSettings,
): void {
  const expected = {
    ...before,
    ...structuredClone(patch),
    database: { ...structuredClone(settings), rows: [] },
    revision: after.revision,
    updatedAt: after.updatedAt,
  };
  if (!sameSettingsValue(expected, after))
    throw new Error(
      "Owner Page acknowledgement mismatch; pending changes retained",
    );
}
function validId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}
function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
