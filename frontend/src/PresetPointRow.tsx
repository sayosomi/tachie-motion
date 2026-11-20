import { useState } from "react";
import PresetPicker from "./PresetPicker";
import {
  percentFromSample, sampleFromPercent, sampleFromSeconds,
  secondsFromSample, validEditSample,
} from "./presetPosition";
import type { PresetChangePoint } from "./presetChangePoints";
import type { UnifiedPreset } from "./presetModel";

type PresetOption = Pick<UnifiedPreset, "id" | "name" | "thumbnail">;

export default function PresetPointRow({
  point, samples, sampleRate, presets, presetImages, presetStatus,
  disabled, selected, onSelect, onMove, onChoose, onRemove,
}: {
  point: PresetChangePoint;
  samples: number;
  sampleRate: number;
  presets: PresetOption[];
  presetImages: Record<string, string>;
  presetStatus: "loading" | "ready" | "error";
  disabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onMove: (newSample: number) => boolean;
  onChoose: (id: string) => boolean;
  onRemove: () => void;
}) {
  const [secondsText, setSecondsText] = useState(secondsFromSample(point.sample, sampleRate));
  const [percentText, setPercentText] = useState(percentFromSample(point.sample, samples));
  const [editedSample, setEditedSample] = useState(point.sample);
  const [valid, setValid] = useState(true);

  function updateSeconds(raw: string) {
    setSecondsText(raw);
    const seconds = Number(raw);
    const sample = sampleFromSeconds(seconds, sampleRate);
    const acceptable = raw.trim() !== "" && Number.isFinite(seconds) &&
      seconds >= 0 && seconds <= samples / sampleRate &&
      validEditSample(sample, samples);
    setValid(acceptable);
    if (acceptable) {
      setEditedSample(sample);
      setPercentText(percentFromSample(sample, samples));
    }
  }
  function updatePercent(raw: string) {
    setPercentText(raw);
    const percent = Number(raw);
    const sample = sampleFromPercent(percent, samples);
    const acceptable = raw.trim() !== "" && Number.isFinite(percent) &&
      percent >= 0 && percent <= 100 && validEditSample(sample, samples);
    setValid(acceptable);
    if (acceptable) {
      setEditedSample(sample);
      setSecondsText(secondsFromSample(sample, sampleRate));
    }
  }
  return <li className="preset-change-point" data-edit-point={point.sample}
      data-selected={selected}>
    <button type="button" className="preset-point-seek" onClick={onSelect}
      aria-label={((point.sample / sampleRate).toFixed(3)) + "秒の編集点を選択"}>
      {(point.sample / sampleRate).toFixed(3)}秒
    </button>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid) onMove(editedSample);
    }}>
      <label>秒
        <input type="number" aria-label="編集点の時刻（秒）" min={0}
          max={samples / sampleRate} step="any" disabled={disabled}
          value={secondsText} onChange={(event) => updateSeconds(event.target.value)} />
      </label>
      <label>割合（%）
        <input type="number" aria-label="編集点の位置（%）" min={0} max={100}
          step="any" disabled={disabled} value={percentText}
          onChange={(event) => updatePercent(event.target.value)} />
      </label>
      <button type="submit" disabled={disabled || !valid}>位置を更新</button>
    </form>
    <PresetPicker presets={presets} imageMap={presetImages}
      selectedId={point.presetId} status={presetStatus}
      disabled={disabled} label={(point.sample / sampleRate).toFixed(3) + "秒のプリセット"}
      onChoose={onChoose} />
    <button type="button" disabled={disabled} onClick={onRemove}>削除</button>
  </li>;
}
