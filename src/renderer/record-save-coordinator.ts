import { fileFits } from "../shared/limits";
import { isDocument } from "../shared/types";
import { documentSchema } from "../shared/editor-schema";
import { BLOCK_TYPES } from "../editor/block-identity";
import { PendingEdits } from "./pending-edits";
import type {
  Doc,
  FilterValue,
  Page,
  PagePatch,
  RecordPatch,
  RecordProjection,
} from "../shared/types";

export type RecordSaveRequest = {
  type: "record:patch";
  pageId: string;
  databasePageId: string;
  revision: number;
  patch: RecordPatch;
};
type PageWriteTicket = {
  readonly token: object;
  readonly request: {
    type: "update";
    id: string;
    revision: number;
    patch: PagePatch;
  };
};
type ActivePageWrite = {
  token: object;
  pageId: string;
  revision: number;
  through: number;
  sequences: number[];
  patch: PagePatch;
};
export type RecordResyncSnapshot = { page: Page; record: RecordProjection };
export type RecordResyncResult = RecordResyncSnapshot & {
  readonly token: object;
};
type Lane = {
  revision: number;
  /** Owner-bound through trusted read, never inferred from the first ACK. */
  ownerBound?: boolean;
  /** True only after full Page and actual Editor document installation. */
  documentReady?: boolean;
  ownerId?: string;
  lastAck?: RecordProjection;
  pendingResync?: RecordResyncResult & { laneWasCreated: boolean };
  failure?: Error;
  inFlight?: Promise<RecordProjection | undefined>;
};

/** Save orchestration over the shared PendingEdits owner. The caller must
 * enqueue before flushing, schedule flush in App's queue and retain both this
 * coordinator and PendingEdits across navigation; this is not wired into App.
 * Legacy enqueue without owner binding remains a prototype and must not be
 * used by App. A supplied expected owner is checked by storage and the ACK. */
export class RecordSaveCoordinator {
  private lanes = new Map<string, Lane>();
  private unboundPageFailures = new Map<string, Error>();
  private activePageId: string | undefined;
  private bindingPageId: string | undefined;
  private activeResync: { pageId: string; ownerId: string } | undefined;
  private editorEpochs = new Map<string, number>();
  private activePageWrite: ActivePageWrite | undefined;
  constructor(
    private readonly edits: PendingEdits,
    private readonly send: (
      request: RecordSaveRequest,
    ) => Promise<RecordProjection>,
  ) {}

  enqueue(
    pageId: string,
    observedRevision: number,
    patch: RecordPatch,
    expectedOwnerId?: string,
  ): number {
    if (
      !pageId ||
      pageId.length > 500 ||
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0
    )
      throw new Error("Invalid record identity or revision");
    const clean = validatePatch(patch);
    let lane = this.lanes.get(pageId);
    if (!lane) {
      lane = {
        revision: observedRevision,
        failure: this.unboundPageFailures.get(pageId),
      };
      this.unboundPageFailures.delete(pageId);
      this.lanes.set(pageId, lane);
    }
    const seq = this.edits.addRecord(
      pageId,
      observedRevision,
      clean,
      !lane.pendingResync &&
        this.bindingPageId !== pageId &&
        observedRevision === lane.revision,
      expectedOwnerId ?? (lane.ownerBound ? lane.ownerId : undefined),
    );
    if (lane.pendingResync || this.bindingPageId === pageId)
      this.markResyncInputFailure(pageId, lane);
    return seq;
  }

  /** Safe App entrypoint for a list edit. Missing/wrong ownership is retained
   * as unknown and failed instead of allowing the first ACK to choose an owner. */
  enqueueBound(
    expectedOwnerId: string,
    pageId: string,
    observedRevision: number,
    patch: RecordPatch,
  ): number {
    if (
      typeof expectedOwnerId !== "string" ||
      !expectedOwnerId ||
      expectedOwnerId.length > 500 ||
      typeof pageId !== "string" ||
      !pageId ||
      pageId.length > 500 ||
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0
    )
      throw new Error("Invalid bound record identity or revision");
    const clean = validatePatch(patch);
    const lane = this.lanes.get(pageId);
    if (
      !lane?.ownerBound ||
      lane.ownerId !== expectedOwnerId ||
      this.bindingPageId === pageId
    ) {
      const seq = this.edits.addRecord(
        pageId,
        observedRevision,
        clean,
        false,
        expectedOwnerId,
      );
      this.markPagePreflightFailure(
        pageId,
        observedRevision,
        new Error("Record owner binding unavailable; pending changes retained"),
      );
      return seq;
    }
    return this.enqueue(pageId, observedRevision, clean, expectedOwnerId);
  }

