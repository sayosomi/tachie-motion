import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { ThumbnailView } from "./thumbnailView";

type Point = { x: number; y: number };
type PreviewView = { level: number; pan: Point };
type Props = {
  image?: string;
  alt: string;
  error?: string;
  focus?: Point;
  focusLabel?: string;
  selectedFocus?: Point;
  onThumbnailSave?: (view: ThumbnailView) => boolean;
};

const LEVELS = [1, 1.5, 2, 3, 4, 6, 8];

export default function PresetImagePreview({
  image, alt, error, focus, focusLabel = "口元へ", selectedFocus, onThumbnailSave,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: Point } | null>(null);
  const wheelDelta = useRef(0);

  // Wheel and pointer input may arrive before React commits a render.
  const [view, setView] = useState<PreviewView>({ level: 0, pan: { x: 0, y: 0 } });
  const viewRef = useRef(view);
  const { level, pan } = view;
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
    wheelDelta.current = 0;
    cancelDrag();
    setSavedMessage("");
    const current = viewRef.current;
    const next = Math.max(0, Math.min(LEVELS.length - 1, current.level + step));
    applyView({ level: next, pan: bound(current.pan, LEVELS[next]) });
  }

  function fitAll() {
    wheelDelta.current = 0;
    cancelDrag();
    setSavedMessage("");
    applyView({ level: 0, pan: { x: 0, y: 0 } });
  }

  function focusAt(target?: Point) {
    wheelDelta.current = 0;
    cancelDrag();
    setSavedMessage("");
    const g = geometry();
    if (!g || !target) return;
    const last = LEVELS.length - 1;
    const magnification = LEVELS[last];
    const wanted = {
      x: -(target.x - 0.5) * g.sourceWidth * g.fit * magnification,
      y: -(target.y - 0.5) * g.sourceHeight * g.fit * magnification,
    };
    applyView({ level: last, pan: bound(wanted, magnification) });
  }


  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    const current = viewRef.current;
    if (!image || LEVELS[current.level] === 1 || event.button !== 0) return;
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
    applyView({ level: current.level, pan: bound({
      x: previous.start.x + event.clientX - previous.x,
      y: previous.start.y + event.clientY - previous.y,
    }, LEVELS[current.level]) });
  }

  function pointerStop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    cancelDrag();
  }

  function keyboardMove(event: KeyboardEvent<HTMLDivElement>) {
    const current = viewRef.current;
    if (!image || LEVELS[current.level] === 1) return;
    const delta = { ArrowLeft: [24, 0], ArrowRight: [-24, 0],
      ArrowUp: [0, 24], ArrowDown: [0, -24] }[event.key];
    if (!delta) return;
    setSavedMessage("");
    event.preventDefault();
    applyView({ level: current.level, pan: bound({
      x: current.pan.x + delta[0], y: current.pan.y + delta[1],
    }, LEVELS[current.level]) });
  }

  // React's delegated wheel listener may be passive in browsers. Attach a
  // non-passive listener only to the preview so page scrolling still works
  // everywhere else. Accumulate small trackpad deltas before changing levels.
  useEffect(() => {
    const stage = viewport.current;
    if (!stage || !image) return;
    wheelDelta.current = 0;
    function onWheel(event: WheelEvent) {
      if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const g = geometry();
      if (!g || !stage) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16
        : event.deltaMode === 2 ? g.height : 1);
      if (Math.sign(wheelDelta.current) !== Math.sign(delta)) {
        wheelDelta.current = 0;
      }
      wheelDelta.current += delta;
      const steps = Math.trunc(Math.abs(wheelDelta.current) / 100);
      if (!steps) return;
      const direction = Math.sign(wheelDelta.current);
      wheelDelta.current -= direction * steps * 100;
      const current = viewRef.current;
      const next = Math.max(0, Math.min(LEVELS.length - 1,
        current.level - direction * steps));
      if (next === current.level) {
        wheelDelta.current = 0;
        return;
      }
      // Wheel zoom ends a pointer drag, so stale drag origins cannot overwrite it.
      cancelDrag();
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const factor = LEVELS[next] / LEVELS[current.level];
      applyView({ level: next, pan: bound({
        x: current.pan.x + (x - current.pan.x) * (1 - factor),
        y: current.pan.y + (y - current.pan.y) * (1 - factor),
      }, LEVELS[next]) });
      setSavedMessage("");
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [image]);

  function saveThumbnail() {
    const g = geometry();
    if (!g || !image || !onThumbnailSave) return;
    const current = viewRef.current;
    const magnitude = LEVELS[current.level];
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
        disabled={!image || (level === 0 && pan.x === 0 && pan.y === 0)}>全体表示</button>
      <button type="button" className="secondary" aria-label="縮小"
        onClick={() => changeZoom(-1)} disabled={!image || level === 0}>−</button>
      <output aria-label="プレビュー倍率">{zoom}×</output>
      <button type="button" className="secondary" aria-label="拡大"
        onClick={() => changeZoom(1)}
        disabled={!image || level === LEVELS.length - 1}>＋</button>
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
          applyView({ level: current.level,
            pan: bound(current.pan, LEVELS[current.level]) });
        }} /> :
        <span className="preview-empty">{error || "プレビューを更新中…"}</span>}
    </div>
  </>;
}
