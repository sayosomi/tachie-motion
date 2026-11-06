import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

type Point = { x: number; y: number };
type SelectionBox = { x: number; y: number; width: number; height: number;
  sourceWidth: number; sourceHeight: number };
type Props = {
  image?: string;
  alt: string;
  error?: string;
  focus?: Point;
  selectedFocus?: Point;
  selectedBox?: SelectionBox;
};

const LEVELS = [1, 1.5, 2, 3, 4, 6, 8];

export default function PresetImagePreview({
  image, alt, error, focus, selectedFocus, selectedBox,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: Point } | null>(null);
  const [level, setLevel] = useState(0);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const zoom = LEVELS[level];

  function geometry() {
    const stage = viewport.current;
    const bitmap = img.current;
    if (!stage || !bitmap?.naturalWidth || !bitmap.naturalHeight) return null;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return null;
    const fit = Math.min(width / bitmap.naturalWidth, height / bitmap.naturalHeight);
    return { width, height, sourceWidth: bitmap.naturalWidth,
      sourceHeight: bitmap.naturalHeight, fit };
  }

  function bound(point: Point, magnitude: number): Point {
    const g = geometry();
    if (!g) return magnitude === 1 ? { x: 0, y: 0 } : point;
    const maxX = Math.max(0, (g.sourceWidth * g.fit * magnitude - g.width) / 2);
    const maxY = Math.max(0, (g.sourceHeight * g.fit * magnitude - g.height) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, point.x)),
      y: Math.max(-maxY, Math.min(maxY, point.y)),
    };
  }

  function changeZoom(step: number) {
    const next = Math.max(0, Math.min(LEVELS.length - 1, level + step));
    setLevel(next);
    setPan((previous) => bound(previous, LEVELS[next]));
  }

  function fitAll() {
    drag.current = null;
    setLevel(0);
    setPan({ x: 0, y: 0 });
  }

  function focusAt(target?: Point) {
    const g = geometry();
    if (!g || !target) return;
    const last = LEVELS.length - 1;
    const magnification = LEVELS[last];
    // Center the selected mouth layers on the fixed full-canvas PNG,
    // without fetching a new crop or changing the PSD/renderer coordinates.
    const wanted = {
      x: -(target.x - 0.5) * g.sourceWidth * g.fit * magnification,
      y: -(target.y - 0.5) * g.sourceHeight * g.fit * magnification,
    };
    setLevel(last);
    setPan(bound(wanted, magnification));
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!image || zoom === 1 || event.button !== 0) return;
    drag.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, start: pan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current;
    if (!previous || previous.id !== event.pointerId) return;
    setPan(bound({
      x: previous.start.x + event.clientX - previous.x,
      y: previous.start.y + event.clientY - previous.y,
    }, zoom));
  }

  function pointerStop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function keyboardMove(event: KeyboardEvent<HTMLDivElement>) {
    if (!image || zoom === 1) return;
    const delta = { ArrowLeft: [24, 0], ArrowRight: [-24, 0],
      ArrowUp: [0, 24], ArrowDown: [0, -24] }[event.key];
    if (!delta) return;
    event.preventDefault();
    setPan((previous) => bound({
      x: previous.x + delta[0], y: previous.y + delta[1],
    }, zoom));
  }

  return <>
    <div className="preset-image-controls" role="group" aria-label="プレビューの拡大縮小">
      <button type="button" className="secondary" onClick={fitAll}
        disabled={!image || (level === 0 && pan.x === 0 && pan.y === 0)}>全体表示</button>
      <button type="button" className="secondary" aria-label="縮小"
        onClick={() => changeZoom(-1)} disabled={!image || level === 0}>−</button>
      <output aria-label="プレビュー倍率">{zoom}×</output>
      <button type="button" className="secondary" aria-label="拡大"
        onClick={() => changeZoom(1)}
        disabled={!image || level === LEVELS.length - 1}>＋</button>
      <button type="button" className="secondary" onClick={() => focusAt(focus)}
        disabled={!image || !focus} title={!focus ? "口形の役割を割り当てると使用できます" : undefined}>
        口元へ
      </button>
      <button type="button" className="secondary" onClick={() => focusAt(selectedFocus)}
        disabled={!image || !selectedFocus}>選択位置へ</button>
    </div>
    <div ref={viewport} className="preview-stage preset-image-viewport"
      tabIndex={image && zoom > 1 ? 0 : -1}
      role="group" aria-label="立ち絵プレビュー。拡大時はドラッグか矢印キーで移動"
      style={{ touchAction: zoom > 1 ? "none" : "auto" }}
      onPointerDown={pointerDown} onPointerMove={pointerMove}
      onPointerUp={pointerStop} onPointerCancel={pointerStop}
      onKeyDown={keyboardMove}>
      {image ? <img ref={img} src={image} alt={alt} draggable={false}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        onLoad={() => setPan((previous) => bound(previous, zoom))} /> :
        <span className="preview-empty">{error || "プレビューを更新中…"}</span>}
      {image && selectedBox && <svg className="preset-image-selection" aria-hidden="true"
        viewBox={`0 0 ${selectedBox.sourceWidth} ${selectedBox.sourceHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <rect x={selectedBox.x} y={selectedBox.y} width={selectedBox.width}
          height={selectedBox.height} />
      </svg>}
    </div>
  </>;
}
