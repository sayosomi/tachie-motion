import NativeFilePicker from "./NativeFilePicker";
import { wavFilename, type UtteranceItem } from "./utteranceItems";

type Props = {
  items: UtteranceItem[];
  selectedId: string | null;
  pendingPath: string;
  addingCount: number;
  addError: string;
  disabled: boolean;
  exportingId: string | null;
  onPathChange: (path: string) => void;
  onAdd: (path: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
};

export default function UtteranceList({
  items, selectedId, pendingPath, addingCount, addError, disabled,
  exportingId, onPathChange, onAdd, onSelect, onMove, onRemove,
}: Props) {
  return <section className="panel utterance-list-panel" aria-label="セリフ一覧">
    <div className="utterance-list-header">
      <h2>WAV一覧</h2><span className="meta">{items.length}件</span>
    </div>
    <NativeFilePicker id="speech-wav-path" kind="wav" label="WAVファイルを追加"
      value={pendingPath} disabled={disabled}
      onChange={onPathChange}
      onSelected={onAdd}
      onApply={async () => { await onAdd(pendingPath); }} applyLabel="WAVを確認" />
    <p className="hint">同じWAVも別のセリフ項目として追加できます。削除しても元ファイルは残ります。</p>
    {addingCount > 0 && <p className="hint" role="status">WAVを解析中…（{addingCount}件）</p>}
    {addError && <p className="hint warning" role="alert">{addError}</p>}
    {items.length === 0 ? <p className="empty-state">WAVを追加してください。</p> :
      <ol className="utterance-items" aria-label="登録済みセリフ">
        {items.map((item, index) => {
          const name = wavFilename(item.wavPath);
          return <li className="utterance-item" data-utterance-id={item.id}
            data-selected={item.id === selectedId} key={item.id}>
            <button type="button" className="utterance-item-select"
              aria-current={item.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(item.id)}>
              <span className="utterance-item-index">{index + 1}</span>
              <span className="utterance-item-details">
                <strong title={item.wavPath}>{name}</strong>
                <small title={item.wavPath}>{item.wavPath}</small>
                <small>{item.wav.duration_seconds.toFixed(2)}秒 ／ {item.mode}</small>
              </span>
            </button>
            <div className="utterance-item-actions">
              <button type="button" aria-label={`上へ: ${index + 1} ${name}`}
                disabled={index === 0} onClick={() => onMove(item.id, -1)}>↑</button>
              <button type="button" aria-label={`下へ: ${index + 1} ${name}`}
                disabled={index === items.length - 1} onClick={() => onMove(item.id, 1)}>↓</button>
              <button type="button" aria-label={`削除: ${index + 1} ${name}`}
                disabled={exportingId === item.id} onClick={() => onRemove(item.id)}>削除</button>
            </div>
          </li>;
        })}
      </ol>}
  </section>;
}