  /** Safe App Page entrypoint. Binding the list alone does not install a doc. */
  enqueueBoundPage(
    expectedOwnerId: string,
    pageId: string,
    observedRevision: number,
    patch: PagePatch,
  ): number {
    if (
      typeof expectedOwnerId !== "string" ||
      !expectedOwnerId ||
      expectedOwnerId.length > 500 ||
      typeof pageId !== "string" ||
      !pageId ||
      pageId.length > 500 ||
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0
    )
      throw new Error("Invalid bound Page identity or revision");
    const lane = this.lanes.get(pageId);
    if (
      !lane?.ownerBound ||
      lane.ownerId !== expectedOwnerId ||
      this.bindingPageId === pageId
    ) {
      const seq = this.edits.addObservedPage(
        pageId,
        observedRevision,
        patch,
        false,
        expectedOwnerId,
      );
      this.markPagePreflightFailure(
        pageId,
        observedRevision,
        new Error("Record owner binding unavailable; pending changes retained"),
      );
      return seq;
    }
    return this.enqueuePage(pageId, observedRevision, patch, expectedOwnerId);
  }

  /** Capture the Page revision observed when this input was produced. */
  enqueuePage(
    pageId: string,
    observedRevision: number,
    patch: PagePatch,
    expectedOwnerId?: string,
  ): number {
    if (
      !pageId ||
      pageId.length > 500 ||
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0
    )
      throw new Error("Invalid Page edit identity or revision");
    let lane = this.lanes.get(pageId);
    if (!lane) {
      lane = {
        revision: observedRevision,
        failure: this.unboundPageFailures.get(pageId),
      };
      this.unboundPageFailures.delete(pageId);
      this.lanes.set(pageId, lane);
    }
    const seq = this.edits.addObservedPage(
      pageId,
      observedRevision,
      patch,
      !lane.pendingResync &&
        this.bindingPageId !== pageId &&
        (!lane.ownerBound || lane.documentReady === true) &&
        observedRevision === lane.revision,
      expectedOwnerId ?? (lane.ownerBound ? lane.ownerId : undefined),
      "record",
    );
    if (
      lane.pendingResync ||
      this.bindingPageId === pageId ||
      (lane.ownerBound && !lane.documentReady)
    )
      this.markResyncInputFailure(pageId, lane);
    return seq;
  }

  private markResyncInputFailure(pageId: string, lane: Lane): void {
    lane.failure = new Error(
      "Record resync installation not confirmed; pending changes retained",
    );
    this.edits.failed.add(pageId);
  }

  private markPagePreflightFailure(
    pageId: string,
    expectedRevision: number,
    failure: unknown,
  ): void {
    if (!pageId) return;
    const error =
      failure instanceof Error ? failure : new Error(String(failure));
    let lane = this.lanes.get(pageId);
    if (
      !lane &&
      Number.isSafeInteger(expectedRevision) &&
      expectedRevision >= 0
    ) {
      lane = { revision: expectedRevision };
      this.lanes.set(pageId, lane);
    }
    if (lane) lane.failure = error;
    else this.unboundPageFailures.set(pageId, error);
    this.edits.failed.add(pageId);
  }

  /** Explicitly perform one Page write using the App-provided IPC transport.
   * Only identity/revision is returned: App retains/reapplies its doc state. */
  async flushPage(
    pageId: string,
    expectedRevision: number,
    through: number,
    sendPage: (request: PageWriteTicket["request"]) => Promise<Page>,
  ): Promise<{ id: string; revision: number }> {
    let issued: PageWriteTicket;
    try {
      issued = this.beginPageWrite(pageId, expectedRevision, through);
    } catch (failure) {
      this.markPagePreflightFailure(pageId, expectedRevision, failure);
      throw failure;
    }
    let response: Page;
    try {
      response = await sendPage(issued.request);
    } catch (failure) {
      this.failPageWrite(issued.token, failure);
      throw failure;
    }
    this.acceptPageAck(issued.token, response);
    return { id: response.id, revision: response.revision };
  }

  /** Explicitly retry a failed Page write without discarding pending edits. */
  retryPage(
    pageId: string,
    expectedRevision: number,
    through: number,
    sendPage: (request: PageWriteTicket["request"]) => Promise<Page>,
  ): Promise<{ id: string; revision: number }> {
    if (this.activePageId !== undefined) {
      const failure = new Error(
        "Page write must run in the App serialization queue",
      );
      this.markPagePreflightFailure(pageId, expectedRevision, failure);
      return Promise.reject(failure);
    }
    const lane = this.lanes.get(pageId);
    const priorFailure = lane?.failure ?? this.unboundPageFailures.get(pageId);
    if (lane) lane.failure = undefined;
    this.unboundPageFailures.delete(pageId);
    return this.flushPage(pageId, expectedRevision, through, sendPage).catch(
      (failure) => {
        // A preflight failure must not silently unblock another record write.
        const current = this.lanes.get(pageId);
        if (current && !current.failure && priorFailure)
          current.failure = priorFailure;
        else if (!current && priorFailure)
          this.unboundPageFailures.set(pageId, priorFailure);
        throw failure;
      },
    );
  }

