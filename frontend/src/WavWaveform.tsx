import type { PointerEvent } from "react";

type Props = {
  peaks: number[] | null;
  name: string;
  elapsed: number;
  duration: number;
  disabled: boolean;
  onSeek: (seconds: number) => void;
};

function waveformStrokes(peaks: number[]): string {
  return peaks.map((value, index) => {
    const height = Math.max(1, Math.round(Math.min(1, Math.max(0, value)) * 25));
    return `M${index * 2 + 1} ${28 - height}V${28 + height}`;
  }).join(" ");
}

export default function WavWaveform({ peaks, name, elapsed, duration, disabled, onSeek }: Props) {
  function seekAt(event: PointerEvent<HTMLDivElement>) {
    if (disabled || duration <= 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    onSeek(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration);
  }

  const progress = duration ? Math.min(1, Math.max(0, elapsed / duration)) : 0;
  return <div className="wav-timeline">
    {peaks && <div className="wav-waveform" title="クリック・ドラッグで再生位置を移動"
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        seekAt(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seekAt(event);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          seekAt(event);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}>
      <svg viewBox="0 0 360 56" preserveAspectRatio="none" aria-hidden="true">
        <path d={waveformStrokes(peaks)} />
        <line x1={progress * 360} x2={progress * 360} y1="0" y2="56" />
      </svg>
    </div>}
    <input type="range" aria-label={`再生位置: ${name}`} disabled={disabled}
      min={0} max={Math.max(0.01, duration)} step="0.01"
      value={Math.min(elapsed, duration)}
      onChange={(event) => onSeek(Number(event.target.value))} />
  </div>;
}
