import { useRef, type PointerEvent } from "react";

type Marker = { sample: number; seconds: number };
type Props = {
  peaks: number[] | null;
  name: string;
  elapsed: number;
  duration: number;
  disabled: boolean;
  markers?: Marker[];
  onMoveMarker?: (sample: number, seconds: number) => void;
  onSeek: (seconds: number) => void;
};

function waveformStrokes(peaks: number[]): string {
  return peaks.map((value, index) => {
    const height = Math.max(1, Math.round(Math.min(1, Math.max(0, value)) * 25));
    return `M${index * 2 + 1} ${28 - height}V${28 + height}`;
  }).join(" ");
}

export default function WavWaveform({
  peaks, name, elapsed, duration, disabled, markers, onSeek, onMoveMarker,
}: Props) {
  const dragging = useRef<number | null>(null);
  function secondsAt(event: PointerEvent<HTMLDivElement>): number | null {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || duration <= 0) return null;
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration;
  }
  function seekAt(event: PointerEvent<HTMLDivElement>) {
    const seconds = secondsAt(event);
    if (!disabled && seconds !== null) onSeek(seconds);
  }
  const progress = duration ? Math.min(1, Math.max(0, elapsed / duration)) : 0;
  return <div className="wav-timeline">
    {(peaks || markers?.length) ? <div className="wav-waveform"
      title="クリックで再生位置を移動・変更点をドラッグで移動"
      onPointerDown={(event) => {
        if (disabled) return;
        const target = event.target as Element;
        const marker = target.closest("[data-change-marker]");
        dragging.current = marker ? Number(marker.getAttribute("data-change-marker")) : null;
        event.currentTarget.setPointerCapture(event.pointerId);
        if (dragging.current === null) seekAt(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId) &&
            dragging.current === null) seekAt(event);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const from = dragging.current;
        dragging.current = null;
        if (from !== null) {
          const to = secondsAt(event);
          if (to !== null && onMoveMarker) onMoveMarker(from, to);
        } else seekAt(event);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        dragging.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}>
      <svg viewBox="0 0 360 56" preserveAspectRatio="none" aria-hidden="true">
        {peaks && <path d={waveformStrokes(peaks)} />}
        {markers?.map((marker) => <line key={marker.sample}
          data-change-marker={marker.sample}
          x1={marker.seconds / duration * 360} x2={marker.seconds / duration * 360}
          y1="0" y2="56" stroke="currentColor" strokeWidth="6"
          className="preset-change-marker" />)}
        <line x1={progress * 360} x2={progress * 360} y1="0" y2="56" />
      </svg>
    </div> : null}
    <input type="range" aria-label={`再生位置: ${name}`} disabled={disabled}
      min={0} max={Math.max(0.01, duration)} step="0.01"
      value={Math.min(elapsed, duration)}
      onChange={(event) => onSeek(Number(event.target.value))} />
  </div>;
}
