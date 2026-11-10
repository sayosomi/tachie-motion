import { useEffect, useState } from "react";
import NativeFilePicker from "./NativeFilePicker";
import type { WavPlaybackControls } from "./WavPlayback";
import type { UnifiedPreset } from "./presetModel";
import { wavFilename, type LipMode, type UtteranceItem } from "./utteranceItems";

type Props = {
  items: UtteranceItem[];
  presets: Pick<UnifiedPreset, "id" | "name">[];
  presetStatus: "loading" | "ready" | "error";
  selectedId: string | null;
  pendingPath: string;
  addingCount: number;
  addError: string;
  disabled: boolean;
  exportingId: string | null;
  playback: WavPlaybackControls;
  onPathChange: (path: string) => void;
  onAdd: (path: string) => Promise<boolean>;
  onAddMany: (paths: string[]) => Promise<boolean>;
  onSelect: (id: string) => void;
  onRevise: (id: string, patch: Partial<UtteranceItem>) => boolean;
  canApplyToAll: boolean;
  onApplyToAll: () => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onReorder: (from: string, to: string, after: boolean) => void;
  onRemove: (id: string) => void;
};

export default function UtteranceList({
  items, presets, presetStatus, selectedId, pendingPath, addingCount, addError, disabled,
  exportingId, playback, onPathChange, onAdd, onAddMany, onSelect, onRevise,
  onMove, onReorder, onRemove, canApplyToAll, onApplyToAll,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const orderingLocked = disabled || !!exportingId || addingCount > 0;
  // A drag may begin before export. Invalidate it as soon as editing locks.
  useEffect(() => {
    if (orderingLocked) {
      setDragging(null);
      setHover(null);
    }
  }, [orderingLocked]);
  return <section className="panel utterance-list-panel" aria-label="セリフ一覧">
    <div className="utterance-list-header">
      <h2>WAV一覧</h2>
      <div className="utterance-list-toolbar">
        <span className="meta">{items.length}件</span>
        <button type="button" disabled={items.length === 0}
          onClick={playback.playAll}>全件を連続再生</button>
        <button type="button" disabled={!playback.activeId}
          onClick={playback.stop}>停止</button>
        {items.length > 1 && <button type="button" disabled={!canApplyToAll}
          onClick={onApplyToAll}>選択中の設定を全件に適用</button>}
      </div>
    </div>
    <NativeFilePicker id="speech-wav-path" kind="wav" label="WAVファイルを追加"
      value={pendingPath} disabled={disabled} multiple
      onSelectedMany={onAddMany}
      onChange={onPathChange}
      onSelected={onAdd}
      onApply={async () => { await onAdd(pendingPath); }} applyLabel="WAVを確認" />
    <p className="hint">FinderではCommand/Shiftで複数選択できます。左端で並べ替え、各行で試聴・プリセット・口パクを設定します。元WAVは変更しません。</p>
    {addingCount > 0 && <p className="hint" role="status">WAVを解析中…（{addingCount}件）</p>}
    {addError && <p className="hint warning" role="alert">{addError}</p>}
    {items.length === 0 ? <p className="empty-state">WAVを追加してください。</p> : <>
      <div className="utterance-list-columns" aria-hidden="true">
        <span className="utterance-column-name">WAV</span>
        <span className="utterance-column-preset">プリセット</span>
        <span className="utterance-column-mode">口パク</span>
      </div>
      <ol className="utterance-items" aria-label="登録済みセリフ">
        {items.map((item, index) => {
          const name = wavFilename(item.wavPath);
          // Keep the saved ID stable, including while the preset snapshot is reloading.
          const presetFound = presets.some((entry) => entry.id === item.presetId);
          return <li className="utterance-item" data-utterance-id={item.id}
            data-selected={item.id === selectedId} data-playing={playback.activeId === item.id}
            data-drop-target={hover === item.id}
            key={item.id}
            onDragOver={(event) => {
              if (!orderingLocked && dragging && dragging !== item.id) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (hover !== item.id) setHover(item.id);
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!orderingLocked && dragging && dragging !== item.id) {
                const rect = event.currentTarget.getBoundingClientRect();
                onReorder(dragging, item.id, event.clientY > rect.top + rect.height / 2);
              }
              setDragging(null); setHover(null);
            }}>
            <button type="button" className="utterance-drag-handle"
              draggable={!orderingLocked}
              aria-label={`ドラッグで移動: ${index + 1} ${name}`} title="ドラッグして順序変更"
              disabled={orderingLocked}
              onDragStart={(event) => {
                if (orderingLocked) { event.preventDefault(); return; }
                setDragging(item.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.id);
              }}
              onDragEnd={() => { setDragging(null); setHover(null); }}>⠿</button>
            <button type="button" className="utterance-item-play"
              aria-label={`${playback.activeId === item.id && playback.loading ? "読み込み中止" :
                playback.activeId === item.id && !playback.paused ? "一時停止" : "再生"}: ${index + 1} ${name}`}
              aria-pressed={playback.activeId === item.id && !playback.paused && !playback.loading}
              onClick={() => { onSelect(item.id); playback.toggleItem(item.id); }}>
              {playback.activeId === item.id && playback.loading ? "■" :
                playback.activeId === item.id && !playback.paused ? "Ⅱ" : "▶"}
            </button>
            <button type="button" className="utterance-item-select"
              aria-current={item.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(item.id)}>
              <span className="utterance-item-index">{index + 1}</span>
              <span className="utterance-item-details">
                <strong title={item.wavPath}>{name}</strong>
                <small title={item.wavPath}>{item.wavPath}</small>
                <small>{item.wav.duration_seconds.toFixed(2)}秒 ／ {item.wav.sample_rate}Hz
                  {item.result ? " ／ 書き出し済み" : item.error ? " ／ 書き出し失敗" : ""}
                </small>
              </span>
            </button>
            <label className="utterance-row-field utterance-row-preset">
              <span className="utterance-row-field-label">プリセット</span>
              <select aria-label={`プリセット: ${index + 1} ${name}`} value={item.presetId}
                disabled={disabled} onChange={(event) => {
                  if (onRevise(item.id, { presetId: event.target.value })) onSelect(item.id);
                }}>
                {!presetFound && <option value={item.presetId} disabled>
                  {presetStatus === "loading" ? "確認中…" :
                    presetStatus === "error" ? "プリセットを確認できません" :
                      "未設定（要再選択）"}
                </option>}
                {presets.map((entry) =>
                  <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
            </label>
            <label className="utterance-row-field utterance-row-mode">
              <span className="utterance-row-field-label">口パク</span>
              <select aria-label={`口パク: ${index + 1} ${name}`} value={item.mode}
                disabled={disabled} onChange={(event) => {
                  if (onRevise(item.id, { mode: event.target.value as LipMode })) onSelect(item.id);
                }}>
                <option value="none">なし</option>
                <option value="open">open</option>
              </select>
            </label>
            <div className="utterance-item-actions">
              <button type="button" aria-label={`上へ: ${index + 1} ${name}`}
                disabled={disabled || !!exportingId || addingCount > 0 || index === 0} onClick={() => onMove(item.id, -1)}>↑</button>
              <button type="button" aria-label={`下へ: ${index + 1} ${name}`}
                disabled={disabled || !!exportingId || addingCount > 0 || index === items.length - 1} onClick={() => onMove(item.id, 1)}>↓</button>
              <button type="button" aria-label={`削除: ${index + 1} ${name}`}
                disabled={disabled || !!exportingId || addingCount > 0} onClick={() => onRemove(item.id)}>削除</button>
            </div>
            {playback.activeId === item.id &&
              <div className="utterance-row-progress">
                {playback.loading ? <span className="utterance-loading-label">
                  読み込み中止（■を押す）
                </span> : <>
                  <input type="range" aria-label={`再生位置: ${name}`}
                    min={0} max={Math.max(0.01, item.wav.duration_seconds)} step="0.01"
                    value={Math.min(playback.elapsed, item.wav.duration_seconds)}
                    onChange={(event) => playback.seek(Number(event.target.value))} />
                  <span className="meta">{playback.elapsed.toFixed(1)} / {item.wav.duration_seconds.toFixed(1)}秒</span>
                </>}
              </div>}
          </li>;
        })}
      </ol></>}
    {playback.audioElement}
    {playback.status && <p className="hint utterance-audio-status" role="status">{playback.status}</p>}
  </section>;
}
