import { Database, X } from 'lucide-react';
import { DialogFrame } from './Modal';
import { composing } from '../shared/keyboard';
import './r5-database.css';

export function NewDatabaseDialog({ title, onTitle, state, error, onSubmit, onResolve, onClose }: {
  title: string; onTitle: (title: string) => void;
  state: 'idle' | 'saving' | 'unknown' | 'rejected'; error?: string;
  onSubmit: () => void; onResolve: () => void; onClose: () => void;
}) {
  const locked = state === 'saving' || state === 'unknown';
  return <DialogFrame modal name="新しいデータベース" className="r5-create-database" onClose={onClose}>
    <div className="r5-create-heading"><Database size={20} /><h2>新しいデータベース</h2>
      <button aria-label="閉じる" onClick={onClose}><X size={18} /></button></div>
    <p>ページとして開ける行と、メモ・見積・完了の項目を用意します。</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!locked) onSubmit(); }}
      onKeyDown={(event) => { if (event.key === 'Enter' && composing(event.nativeEvent)) event.preventDefault(); }}>
      <label>データベース名<input data-initial-focus aria-label="データベース名" maxLength={500}
        value={title} disabled={locked} onChange={(event) => onTitle(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="r5-create-actions">
        <button type="button" onClick={onClose}>閉じる</button>
        {state === 'unknown' ? <button type="button" className="primary" onClick={onResolve}>作成結果を確認</button> :
          <button className="primary" type="submit" disabled={locked || !title.trim()}>{state === 'saving' ? '作成中…' : '作成'}</button>}
      </div>
    </form>
  </DialogFrame>;
}
