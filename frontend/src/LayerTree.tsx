import { useEffect, useState } from "react";

export type Layer = {
  path: string; name: string; kind: string; visible: boolean;
  effective_visible: boolean; bbox: number[];
};
export type BindingKind = "closed" | "opened" | "eyeOpen" | "eyeClosed";

type Props = {
  layers: Layer[];
  bindings: Record<BindingKind, string>;
  disabled: boolean;
  onChoose: (kind: BindingKind, path: string) => void;
};

export default function LayerTree({ layers, bindings, disabled, onChoose }: Props) {
  const [expanded, setExpanded] = useState<string[]>(
    () => layers.filter((layer) => layer.kind === "group").map((layer) => layer.path),
  );
  const [category, setCategory] = useState<"mouth" | "eyes">("mouth");
  const groups = layers.filter((layer) => layer.kind === "group").map((layer) => layer.path);

  // A new PSD response may have different groups even when the input path is unchanged.
  useEffect(() => {
    setExpanded(groups);
  }, [layers]);

  function toggle(path: string) {
    setExpanded((previous) => previous.includes(path)
      ? previous.filter((value) => value !== path)
      : [...previous, path]);
  }

  function isShown(path: string) {
    const parts = path.split("/");
    return parts.slice(1).every((_, index) =>
      expanded.includes(parts.slice(0, index + 1).join("/")));
  }

  return (
    <>
      <div className="tree-tools">
        <div className="binding-tabs" role="group" aria-label="割当対象">
          <button className={category === "mouth" ? "chosen-tab" : ""}
            aria-pressed={category === "mouth"}
            onClick={() => setCategory("mouth")} type="button">口</button>
          <button className={category === "eyes" ? "chosen-tab" : ""}
            aria-pressed={category === "eyes"}
            onClick={() => setCategory("eyes")} type="button">目</button>
        </div>
        <div className="tree-expand">
          <button className="small secondary" type="button"
            onClick={() => setExpanded(groups)}>すべて開く</button>
          <button className="small secondary" type="button"
            onClick={() => setExpanded([])}>すべて閉じる</button>
        </div>
      </div>
      <p className="hint">
        {category === "mouth"
          ? "口レイヤーを「閉口」「開口」に1つずつ割り当てます。"
          : "目レイヤーを「開眼」「閉眼」に割り当てます（瞬きのMOV出力は未実装）。"}
      </p>
      <div className="layer-list" aria-label="PSD layer list">
        {layers.filter((layer) => isShown(layer.path)).map((layer) => {
          const depth = layer.path.split("/").length - 1;
          const isGroup = layer.kind === "group";
          const open = expanded.includes(layer.path);
          const chosen = (kind: BindingKind) => bindings[kind] === layer.path;
          return <div key={layer.path} className={"layer " + (isGroup ? "group" : "")}
            style={{ paddingLeft: 10 + depth * 13 }}>
            {isGroup
              ? <button type="button" className="group-toggle"
                  aria-label={layer.name + " [" + layer.path + "] を" + (open ? "閉じる" : "開く")}
                  aria-expanded={open} onClick={() => toggle(layer.path)}>
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  <span className="layer-path">{layer.path}</span>
                  <span className="group-name">{layer.name}</span>
                  {!layer.effective_visible && <span className="hidden-label"> 非表示</span>}
                </button>
              : <>
                <span className="layer-label" title={layer.name}>
                  <span className="layer-path">{layer.path}</span>{layer.name}
                  {!layer.effective_visible && <span className="hidden-label"> 非表示</span>}
                </span>
                <span className="layer-actions">
                  {(category === "mouth"
                    ? [["closed", "閉口"], ["opened", "開口"]]
                    : [["eyeOpen", "開眼"], ["eyeClosed", "閉眼"]]
                  ).map(([kind, label]) => (
                    <button key={kind} className={chosen(kind as BindingKind) ? "chosen" : "small"}
                      type="button" disabled={disabled} aria-pressed={chosen(kind as BindingKind)}
                      aria-label={layer.name + " [" + layer.path + "] を" + label + "に指定"}
                      onClick={() => onChoose(kind as BindingKind, layer.path)}>{label}</button>
                  ))}
                </span>
              </>}
          </div>;
        })}
      </div>
    </>
  );
}
