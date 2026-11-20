import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { DatabaseCallbacks, Doc, Page, RecordPatch, RecordProjection } from '../shared/types';
import type { WorkspaceReadPort } from '../shared/app-api';
import { DatabasePresentation } from '../database/DatabasePresentation';
import { ControlledRecordTable, type RecordTableState } from '../database/ControlledRecordTable';
import { DatabaseSettingsPanel } from '../database/DatabaseSettingsPanel';
import { displayOf, visibleRecords, groupedRecords } from '../database/database-ui';
import { EditSessionCoordinator } from './edit-session-coordinator';
import { DatabaseSessionCoordinator } from './database-session-coordinator';
import { validateRecordReadSnapshot } from './record-save-coordinator';
import './r5-database.css';

/** The App owns settings, creation operations, record sessions and raw inputs. */
export function LiveRecordDatabase({ databasePageId, workspace, pages, lifecycle, databases, sessions, numberDrafts, onNumberDraft,
  filterInputTexts, onFilterInputTextChange, creatingRecord, onCreateRecord, onOpenRecord, onOpenProperties, onError }: {
  databasePageId: string;
  workspace: WorkspaceReadPort;
  pages: ReadonlyMap<string, Page>;
  lifecycle: Pick<DatabaseCallbacks, 'trashRecord' | 'duplicateRecord' | 'restoreRecord'>;
  databases: DatabaseSessionCoordinator;
  sessions: EditSessionCoordinator;
  numberDrafts: Record<string, Record<string, string>>;
  onNumberDraft: (id: string, propertyId: string, text: string) => void;
  filterInputTexts: Record<string, Record<string, string>>;
  onFilterInputTextChange: (viewId: string, filterId: string, text: string) => void;
  creatingRecord: boolean;
  onCreateRecord: DatabaseCallbacks['createRecord'];
  onOpenRecord: (id: string) => void;
  onOpenProperties: () => void;
  onError: (error: unknown) => void;
}) {
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<RecordProjection>();
  useEffect(() => {
    let cancelled = false;
    setError('');
    if (!databases.get(databasePageId)) void workspace.readDatabase(databasePageId)
      .then((value) => {
        if (cancelled) return;
        if (value.page.id !== databasePageId) throw new Error('所属を確認できません。');
        databases.attach(value.page, value.database);
      }).catch((error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [databasePageId, workspace, databases]);
  const database = databases.get(databasePageId);
  const projection = database?.projection;
  // Projection values suffice for the table. Fetch a body only when a focused
  // row has no matching page in the workspace snapshot.
  const focusedId = editing?.pageId;
  useEffect(() => {
    let cancelled = false;
    const record = databases.get(databasePageId)?.projection.records.find(row => row.pageId === focusedId);
    if (record && !sessions.get(record.pageId) && pages.get(record.pageId)?.revision !== record.revision) {
      void (async () => {
        const read = await workspace.readRecord(record.pageId);
        if (cancelled) return;
        const pair = validateRecordReadSnapshot(read, record.pageId, databasePageId);
        sessions.attach(pair.page, pair.record);
      })().catch(error => {if (!cancelled) onError(error);});
    }
    return () => {cancelled = true;};
  }, [databasePageId, focusedId, pages, workspace, databases, sessions]);
  if (!database || !projection) return <section aria-label="レコード一覧">{error ? <p role="alert">{error}</p> : <p role="status">読み込み中…</p>}</section>;
  const recordSessions = new Map(projection.records.map((record) => [record.pageId, sessions.get(record.pageId)]));
  const records = projection.records.map((record) => recordSessions.get(record.pageId)?.record ?? record);
  const recordBodies: Record<string, Doc> = {};
  for (const record of records) {
    const session = recordSessions.get(record.pageId);
    const body = session?.page ?? pages.get(record.pageId);
    if (body && record.deletedAt === null && record.databasePageId === databasePageId &&
        body.revision === record.revision && !body.documentError) recordBodies[record.pageId] = body.doc;
  }
  const currentRecords = new Map(records.map((record) => [record.pageId, record]));
  const states: Record<string, RecordTableState> = {};
  for (const record of records) {
    const session = recordSessions.get(record.pageId);
    const editable = session ? session.record?.databasePageId === databasePageId : !!recordBodies[record.pageId];
    states[record.pageId] = {status: session?.state ?? (editable ? 'saved' : 'blocked'), error: session?.error, editable};
  }
  // Derive membership and position from the focused row's initial values.
  // Its controls still render the latest session values; blur reapplies layout.
  const display = displayOf({...projection, records: records.map((record) =>
    editing?.pageId === record.pageId ? editing : record)});
  const capture = (id: string, revision: number, patch: RecordPatch) => {
    const record = currentRecords.get(id);
    if (!record || record.revision !== revision || record.databasePageId !== databasePageId) throw new Error('レコードの版または所属が変わりました。');
    const current = sessions.get(id);
    if (current && (current.baseRevision !== revision || ['conflict','blocked','unknown'].includes(current.state)))
      throw new Error('レコードの保存結果を確認してください。');
    const page = current?.page ?? pages.get(id);
    if (!page) throw new Error('本文を読み込み中です。');
    const handle = current?.handle ?? sessions.attach(page, record);
    sessions.edit(handle, patch.title === undefined ? {} : {title: patch.title}, patch.values);
  };
  const callbacks: DatabaseCallbacks = {...lifecycle, openRecord: onOpenRecord, createRecord: onCreateRecord,
    async patchRecord(id, revision, patch) {
      capture(id, revision, patch);
      await sessions.flush(id);
      const saved = sessions.get(id);
      if (saved?.state !== 'saved' || !saved.record) throw new Error('レコードの保存結果を確認してください。');
      return saved.record;
    },
    async updateSettings(revision, next) {
      const current = databases.get(databasePageId);
      if (!current || current.state !== 'saved' || current.page.revision !== revision) throw new Error('DB設定の版が変わりました。');
      databases.editSettings(current.handle, {kind: 'replaceViews', base: current.projection.settings, next});
      await databases.flush(databasePageId);
      const saved = databases.get(databasePageId);
      if (saved?.state !== 'saved') throw new Error('DB設定の保存結果を確認してください。');
      return saved.projection;
    },
  };
  const table = (visible: readonly RecordProjection[]) => <ControlledRecordTable databasePageId={databasePageId}
    properties={projection.settings.properties} records={visible.map((record) =>
      currentRecords.get(record.pageId) ?? record)} states={states} inputTexts={numberDrafts}
    onEditingChange={(id) => setEditing((current) => id === current?.pageId ? current : records.find((record) => record.pageId === id))}
    onInputTextChange={onNumberDraft} onOpenRecord={onOpenRecord} onResolve={(id) => void sessions.resolve(id)}
    onDuplicate={record => void lifecycle.duplicateRecord(record.pageId, record.revision).catch(onError)}
    onTrash={record => void lifecycle.trashRecord(record.pageId, record.revision).catch(onError)}
    onPatch={(id, patch) => {
      try {
        capture(id, currentRecords.get(id)!.revision, patch);
        sessions.scheduleFlush(id);
      } catch (error) {onError(error);}
    }} />;
  const latestCreated = database.lastResult?.record?.pageId;
  return <section aria-label="レコード一覧" data-database-id={databasePageId}>
    <DatabaseSettingsPanel settings={projection.settings} status={database.state} error={database.error}
      filterInputTexts={filterInputTexts} onFilterInputTextChange={onFilterInputTextChange}
      onIntent={(intent) => {try {databases.editSettings(database.handle, intent); void databases.flush(databasePageId);} catch (error) {onError(error);}}}
      onResolve={() => void databases.resolve(databasePageId)}
      schemaActions={
        <button type="button" onClick={onOpenProperties}>プロパティを編集</button>
      }
      toolbarActions={
        <button type="button" className="r7-new-record" onClick={() => void onCreateRecord({title: '無題', values: {}}).catch(onError)} disabled={creatingRecord || ['unknown','conflict','blocked'].includes(database.state)}><Plus size={15} />新規行</button>
      } />
    {(creatingRecord || latestCreated) && <div className="r5-database-actions">
      {creatingRecord && <p role="status">行を追加中…</p>}
      {latestCreated && <button type="button" onClick={() => onOpenRecord(latestCreated)}>追加したページを開く</button>}
      {latestCreated && !visibleRecords(display).some((record) => record.pageId === latestCreated) &&
        <p>追加した行は現在のフィルター条件では表示されません。</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {display.view.type === 'table' ? display.view.groupBy ?
      <div className="r5-record-groups">{groupedRecords(display).map((group) => <section key={group.key} aria-label={`グループ ${group.label || '未設定'}`}>
        <h4>{group.label || '未設定'} <small>{group.records.length}</small></h4>{table(group.records)}</section>)}</div> : table(visibleRecords(display)) :
      <DatabasePresentation databasePageId={databasePageId} value={{...projection, records}} callbacks={callbacks}
        controlledViewId={projection.settings.activeViewId} recordBodies={recordBodies} hideNavigation />}
  </section>;
}