  /** Start a Page write in App's serialization queue. The returned request
   * must be sent exactly as issued; only its one-use ticket can ACK it. */
  private beginPageWrite(
    pageId: string,
    expectedRevision: number,
    through: number,
  ): PageWriteTicket {
    if (
      !pageId ||
      pageId.length > 500 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !Number.isSafeInteger(through) ||
      through < 1
    )
      throw new Error("Invalid page write identity, revision or generation");
    if (this.activePageId !== undefined)
      throw new Error("Page write must run in the App serialization queue");
    const pages = this.edits
      .snapshotPages()
      .filter((entry) => entry.id === pageId && entry.seq <= through);
    if (!pages.length || pages[pages.length - 1].seq !== through)
      throw new Error("Page write generation is not pending");
    if (
      this.edits.hasRecord(pageId, through) ||
      this.edits.hasValues(pageId, through) ||
      this.edits.hasSettings(pageId, through)
    )
      throw new Error("Earlier record, value or settings edit is pending");
    let lane = this.lanes.get(pageId);
    if (!lane) {
      lane = { revision: expectedRevision };
      this.lanes.set(pageId, lane);
    }
    if (
      lane.failure ||
      lane.inFlight ||
      lane.pendingResync ||
      (lane.ownerBound && !lane.documentReady) ||
      lane.revision !== expectedRevision
    )
      throw new Error(
        "Page write revision or order conflict; pending changes retained",
      );
    if (
      pages.some(
        (entry) =>
          entry.observedKnown !== true ||
          (lane.ownerBound && entry.expectedOwnerId !== lane.ownerId) ||
          !Number.isSafeInteger(entry.observedRevision) ||
          entry.observedRevision! > lane.revision,
      )
    )
      throw new Error(
        "Page edit revision provenance conflict; pending changes retained",
      );
    const patch = structuredClone(this.edits.patch(pageId, through));
    if (Object.hasOwn(patch, "database"))
      throw new Error(
        "Record Page cannot save a database patch; pending changes retained",
      );
    const token = {};
    this.activePageWrite = {
      token,
      pageId,
      revision: expectedRevision,
      through,
      sequences: pages.map((entry) => entry.seq),
      patch,
    };
    this.activePageId = pageId;
    return {
      token,
      request: {
        type: "update",
        id: pageId,
        revision: expectedRevision,
        patch: structuredClone(patch),
      },
    };
  }

  /** Validate and apply only the Page ACK corresponding to an issued ticket. */
  private acceptPageAck(token: object, page: Page): void {
    const write = this.activePageWrite;
    if (!write || write.token !== token)
      throw new Error("Page acknowledgement ticket mismatch");
    try {
      const lane = this.lanes.get(write.pageId);
      const sequences = this.edits
        .snapshotPages()
        .filter(
          (entry) => entry.id === write.pageId && entry.seq <= write.through,
        )
        .map((entry) => entry.seq);
      if (
        !lane ||
        lane.revision !== write.revision ||
        this.activePageId !== write.pageId ||
        !page ||
        page.id !== write.pageId ||
        !Number.isSafeInteger(page.revision) ||
        page.revision !== write.revision + 1 ||
        page.deletedAt !== null ||
        page.documentError ||
        JSON.stringify(sequences) !== JSON.stringify(write.sequences)
      )
        throw new Error(
          "Page acknowledgement identity, revision or order mismatch",
        );
      for (const [key, expected] of Object.entries(write.patch))
        if (JSON.stringify((page as any)[key]) !== JSON.stringify(expected))
          throw new Error(
            "Page acknowledgement does not contain the submitted patch",
          );
      this.edits.ack(write.pageId, write.through);
      if (lane.failure) this.edits.failed.add(write.pageId);
      lane.revision = page.revision;
      // A Page ACK does not include the membership projection. Do not expose
      // an older record projection as if it matched the new revision.
      lane.lastAck = undefined;
    } catch (failure) {
      const lane = this.lanes.get(write.pageId);
      if (lane)
        lane.failure =
          failure instanceof Error ? failure : new Error(String(failure));
      this.edits.failed.add(write.pageId);
      throw failure;
    } finally {
      this.activePageWrite = undefined;
      this.activePageId = undefined;
    }
  }

  /** Failed IPC releases the ticket without acknowledging any Page edits. */
  private failPageWrite(token: object, failure: unknown): void {
    const write = this.activePageWrite;
    if (!write || write.token !== token)
      throw new Error("Page acknowledgement ticket mismatch");
    const lane = this.lanes.get(write.pageId);
    if (lane)
      lane.failure =
        failure instanceof Error ? failure : new Error(String(failure));
    this.edits.failed.add(write.pageId);
    this.activePageWrite = undefined;
    this.activePageId = undefined;
  }

