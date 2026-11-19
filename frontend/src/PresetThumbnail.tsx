import { useEffect, useRef, useState } from "react";
import { thumbnailLayout, thumbnailView, type ThumbnailView } from "./thumbnailView";

type Size = { width: number; height: number };

export default function PresetThumbnail({
  image, view, alt, className = "", fallback = "プレビューを更新中…",
}: {
  image?: string;
  view?: ThumbnailView;
  alt: string;
  className?: string;
  fallback?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [bitmap, setBitmap] = useState<Size & { image?: string }>({ width: 0, height: 0 });
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

  const geometry = thumbnailLayout(thumbnailView(view), size.width, size.height,
    bitmap.image === image ? bitmap.width : 0,
    bitmap.image === image ? bitmap.height : 0);

  return <div ref={stage} className={`thumbnail-frame ${className}`}>
    {image && !failed ? <img src={image} alt={alt} draggable={false}
      onLoad={(event) => setBitmap({
        image,
        width: event.currentTarget.naturalWidth,
        height: event.currentTarget.naturalHeight,
      })}
      onError={() => setFailed(true)}
      style={{
        left: geometry?.left ?? 0, top: geometry?.top ?? 0,
        width: geometry?.width ?? 0, height: geometry?.height ?? 0,
        visibility: geometry ? "visible" : "hidden",
      }} /> : <span className="thumbnail-fallback">
        {failed ? "画像を表示できません" : fallback}
      </span>}
  </div>;
}
