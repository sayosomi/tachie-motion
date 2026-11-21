import { useEffect, useRef, useState, type ReactNode } from "react";
import NativeFilePicker from "./NativeFilePicker";
import PresetPicker from "./PresetPicker";
import type { WavPlaybackControls } from "./WavPlayback";
import WavWaveform from "./WavWaveform";
import PresetChangeEditor from "./PresetChangeEditor";
import type { LabInfo } from "./useLabStatus";
import type { UnifiedPreset } from "./presetModel";
import { wavFilename, type LipMode, type UtteranceItem } from "./utteranceItems";

type Props = {
  projectControls?: ReactNode;
  items: UtteranceItem[];
  labStatuses: Record<string, LabInfo>;
  onRecheckLabs: () => void;
  presets: Pick<UnifiedPreset, "id" | "name" | "thumbnail">[];
  presetImages: Record<string, string>;
  presetStatus: "loading" | "ready" | "error";
  selectedId: string | null;
  pendingPath: string;
  addingCount: number;
  addError: string;
  disabled: boolean;
  selectionLocked: boolean;
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
  projectControls, items, labStatuses, onRecheckLabs, presets, presetImages, presetStatus, selectedId, pendingPath, addingCount, addError, disabled,
  selectionLocked, exportingId, playback, onPathChange, onAdd, onAddMany, onSelect, onRevise,
  onMove, onReorder, onRemove, canApplyToAll, onApplyToAll,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const seekPositions = useRef<Record<string, number>>({});
  const orderingLocked = disabled || !!exportingId || addingCount > 0;
  // Only the selected WAV can own the expanded editor. Another selection reopens it.
  useEffect(() => { setCollapsedId(null); }, [selectedId]);
  // Space toggles playback of the selected WAV. Keep native Space behavior for
  // text editing, dropdowns, ordinary buttons and modal/export UI.
  useEffect(() => {
    function onSpace(event: KeyboardEvent) {
      if ((event.code !== "Space" && event.key !== " ") || event.defaultPrevented ||
          event.repeat || event.isComposing || event.altKey || event.ctrlKey ||
          event.metaKey || event.shiftKey || !selectedId || disabled ||
          selectionLocked || exportingId || addingCount > 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]')) return;
      // Selecting a WAV leaves its row-selection button focused: Space should
      // start playback rather than redundantly reselecting the WAV.
      if (target.closest('button, a, [role="button"]') &&
          !target.closest(".utterance-item-select")) return;
      if (document.querySelector('[aria-modal="true"], dialog[open], .export-progress-backdrop')) return;
      event.preventDefault();
      playback.toggleItem(selectedId, seekPositions.current[selectedId]);
    }
    document.addEventListener("keydown", onSpace);
    return () => document.removeEventListener("keydown", onSpace);
  }, [selectedId, disabled, selectionLocked, exportingId, addingCount, playback]);
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
        <button type="button" disabled={disabled || selectionLocked || items.length === 0 ||
          !!exportingId || addingCount > 0} onClick={onRecheckLabs}>
          LABを再確認
        </button>
        <button type="button" disabled={selectionLocked || items.length === 0}
          onClick={playback.playAll}>全件を連続再生</button>
        <button type="button" disabled={!playback.activeId}
          onClick={playback.stop}>停止</button>
        {items.length > 1 && <button type="button" disabled={!canApplyToAll}
          onClick={onApplyToAll}>選択中の設定を全件に適用</button>}
      </div>
    </div>
    {projectControls}
    <NativeFilePicker id="speech-wav-path" kind="wav" label="WAVファイルを追加"
      value={pendingPath} disabled={disabled} multiple
      onSelectedMany={onAddMany}
      onChange={onPathChange}
      onSelected={onAdd}
      onApply={async () => { await onAdd(pendingPath); }} applyLabel="WAVを確認" />
    <p className="hint">FinderではCommand/Shiftで複数選択できます。左端で並べ替え、WAV行を選ぶとその直下で波形・編集点を操作できます。元WAVは変更しません。</p>
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
          const expanded = item.id === selectedId && collapsedId !== item.id;
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
              title="Space：選択中のWAVを再生・一時停止"
              disabled={selectionLocked}
              aria-label={`${playback.activeId === item.id && playback.loading ? "読み込み中止" :
                playback.activeId === item.id && !playback.paused ? "一時停止" : "再生"}: ${index + 1} ${name}`}
              aria-pressed={playback.activeId === item.id && !playback.paused && !playback.loading}
              onClick={() => {
                const at = item.id === selectedId ? seekPositions.current[item.id] : undefined;
                onSelect(item.id);
                playback.toggleItem(item.id, at);
              }}>
              {playback.activeId === item.id && playback.loading ? "■" :
                playback.activeId === item.id && !playback.paused ? "Ⅱ" : "▶"}
            </button>
            <button type="button" className="utterance-item-select"
              disabled={selectionLocked}
              aria-current={item.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(item.id)}>
              <span className="utterance-item-index">{index + 1}</span>
              <span className="utterance-item-details">
                <strong title={item.wavPath}>{name}</strong>
                <small title={item.wavPath}>{item.wavPath}</small>
                <small>{item.wav.duration_seconds.toFixed(2)}秒 ／ {item.wav.sample_rate}Hz
                  {item.result ? " ／ 書き出し済み" : item.error ? " ／ 書き出し失敗" : ""}
                </small>
                <small data-lab-status={labStatuses[item.id]?.status ?? "checking"}
                  title={labStatuses[item.id]?.reason ?? undefined}>
                  {labStatuses[item.id]?.status === "valid" ? "LAB: 有効"
                    : labStatuses[item.id]?.status === "missing" ? "LAB: なし"
                    : labStatuses[item.id]?.status === "invalid" ? "LAB: 不正"
                    : labStatuses[item.id]?.status === "unavailable"
                      ? (labStatuses[item.id]?.reason ? "LAB: 確認失敗" : "LAB: 未確認")
                    : "LAB: 確認中…"}
                </small>
              </span>
            </button>
            <div className="utterance-row-field utterance-row-preset">
              <span className="utterance-row-field-label">プリセット</span>
              <PresetPicker presets={presets} imageMap={presetImages}
                selectedId={item.presetId} status={presetStatus}
                disabled={disabled} label={`プリセット: ${index + 1} ${name}`}
                onChoose={(id) => {
                  const changed = onRevise(item.id, { presetId: id });
                  if (changed) onSelect(item.id);
                  return changed;
                }} />
            </div>
            <label className="utterance-row-field utterance-row-mode">
              <span className="utterance-row-field-label">口パク</span>
              <select aria-label={`口パク: ${index + 1} ${name}`} value={item.mode}
                disabled={disabled} onChange={(event) => {
                  if (onRevise(item.id, { mode: event.target.value as LipMode })) onSelect(item.id);
                }}>
                <option value="none">なし</option>
                <option value="open">open</option>
                <option value="aiueo"
                  disabled={labStatuses[item.id]?.status !== "valid"}>
                  aiueo{labStatuses[item.id]?.status === "valid" ? "" : "（有効なLABが必要）"}
                </option>
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
            {item.id === selectedId && <button type="button"
              className="utterance-item-edit-toggle" aria-expanded={expanded}
              aria-label={expanded ? "プリセット編集を閉じる: " + name : "プリセット編集を開く: " + name}
              onClick={() => setCollapsedId(expanded ? item.id : null)}>
              {expanded ? "▾ プリセット編集を閉じる" : "▸ プリセット編集を開く"}
              <span className="meta">編集点 {(item.presetChanges ?? []).length}件</span>
            </button>}
            {expanded && <div className="utterance-item-editor">
              <PresetChangeEditor key={item.id} item={item}
                presets={presets} presetImages={presetImages}
                playback={playback} disabled={disabled} onRevise={onRevise}
                onCursorChange={(seconds) => { seekPositions.current[item.id] = seconds; }} />
            </div>}
            {playback.activeId === item.id && !expanded &&
              <div className="utterance-row-progress">
                {playback.loading ? <span className="utterance-loading-label">
                  読み込み中止（■を押す）
                </span> : <>
                  <WavWaveform name={name}
                    disabled={selectionLocked} elapsed={playback.elapsed}
                    duration={item.wav.duration_seconds}
                    peaks={playback.waveform?.sourceId === item.id ? playback.waveform.peaks : null}
                    onSeek={playback.seek} />
                  <span className="meta">{playback.elapsed.toFixed(1)} / {item.wav.duration_seconds.toFixed(1)}秒</span>
                </>}
              </div>}
          </li>;
        })}
      </ol>
    </>}
    {playback.audioElement}
    {playback.status.startsWith("音声の再生に失敗") &&
      <p className="hint warning utterance-audio-status" role="alert">{playback.status}</p>}
  </section>;
}
