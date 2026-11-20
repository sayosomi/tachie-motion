import { useEffect, useState, type KeyboardEvent } from "react";
import PresetPicker from "./PresetPicker";
import {
  sampleFromPercent, sampleFromSeconds, validEditSample,
} from "./presetPosition";
import type { PresetChangePoint } from "./presetChangePoints";
import type { UnifiedPreset } from "./presetModel";

type PresetOption = Pick<UnifiedPreset, "id" | "name" | "thumbnail">;

// Display fewer digits without rounding the saved PCM sample position.
function secondsLabel(sample: number, rate: number): string {
  return Number((sample / rate).toFixed(6)).toString();
}
function percentLabel(sample: number, samples: number): string {
  return Number((sample / samples * 100).toFixed(3)).toString();
}

/** A change point is edited in its own list row, without a separate form. */
export default function PresetPointRow({
  point, samples, sampleRate, presets, presetImages,
  disabled, selected, onSelect, onMove, onChoose, onRemove,
}: {
  point: PresetChangePoint;
  samples: number;
  sampleRate: number;
  presets: PresetOption[];
  presetImages: Record<string, string>;
  disabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onMove: (newSample: number) => boolean;
  onChoose: (id: string) => boolean;
  onRemove: () => void;
}) {
  const [secondsText, setSecondsText] = useState(() => secondsLabel(point.sample, sampleRate));
  const [percentText, setPercentText] = useState(() => percentLabel(point.sample, samples));
  const [draftSample, setDraftSample] = useState(point.sample);
  const [valid, setValid] = useState(true);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setSecondsText(secondsLabel(point.sample, sampleRate));
    setPercentText(percentLabel(point.sample, samples));
    setDraftSample(point.sample);
    setValid(true);
  }, [point.sample, sampleRate, samples, dirty]);

  function reset() {
    setSecondsText(secondsLabel(point.sample, sampleRate));
    setPercentText(percentLabel(point.sample, samples));
    setDraftSample(point.sample);
    setValid(true);
    setDirty(false);
  }

  function updateSeconds(raw: string) {
    setSecondsText(raw);
    setDirty(true);
    const value = Number(raw);
    const sample = sampleFromSeconds(value, sampleRate);
    const ok = raw.trim() !== "" && Number.isFinite(value) &&
      value > 0 && value < samples / sampleRate && validEditSample(sample, samples);
    setValid(ok);
    if (ok) {
      setDraftSample(sample);
      setPercentText(percentLabel(sample, samples));
    }
  }

  function updatePercent(raw: string) {
    setPercentText(raw);
    setDirty(true);
    const value = Number(raw);
    const sample = sampleFromPercent(value, samples);
    const ok = raw.trim() !== "" && Number.isFinite(value) && value > 0 &&
      value < 100 && validEditSample(sample, samples);
    setValid(ok);
    if (ok) {
      setDraftSample(sample);
      setSecondsText(secondsLabel(sample, sampleRate));
    }
  }

  function commit() {
    if (!dirty) return;
    if (!valid) { reset(); return; }
    if (draftSample !== point.sample && !onMove(draftSample)) {
      reset();
    } else {
      setDirty(false);
    }
  }

  function inputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur(); // Commit on blur; never on a partial number.
    } else if (event.key === "Escape") {
      event.preventDefault();
      reset();
      event.currentTarget.blur();
    }
  }

  return <li className="preset-change-point" data-edit-point={point.sample}
    data-selected={selected}>
    <input type="number" min={0} max={samples / sampleRate} step="any"
      aria-label="編集点の時刻（秒）" aria-invalid={!valid}
      title="秒数。Enterまたはフォーカスを外すと確定"
      disabled={disabled} value={secondsText} onFocus={onSelect}
      onChange={(event) => updateSeconds(event.target.value)}
      onKeyDown={inputKeyDown} onBlur={commit} />
    <input type="number" min={0} max={100} step="any"
      aria-label="編集点の位置（%）" aria-invalid={!valid}
      title="割合。Enterまたはフォーカスを外すと確定"
      disabled={disabled} value={percentText} onFocus={onSelect}
      onChange={(event) => updatePercent(event.target.value)}
      onKeyDown={inputKeyDown} onBlur={commit} />
    <PresetPicker presets={presets} imageMap={presetImages}
      selectedId={point.presetId} status="ready" disabled={disabled}
      label={(point.sample / sampleRate).toFixed(3) + "秒のプリセット"}
      onChoose={onChoose} />
    <button type="button" className="preset-change-remove" disabled={disabled}
      title="編集点を削除" aria-label="編集点を削除" onClick={onRemove}>×</button>
  </li>;
}