  /** Explicitly clear an error only after all drafts and in-flight work have
   * settled. This does not change the stored revision or perform a retry. */
  clearSettledFailure(pageId: string): void {
    const lane = this.lanes.get(pageId);
    if (
      this.activePageId !== undefined ||
      lane?.inFlight ||
      lane?.pendingResync ||
      this.edits.hasAny(pageId)
    )
      throw new Error(
        "Cannot clear failure while pending or in-flight work exists",
      );
    if (lane) lane.failure = undefined;
    this.unboundPageFailures.delete(pageId);
    this.edits.failed.delete(pageId);
  }

  /** Establish list-edit provenance from an atomic trusted record:read. The
   * caller supplies the exact displayed projection; it must match the live
   * owner, Page and membership read. This does not install an Editor document.
   * Schedule in App's single queue. Existing/failed/pending lanes are refused. */
  async bindListRecord(
    pageId: string,
    expectedOwnerId: string,
    displayed: RecordProjection,
    read: (pageId: string) => Promise<RecordResyncSnapshot>,
  ): Promise<RecordProjection> {
    if (
      typeof pageId !== "string" ||
      !pageId ||
      pageId.length > 500 ||
      typeof expectedOwnerId !== "string" ||
      !expectedOwnerId ||
      expectedOwnerId.length > 500
    )
      throw new Error("Invalid list record binding identity");
    if (this.activePageId !== undefined)
      throw new Error("Record binding must run in the App serialization queue");
    const assertIdle = () => {
      if (
        this.lanes.has(pageId) ||
        this.edits.hasAny(pageId) ||
        this.edits.failed.has(pageId) ||
        this.unboundPageFailures.has(pageId)
      )
        throw new Error(
          "Cannot bind record while existing, pending or failed work exists",
        );
    };
    assertIdle();
    const observed = validateReadProjection(displayed, pageId, expectedOwnerId);
    this.activePageId = pageId;
    this.bindingPageId = pageId;
    try {
      const value = await read(pageId);
      assertIdle();
      if (!value || typeof value !== "object")
        throw new Error("Invalid list record binding snapshot");
      const actual = validateReadProjection(
        value.record,
        pageId,
        expectedOwnerId,
      );
      // Validate that this membership and the complete stored Page are the
      // same understood, live revision. The read must also prove a live owner.
      validateReadPage(value.page, actual);
      if (!sameProjection(actual, observed))
        throw new Error(
          "Displayed record differs from trusted binding projection",
        );
      this.lanes.set(pageId, {
        revision: actual.revision,
        ownerId: expectedOwnerId,
        ownerBound: true,
        documentReady: false,
        lastAck: structuredClone(actual),
      });
      return structuredClone(actual);
    } finally {
      if (this.bindingPageId === pageId) this.bindingPageId = undefined;
      if (this.activePageId === pageId) this.activePageId = undefined;
    }
  }

  /** Called when App unmounts the Editor. This never acknowledges, removes or
   * rewrites any pending input, even if a Page or record request is in flight.
   * A stale completion must not install a document after this invalidation. */
  invalidateEditor(expectedOwnerId: string, pageId: string): void {
    const lane = this.lanes.get(pageId);
    const authorized =
      (lane?.ownerBound && lane.ownerId === expectedOwnerId) ||
      lane?.pendingResync?.record.databasePageId === expectedOwnerId ||
      (this.activeResync?.pageId === pageId &&
        this.activeResync.ownerId === expectedOwnerId);
    if (!expectedOwnerId || !pageId || !authorized)
      throw new Error("Editor invalidation owner mismatch");
    this.editorEpochs.set(pageId, (this.editorEpochs.get(pageId) ?? 0) + 1);
    if (lane) lane.documentReady = false;
    if (lane?.pendingResync)
      this.cancelResync(pageId, lane.pendingResync.token);
  }

