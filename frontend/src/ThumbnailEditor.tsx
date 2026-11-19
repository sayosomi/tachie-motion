import { useEffect, useState } from "react";
import PresetThumbnail from "./PresetThumbnail";
import { DEFAULT_THUMBNAIL, thumbnailView, type ThumbnailView } from "./thumbnailView";

export default function ThumbnailEditor({
  presetId, name, image, saved, onSave,
}: {
  presetId: string;
  name: string;
  image?: string;
  saved?: ThumbnailView;
  onSave: (view: ThumbnailView) => boolean;
}) {
  const [draft, setDraft] = useState<ThumbnailView>(() => ({ ...thumbnailView(saved) }));
  const [message, setMessage] = useState("");
  useEffect(() => {
    setDraft({ ...thumbnailView(saved) });
    setMessage("");
  }, [presetId, saved?.zoom, saved?.centerX, saved?.centerY]);
  const actual = thumbnailView(saved);
  const changed = draft.zoom !== actual.zoom ||
    draft.centerX !== actual.centerX || draft.centerY !== actual.centerY;

  return <div className="thumbnail-editor" data-preset-id={presetId}>
    <h3>サムネイル</h3>
    <p className="hint">一覧とWAVのプリセット選択に使う画像です。MOVには影響しません。</p>
    <PresetThumbnail image={image} view={draft} alt={name + " のサムネイル編集"}
      className="thumbnail-edit-stage"
      onPan={(dx, dy) => {
        setDraft((previous) => ({
          ...previous,
          centerX: Math.max(0, Math.min(1, previous.centerX + dx)),
          centerY: Math.max(0, Math.min(1, previous.centerY + dy)),
        }));
        setMessage("");
      }} />
    <div className="thumbnail-editor-controls">
      <label htmlFor="thumbnail-zoom">倍率 <output>{draft.zoom.toFixed(2)}×</output></label>
      <input id="thumbnail-zoom" aria-label="サムネイル倍率" type="range"
        min="1" max="8" step="0.25" value={draft.zoom} disabled={!image}
        onChange={(event) => { setDraft((old) => ({
          ...old, zoom: Number(event.target.value),
        })); setMessage(""); }} />
      <div className="thumbnail-editor-actions">
        <button type="button" className="secondary" disabled={!image}
          onClick={() => { setDraft({ ...DEFAULT_THUMBNAIL }); setMessage(""); }}>
          全体表示に戻す
        </button>
        <button type="button" disabled={!image || !changed}
          onClick={() => {
            if (onSave(draft)) setMessage("サムネイルの設定を保存しました");
          }}>サムネイルを保存</button>
      </div>
    </div>
    {message && <p role="status" className="hint">{message}</p>}
    <p className="hint">拡大するとドラッグ・矢印キーで位置を調整できます。</p>
  </div>;
}
