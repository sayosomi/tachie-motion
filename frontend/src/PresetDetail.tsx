import { useEffect, useState } from "react";
import type { Layer } from "./LayerTree";
import type { UnifiedPreset, EditableOpenLayerRole } from "./presetModel";
import { openLayerRole } from "./presetModel";
import PresetImagePreview from "./PresetImagePreview";
import { PreviewSourceChangedError, type BrowserPreviewRenderer } from "./useBrowserPreview";

type Props = {
  preset: UnifiedPreset;
  layers: Layer[];
  preview?: string;
  previewError?: string;
  browserRenderer?: BrowserPreviewRenderer | null;
  sourceChanged?: boolean;
  previewLoading?: boolean;
  verifySource?: () => Promise<void>;
  sourceIdentity?: string;
  sourcePath: string;
  fingerprint: string;
  canvasWidth: number;
  canvasHeight: number;
  nameDraft: string;
  onNameDraftChange: (name: string) => void;
  onBack: () => void;
  onRename: (name: string) => void;
  onToggle: (path: string) => void;
  onOpenRoleChange: (path: string, role: EditableOpenLayerRole) => void;
  onDelete: () => void;
};

type PreviewState = "base" | "closed" | "opened";
type ShapePreview = { key: string; image?: string; error?: string };

