import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { thumbnailLayout, thumbnailView, type ThumbnailView } from "./thumbnailView";

type Size = { width: number; height: number };

export default function PresetThumbnail({
  image, view, alt, className = "", fallback = "プレビューを更新中…", onPan,
}: {
  image?: string;
  view?: ThumbnailView;
  alt: string;
  className?: string;
  fallback?: string;
  /** Delta in normalized source-image coordinates. */
  onPan?: (dx: number, dy: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [bitmap, setBitmap] = useState<Size>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setSize({
      width: element.clientWidth, height: element.clientHeight,
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setFailed(false); }, [image]);

  const current = thumbnailView(view);
  const geometry = thumbnailLayout(current, size.width, size.height,
    bitmap.width, bitmap.height);
  const movable = !!onPan && !!image && current.zoom > 1 && !!geometry;

  function move(dx: number, dy: number) {
    if (!movable || !geometry) return;
    onPan?.(-dx / geometry.width, -dy / geometry.height);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!movable || event.button !== 0) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const last = drag.current;
    if (!last || last.pointer !== event.pointerId) return;
    move(event.clientX - last.x, event.clientY - last.y);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  }
  function pointerStop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboardMove(event: KeyboardEvent<HTMLDivElement>) {
    if (!movable) return;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-24, 0], ArrowRight: [24, 0],
      ArrowUp: [0, -24], ArrowDown: [0, 24],
    };
    const change = delta[event.key];
    if (!change) return;
    event.preventDefault();
    move(change[0], change[1]);
  }

  return <div ref={stage} className={`thumbnail-frame ${className}`}
    role={onPan ? "group" : undefined}
    aria-label={onPan ? "サムネイルの切り抜き位置。拡大中はドラッグか矢印キーで調整" : undefined}
    tabIndex={onPan ? 0 : undefined}
    style={{ touchAction: movable ? "none" : "auto" }}
    onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={pointerStop} onPointerCancel={pointerStop} onKeyDown={keyboardMove}>
    {image && !failed ? <img src={image} alt={alt} draggable={false}
      onLoad={(event) => setBitmap({
        width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight,
      })}
      onError={() => setFailed(true)}
      style={{
        left: geometry?.left ?? 0, top: geometry?.top ?? 0,
        width: geometry?.width ?? 0, height: geometry?.height ?? 0,
        visibility: geometry ? "visible" : "hidden",
      }} /> : <span className="thumbnail-fallback">{failed ? "画像を表示できません" : fallback}</span>}
  </div>;
}
