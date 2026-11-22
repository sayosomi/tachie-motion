import { useEffect, useState } from "react";
import PresetPointRow from "./PresetPointRow";
import {
  addPresetChangePoint, movePresetChangePoint, removePresetChangePoint,
  replacePresetChangePoint, presetAtSample,
} from "./presetChangePoints";
import { sampleFromSeconds } from "./presetPosition";
import { wavFilename, type UtteranceItem } from "./utteranceItems";
import type { WavPlaybackControls } from "./WavPlayback";
import WavWaveform from "./WavWaveform";
import useEditorWaveform from "./useEditorWaveform";
import type { UnifiedPreset } from "./presetModel";

type PresetOption = Pick<UnifiedPreset, "id" | "name" | "thumbnail">;

/** Waveform and editable list rows share a single position and PCM sample timeline. */
export default function PresetChangeEditor({
  item, presets, presetImages, playback, disabled, onRevise, onCursorChange,
}: {
  item: UtteranceItem;
  presets: PresetOption[];
  presetImages: Record<string, string>;
  playback: WavPlaybackControls;
  disabled: boolean;
  onRevise: (id: string, patch: Partial<UtteranceItem>) => boolean;
  onCursorChange: (seconds: number) => void;
}) {
  const [cursorSample, setCursorSample] = useState(0);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [error, setError] = useState("");
  const { samples, sample_rate: sampleRate } = item.wav;
  const duration = samples / sampleRate;
  const active = playback.activeId === item.id;
  const { peaks, unavailable } = useEditorWaveform(item, playback);
  const points = item.presetChanges ?? [];
  const ids = new Set(presets.map((preset) => preset.id));
  const effectivePresetId = presetAtSample(item.presetId, points, cursorSample);

  useEffect(() => {
    if (!active || playback.loading) return;
    const sample = Math.min(samples - 1,
      Math.max(0, Math.round(playback.elapsed * sampleRate)));
    setCursorSample(sample);
  }, [active, playback.loading, playback.elapsed, samples, sampleRate]);

  function seek(seconds: number) {
    const sample = Math.min(samples - 1, Math.max(0, sampleFromSeconds(seconds, sampleRate)));
    setCursorSample(sample);
    onCursorChange(sample / sampleRate);
    setSelectedPoint(null);
    if (active && !playback.loading) playback.seek(sample / sampleRate);
  }

  function selectPoint(sample: number) {
    seek(sample / sampleRate);
    setSelectedPoint(sample);
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
    if (!canAdd) return;
    if (edit(() => addPresetChangePoint(points, cursorSample,
      effectivePresetId, samples, ids))) {
      setSelectedPoint(cursorSample);
    }
  }

  const canAdd = !disabled && cursorSample > 0 && cursorSample < samples &&
    !points.some((point) => point.sample === cursorSample) &&
    ids.has(effectivePresetId);

  return <section className="preset-change-editor"
    aria-label={wavFilename(item.wavPath) + " のプリセット編集"}>
    <WavWaveform name={wavFilename(item.wavPath)}
      disabled={disabled || playback.loading}
      elapsed={cursorSample / sampleRate} duration={duration}
      peaks={peaks} showSlider={!peaks}
      markers={peaks ? points.map((point) => ({
        sample: point.sample, seconds: point.sample / sampleRate,
      })) : []}
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
      <span>0秒</span><span>{duration.toFixed(2)}秒</span>
    </div>
    {unavailable && <p className="hint preset-change-fallback">
      波形を表示できないため、スライダーで位置を指定します。
    </p>}
    <div className="preset-change-table-heading" aria-hidden="true">
      <span>時刻（秒）</span><span>割合（%）</span><span>切替先プリセット</span><span />
    </div>
    <ol className="preset-change-points" aria-label="登録済み編集点">
      {points.map((point) => <PresetPointRow key={point.sample}
        point={point} samples={samples} sampleRate={sampleRate}
        presets={presets} presetImages={presetImages}
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
    </ol>
    <button type="button" className="preset-change-add-button"
      disabled={!canAdd} onClick={add}
      title={canAdd ? "現在の波形位置に編集点を追加" :
        "波形またはスライダーでWAVの開始・終了以外の位置を選択"}>
      ＋ 編集点を追加
    </button>
    {error && <p role="alert" className="hint warning">{error}</p>}
  </section>;
}