  /** The trusted IPC must atomically read the complete Page, membership projection,
   * and live owner in the same consistent storage snapshot. Run in App's single queue.
   * App must install the returned Page AND Editor doc before confirmResync;
   * edits captured before confirmation are retained as failed unknown inputs. */
  async resync(
    pageId: string,
    expectedOwnerId: string,
    read: (pageId: string) => Promise<RecordResyncSnapshot>,
  ): Promise<RecordResyncResult> {
    if (
      typeof pageId !== "string" ||
      !pageId ||
      pageId.length > 500 ||
      typeof expectedOwnerId !== "string" ||
      !expectedOwnerId ||
      expectedOwnerId.length > 500
    )
      throw new Error("Invalid record resync identity");
    const initialLane = this.lanes.get(pageId);
    const initialEditorEpoch = this.editorEpochs.get(pageId) ?? 0;
    const assertIdle = () => {
      const lane = this.lanes.get(pageId);
      if (
        this.edits.hasAny(pageId) ||
        this.edits.failed.has(pageId) ||
        lane?.failure ||
        lane?.inFlight ||
        lane?.pendingResync ||
        this.unboundPageFailures.has(pageId)
      )
        throw new Error(
          "Cannot resync while pending, failed or in-flight work exists",
        );
      if (lane?.ownerId !== undefined && lane.ownerId !== expectedOwnerId)
        throw new Error("Record resync owner mismatch");
    };
    if (this.activePageId !== undefined)
      throw new Error("Record resync must run in the App serialization queue");
    assertIdle();
    this.activePageId = pageId;
    this.activeResync = { pageId, ownerId: expectedOwnerId };
    try {
      const value = await read(pageId);
      assertIdle();
      if (this.lanes.get(pageId) !== initialLane)
        throw new Error("Record lane changed during resync");
      if ((this.editorEpochs.get(pageId) ?? 0) !== initialEditorEpoch)
        throw new Error("Editor was invalidated during resync");
      if (!value || typeof value !== "object")
        throw new Error("Invalid record resync snapshot");
      const record = validateReadProjection(
        value.record,
        pageId,
        expectedOwnerId,
      );
      const page = validateReadPage(value.page, record);
      if (initialLane && record.revision < initialLane.revision)
        throw new Error("Record resync revision went backwards");
      if (
        initialLane?.lastAck &&
        record.revision === initialLane.revision &&
        !sameProjection(record, initialLane.lastAck)
      )
        throw new Error(
          "Record resync disagrees with the acknowledged revision",
        );
      const lane: Lane = initialLane ?? { revision: record.revision };
      const token = {};
      lane.pendingResync = {
        token,
        page: structuredClone(page),
        record: structuredClone(record),
        laneWasCreated: !initialLane,
      };
      if (!initialLane) this.lanes.set(pageId, lane);
      return {
        token,
        page: structuredClone(page),
        record: structuredClone(record),
      };
    } finally {
      if (this.activeResync?.pageId === pageId) this.activeResync = undefined;
      if (this.activePageId === pageId) this.activePageId = undefined;
    }
  }

  /** Confirm only after App has installed the fresh Page and the actual Editor
   * getJSON() document. The supported schema may add defaults and missing
   * block IDs, but existing data and IDs must be preserved. Added IDs are
   * only in memory until App separately saves them with a proven Page write.
   * Passing the read object without installing it violates the API. */
  confirmResync(
    pageId: string,
    token: object,
    installedPage: Page,
    editorDoc: Doc,
  ): void {
    const lane = this.lanes.get(pageId);
    const pending = lane?.pendingResync;
    if (!lane || !pending || pending.token !== token)
      throw new Error("Record resync installation ticket mismatch");
    if (
      this.activePageId !== undefined ||
      lane.inFlight ||
      lane.failure ||
      this.unboundPageFailures.has(pageId) ||
      this.edits.failed.has(pageId) ||
      this.edits.hasAny(pageId)
    )
      throw new Error(
        "Cannot confirm resync while pending, failed or in-flight work exists",
      );
    const cleanInstalledPage = validateReadPage(installedPage, pending.record);
    if (
      !isDocument(editorDoc) ||
      !sameValue(cleanInstalledPage, pending.page) ||
      !sameInstalledDocument(pending.page.doc, editorDoc)
    )
      throw new Error(
        "Fresh Page and Editor document must be installed before resync confirmation",
      );
    lane.revision = pending.record.revision;
    lane.ownerId = pending.record.databasePageId;
    lane.ownerBound = true;
    lane.documentReady = true;
    lane.lastAck = structuredClone(pending.record);
    lane.pendingResync = undefined;
  }

  /** Cancel a not-yet-confirmed read without adopting it or discarding drafts.
   * If App partially installed the snapshot, it must restore a coherent Page
   * and Editor before further input. Any captured conflict stays failed and
   * requires an explicit recovery workflow; cancellation does not rebase. */
  cancelResync(pageId: string, token: object): void {
    const lane = this.lanes.get(pageId);
    const pending = lane?.pendingResync;
    if (!lane || !pending || pending.token !== token)
      throw new Error("Record resync installation ticket mismatch");
    lane.pendingResync = undefined;
    if (pending.laneWasCreated) {
      // A transient lane's revision came from the cancelled read, not an ACK.
      // Preserve failure even when input arrived during the installation window.
      if (lane.failure) this.unboundPageFailures.set(pageId, lane.failure);
      if (this.edits.hasAny(pageId) && !lane.failure) {
        const failure = new Error(
          "Cancelled record resync has unresolved pending changes",
        );
        this.unboundPageFailures.set(pageId, failure);
        this.edits.failed.add(pageId);
      }
      this.lanes.delete(pageId);
    }
  }

