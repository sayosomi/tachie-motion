import { useEffect, useRef, useState } from "react";
import PresetPicker from "./PresetPicker";
import PresetPointRow from "./PresetPointRow";
import PresetThumbnail from "./PresetThumbnail";
import {
  addPresetChangePoint, movePresetChangePoint, removePresetChangePoint,
  replacePresetChangePoint, presetAtSample,
} from "./presetChangePoints";
import {
  percentFromSample, sampleFromPercent, sampleFromSeconds,
  secondsFromSample, validEditSample,
} from "./presetPosition";
import { wavFilename, type UtteranceItem } from "./utteranceItems";
import type { WavPlaybackControls } from "./WavPlayback";
import WavWaveform from "./WavWaveform";
import useEditorWaveform from "./useEditorWaveform";
import type { UnifiedPreset } from "./presetModel";

type PresetOption = Pick<UnifiedPreset, "id" | "name" | "thumbnail">;

export default function PresetChangeEditor({
  item, presets, presetImages, playback, disabled, onRevise,
}: {
  item: UtteranceItem;
  presets: PresetOption[];
  presetImages: Record<string, string>;
  playback: WavPlaybackControls;
  disabled: boolean;
  onRevise: (id: string, patch: Partial<UtteranceItem>) => boolean;
}) {
  const [cursorSample, setCursorSample] = useState(0);
  const [positionText, setPositionText] = useState("0");
  const [percentText, setPercentText] = useState("0");
  const [newPresetId, setNewPresetId] = useState(item.presetId);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [error, setError] = useState("");
  const positionEditing = useRef(false);
  const positionDirty = useRef(false);
  const { samples, sample_rate: sampleRate } = item.wav;
  const duration = samples / sampleRate;
  const active = playback.activeId === item.id;
  const { peaks, unavailable } = useEditorWaveform(item, playback);
  const points = item.presetChanges ?? [];
  const ids = new Set(presets.map((preset) => preset.id));
  const effectivePresetId = presetAtSample(item.presetId, points, cursorSample);
  const effectivePresetName = presets.find((value) => value.id === effectivePresetId)?.name
    ?? "参照先のないプリセット";
  const initialPreset = presets.find((value) => value.id === item.presetId);

  useEffect(() => {
    if (!active || playback.loading || positionEditing.current || positionDirty.current) return;
    const sample = Math.min(samples - 1,
      Math.max(0, Math.round(playback.elapsed * sampleRate)));
    setCursorSample(sample);
    setPositionText(secondsFromSample(sample, sampleRate));
    setPercentText(percentFromSample(sample, samples));
  }, [active, playback.loading, playback.elapsed, samples, sampleRate]);

  useEffect(() => {
    if (!ids.has(newPresetId)) setNewPresetId(item.presetId);
  }, [presets, newPresetId, item.presetId]);

  const clampSample = (sample: number) =>
    Math.min(samples - 1, Math.max(0, sample));
  const format = (sample: number) => (sample / sampleRate).toFixed(3);

  function seek(seconds: number) {
    const sample = clampSample(sampleFromSeconds(seconds, sampleRate));
    setCursorSample(sample);
    setPositionText(secondsFromSample(sample, sampleRate));
    setPercentText(percentFromSample(sample, samples));
    positionDirty.current = false;
    if (active && !playback.loading) playback.seek(seconds);
  }

  function changeSeconds(raw: string) {
    positionDirty.current = true;
    setPositionText(raw);
    const seconds = Number(raw);
    if (raw.trim() && Number.isFinite(seconds) && seconds >= 0 && seconds <= duration) {
      const sample = clampSample(sampleFromSeconds(seconds, sampleRate));
      setCursorSample(sample);
      setPercentText(percentFromSample(sample, samples));
      if (active && !playback.loading) playback.seek(seconds);
    }
  }

  function changePercent(raw: string) {
    positionDirty.current = true;
    setPercentText(raw);
    const percent = Number(raw);
    if (raw.trim() && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      const sample = clampSample(sampleFromPercent(percent, samples));
      setCursorSample(sample);
      setPositionText(secondsFromSample(sample, sampleRate));
      if (active && !playback.loading) playback.seek(sample / sampleRate);
    }
  }

  function edit(action: () => NonNullable<UtteranceItem["presetChanges"]>): boolean {
    if (disabled) return false;
    try {
      const result = action();
      if (!onRevise(item.id, { presetChanges: result })) return false;
      setError("");
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message.replaceAll("プリセット変更点", "編集点").replaceAll("変更点", "編集点"));
      return false;
    }
  }

  function add() {
    const seconds = Number(positionText);
    if (!positionText.trim() || !Number.isFinite(seconds)) return;
    const sample = sampleFromSeconds(seconds, sampleRate);
    if (edit(() => addPresetChangePoint(points, sample, newPresetId, samples, ids))) {
      setSelectedPoint(sample);
    }
  }

  function selectPoint(sample: number) {
    setSelectedPoint(sample);
    seek(sample / sampleRate);
  }

  const seconds = Number(positionText);
  const percent = Number(percentText);
  const addSample = sampleFromSeconds(seconds, sampleRate);
  const canAdd = !!positionText.trim() && !!percentText.trim() &&
    Number.isFinite(seconds) && Number.isFinite(percent) &&
    seconds > 0 && seconds < duration && percent > 0 && percent < 100 &&
    validEditSample(addSample, samples) && ids.has(newPresetId);
  return <section className="preset-change-editor" aria-label={wavFilename(item.wavPath) + " のプリセット編集"}>
    <div className="preset-change-heading">
      <strong>プリセットの切替</strong>
      <span className="meta">{wavFilename(item.wavPath)}</span>
    </div>
    <p className="hint preset-change-active">編集位置のプリセット：
      <strong>{effectivePresetName}</strong>（{format(cursorSample)}秒）
    </p>
    <WavWaveform name={wavFilename(item.wavPath)}
      disabled={disabled || playback.loading}
      elapsed={cursorSample / sampleRate} duration={duration}
      peaks={peaks}
      markers={points.map((point) => ({
        sample: point.sample, seconds: point.sample / sampleRate,
      }))}
      onSelectMarker={selectPoint}
      onMoveMarker={(oldSample, seconds) => {
        const sample = sampleFromSeconds(seconds, sampleRate);
        if (sample === oldSample) { selectPoint(oldSample); return; }
        if (edit(() => movePresetChangePoint(points, oldSample, sample, samples, ids))) {
          selectPoint(sample);
        }
      }}
      onSeek={seek} />
    <div className="preset-change-ticks" aria-hidden="true">
      <span>0秒</span><span>{(duration / 2).toFixed(2)}秒</span>
      <span>{duration.toFixed(2)}秒</span>
    </div>
    {unavailable && <p className="hint">波形を表示できません。下のスライダー・秒数・割合で編集できます。</p>}
    <p className="hint preset-change-legend">波形をクリックして位置を指定。編集点はドラッグで移動、クリックで選択できます。</p>
    <div className="preset-change-add">
      <label>位置（秒）
        <input aria-label="編集点の追加位置（秒）" type="number" min={0}
          max={duration} step="any" disabled={disabled} value={positionText}
          onFocus={() => { positionEditing.current = true; }}
          onBlur={() => { positionEditing.current = false; }}
          onChange={(event) => changeSeconds(event.target.value)} />
      </label>
      <label>位置（割合 %）
        <input aria-label="編集点の追加位置（%）" type="number" min={0}
          max={100} step="any" disabled={disabled} value={percentText}
          onFocus={() => { positionEditing.current = true; }}
          onBlur={() => { positionEditing.current = false; }}
          onChange={(event) => changePercent(event.target.value)} />
      </label>
      <div className="preset-change-add-preset">
        <span>切替先プリセット</span>
        <PresetPicker presets={presets} imageMap={presetImages}
          selectedId={newPresetId} status="ready" disabled={disabled}
          label="追加するプリセット" onChoose={(id) => {
            setNewPresetId(id);
            return true;
          }} />
      </div>
      <button type="button" onClick={add} disabled={disabled || !canAdd}>編集点を追加</button>
    </div>
    {error && <p role="alert" className="hint warning">{error}</p>}
    <div className="preset-change-point-heading"><strong>編集点一覧</strong>
      <span className="meta">{points.length}件</span></div>
    <div className="preset-change-initial">
      <span className="meta">0.000秒 / 0%（初期）</span>
      <PresetThumbnail className="preset-picker-thumb"
        image={initialPreset && presetImages[initialPreset.id]}
        view={initialPreset?.thumbnail} alt="初期プリセットのサムネイル" fallback="画像待ち" />
      <span>{initialPreset?.name ?? "参照先のないプリセット"}</span>
    </div>
    {points.length ? <ol className="preset-change-points" aria-label="登録済み編集点">
      {points.map((point) => <PresetPointRow key={point.sample}
        point={point} samples={samples} sampleRate={sampleRate}
        presets={presets} presetImages={presetImages} presetStatus="ready"
        disabled={disabled} selected={selectedPoint === point.sample}
        onSelect={() => selectPoint(point.sample)}
        onMove={(sample) => {
          const ok = edit(() => movePresetChangePoint(points,
            point.sample, sample, samples, ids));
          if (ok) selectPoint(sample);
          return ok;
        }}
        onChoose={(id) => edit(() => replacePresetChangePoint(points,
          point.sample, id, samples, ids))}
        onRemove={() => {
          if (edit(() => removePresetChangePoint(points, point.sample, samples, ids))) {
            if (selectedPoint === point.sample) setSelectedPoint(null);
          }
        }} />)}
    </ol> : <p className="hint">編集点はありません。初期プリセットがWAVの最後まで続きます。</p>}
  </section>;
}