export default function PresetDetail({
  preset, layers, preview, previewError, browserRenderer, sourceChanged = false,
  previewLoading = false, verifySource = async () => {}, sourceIdentity = "",
  sourcePath, fingerprint, canvasWidth, canvasHeight, nameDraft,
  onNameDraftChange, onBack, onRename, onToggle, onOpenRoleChange, onDelete,
}: Props) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [assignedOnly, setAssignedOnly] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>("base");
  const [shapePreview, setShapePreview] = useState<ShapePreview | null>(null);

  useEffect(() => {
    setExpanded(layers.filter((layer) => layer.kind === "group").map((layer) => layer.path));
    setSelectedPath(null);
  }, [layers]);

  const baseByPath = new Map(preset.base.map((layer) => [layer.path, layer.visible]));
  const roles = new Map(layers.filter((layer) => layer.kind !== "group")
    .map((layer) => [layer.path, openLayerRole(preset, layer.path)]));
  const chosen = [...roles.values()].filter((role) => role !== "none").length;
  const queryText = query.trim().toLocaleLowerCase();
  const activeFilter = Boolean(queryText || assignedOnly);
  const matches = new Set<string>();
  const matchingGroups = layers.filter((layer) => layer.kind === "group"
    && queryText && (layer.name.toLocaleLowerCase().includes(queryText)
      || layer.path.includes(queryText))).map((layer) => layer.path);
  for (const layer of layers) {
    if (layer.kind === "group") continue;
    const role = roles.get(layer.path) ?? "none";
    if (assignedOnly && role === "none") continue;
    if (queryText && !(
      layer.name.toLocaleLowerCase().includes(queryText)
      || layer.path.includes(queryText)
      || matchingGroups.some((group) => layer.path.startsWith(group + "/"))
    )) continue;
    const parts = layer.path.split("/");
    for (let i = 1; i <= parts.length; i++) matches.add(parts.slice(0, i).join("/"));
  }

  // When a filter changes, reveal the ancestors of its matches once.
  // Do not rerun this when expanded changes: manual folding must be respected.
  useEffect(() => {
    if (!activeFilter) return;
    const matchedGroups = layers.filter(
      (layer) => layer.kind === "group" && matches.has(layer.path),
    ).map((layer) => layer.path);
    setExpanded((previous) => {
      const missing = matchedGroups.filter((path) => !previous.includes(path));
      return missing.length ? [...previous, ...missing] : previous;
    });
  }, [queryText, assignedOnly]);

  function visibleInTree(path: string): boolean {
    const components = path.split("/");
    return components.slice(1).every((_, i) =>
      expanded.includes(components.slice(0, i + 1).join("/")));
  }

  const shape = previewState === "base" ? undefined :
    preset.openMouth?.[previewState];
  const shapeKey = JSON.stringify([sourcePath, fingerprint, sourceIdentity, preset.base, shape, previewState]);
  useEffect(() => {
    if (previewState === "base" || sourceChanged || previewLoading) return;
    if (!shape?.length) {
      setShapePreview({ key: shapeKey, error: "口形を指定してください" });
      return;
    }
    const abort = new AbortController();
    const overrides = new Map(shape.map((item) => [item.path, item.visible]));
    const states = preset.base.map((layer) => ({
      path: layer.path, visible: overrides.get(layer.path) ?? layer.visible,
    }));
    const legacy = () => {
      void (async () => {
        try {
          await verifySource();
          if (abort.signal.aborted) return;
          const response = await fetch("/api/preset-preview", {
            method: "POST", signal: abort.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              path: sourcePath, fingerprint, source_identity: sourceIdentity, layers: states,
            }),
          });
          const result = await response.json() as { preview?: string; detail?: string };
          if (!response.ok) throw new Error(result.detail || "口形プレビューを取得できません");
          if (!result.preview) throw new Error("口形プレビューが空です");
          if (!abort.signal.aborted) setShapePreview({ key: shapeKey, image: result.preview });
        } catch (error) {
          if (!abort.signal.aborted && !(error instanceof PreviewSourceChangedError))
            setShapePreview({
              key: shapeKey, error: error instanceof Error ? error.message : String(error),
            });
        }
      })();
    };
    setShapePreview(null);
    if (browserRenderer) {
      void browserRenderer.render(states).then((image) => {
        if (!abort.signal.aborted) setShapePreview({ key: shapeKey, image });
      }).catch((err: unknown) => {
        if (!abort.signal.aborted && !(err instanceof PreviewSourceChangedError)) legacy();
      });
    } else {
      legacy();
    }
    return () => abort.abort();
  }, [shapeKey, browserRenderer, sourceChanged, previewLoading, verifySource]);

  const shownPreview = sourceChanged ? undefined : previewState === "base" ? preview :
    shapePreview?.key === shapeKey ? shapePreview.image : undefined;
  const shownError = sourceChanged ? "PSDが変更されました。再読み込みしてください。" :
    previewState === "base" ? previewError :
    shapePreview?.key === shapeKey ? shapePreview.error : undefined;
  const focusPaths = new Set([
    ...(preset.openMouth?.closed ?? []),
    ...(preset.openMouth?.opened ?? []),
  ].map((item) => item.path));
  const focusBounds = layers.filter((layer) =>
    focusPaths.has(layer.path) && layer.bbox.length === 4
    && layer.bbox.every(Number.isFinite));
  const focus = focusBounds.length && canvasWidth > 0 && canvasHeight > 0
    ? {
      x: Math.max(0, Math.min(1,
        (Math.min(...focusBounds.map((item) => item.bbox[0]))
          + Math.max(...focusBounds.map((item) => item.bbox[2]))) / (2 * canvasWidth))),
      y: Math.max(0, Math.min(1,
        (Math.min(...focusBounds.map((item) => item.bbox[1]))
          + Math.max(...focusBounds.map((item) => item.bbox[3]))) / (2 * canvasHeight))),
    }
    : undefined;
  const selectedLayer = layers.find((layer) => layer.path === selectedPath);
  const selectedBounds = selectedLayer?.bbox ?? [];
  const x1 = Math.max(0, Math.min(canvasWidth, selectedBounds[0] ?? 0));
  const y1 = Math.max(0, Math.min(canvasHeight, selectedBounds[1] ?? 0));
  const x2 = Math.max(0, Math.min(canvasWidth, selectedBounds[2] ?? 0));
  const y2 = Math.max(0, Math.min(canvasHeight, selectedBounds[3] ?? 0));
  const selectedBox = canvasWidth > 0 && canvasHeight > 0 && selectedBounds.length === 4
    && selectedBounds.every(Number.isFinite) && x2 > x1 && y2 > y1
    ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      sourceWidth: canvasWidth, sourceHeight: canvasHeight } : undefined;
  const selectedFocus = selectedBox
    ? { x: (x1 + x2) / (2 * canvasWidth), y: (y1 + y2) / (2 * canvasHeight) }
    : undefined;
  const hiddenParents = layers.filter((layer) => layer.kind !== "group"
    && roles.get(layer.path) !== "none"
    && layer.path.split("/").slice(0, -1).some((_, i, parts) =>
      baseByPath.get(parts.slice(0, i + 1).join("/")) === false));

  return <div className="preset-detail-page">
    <div className="preset-detail-head">
      <button type="button" className="secondary" onClick={onBack}>← 一覧へ</button>
    </div>
    <div className="preset-layout">
      <section className="panel preset-editor">
        <h2>編集</h2>
        <label htmlFor="preset-name">名前</label>
        <div className="input-row">
          <input id="preset-name" value={nameDraft}
            onChange={(e) => onNameDraftChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) onRename(nameDraft); }} />
          <button type="button" disabled={!nameDraft.trim() || nameDraft === preset.name}
            onClick={() => onRename(nameDraft)}>名前を変更</button>
        </div>
        <div className="preset-role-tabs" role="group" aria-label="レイヤーの役割モード">
          <button type="button" aria-pressed="true">Open</button>
          <button type="button" disabled title="後続対応">aiueo（未対応）</button>
          <button type="button" disabled title="後続対応">目・瞬き（未対応）</button>
        </div>
        <p className="hint">レイヤー名をクリックすると位置を選択表示します。左のチェックは基本表示、右の「なし／閉／開」はOpenの役割です。</p>
        <div className="preset-role-tools">
          <input aria-label="レイヤー検索" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="レイヤー名・パスで検索" />
          <label className="preset-role-filter"><input type="checkbox"
            checked={assignedOnly} onChange={(e) => setAssignedOnly(e.target.checked)} />
            割当済みのみ
          </label>
        </div>
        <div className="tree-tools">
          <button type="button" className="secondary" onClick={() =>
            setExpanded(layers.filter((layer) => layer.kind === "group").map((layer) => layer.path))
          }>すべて開く</button>
          <button type="button" className="secondary" onClick={() => setExpanded([])}>すべて閉じる</button>
          <span className="hint">Open対象 {chosen} レイヤー</span>
        </div>
        <div className="preset-role-head" aria-hidden="true">
          <span>基本表示・PSDレイヤー</span><span>Openの役割</span>
        </div>
        <div className="layer-list preset-layer-list" aria-label="プリセットのPSDレイヤー">
          {layers.filter((layer) => (!activeFilter || matches.has(layer.path))
            && visibleInTree(layer.path)).map((layer) => {
            const isGroup = layer.kind === "group";
            const on = baseByPath.get(layer.path) ?? false;
            const depth = layer.path.split("/").length - 1;
            const role = roles.get(layer.path) ?? "none";
            const groupCount = isGroup ? [...roles].filter(([path, item]) =>
              path.startsWith(layer.path + "/") && item !== "none").length : 0;
            return <div key={layer.path} data-layer-path={layer.path}
              data-selected={selectedPath === layer.path ? "true" : "false"}
              className={"layer preset-layer " + (isGroup ? "group" : "")}
              style={{ paddingLeft: 10 + depth * 13 }}>
              {isGroup && <button className="group-toggle preset-expand" type="button"
                aria-expanded={expanded.includes(layer.path)}
                aria-label={layer.name + " [" + layer.path + "] を" +
                  (expanded.includes(layer.path) ? "閉じる" : "開く")}
                onClick={() => setExpanded((old) => old.includes(layer.path)
                  ? old.filter((p) => p !== layer.path) : [...old, layer.path])}>
                {expanded.includes(layer.path) ? "▾" : "▸"}
              </button>}
              <div className="preset-visibility-label">
                <input type="checkbox" checked={on} onChange={() => onToggle(layer.path)}
                  aria-label={layer.name + " [" + layer.path + "] 表示"} />
                <button type="button" className="preset-layer-select"
                  aria-pressed={selectedPath === layer.path}
                  aria-label={layer.name + " [" + layer.path + "] を選択"}
                  onClick={() => setSelectedPath((previous) =>
                    previous === layer.path ? null : layer.path)}>
                  <span className="layer-path">{layer.path}</span>
                  <span className="preset-layer-name">{layer.name}</span>
                </button>
              </div>
              {isGroup
                ? <span className="preset-role-group-count">{groupCount ? "対象 " + groupCount : ""}</span>
                : <div className="preset-layer-role" data-layer-path={layer.path}
                    data-open-role={role} role="group"
                    aria-label={layer.name + " [" + layer.path + "] Openの役割"}>
                    {(["none", "closed", "opened"] as const).map((next) => (
                      <button key={next} type="button" aria-pressed={role === next}
                        aria-label={layer.name + " [" + layer.path + "] Open: " +
                          (next === "none" ? "なし" : next === "closed" ? "閉じ口" : "開き口")}
                        title={next === "none" ? "Open割当なし" : next === "closed" ? "閉じ口に割当" : "開き口に割当"}
                        onClick={() => onOpenRoleChange(layer.path, next)}>
                        {next === "none" ? "なし" : next === "closed" ? "閉" : "開"}
                      </button>
                    ))}
                    {role === "custom" && <span className="preset-role-custom">既存の個別設定</span>}
                  </div>}
            </div>;
          })}
          {activeFilter && matches.size === 0 && <p className="hint">該当するレイヤーがありません。</p>}
        </div>
        {hiddenParents.length > 0 && <p className="hint warning" role="status">
          口形対象の親グループが非表示です。書き出すには左側の基本表示をONにしてください。
        </p>}
        {[...roles.values()].includes("custom") && <p className="hint warning">
          既存の特殊な口形設定は保持しています。該当レイヤーの役割を選ぶと、そのレイヤーだけ通常のOpen割当に変更します。
        </p>}
        <p className="hint">aiueo・目パチの割当とOpenの動作パラメータは後続対応です。</p>
        <button type="button" className="secondary preset-delete" onClick={onDelete}>このプリセットを削除</button>
      </section>
      <section className="panel preset-preview">
        <h2>プレビュー</h2>
        <div className="preset-shape-tabs" role="group" aria-label="プレビューする状態">
          <button type="button" aria-pressed={previewState === "base"}
            onClick={() => setPreviewState("base")}>基本表示</button>
          <button type="button" aria-pressed={previewState === "closed"}
            onClick={() => setPreviewState("closed")}>閉じ口</button>
          <button type="button" aria-pressed={previewState === "opened"}
            onClick={() => setPreviewState("opened")}>開き口</button>
        </div>
        <p className="hint preset-selected-summary" aria-live="polite">
          {selectedLayer
            ? "選択中: " + selectedLayer.name + " [" + selectedLayer.path + "]" +
              (selectedBox ? "" : "（位置情報なし）")
            : "レイヤー名をクリックすると、その範囲をプレビューに表示します。"}
        </p>
        <PresetImagePreview image={shownPreview} alt={preset.name + " のプレビュー"}
          error={shownError} focus={focus} selectedBox={selectedBox}
          selectedFocus={selectedFocus} />
        <p className="hint">全体表示と口元の拡大を切り替えられます。拡大時はドラッグで移動できます。</p>
      </section>
    </div>
  </div>;
}
