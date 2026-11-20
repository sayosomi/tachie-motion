import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { ThumbnailView } from "./thumbnailView";

type Point = { x: number; y: number };
type PreviewView = { zoom: number; pan: Point };
type Props = {
  image?: string;
  alt: string;
  error?: string;
  focus?: Point;
  focusLabel?: string;
  selectedFocus?: Point;
  onThumbnailSave?: (view: ThumbnailView) => boolean;
};

const BUTTON_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];
// Linear wheel sensitivity: delta 100px changes magnification by 0.5x.
const WHEEL_ZOOM_PER_PIXEL = 0.005;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export default function PresetImagePreview({
  image, alt, error, focus, focusLabel = "口元へ", selectedFocus, onThumbnailSave,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: Point } | null>(null);

  // Wheel and pointer input may arrive before React commits a render.
  const [view, setView] = useState<PreviewView>({ zoom: MIN_ZOOM, pan: { x: 0, y: 0 } });
  const viewRef = useRef(view);
  const { zoom, pan } = view;
  function applyView(next: PreviewView) {
    viewRef.current = next;
    setView(next);
  }
  function cancelDrag() {
    const active = drag.current;
    drag.current = null;
    if (active && viewport.current?.hasPointerCapture(active.id)) {
      viewport.current.releasePointerCapture(active.id);
    }
  }
  const [savedMessage, setSavedMessage] = useState("");

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


  function changeZoom(step: -1 | 1) {
    cancelDrag();
    setSavedMessage("");
    const current = viewRef.current;
    const next = step > 0
      ? BUTTON_LEVELS.find((value) => value > current.zoom + 1e-9) ?? MAX_ZOOM
      : BUTTON_LEVELS.filter((value) => value < current.zoom - 1e-9).at(-1) ?? MIN_ZOOM;
    applyView({ zoom: next, pan: bound(current.pan, next) });
  }

  function fitAll() {
    cancelDrag();
    setSavedMessage("");
    applyView({ zoom: MIN_ZOOM, pan: { x: 0, y: 0 } });
  }

  function focusAt(target?: Point) {
    cancelDrag();
    setSavedMessage("");
    const g = geometry();
    if (!g || !target) return;
    const magnification = MAX_ZOOM;
    const wanted = {
      x: -(target.x - 0.5) * g.sourceWidth * g.fit * magnification,
      y: -(target.y - 0.5) * g.sourceHeight * g.fit * magnification,
    };
    applyView({ zoom: magnification, pan: bound(wanted, magnification) });
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    const current = viewRef.current;
    if (!image || current.zoom === 1 || event.button !== 0) return;
    setSavedMessage("");
    drag.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, start: current.pan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current;
    if (!previous || previous.id !== event.pointerId) return;
    const current = viewRef.current;
    applyView({ zoom: current.zoom, pan: bound({
      x: previous.start.x + event.clientX - previous.x,
      y: previous.start.y + event.clientY - previous.y,
    }, current.zoom) });
  }

  function pointerStop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    cancelDrag();
  }

  function keyboardMove(event: KeyboardEvent<HTMLDivElement>) {
    const current = viewRef.current;
    if (!image || current.zoom === 1) return;
    const delta = { ArrowLeft: [24, 0], ArrowRight: [-24, 0],
      ArrowUp: [0, 24], ArrowDown: [0, -24] }[event.key];
    if (!delta) return;
    setSavedMessage("");
    event.preventDefault();
    applyView({ zoom: current.zoom, pan: bound({
      x: current.pan.x + delta[0], y: current.pan.y + delta[1],
    }, current.zoom) });
  }

  // Wheel deltas map directly to magnification, without fixed-step snapping.
  // Use the synchronized viewRef for rapid bursts before React can rerender.
  useEffect(() => {
    const stage = viewport.current;
    if (!stage || !image) return;
    function onWheel(event: WheelEvent) {
      if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const g = geometry();
      if (!g) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16
        : event.deltaMode === 2 ? g.height : 1);
      if (!Number.isFinite(delta)) return;
      const current = viewRef.current;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
        current.zoom - delta * WHEEL_ZOOM_PER_PIXEL));
      if (next === current.zoom) return;
      cancelDrag();
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const factor = next / current.zoom;
      applyView({ zoom: next, pan: bound({
        x: current.pan.x + (x - current.pan.x) * (1 - factor),
        y: current.pan.y + (y - current.pan.y) * (1 - factor),
      }, next) });
      setSavedMessage("");
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [image]);

  function saveThumbnail() {
    const g = geometry();
    if (!g || !image || !onThumbnailSave) return;
    const current = viewRef.current;
    const magnitude = current.zoom;
    const view: ThumbnailView = {
      zoom: magnitude,
      centerX: Math.max(0, Math.min(1,
        0.5 - current.pan.x / (g.sourceWidth * g.fit * magnitude))),
      centerY: Math.max(0, Math.min(1,
        0.5 - current.pan.y / (g.sourceHeight * g.fit * magnitude))),
    };
    if (onThumbnailSave(view)) setSavedMessage("この表示範囲をサムネイルに保存しました");
  }

  return <>
    <div className="preset-image-controls" role="group" aria-label="プレビューの拡大縮小">
      <button type="button" className="secondary" onClick={fitAll}
        disabled={!image || (zoom === MIN_ZOOM && pan.x === 0 && pan.y === 0)}>全体表示</button>
      <button type="button" className="secondary" aria-label="縮小"
        onClick={() => changeZoom(-1)} disabled={!image || zoom === MIN_ZOOM}>−</button>
      <output aria-label="プレビュー倍率">{Number(zoom.toFixed(2))}×</output>
      <button type="button" className="secondary" aria-label="拡大"
        onClick={() => changeZoom(1)}
        disabled={!image || zoom === MAX_ZOOM}>＋</button>
      <button type="button" className="secondary" onClick={() => focusAt(focus)}
        disabled={!image || !focus} title={!focus ? "動作対象グループを指定すると使用できます" : undefined}>
        {focusLabel}
      </button>
      <button type="button" className="secondary" onClick={() => focusAt(selectedFocus)}
        disabled={!image || !selectedFocus}>選択位置へ</button>
      {onThumbnailSave && <button type="button" onClick={saveThumbnail}
        disabled={!image}>サムネにする</button>}
    </div>
    {savedMessage && <p role="status" className="hint">{savedMessage}</p>}
    <div ref={viewport} className="preview-stage preset-image-viewport"
      tabIndex={image && zoom > 1 ? 0 : -1}
      role="group" aria-label="立ち絵プレビュー。ホイールで拡大縮小、拡大時はドラッグか矢印キーで移動"
      style={{ touchAction: zoom > 1 ? "none" : "auto" }}
      onPointerDown={pointerDown} onPointerMove={pointerMove}
      onPointerUp={pointerStop} onPointerCancel={pointerStop}
      onKeyDown={keyboardMove}>
      {image ? <img ref={img} src={image} alt={alt} draggable={false}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        onLoad={() => {
          const current = viewRef.current;
          applyView({ zoom: current.zoom,
            pan: bound(current.pan, current.zoom) });
        }} /> :
        <span className="preview-empty">{error || "プレビューを更新中…"}</span>}
    </div>
  </>;
}