  pending(pageId: string) {
    return this.edits
      .snapshotRecords(pageId)
      .map(({ id, ...entry }) => ({ ...entry, pageId: id }));
  }
  error(pageId: string): Error | undefined {
    return this.lanes.get(pageId)?.failure;
  }
  lastAcknowledged(pageId: string): RecordProjection | undefined {
    const ack = this.lanes.get(pageId)?.lastAck;
    return ack ? structuredClone(ack) : undefined;
  }

  /** The caller must schedule this explicit action in App's single queue.
   * Only edits through the captured generation run, so later Page operations
   * in that queue cannot be overtaken by later record inputs. */
  flush(
    pageId: string,
    through = this.edits.sequence,
  ): Promise<RecordProjection | undefined> {
    const lane = this.lanes.get(pageId);
    if (!lane) {
      const failure = this.unboundPageFailures.get(pageId);
      if (failure) return Promise.reject(failure);
      if (this.edits.hasRecord(pageId, through))
        return Promise.reject(
          new Error(
            "Record revision lineage unavailable; pending changes retained",
          ),
        );
      return Promise.resolve(undefined);
    }
    if (lane.failure) return Promise.reject(lane.failure);
    if (lane.pendingResync)
      return Promise.reject(
        new Error("Record resync installation not confirmed"),
      );
    if (lane.inFlight)
      return lane.inFlight.then(() =>
        this.edits.hasRecord(pageId, through)
          ? this.flush(pageId, through)
          : this.lastAcknowledged(pageId),
      );
    if (this.activePageId !== undefined)
      return Promise.reject(
        new Error("Record flush must run in the App serialization queue"),
      );
    this.activePageId = pageId;
    const run = this.drain(pageId, lane, through);
    const wrapped = run.finally(() => {
      if (lane.inFlight === wrapped) lane.inFlight = undefined;
      if (this.activePageId === pageId) this.activePageId = undefined;
    });
    lane.inFlight = wrapped;
    return wrapped;
  }

  /** Explicit retry does not adopt an unknown revision or discard a draft. */
  retry(
    pageId: string,
    through = this.edits.sequence,
  ): Promise<RecordProjection | undefined> {
    const lane = this.lanes.get(pageId);
    if (lane && !lane.inFlight) lane.failure = undefined;
    return this.flush(pageId, through);
  }

  private async drain(
    pageId: string,
    lane: Lane,
    through: number,
  ): Promise<RecordProjection | undefined> {
    try {
      while (this.edits.hasRecord(pageId, through)) {
        const entry = this.edits.snapshotRecords(pageId, through)[0];
        if (
          this.edits.has(pageId, entry.seq) ||
          this.edits.hasValues(pageId, entry.seq)
        )
          throw new Error(
            "Earlier page or value edits are pending; record changes retained",
          );
        if (
          !entry.observedKnown ||
          !entry.expectedOwnerId ||
          (lane.ownerId !== undefined && entry.expectedOwnerId !== lane.ownerId)
        )
          throw new Error(
            "Unknown external record revision; pending changes retained",
          );
        const revision = lane.revision;
        // Owner-bound writes must have a complete projection at this exact
        // revision. A Page ACK currently invalidates it and cannot prove that
        // membership values remain unchanged; stop without consuming input.
        if (lane.ownerBound && (!lane.lastAck || lane.lastAck.revision !== revision))
          throw new Error("Trusted record base unavailable; pending changes retained");
        const base = lane.ownerBound ? structuredClone(lane.lastAck!) : undefined;
        const request: RecordSaveRequest = {
          type: "record:patch",
          pageId,
          databasePageId: entry.expectedOwnerId,
          revision,
          patch: structuredClone(entry.patch),
        };
        const response = await this.send(request);
        const ack = validateAck(response, request, request.databasePageId, base);
        // Exactly the acknowledged entry is removed, never a newer edit.
        if (this.edits.snapshotRecords(pageId, through)[0]?.seq !== entry.seq)
          throw new Error("Record pending sequence changed");
        this.edits.ackRecord(pageId, entry.seq);
        if (lane.failure) this.edits.failed.add(pageId);
        lane.revision = ack.revision;
        lane.ownerId = ack.databasePageId;
        lane.lastAck = ack;
        // A different operation may have failed its preflight while the IPC
        // was in flight; do not continue the drain past that failure.
        if (lane.failure) throw lane.failure;
      }
      return this.lastAcknowledged(pageId);
    } catch (failure) {
      lane.failure =
        failure instanceof Error ? failure : new Error(String(failure));
      this.edits.failed.add(pageId);
      throw lane.failure;
    }
  }
}

