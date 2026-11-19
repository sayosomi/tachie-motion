import { useEffect, useId, useRef, useState } from "react";
import PresetThumbnail from "./PresetThumbnail";
import type { UnifiedPreset } from "./presetModel";

type Item = Pick<UnifiedPreset, "id" | "name" | "thumbnail">;

export default function PresetPicker({
  presets, imageMap, selectedId, status, disabled, label, onChoose,
}: {
  presets: Item[];
  imageMap: Record<string, string>;
  selectedId: string;
  status: "loading" | "ready" | "error";
  disabled: boolean;
  label: string;
  onChoose: (id: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  const selected = presets.find((item) => item.id === selectedId);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const missing = status === "loading" ? "確認中…" :
    status === "error" ? "プリセットを確認できません" : "未設定（要再選択）";
  return <div ref={holder} className="preset-picker">
    <button type="button" ref={trigger} className="preset-picker-trigger"
      aria-label={label} data-selected-preset-id={selectedId}
      aria-expanded={open} aria-controls={optionsId}
      disabled={disabled} onClick={() => setOpen((previous) => !previous)}>
      <PresetThumbnail className="preset-picker-thumb"
        image={selected && imageMap[selected.id]} view={selected?.thumbnail}
        alt={selected ? selected.name + " のサムネイル" : missing}
        fallback={selected ? "画像待ち" : "未設定"} />
      <span className="preset-picker-name">{selected?.name ?? missing}</span>
      <span aria-hidden="true">▾</span>
    </button>
    {open && <div id={optionsId} className="preset-picker-options" role="group"
      aria-label={label + " の候補"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}>
      {presets.map((entry) => <button type="button" key={entry.id}
        className="preset-picker-option" data-preset-id={entry.id}
        aria-pressed={entry.id === selectedId}
        onClick={() => {
          if (onChoose(entry.id)) {
            setOpen(false);
            trigger.current?.focus();
          }
        }}>
        <PresetThumbnail className="preset-picker-thumb"
          image={imageMap[entry.id]} view={entry.thumbnail}
          alt={entry.name + " のサムネイル"} fallback="画像待ち" />
        <span>{entry.name}</span>
        {entry.id === selectedId && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
