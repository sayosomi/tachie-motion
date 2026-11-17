import { useEffect, useState } from "react";
import type { Layer } from "./LayerTree";
import type { UnifiedPreset, AiueoKey } from "./presetModel";
import { AIUEO_KEYS, AIUEO_LABELS, aiueoLayerRole, openLayerRole } from "./presetModel";
import PresetImagePreview from "./PresetImagePreview";
import MotionGroupSelector from "./MotionGroupSelector";
import { isMouthLayer } from "./motionGroups";
import { psdChoiceKind, psdParentPath } from "./psdChoice";
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
  onToggle: (path: string, visible: boolean) => void;
  mouthGroups: string[];
  onMouthGroupsChange: (groups: string[]) => void;
  onMouthMotionChange: (enabled: boolean) => void;
  onOpenShapeChange: (shape: "closed" | "opened", path: string, visible: boolean) => void;
  onAiueoChoiceChange: (key: AiueoKey, path: string, visible: boolean) => void;
  onDelete: () => void;
};

type PreviewState = "base" | "closed" | "opened" | `aiueo-${AiueoKey}`;
type ShapePreview = { key: string; image?: string; error?: string };

export default function PresetDetail({
  preset, layers, preview, previewError, browserRenderer, sourceChanged = false,
  previewLoading = false, verifySource = async () => {}, sourceIdentity = "",
  sourcePath, fingerprint, canvasWidth, canvasHeight, nameDraft,
  onNameDraftChange, onBack, onRename, onToggle, mouthGroups,
  onMouthGroupsChange, onMouthMotionChange, onOpenShapeChange,
  onAiueoChoiceChange, onDelete,
}: Props) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<"normal" | "motion">("normal");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>("base");
  const [roleMode, setRoleMode] = useState<"open" | "aiueo">("open");
  const [aiueoKey, setAiueoKey] = useState<AiueoKey>("a");
  const [shapePreview, setShapePreview] = useState<ShapePreview | null>(null);

  useEffect(() => {
    setExpanded(layers.filter((layer) => layer.kind === "group").map((layer) => layer.path));
    setSelectedPath(null);
  }, [layers]);

  const editingBase = area === "normal" || previewState === "base";
  const baseByPath = new Map(preset.base.map((layer) => [layer.path, layer.visible]));
  const roles = new Map(layers.filter((layer) => layer.kind !== "group")
    .map((layer) => [layer.path, roleMode === "open"
      ? openLayerRole(preset, layer.path) : aiueoLayerRole(preset, aiueoKey, layer.path)]));
  const unsetRole = roleMode === "open" ? "none" : "base";
  const eligible = new Set(layers.filter((layer) =>
    area === "motion" ? isMouthLayer(layer.path, mouthGroups)
      : !isMouthLayer(layer.path, mouthGroups)).map((layer) => layer.path));
  const queryText = query.trim().toLocaleLowerCase();
  const activeFilter = Boolean(queryText);
  const matches = new Set<string>();
  const matchingGroups = layers.filter((layer) => layer.kind === "group"
    && eligible.has(layer.path) && queryText
    && (layer.name.toLocaleLowerCase().includes(queryText)
      || layer.path.includes(queryText))).map((layer) => layer.path);
  for (const layer of layers) {
    if (!eligible.has(layer.path)) continue;
    if (queryText && !(
      layer.name.toLocaleLowerCase().includes(queryText)
      || layer.path.includes(queryText)
      || matchingGroups.some((group) => layer.path.startsWith(group + "/"))
    )) continue;
    const parts = layer.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (eligible.has(ancestor)) matches.add(ancestor);
    }
  }

  // Expanding matches never overrides a later manual fold.
  useEffect(() => {
    if (!activeFilter) return;
    const matchedGroups = layers.filter((layer) => layer.kind === "group"
      && matches.has(layer.path)).map((layer) => layer.path);
    setExpanded((old) => [...new Set([...old, ...matchedGroups])]);
  }, [queryText, area, mouthGroups.join("/")]);

  function visibleInTree(path: string): boolean {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (eligible.has(ancestor) && !expanded.includes(ancestor)) return false;
    }
    return true;
  }

  function layerDepth(path: string): number {
    if (area === "normal") return path.split("/").length - 1;
    const root = mouthGroups.filter((group) => isMouthLayer(path, [group]))
      .sort((a, b) => b.length - a.length)[0];
    return root ? path.split("/").length - root.split("/").length : 0;
  }

  const shape = previewState === "base" ? undefined :
    previewState === "closed" || previewState === "opened"
      ? preset.openMouth?.[previewState]
      : preset.aiueoMouth?.[previewState.slice(6) as AiueoKey];
  const shapeKey = JSON.stringify([sourcePath, fingerprint, sourceIdentity,
    preset.base, shape, previewState, preset.mouthMotionEnabled]);
  useEffect(() => {
    if (previewState === "base" || preset.mouthMotionEnabled === false ||
        sourceChanged || previewLoading) return;
    if (!shape?.length) {
      // An unconfigured aiueo shape starts from the full base portrait,
      // not a blank checkerboard. Unconfigured Open keeps its existing guard.
      setShapePreview(previewState.startsWith("aiueo-")
        ? null : { key: shapeKey, error: "口形を指定してください" });
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
  }, [shapeKey, browserRenderer, sourceChanged, previewLoading, verifySource,
    preset.mouthMotionEnabled]);

  const unconfiguredAiueo = previewState.startsWith("aiueo-") && !shape?.length;
  const shownPreview = sourceChanged ? undefined :
    previewState === "base" || unconfiguredAiueo || preset.mouthMotionEnabled === false ? preview :
    shapePreview?.key === shapeKey ? shapePreview.image : undefined;
  const shownError = sourceChanged ? "PSDが変更されました。再読み込みしてください。" :
    previewState === "base" || unconfiguredAiueo || preset.mouthMotionEnabled === false ? previewError :
    shapePreview?.key === shapeKey ? shapePreview.error : undefined;
  const focusPaths = new Set((roleMode === "open" ? [
    ...(preset.openMouth?.closed ?? []), ...(preset.openMouth?.opened ?? []),
  ] : AIUEO_KEYS.flatMap((key) => preset.aiueoMouth?.[key] ?? [])).map((item) => item.path));
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
  const selectedHasBounds = canvasWidth > 0 && canvasHeight > 0
    && selectedBounds.length === 4 && selectedBounds.every(Number.isFinite)
    && x2 > x1 && y2 > y1;
  const selectedFocus = selectedHasBounds
    ? { x: (x1 + x2) / (2 * canvasWidth), y: (y1 + y2) / (2 * canvasHeight) }
    : undefined;
  const hiddenParents = layers.filter((layer) => layer.kind !== "group"
    && roles.get(layer.path) !== unsetRole
    && layer.path.split("/").slice(0, -1).some((_, i, parts) =>
      baseByPath.get(parts.slice(0, i + 1).join("/")) === false));

  return <div className="preset-detail-page">
    <div className="preset-detail-head">
      <button type="button" className="secondary" onClick={onBack}>← 一覧へ</button>
    </div>
    <div className="preset-layout">
      <section className="panel preset-editor" data-role-mode={roleMode} data-edit-area={area}>
        <h2>編集</h2>
        <label htmlFor="preset-name">名前</label>
        <div className="input-row">
          <input id="preset-name" value={nameDraft}
            onChange={(e) => onNameDraftChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) onRename(nameDraft); }} />
          <button type="button" disabled={!nameDraft.trim() || nameDraft === preset.name}
            onClick={() => onRename(nameDraft)}>名前を変更</button>
        </div>
        <div className="preset-role-tabs" role="group" aria-label="編集区分">
          <button type="button" aria-pressed={area === "normal"}
            onClick={() => { setArea("normal"); setPreviewState("base"); setQuery(""); }}>
            通常レイヤー
          </button>
          <button type="button" aria-pressed={area === "motion"}
            onClick={() => { setArea("motion"); setPreviewState(roleMode === "open"
              ? "closed" : `aiueo-${aiueoKey}`); setQuery(""); }}>
            動かすパーツ
          </button>
        </div>
        {area === "motion" && <>
          <label className="motion-enabled-toggle">
            <input type="checkbox" checked={preset.mouthMotionEnabled !== false}
              onChange={(event) => onMouthMotionChange(event.target.checked)} />
            口パク
          </label>
          <div className="preset-role-tabs" role="group" aria-label="口パク方式">
            <button type="button" aria-pressed={roleMode === "open"}
              onClick={() => { setRoleMode("open"); setPreviewState("closed"); }}>Open</button>
            <button type="button" aria-pressed={roleMode === "aiueo"}
              onClick={() => { setRoleMode("aiueo"); setPreviewState(`aiueo-${aiueoKey}`); }}>aiueo</button>
          </div>
          {roleMode === "open" ? <div className="preset-aiueo-choice" role="group"
            aria-label="編集する口形">
            <button type="button" aria-pressed={previewState === "base"}
              onClick={() => setPreviewState("base")}>基本</button>
            <button type="button" aria-pressed={previewState === "closed"}
              onClick={() => setPreviewState("closed")}>閉じ口</button>
            <button type="button" aria-pressed={previewState === "opened"}
              onClick={() => setPreviewState("opened")}>開き口</button>
          </div> : <div className="preset-aiueo-choice" role="group"
            aria-label="編集する口形">
            <button type="button" aria-pressed={previewState === "base"}
              onClick={() => setPreviewState("base")}>基本</button>
            {AIUEO_KEYS.map((key) => <button key={key} type="button"
              aria-pressed={previewState === `aiueo-${key}`}
              title={key === "n" ? "ん（無音・静止口）" : undefined}
              onClick={() => { setAiueoKey(key); setPreviewState(`aiueo-${key}`); }}>
              {AIUEO_LABELS[key]}
            </button>)}
          </div>}
          <MotionGroupSelector groups={layers.filter((layer) => layer.kind === "group")}
            selected={mouthGroups} onChange={onMouthGroupsChange} />
        </>}
        <div className="preset-role-tools">
          <input aria-label="レイヤー検索" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="レイヤー名・パスで検索" />
        </div>
        <div className="tree-tools">
          <button type="button" className="secondary" onClick={() =>
            setExpanded(layers.filter((layer) => layer.kind === "group").map((layer) => layer.path))
          }>すべて開く</button>
          <button type="button" className="secondary" onClick={() => setExpanded([])}>すべて閉じる</button>
        </div>
        <div className="layer-list preset-layer-list" aria-label="プリセットのPSDレイヤー">
          {layers.filter((layer) => eligible.has(layer.path)
            && (!activeFilter || matches.has(layer.path))
            && visibleInTree(layer.path)).map((layer) => {
            const isGroup = layer.kind === "group";
            const choice = psdChoiceKind(layer.name);
            const on = baseByPath.get(layer.path) ?? false;
            const role = roles.get(layer.path) ?? unsetRole;
            const effective = previewState === "closed" || previewState === "opened"
              ? preset.openMouth?.[previewState].find((item) => item.path === layer.path)?.visible ?? on
              : role === "base" ? on : role === "show";
            return <div key={layer.path} data-layer-path={layer.path}
              data-aiueo-role={area === "motion" && roleMode === "aiueo" && !isGroup && !editingBase
                ? role : undefined}
              data-open-role={area === "motion" && roleMode === "open" && !isGroup
                ? openLayerRole(preset, layer.path) : undefined}
              data-selected={selectedPath === layer.path ? "true" : "false"}
              className={"layer preset-layer " + (isGroup ? "group" : "")}
              style={{ paddingLeft: 10 + layerDepth(layer.path) * 13 }}>
              {isGroup && <button className="group-toggle preset-expand" type="button"
                aria-expanded={expanded.includes(layer.path)}
                aria-label={layer.name + " [" + layer.path + "] を" +
                  (expanded.includes(layer.path) ? "閉じる" : "開く")}
                onClick={() => setExpanded((old) => old.includes(layer.path)
                  ? old.filter((p) => p !== layer.path) : [...old, layer.path])}>
                {expanded.includes(layer.path) ? "▾" : "▸"}
              </button>}
              <div className="preset-visibility-label">
                {(editingBase || !isGroup) && choice !== "fixed" && <input
                  type={choice === "radio" ? "radio" : "checkbox"}
                  name={choice === "radio"
                    ? "psd-choice-" + preset.id + "-" + (editingBase ? "base" : previewState)
                      + "-" + psdParentPath(layer.path) : undefined}
                  checked={editingBase ? on : effective}
                  onChange={(event) => {
                    const selected = event.target.checked;
                    if (editingBase) onToggle(layer.path, selected);
                    else if (roleMode === "open") {
                      onOpenShapeChange(previewState as "closed" | "opened", layer.path,
                        selected);
                    } else {
                      onAiueoChoiceChange(aiueoKey, layer.path, selected);
                    }
                  }}
                  aria-label={layer.name + " [" + layer.path + "] " +
                    (editingBase ? "基本" : roleMode === "open"
                      ? previewState === "closed" ? "閉じ口" : "開き口" : AIUEO_LABELS[aiueoKey])} />}
                <button type="button" className="preset-layer-select"
                  aria-pressed={selectedPath === layer.path}
                  aria-label={layer.name + " [" + layer.path + "] を選択"}
                  onClick={() => setSelectedPath((previous) =>
                    previous === layer.path ? null : layer.path)}>
                  <span className="preset-layer-name">{layer.name}</span>
                </button>
              </div>
            </div>;
          })}
          {area === "motion" && mouthGroups.length === 0 && <p className="hint">
            対象グループを選択してください。
          </p>}
          {activeFilter && !layers.some((layer) => eligible.has(layer.path)
            && matches.has(layer.path)) &&
            <p className="hint">該当するレイヤーがありません。</p>}
        </div>
        {area === "motion" && hiddenParents.length > 0 && !editingBase &&
          <p className="hint warning" role="status">
            口形対象の親グループが非表示です。「基本」または「通常レイヤー」で親グループをONにしてください。
          </p>}
        <button type="button" className="secondary preset-delete"
          onClick={onDelete}>このプリセットを削除</button>
      </section>
      <section className="panel preset-preview">
        <h2>プレビュー</h2>
        {(selectedLayer || roleMode === "open") && <p className="hint preset-selected-summary" aria-live="polite">
          {selectedLayer
            ? "選択中: " + selectedLayer.name + " [" + selectedLayer.path + "]" +
              (selectedHasBounds ? "" : "（位置情報なし）")
            : "レイヤー名で選択し、「選択位置へ」で拡大できます。"}
        </p>}
        <PresetImagePreview image={shownPreview} alt={preset.name + " のプレビュー"}
          error={shownError} focus={focus}
          selectedFocus={selectedFocus} />
        <p className="hint">全体表示と口元の拡大を切り替えられます。拡大時はドラッグで移動できます。</p>
      </section>
    </div>
  </div>;
}
