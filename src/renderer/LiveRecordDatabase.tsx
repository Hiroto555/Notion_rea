import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { DatabaseCallbacks, Page, RecordProjection } from '../shared/types';
import type { DatabaseReadSnapshot } from '../shared/database-operation';
import { DatabasePresentation } from '../database/DatabasePresentation';
import { ControlledRecordTable, type RecordTableState } from '../database/ControlledRecordTable';
import { DatabaseSettingsPanel } from '../database/DatabaseSettingsPanel';
import { displayOf, visibleRecords, groupedRecords } from '../database/database-ui';
import { EditSessionCoordinator } from './edit-session-coordinator';
import { DatabaseSessionCoordinator } from './database-session-coordinator';
import { validateRecordReadSnapshot } from './record-save-coordinator';
import './r5-database.css';

/** The App owns settings, creation operations, record sessions and raw inputs. */
export function LiveRecordDatabase({ databasePageId, databases, sessions, numberDrafts, onNumberDraft,
  filterInputTexts, onFilterInputTextChange, creatingRecord, onCreateRecord, onOpenRecord, onError }: {
  databasePageId: string;
  databases: DatabaseSessionCoordinator;
  sessions: EditSessionCoordinator;
  numberDrafts: Record<string, Record<string, string>>;
  onNumberDraft: (id: string, propertyId: string, text: string) => void;
  filterInputTexts: Record<string, Record<string, string>>;
  onFilterInputTextChange: (viewId: string, filterId: string, text: string) => void;
  creatingRecord: boolean;
  onCreateRecord: () => void;
  onOpenRecord: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<RecordProjection>();
  useEffect(() => {
    let cancelled = false;
    setError('');
    if (!databases.get(databasePageId)) void window.folio.request<DatabaseReadSnapshot>({ type: 'database:read', databasePageId })
      .then((value) => {
        if (cancelled) return;
        if (value.page.id !== databasePageId) throw new Error('所属を確認できません。');
        databases.attach(value.page, value.database);
      }).catch((error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [databasePageId, databases]);
  const database = databases.get(databasePageId);
  const projection = database?.projection;
  const ids = projection?.records.filter((record) => record.deletedAt === null).map((record) => record.pageId).join('|') ?? '';
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const record of databases.get(databasePageId)?.projection.records ?? []) {
        if (record.deletedAt !== null || sessions.get(record.pageId)) continue;
        const read = await window.folio.request<{page: Page; record: RecordProjection}>({type: 'record:read', pageId: record.pageId});
        if (cancelled) return;
        const pair = validateRecordReadSnapshot(read, record.pageId, databasePageId);
        sessions.attach(pair.page, pair.record);
      }
    })().catch((error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [databasePageId, databases, sessions, ids]);
  if (!database || !projection) return <section aria-label="レコード一覧">{error ? <p role="alert">{error}</p> : <p role="status">読み込み中…</p>}</section>;
  const records = projection.records.map((record) => sessions.get(record.pageId)?.record ?? record);
  const currentRecords = new Map(records.map((record) => [record.pageId, record]));
  const states: Record<string, RecordTableState> = {};
  for (const record of records) {
    const session = sessions.get(record.pageId);
    states[record.pageId] = {status: session?.state ?? 'blocked', error: session?.error,
      editable: !!session && session.record?.databasePageId === databasePageId};
  }
  // Derive membership and position from the focused row's initial values.
  // Its controls still render the latest session values; blur reapplies layout.
  const display = displayOf({...projection, records: records.map((record) =>
    editing?.pageId === record.pageId ? editing : record)});
  const unavailable = async (): Promise<never> => {throw new Error('この操作は準備中です。');};
  const callbacks: DatabaseCallbacks = {openRecord: onOpenRecord, createRecord: unavailable, patchRecord: unavailable,
    trashRecord: unavailable, restoreRecord: unavailable, duplicateRecord: unavailable, updateSettings: unavailable};
  const table = (visible: readonly RecordProjection[]) => <ControlledRecordTable databasePageId={databasePageId}
    properties={projection.settings.properties} records={visible.map((record) =>
      currentRecords.get(record.pageId) ?? record)} states={states} inputTexts={numberDrafts}
    onEditingChange={(id) => setEditing((current) => id === current?.pageId ? current : records.find((record) => record.pageId === id))}
    onInputTextChange={onNumberDraft} onOpenRecord={onOpenRecord} onResolve={(id) => void sessions.resolve(id)}
    onPatch={(id, patch) => {
      try {
        const session = sessions.get(id);
        if (!session || session.record?.databasePageId !== databasePageId) throw new Error('所属を確認できません。');
        sessions.edit(session.handle, patch.title === undefined ? {} : {title: patch.title}, patch.values);
        void sessions.flush(id);
      } catch (error) {onError(error);}
    }} />;
  const latestCreated = database.lastResult?.record?.pageId;
  return <section aria-label="レコード一覧" data-database-id={databasePageId}>
    <DatabaseSettingsPanel settings={projection.settings} status={database.state} error={database.error}
      filterInputTexts={filterInputTexts} onFilterInputTextChange={onFilterInputTextChange}
      onIntent={(intent) => {try {databases.editSettings(database.handle, intent); void databases.flush(databasePageId);} catch (error) {onError(error);}}}
      onResolve={() => void databases.resolve(databasePageId)} />
    <div className="r5-database-actions">
      <button type="button" onClick={onCreateRecord} disabled={creatingRecord || ['unknown','conflict','blocked'].includes(database.state)}><Plus size={15} />新規行</button>
      {creatingRecord && <p role="status">行を追加中…</p>}
      {latestCreated && <button type="button" onClick={() => onOpenRecord(latestCreated)}>追加したページを開く</button>}
      {latestCreated && !visibleRecords(display).some((record) => record.pageId === latestCreated) &&
        <p>追加した行は現在のフィルター条件では表示されません。</p>}
    </div>
    {error && <p role="alert">{error}</p>}
    {display.view.type === 'table' ? display.view.groupBy ?
      <div className="r5-record-groups">{groupedRecords(display).map((group) => <section key={group.key} aria-label={`グループ ${group.label || '未設定'}`}>
        <h4>{group.label || '未設定'} <small>{group.records.length}</small></h4>{table(group.records)}</section>)}</div> : table(visibleRecords(display)) :
      <DatabasePresentation databasePageId={databasePageId} value={{...projection, records}} callbacks={callbacks}
        controlledViewId={projection.settings.activeViewId} hideNavigation readOnly />}
  </section>;
}
