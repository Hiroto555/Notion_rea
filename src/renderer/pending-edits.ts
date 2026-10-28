import type {
  DatabaseSettings,
  FilterValue,
  Page,
  PagePatch,
  RecordPatch,
} from "../shared/types";
import type { SettingsIntent } from "./settings-intent";

type PendingRecordValues = NonNullable<RecordPatch["values"]>;
type PendingPageEdit = {
  seq: number;
  id: string;
  patch: PagePatch;
  observedRevision?: number;
  observedKnown?: boolean;
  /** Membership the caller observed; retained even on owner mismatch. */
  expectedOwnerId?: string;
  recoveryKind?: "record" | "database";
};
export type PendingRecordCommand = {
  seq: number;
  id: string;
  observedRevision: number;
  observedKnown: boolean;
  expectedOwnerId?: string;
  patch: RecordPatch;
};
export type PendingSettingsIntent = {
  seq: number;
  id: string;
  observedRevision: number;
  observedKnown: boolean;
  intent: SettingsIntent;
};
type PendingSettings = {
  seq: number;
  id: string;
  baseRevision: number;
  settings: DatabaseSettings;
};

/** Page edits and record-value edits share one generation counter, but an ACK
 * only removes the kind actually persisted by that request. */
export class PendingEdits {
  private serial = 0;
  private lastById = new Map<string, number>();
  private entries: PendingPageEdit[] = [];
  private valueEntries: {
    seq: number;
    id: string;
    values: PendingRecordValues;
  }[] = [];
  private settingEntries: PendingSettings[] = [];
  private settingIntents: PendingSettingsIntent[] = [];
  private recordEntries: PendingRecordCommand[] = [];
  failed = new Set<string>();
  get sequence() {
    return this.serial;
  }
  /** Monotonic input generation for one owner, independent of other Pages. */
  sequenceFor(id: string): number {
    return this.lastById.get(id) ?? 0;
  }
  private nextSequence(id: string): number {
    const seq = ++this.serial;
    this.lastById.set(id, seq);
    return seq;
  }
  add(id: string, patch: PagePatch) {
    // PagePatch and RecordPatch both contain title, so a structurally-typed
    // object could otherwise smuggle values into the Page merge path.
    const allowed = new Set([
      "title",
      "icon",
      "cover",
      "doc",
      "database",
      "favorite",
    ]);
    if (Object.keys(patch).some((key) => !allowed.has(key)))
      throw new Error("Unsupported Page patch field");
    const seq = this.nextSequence(id);
    this.entries.push({ seq, id, patch: structuredClone(patch) });
    return seq;
  }
  /** Captured provenance for the record Page coordinator; legacy add remains unchanged. */
  addObservedPage(
    id: string,
    observedRevision: number,
    patch: PagePatch,
    observedKnown: boolean,
    expectedOwnerId?: string,
    recoveryKind?: "record" | "database",
  ) {
    if (
      expectedOwnerId !== undefined &&
      (typeof expectedOwnerId !== "string" ||
        !expectedOwnerId ||
        expectedOwnerId.length > 500)
    )
      throw new Error("Invalid expected record owner");
    if (!id || !Number.isSafeInteger(observedRevision) || observedRevision < 0)
      throw new Error("Invalid Page edit identity or revision");
    const seq = this.add(id, patch);
    const entry = this.entries[this.entries.length - 1];
    entry.observedRevision = observedRevision;
    entry.observedKnown = observedKnown;
    if (expectedOwnerId !== undefined) entry.expectedOwnerId = expectedOwnerId;
    if (recoveryKind !== undefined) entry.recoveryKind = recoveryKind;
    return seq;
  }
  /** Restore already validated ordinary Page intents without renumbering an operation. */
  restorePage(entry: import("../shared/crash-recovery").EditSessionRecovery) {
    if (entry.record || this.hasAny(entry.base.id)) throw new Error("Recovery Page already has input");
    for (const intent of entry.intents) this.entries.push({id: entry.base.id, seq: intent.seq,
      patch: structuredClone(intent.patch), observedRevision: entry.base.revision, observedKnown: true});
    this.serial = Math.max(this.serial, entry.seq);
    this.lastById.set(entry.base.id, entry.seq);
  }
  addValues(id: string, values: PendingRecordValues) {
    const seq = this.nextSequence(id);
    this.valueEntries.push({ seq, id, values: structuredClone(values) });
    return seq;
  }
  /** Capture one atomic title+values command under the shared sequence. */
  addRecord(
    id: string,
    observedRevision: number,
    patch: RecordPatch,
    observedKnown: boolean,
    expectedOwnerId?: string,
  ) {
    if (
      (expectedOwnerId !== undefined &&
        (typeof expectedOwnerId !== "string" ||
          !expectedOwnerId ||
          expectedOwnerId.length > 500)) ||
      !id ||
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0 ||
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => key !== "title" && key !== "values")
    )
      throw new Error("Invalid pending record command");
    const copy = structuredClone(patch);
    const seq = this.nextSequence(id);
    this.recordEntries.push({
      seq,
      id,
      observedRevision,
      observedKnown,
      ...(expectedOwnerId === undefined ? {} : { expectedOwnerId }),
      patch: copy,
    });
    return seq;
  }
  snapshotRecords(id?: string, through = Infinity): PendingRecordCommand[] {
    return structuredClone(
      this.recordEntries.filter(
        (entry) =>
          (id === undefined || entry.id === id) && entry.seq <= through,
      ),
    );
  }
  /** A record ACK removes exactly one record command, never Page or values. */
  ackRecord(id: string, seq: number) {
    this.recordEntries = this.recordEntries.filter(
      (entry) => entry.id !== id || entry.seq !== seq,
    );
    this.clearFailureIfSaved(id);
  }
  /** Core owns each semantic intent and its provenance in the shared sequence. */
  addSettingsIntent(
    id: string,
    observedRevision: number,
    intent: SettingsIntent,
    observedKnown: boolean,
  ) {
    if (
      !id ||
      id.length > 500 ||
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0 ||
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent)
    )
      throw new Error("Invalid settings intent identity or revision");
    const copy = structuredClone(intent);
    const seq = this.nextSequence(id);
    this.settingIntents.push({
      seq,
      id,
      observedRevision,
      observedKnown,
      intent: copy,
    });
    return seq;
  }
  snapshotSettingsIntents(
    id?: string,
    through = Infinity,
  ): PendingSettingsIntent[] {
    return structuredClone(
      this.settingIntents.filter(
        (entry) =>
          (id === undefined || entry.id === id) && entry.seq <= through,
      ),
    );
  }
  /** Call only after validating a one-use matching transport ACK and ticket. */
  ackSettingsIntent(id: string, seq: number) {
    if (
      !this.settingIntents.some((entry) => entry.id === id && entry.seq === seq)
    )
      throw new Error("Settings intent acknowledgement mismatch");
    this.settingIntents = this.settingIntents.filter(
      (entry) => entry.id !== id || entry.seq !== seq,
    );
    this.clearFailureIfSaved(id);
  }
  /** Capture the revision that this complete settings snapshot was based on.
   * A later snapshot must include earlier pending edits; this queue cannot
   * merge independent whole snapshots or infer an intent-level change. */
  addSettings(id: string, baseRevision: number, settings: DatabaseSettings) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0)
      throw new Error("Invalid database settings revision");
    if (
      !settings ||
      typeof settings !== "object" ||
      Object.hasOwn(settings, "rows")
    )
      throw new Error("Database settings cannot include rows");
    const copy = structuredClone(settings);
    const seq = this.nextSequence(id);
    this.settingEntries.push({ seq, id, baseRevision, settings: copy });
    return seq;
  }
  /** Read a coalesced snapshot only if every included edit has the same base.
   * Caller must obtain currentRevision from its known persisted state. */
  settingsDraft(
    id: string,
    currentRevision: number,
    through = Infinity,
  ): PendingSettings | undefined {
    const entries = this.settingEntries.filter(
      (e) => e.id === id && e.seq <= through,
    );
    if (!entries.length) return undefined;
    if (entries.some((e) => e.baseRevision !== currentRevision))
      throw new Error(
        "Database settings revision conflict; pending settings retained",
      );
    return structuredClone(entries[entries.length - 1]);
  }
  patch(id: string, through = Infinity): PagePatch {
    return Object.assign(
      {},
      ...this.entries
        .filter((e) => e.id === id && e.seq <= through)
        .map((e) => e.patch),
    );
  }
  /** Returns a per-key patch; null means delete, not an empty stored value. */
  valuesPatch(id: string, through = Infinity): PendingRecordValues {
    const values = new Map<string, FilterValue | null>();
    const changes = [
      ...this.valueEntries
        .filter((entry) => entry.id === id && entry.seq <= through)
        .map((entry) => ({ seq: entry.seq, values: entry.values })),
      ...this.recordEntries
        .filter(
          (entry) =>
            entry.id === id &&
            entry.seq <= through &&
            entry.patch.values !== undefined,
        )
        .map((entry) => ({ seq: entry.seq, values: entry.patch.values! })),
    ].sort((a, b) => a.seq - b.seq);
    for (const change of changes)
      for (const [key, value] of Object.entries(change.values))
        values.set(key, value);
    return Object.fromEntries(values);
  }
  /** Applies pending values to a projection without mutating its source. */
  mergeValues(
    id: string,
    source: Readonly<Record<string, FilterValue>>,
    through = Infinity,
  ): Record<string, FilterValue> {
    const values = new Map(Object.entries(source));
    for (const [key, value] of Object.entries(this.valuesPatch(id, through))) {
      if (value === null) values.delete(key);
      else values.set(key, value);
    }
    return Object.fromEntries(values);
  }
  /** Legacy Page-only predicate. Use hasAny when testing all pending edits. */
  has(id: string, through = Infinity) {
    return this.entries.some((e) => e.id === id && e.seq <= through);
  }
  hasValues(id: string, through = Infinity) {
    return this.valueEntries.some((e) => e.id === id && e.seq <= through);
  }
  hasRecord(id: string, through = Infinity) {
    return this.recordEntries.some((e) => e.id === id && e.seq <= through);
  }
  hasSettings(id: string, through = Infinity) {
    return (
      this.settingEntries.some((e) => e.id === id && e.seq <= through) ||
      this.settingIntents.some((e) => e.id === id && e.seq <= through)
    );
  }
  hasAny(id: string, through = Infinity) {
    return (
      this.has(id, through) ||
      this.hasValues(id, through) ||
      this.hasSettings(id, through) ||
      this.hasRecord(id, through)
    );
  }
  /** A Page ACK never acknowledges values, even at an older sequence. */
  ack(id: string, through: number) {
    this.entries = this.entries.filter((e) => e.id !== id || e.seq > through);
    this.clearFailureIfSaved(id);
  }
  /** A value ACK never acknowledges title/doc Page patches. */
  ackValues(id: string, through: number) {
    this.valueEntries = this.valueEntries.filter(
      (e) => e.id !== id || e.seq > through,
    );
    this.clearFailureIfSaved(id);
  }
  /** ACK only the settings generations actually written against their base. */
  ackSettings(
    id: string,
    through: number,
    baseRevision: number,
    savedRevision: number,
  ) {
    const entries = this.settingEntries.filter(
      (e) => e.id === id && e.seq <= through,
    );
    if (!entries.length) return;
    if (
      !Number.isSafeInteger(baseRevision) ||
      !Number.isSafeInteger(savedRevision) ||
      savedRevision !== baseRevision + 1 ||
      entries.some((e) => e.baseRevision !== baseRevision)
    )
      throw new Error(
        "Database settings acknowledgement mismatch; pending settings retained",
      );
    this.settingEntries = this.settingEntries.filter(
      (e) => e.id !== id || e.seq > through,
    );
    this.clearFailureIfSaved(id);
  }
  discardThrough(through: number) {
    // The existing recovery/export snapshot only contains Page patches.
    // Refuse before changing any queue until records, values and settings have a safe export path.
    if (
      this.entries.some(
        (entry) =>
          entry.seq <= through &&
          (entry.expectedOwnerId !== undefined ||
            entry.recoveryKind !== undefined),
      )
    )
      throw new Error("Record Page drafts have not been included in recovery");
    if (this.recordEntries.some((entry) => entry.seq <= through))
      throw new Error("Record commands have not been included in recovery");
    if (this.valueEntries.some((entry) => entry.seq <= through))
      throw new Error("Record values have not been included in recovery");
    if (this.settingIntents.some((entry) => entry.seq <= through))
      throw new Error(
        "Database settings intents have not been included in recovery",
      );
    if (this.settingEntries.some((entry) => entry.seq <= through))
      throw new Error("Database settings have not been included in recovery");
    this.entries = this.entries.filter((e) => e.seq > through);
    for (const id of this.failed) this.clearFailureIfSaved(id);
  }
  private clearFailureIfSaved(id: string) {
    // A previous failure may refer to a later request; a stale ACK cannot
    // declare success while any Page or property entry still remains.
    if (!this.hasAny(id)) this.failed.delete(id);
  }
  get size() {
    return (
      this.entries.length +
      this.valueEntries.length +
      this.settingEntries.length +
      this.settingIntents.length +
      this.recordEntries.length
    );
  }
  /** Legacy Page-only API for existing export/retry callers. */
  patches() {
    return new Map(
      [...new Set(this.entries.map((e) => e.id))].map((id) => [
        id,
        this.patch(id),
      ]),
    );
  }
  /** Overlay Page fields and atomic record titles in shared input order.
   * Record values remain separate and never enter the Page object. */
  merge(pages: Page[]) {
    return pages.map((page) => {
      const changes = [
        ...this.entries
          .filter((entry) => entry.id === page.id)
          .map((entry) => ({
            seq: entry.seq,
            patch: structuredClone(entry.patch),
          })),
        ...this.recordEntries
          .filter(
            (entry) => entry.id === page.id && entry.patch.title !== undefined,
          )
          .map((entry) => ({
            seq: entry.seq,
            patch: { title: entry.patch.title },
          })),
      ].sort((a, b) => a.seq - b.seq);
      return Object.assign({}, page, ...changes.map((change) => change.patch));
    });
  }
  /** Page-only recovery cannot represent record/value/settings drafts. */
  snapshot() {
    if (
      this.entries.some(
        (entry) =>
          entry.expectedOwnerId !== undefined ||
          entry.recoveryKind !== undefined,
      ) ||
      this.recordEntries.length ||
      this.valueEntries.length ||
      this.settingEntries.length ||
      this.settingIntents.length
    )
      throw new Error(
        "Page-only recovery cannot include pending record or settings edits",
      );
    return this.snapshotPages();
  }
  /** Non-recovery inspection; never by itself an export of all edits. */
  snapshotPages() {
    return structuredClone(this.entries);
  }
  snapshotValues() {
    return structuredClone(this.valueEntries);
  }
  snapshotSettings() {
    return structuredClone(this.settingEntries);
  }
}