function validatePatch(input: RecordPatch): RecordPatch {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "title" && key !== "values")
  )
    throw new Error("Invalid record patch");
  if (input.title !== undefined && typeof input.title !== "string")
    throw new Error("Invalid record title");
  const patch: RecordPatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.values !== undefined) {
    if (
      !input.values ||
      typeof input.values !== "object" ||
      Array.isArray(input.values) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input.values))
    )
      throw new Error("Invalid record values");
    const entries = Object.entries(input.values);
    if (
      entries.some(
        ([, value]) =>
          !(
            value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value))
          ),
      )
    )
      throw new Error("Invalid record values");
    patch.values = Object.fromEntries(entries) as Record<
      string,
      FilterValue | null
    >;
  }
  if (patch.title === undefined && patch.values === undefined)
    throw new Error("Empty record patch");
  // Size and storage-schema validation is performed by IPC. Keep even an
  // oversized, but representable, user edit so a rejected save is recoverable.
  return patch;
}

function validateAck(
  value: RecordProjection,
  request: RecordSaveRequest,
  ownerId?: string,
  base?: RecordProjection,
): RecordProjection {
  let clean: RecordProjection;
  try {
    clean = validateReadProjection(value, request.pageId, ownerId);
  } catch {
    throw new Error("Invalid record ACK; pending changes retained");
  }
  if (clean.revision !== request.revision + 1)
    throw new Error("Invalid record ACK; pending changes retained");
  if (base) {
    const values = new Map(Object.entries(base.values));
    for (const [key, next] of Object.entries(request.patch.values ?? {})) {
      if (next === null) values.delete(key);
      else values.set(key, next);
    }
    const expected: RecordProjection = {
      ...base,
      revision: request.revision + 1,
      title: request.patch.title ?? base.title,
      values: Object.fromEntries(values),
    };
    if (!sameProjection(clean, expected))
      throw new Error("Record ACK differs from trusted base; pending changes retained");
  }
  if (request.patch.title !== undefined && clean.title !== request.patch.title)
    throw new Error("Record ACK does not contain saved title");
  for (const [key, expected] of Object.entries(request.patch.values ?? {})) {
    if (
      expected === null
        ? Object.hasOwn(clean.values, key)
        : clean.values[key] !== expected
    )
      throw new Error("Record ACK does not contain saved values");
  }
  return clean;
}

/** Reject unknown or malformed fields in the contents we consume and pick only
 * the projection fields, so no returned object can replace a Page document. */
function validateReadProjection(
  value: RecordProjection,
  pageId: string,
  ownerId?: string,
): RecordProjection {
  if (
    !value ||
    value.pageId !== pageId ||
    typeof value.databasePageId !== "string" ||
    !value.databasePageId ||
    value.databasePageId.length > 500 ||
    (ownerId !== undefined && value.databasePageId !== ownerId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.title !== "string" ||
    typeof value.icon !== "string" ||
    value.deletedAt !== null ||
    !value.values ||
    typeof value.values !== "object" ||
    Array.isArray(value.values)
  )
    throw new Error("Invalid record projection; pending changes retained");
  const cells = Object.entries(value.values);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value.values)) ||
    cells.length > 1000 ||
    cells.some(
      ([key, cell]) =>
        !key ||
        key.length > 500 ||
        key === "__proto__" ||
        !(
          typeof cell === "string" ||
          typeof cell === "boolean" ||
          (typeof cell === "number" && Number.isFinite(cell))
        ),
    ) ||
    !fileFits(JSON.stringify(value.values))
  )
    throw new Error("Invalid record projection; pending changes retained");
  return {
    pageId: value.pageId,
    databasePageId: value.databasePageId,
    revision: value.revision,
    title: value.title,
    icon: value.icon,
    values: structuredClone(value.values),
    deletedAt: null,
  };
}

function sameProjection(a: RecordProjection, b: RecordProjection): boolean {
  if (
    a.pageId !== b.pageId ||
    a.databasePageId !== b.databasePageId ||
    a.revision !== b.revision ||
    a.title !== b.title ||
    a.icon !== b.icon ||
    a.deletedAt !== b.deletedAt
  )
    return false;
  const left = Object.keys(a.values).sort();
  const right = Object.keys(b.values).sort();
  return (
    left.length === right.length &&
    left.every(
      (key, index) => key === right[index] && a.values[key] === b.values[key],
    )
  );
}

/** Verify a record read before using it for navigation. This does not bind an
 * Editor or authorize a write. */
export function validateRecordReadSnapshot(
  value: RecordResyncSnapshot,
  pageId: string,
  ownerId: string,
): RecordResyncSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid record read snapshot");
  const record = validateReadProjection(value.record, pageId, ownerId);
  return { page: validateReadPage(value.page, record), record };
}

