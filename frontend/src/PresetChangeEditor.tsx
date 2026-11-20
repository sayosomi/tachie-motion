import { useEffect, useState } from "react";
import {
  addPresetChangePoint, movePresetChangePoint, removePresetChangePoint,
  replacePresetChangePoint,
} from "./presetChangePoints";
import type { UtteranceItem } from "./utteranceItems";
import type { WavPlaybackControls } from "./WavPlayback";
import WavWaveform from "./WavWaveform";
import type { UnifiedPreset } from "./presetModel";

type PresetOption = Pick<UnifiedPreset, "id" | "name">;

export default function PresetChangeEditor({
  item, presets, playback, disabled, onRevise,
}: {
  item: UtteranceItem;
  presets: PresetOption[];
  playback: WavPlaybackControls;
  disabled: boolean;
  onRevise: (id: string, patch: Partial<UtteranceItem>) => boolean;
}) {
  const [cursorSample, setCursorSample] = useState(0);
  const [positionText, setPositionText] = useState("0");
  const [positionFocused, setPositionFocused] = useState(false);
  const [newPresetId, setNewPresetId] = useState(item.presetId);
  const [error, setError] = useState("");
  const active = playback.activeId === item.id;
  const { samples, sample_rate: sampleRate, duration_seconds: duration } = item.wav;
  const points = item.presetChanges ?? [];
  const ids = new Set(presets.map((preset) => preset.id));
  useEffect(() => {
    if (active && !playback.loading) {
      setCursorSample(Math.min(samples - 1, Math.max(0, Math.round(playback.elapsed * sampleRate))));
    }
  }, [active, playback.loading, playback.elapsed, samples, sampleRate]);
  useEffect(() => {
    if (!ids.has(newPresetId)) setNewPresetId(item.presetId);
  }, [presets, newPresetId, item.presetId]);

  const toSample = (seconds: number) =>
    Math.min(samples - 1, Math.max(0, Math.round(seconds * sampleRate)));
  const seek = (seconds: number) => {
    setCursorSample(toSample(seconds));
    if (active && !playback.loading) playback.seek(seconds);
  };
  function edit(action: () => NonNullable<UtteranceItem["presetChanges"]>) {
    if (disabled) return;
    try {
      const result = action();
      if (onRevise(item.id, { presetChanges: result })) setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function add() {
    const seconds = Number(positionText);
    const sample = positionText.trim() && Number.isFinite(seconds)
      ? Math.round(seconds * sampleRate) : 0;
    edit(() => addPresetChangePoint(points, sample, newPresetId, samples, ids));
  }
  const format = (sample: number) => (sample / sampleRate).toFixed(3);
  const precise = (sample: number) => (sample / sampleRate).toFixed(9);
  useEffect(() => {
    if (!positionFocused) setPositionText(Number(precise(cursorSample)).toString());
  }, [cursorSample, sampleRate, positionFocused]);
  const editSample = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= duration) {
      throw new Error("変更点はWAV開始より後、終了より前に指定してください");
    }
    return Math.round(seconds * sampleRate);
  };

  return <section className="preset-change-editor" aria-label="プリセット変更点">
    <div className="preset-change-heading">
      <strong>プリセット変更点</strong>
      <span className="meta">時刻を指定して変更点を追加（初期プリセットは0秒）</span>
    </div>
    <WavWaveform
      name={item.wavPath} disabled={disabled || playback.loading}
      elapsed={cursorSample / sampleRate} duration={duration}
      peaks={active ? playback.waveform?.sourceId === item.id
        ? playback.waveform.peaks : null : null}
      markers={points.map((point) => ({ sample: point.sample, seconds: point.sample / sampleRate }))}
      onMoveMarker={(oldSample, seconds) => edit(() =>
        movePresetChangePoint(points, oldSample, editSample(seconds), samples, ids))}
      onSeek={seek} />
    <div className="preset-change-add">
      <label>位置（秒）
        <input aria-label="変更点の追加位置（秒）" type="number" min={0}
          max={duration} step="any" disabled={disabled}
          value={positionText} onFocus={() => setPositionFocused(true)}
          onBlur={() => setPositionFocused(false)}
          onChange={(event) => {
            const next = event.target.value;
            setPositionText(next);
            const seconds = Number(next);
            if (next.trim() && Number.isFinite(seconds) &&
                seconds >= 0 && seconds <= duration) {
              setCursorSample(toSample(seconds));
              if (active && !playback.loading) playback.seek(seconds);
            }
          }} />
      </label>
      <label>変更先
        <select aria-label="追加するプリセット" disabled={disabled} value={newPresetId}
          onChange={(event) => setNewPresetId(event.target.value)}>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>
            {preset.name}</option>)}
        </select>
      </label>
      <button type="button" onClick={add} disabled={disabled ||
        !positionText.trim() || !Number.isFinite(Number(positionText)) ||
        Number(positionText) <= 0 || Number(positionText) >= duration ||
        !ids.has(newPresetId)}>現在位置に変更点を追加</button>
    </div>
    {error && <p role="alert" className="hint warning">{error}</p>}
    {points.length ? <ol className="preset-change-points" aria-label="登録済み変更点">
      {points.map((point) => <li key={point.sample}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("seconds");
          const seconds = Number(value);
          if (!Number.isFinite(seconds)) { setError("時刻が不正です"); return; }
          edit(() => movePresetChangePoint(points, point.sample,
            editSample(seconds), samples, ids));
        }}>
          <button type="button" onClick={() => seek(point.sample / sampleRate)}
            disabled={playback.loading} aria-label={format(point.sample) + "秒に移動"}>
            位置へ
          </button>
          <input name="seconds" aria-label="変更点の時刻（秒）" type="number"
            key={point.sample} defaultValue={precise(point.sample)} min={0}
            max={duration} step="any" disabled={disabled} required />
          <button type="submit" disabled={disabled}>時刻を更新</button>
        </form>
        <select aria-label={format(point.sample) + "秒のプリセット"}
          value={point.presetId} disabled={disabled}
          onChange={(event) => edit(() => replacePresetChangePoint(points,
            point.sample, event.target.value, samples, ids))}>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>
            {preset.name}</option>)}
        </select>
        <button type="button" disabled={disabled} onClick={() => edit(() =>
          removePresetChangePoint(points, point.sample, samples, ids))}>削除</button>
      </li>)}
    </ol> : <p className="hint">変更点はありません。最初のプリセットがWAVの最後まで続きます。</p>}
  </section>;
}