// A complete supported Page and membership must describe the same live record.
function validateReadPage(page: Page, record: RecordProjection): Page {
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
  const validTime = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (
    !page ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    Object.keys(page).some((key) => !keys.has(key)) ||
    page.id !== record.pageId ||
    (page.schemaVersion !== undefined && page.schemaVersion !== 1) ||
    !(
      page.parentId === null ||
      (typeof page.parentId === "string" &&
        page.parentId.length > 0 &&
        page.parentId.length <= 500)
    ) ||
    page.title !== record.title ||
    page.icon !== record.icon ||
    typeof page.cover !== "string" ||
    typeof page.position !== "number" ||
    !Number.isFinite(page.position) ||
    !isDocument(page.doc) ||
    page.kind !== "page" ||
    page.database !== null ||
    typeof page.favorite !== "boolean" ||
    !validTime(page.createdAt) ||
    !validTime(page.updatedAt) ||
    page.revision !== record.revision ||
    page.deletedAt !== null ||
    page.documentError !== undefined ||
    (page.recoveredFrom !== undefined &&
      (!page.recoveredFrom ||
        typeof page.recoveredFrom.pageId !== "string" ||
        !page.recoveredFrom.pageId ||
        page.recoveredFrom.pageId.length > 500 ||
        !validTime(page.recoveredFrom.recoveredAt) ||
        Object.keys(page.recoveredFrom).some(
          (key) => key !== "pageId" && key !== "recoveredAt",
        )))
  )
    throw new Error("Invalid record Page resync snapshot");
  return structuredClone(page);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.keys(a).sort(),
    right = Object.keys(b).sort();
  return (
    left.length === right.length &&
    left.every(
      (key, i) =>
        key === right[i] &&
        sameValue(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Compare the actual Editor representation against stored input without
 * mutating either. ProseMirror adds schema defaults; round-trip checking first
 * proves no explicit source field was dropped or changed. The sole allowed
 * semantic difference is a new valid ID on an eligible ID-less block. */
function sameInstalledDocument(source: Doc, editor: Doc): boolean {
  if (!isDocument(source) || !isDocument(editor)) return false;
  try {
    const oldNormalized = documentSchema.nodeFromJSON(source).toJSON() as Doc;
    const newNormalized = documentSchema.nodeFromJSON(editor).toJSON() as Doc;
    if (
      !preservesExplicitFields(source, oldNormalized) ||
      !preservesExplicitFields(editor, newNormalized)
    )
      return false;
    return matchesWithAddedBlockIds(oldNormalized, newNormalized);
  } catch {
    return false;
  }
}

/** Defaults and omission of empty arrays are representational; each explicitly
 * provided attribute, mark, node, text and child must survive normalization. */
function preservesExplicitFields(raw: Doc, normalized: Doc): boolean {
  if (raw.type !== normalized.type || raw.text !== normalized.text)
    return false;
  for (const [key, value] of Object.entries(raw.attrs ?? {}))
    if (
      !normalized.attrs ||
      !Object.hasOwn(normalized.attrs, key) ||
      !sameValue(value, normalized.attrs[key])
    )
      return false;
  const rawMarks = raw.marks ?? [],
    normalizedMarks = normalized.marks ?? [];
  if (rawMarks.length !== normalizedMarks.length) return false;
  for (let i = 0; i < rawMarks.length; i++) {
    if (rawMarks[i].type !== normalizedMarks[i].type) return false;
    for (const [key, value] of Object.entries(rawMarks[i].attrs ?? {}))
      if (
        !normalizedMarks[i].attrs ||
        !Object.hasOwn(normalizedMarks[i].attrs!, key) ||
        !sameValue(value, normalizedMarks[i].attrs![key])
      )
        return false;
  }
  const rawChildren = raw.content ?? [],
    normalizedChildren = normalized.content ?? [];
  return (
    rawChildren.length === normalizedChildren.length &&
    rawChildren.every((child, i) =>
      preservesExplicitFields(child, normalizedChildren[i]),
    )
  );
}

function matchesWithAddedBlockIds(source: Doc, editor: Doc): boolean {
  if (
    source.type !== editor.type ||
    source.text !== editor.text ||
    !sameValue(source.marks ?? [], editor.marks ?? [])
  )
    return false;
  const oldAttrs = { ...source.attrs },
    newAttrs = { ...editor.attrs };
  if (BLOCK_TYPES.includes(source.type)) {
    const oldId = oldAttrs.id,
      newId = newAttrs.id;
    if (oldId !== null && oldId !== undefined) {
      if (oldId !== newId) return false;
    } else if (
      newId !== null &&
      newId !== undefined &&
      (typeof newId !== "string" || !newId || newId.length > 128)
    )
      return false;
    delete oldAttrs.id;
    delete newAttrs.id;
  }
  if (!sameValue(oldAttrs, newAttrs)) return false;
  const oldChildren = source.content ?? [],
    newChildren = editor.content ?? [];
  return (
    oldChildren.length === newChildren.length &&
    oldChildren.every((child, i) =>
      matchesWithAddedBlockIds(child, newChildren[i]),
    )
  );
}
