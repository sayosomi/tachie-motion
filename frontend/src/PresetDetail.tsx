import { useEffect, useState } from "react";
import PresetNameEditor from "./PresetNameEditor";
import type { BlinkTiming } from "./blinkTiming";
import BlinkTimingEditor from "./BlinkTimingEditor";
import type { Layer } from "./LayerTree";
import type { UnifiedPreset, AiueoKey } from "./presetModel";
import { AIUEO_KEYS, AIUEO_LABELS, aiueoLayerRole, openLayerRole } from "./presetModel";
import PresetImagePreview from "./PresetImagePreview";
import type { ThumbnailView } from "./thumbnailView";
import MotionGroupSelector from "./MotionGroupSelector";
import { isMouthLayer } from "./motionGroups";
import { psdChoiceKind, psdParentPath, derivedEyeRadioGroupHides } from "./psdChoice";
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
  onRename: (name: string) => string | null;
  onToggle: (path: string, visible: boolean) => void;
  mouthGroups: string[];
  eyeGroups: string[];
  onMouthGroupsChange: (groups: string[]) => void;
  onEyeGroupsChange: (groups: string[]) => void;
  onMouthMotionChange: (enabled: boolean) => void;
  onBlinkChange: (enabled: boolean) => void;
  blinkTiming?: BlinkTiming;
  onBlinkTimingChange: (timing: BlinkTiming) => boolean;
  onEyeShapeChange: (pose: "opened" | "closed", path: string, visible: boolean) => void;
  onOpenShapeChange: (shape: "closed" | "opened", path: string, visible: boolean) => void;
  onAiueoChoiceChange: (key: AiueoKey, path: string, visible: boolean) => void;
  onClearMotionShape: (selection: "open" | "eyes" | AiueoKey) => void;
  onDelete: () => void;
  onThumbnailSave: (view: ThumbnailView) => boolean;
};

type PreviewState = "base" | "closed" | "opened" | `aiueo-${AiueoKey}`
  | "eyes-opened" | "eyes-closed";
type ShapePreview = { key: string; image?: string; error?: string };

export default function PresetDetail({
  preset, layers, preview, previewError, browserRenderer, sourceChanged = false,
  previewLoading = false, verifySource = async () => {}, sourceIdentity = "",
  sourcePath, fingerprint, canvasWidth, canvasHeight, nameDraft,
  onNameDraftChange, onBack, onRename, onToggle, mouthGroups, eyeGroups,
  onMouthGroupsChange, onEyeGroupsChange, onMouthMotionChange, onBlinkChange,
  onEyeShapeChange, onOpenShapeChange, onAiueoChoiceChange, onClearMotionShape, onDelete,
  onThumbnailSave,
  blinkTiming, onBlinkTimingChange,
}: Props) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<"normal" | "motion">("normal");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>("base");
  const [roleMode, setRoleMode] = useState<"open" | "aiueo">("open");
  const [motionKind, setMotionKind] = useState<"mouth" | "eyes">("mouth");
  const [aiueoKey, setAiueoKey] = useState<AiueoKey>("a");
  const [shapePreview, setShapePreview] = useState<ShapePreview | null>(null);
  useEffect(() => {
    setExpanded(layers.filter((layer) => layer.kind === "group").map((layer) => layer.path));
    setSelectedPath(null);
  }, [layers]);

  const editingBase = area === "normal" || previewState === "base";
  const eyePose = "closed" as const;
  const selectedGroups = motionKind === "mouth" ? mouthGroups : eyeGroups;
  const motionEnabled = motionKind === "mouth"
    ? preset.mouthMotionEnabled !== false : preset.blinkEnabled;
  const baseByPath = new Map(preset.base.map((layer) => [layer.path, layer.visible]));
  const roles = new Map(layers.filter((layer) => layer.kind !== "group")
    .map((layer) => {
      if (motionKind === "eyes") {
        const eye = preset.eyes?.[eyePose].find((entry) => entry.path === layer.path);
        return [layer.path, eye === undefined ? "base" : eye.visible ? "show" : "hide"];
      }
      return [layer.path, roleMode === "open"
        ? openLayerRole(preset, layer.path) : aiueoLayerRole(preset, aiueoKey, layer.path)];
    }));
  const unsetRole = motionKind === "mouth" && roleMode === "open" ? "none" : "base";
  // Base visibility must be editable for every PSD layer, including motion
  // targets. The motion tab is still scoped to explicitly assigned groups.
  const eligible = new Set(layers.filter((layer) =>
    area === "motion" ? isMouthLayer(layer.path, selectedGroups) : true
  ).map((layer) => layer.path));
  const currentMotionShape = motionKind === "eyes" ? preset.eyes?.closed
    : roleMode === "open" ? preset.openMouth?.opened : preset.aiueoMouth?.[aiueoKey];
  const hasConfiguredMotionShape = currentMotionShape?.some((entry) =>
    eligible.has(entry.path) && entry.visible) ?? false;
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
  }, [queryText, area, mouthGroups.join("/"), eyeGroups.join("/"), motionKind]);

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
    const root = selectedGroups.filter((group) => isMouthLayer(path, [group]))
      .sort((a, b) => b.length - a.length)[0];
    return root ? path.split("/").length - root.split("/").length : 0;
  }

  const shape = previewState === "base" ? undefined :
    previewState === "closed" || previewState === "opened"
      ? preset.openMouth?.[previewState]
      : previewState === "eyes-opened" || previewState === "eyes-closed"
        ? preset.eyes?.[eyePose]
        : preset.aiueoMouth?.[previewState.slice(6) as AiueoKey];
  const unconfiguredOpened = previewState === "opened" &&
    !preset.openMouth?.opened.some((layer) => layer.visible);
  const shapeKey = JSON.stringify([sourcePath, fingerprint, sourceIdentity,
    preset.base, shape, previewState, selectedGroups, layers, preset.mouthMotionEnabled, preset.blinkEnabled]);
  useEffect(() => {
    if (previewState === "base" || !selectedGroups.length
        || (area === "motion" && !motionEnabled)
        || sourceChanged || previewLoading) return;
    const abort = new AbortController();
    const overrides = new Map((shape ?? []).map((item) => [item.path, item.visible]));
    const closedRadioGroups = motionKind === "eyes"
      ? derivedEyeRadioGroupHides(layers, shape, selectedGroups) : new Set<string>();
    const editable = new Set(layers.filter((layer) => layer.kind !== "group"
      && !layer.name.startsWith("!")
      && isMouthLayer(layer.path, selectedGroups)).map((layer) => layer.path));
    const states = preset.base.map((layer) => ({
      path: layer.path,
      visible: closedRadioGroups.has(layer.path) ? false
        : editable.has(layer.path) ? (overrides.get(layer.path) === true) : layer.visible,
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
    preset.mouthMotionEnabled, unconfiguredOpened, motionKind,
    area, motionEnabled]);

  // Unselected editable mouth/eye leaves are hidden instead of inheriting base.
  const usingBasePreview = previewState === "base"
    || !selectedGroups.length || (area === "motion" && !motionEnabled);
  const shownPreview = sourceChanged ? undefined :
    usingBasePreview ? preview : shapePreview?.key === shapeKey ? shapePreview.image : undefined;
  const shownError = sourceChanged ? "PSDが変更されました。再読み込みしてください。" :
    usingBasePreview ? previewError : shapePreview?.key === shapeKey ? shapePreview.error : undefined;
  const focusPaths = new Set((motionKind === "eyes" ? [
    ...(preset.eyes?.closed ?? []),
  ] : roleMode === "open" ? [
    ...(preset.openMouth?.opened ?? []),
  ] : AIUEO_KEYS.flatMap((key) => preset.aiueoMouth?.[key] ?? [])).map((item) => item.path));
  const hasBounds = (layer: Layer) => layer.bbox.length === 4
    && layer.bbox.every(Number.isFinite)
    && layer.bbox[2] > layer.bbox[0] && layer.bbox[3] > layer.bbox[1];
  // A mouth must be reachable before its first shape is authored.
  // Prefer assigned leaves, then a selected mouth-layer, then the original
  // PSD motion groups' descendants, finally the groups' own bounds.
  const assignedBounds = layers.filter((layer) =>
    focusPaths.has(layer.path) && hasBounds(layer));
  const selectedMouth = layers.find((layer) => layer.path === selectedPath
    && isMouthLayer(layer.path, selectedGroups) && hasBounds(layer));
  const unassignedLeaves = layers.filter((layer) => layer.kind !== "group"
    && selectedGroups.some((group) => layer.path.startsWith(group + "/"))
    && hasBounds(layer));
  const focusBounds = assignedBounds.length ? assignedBounds
    : selectedMouth ? [selectedMouth]
    : unassignedLeaves.length ? unassignedLeaves
    : layers.filter((layer) => selectedGroups.includes(layer.path) && hasBounds(layer));
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

  function motionPose(kind: "mouth" | "eyes"): PreviewState {
    return kind === "eyes" ? "eyes-closed"
      : roleMode === "open" ? "opened" : `aiueo-${aiueoKey}`;
  }

  function selectMotion(kind: "mouth" | "eyes") {
    setMotionKind(kind);
    const enabled = kind === "eyes" ? preset.blinkEnabled
      : preset.mouthMotionEnabled !== false;
    setPreviewState(enabled ? motionPose(kind) : "base");
    setSelectedPath(null);
    setQuery("");
  }

  function toggleCurrentMotion(enabled: boolean) {
    if (motionKind === "mouth") onMouthMotionChange(enabled);
    else onBlinkChange(enabled);
    setPreviewState(enabled ? motionPose(motionKind) : "base");
    setSelectedPath(null);
  }

  return <div className="preset-detail-page">
    <div className="preset-detail-head">
      <button type="button" className="secondary" onClick={onBack}>← 一覧へ</button>
    </div>
    <div className="preset-layout">
      <section className="panel preset-editor" data-role-mode={roleMode} data-edit-area={area}>
        <h2>編集</h2>
        <PresetNameEditor key={preset.id} name={preset.name} draft={nameDraft}
          onDraftChange={onNameDraftChange} onCommit={onRename} />}
        <div className="preset-role-tabs preset-area-tabs" role="group" aria-label="編集区分">
          <button type="button" aria-pressed={area === "normal"}
            onClick={() => { setArea("normal"); setPreviewState("base"); setQuery(""); }}>
            固定レイヤー
          </button>
          <button type="button" aria-pressed={area === "motion"}
            onClick={() => { setArea("motion"); selectMotion(motionKind); }}>
            可動レイヤー
          </button>
        </div>
        {area === "motion" && <>
          <div className="preset-motion-controls">
            <div className="preset-role-tabs preset-motion-tabs" role="tablist" aria-label="パーツ">
              <button type="button" role="tab" aria-selected={motionKind === "mouth"}
                aria-controls="preset-motion-content"
                onClick={() => selectMotion("mouth")}>口</button>
              <button type="button" role="tab" aria-selected={motionKind === "eyes"}
                aria-controls="preset-motion-content"
                onClick={() => selectMotion("eyes")}>目</button>
            </div>
            <label className="preset-motion-switch">
              <input type="checkbox" aria-label={motionKind === "mouth" ? "口 ON" : "目 ON"}
                checked={motionEnabled} onChange={(event) => toggleCurrentMotion(event.target.checked)} />
              ON
            </label>
          </div>
          {motionEnabled && <div id="preset-motion-content" role="tabpanel"
            aria-label={motionKind === "mouth" ? "口" : "目"}
            className="preset-motion-settings">
            {motionKind === "mouth" && <>
              <div className="preset-role-tabs preset-mode-tabs" role="group" aria-label="口の方式">
                <button type="button" aria-pressed={roleMode === "open"}
                  onClick={() => { setRoleMode("open"); setPreviewState("opened"); }}>Open</button>
                <button type="button" aria-pressed={roleMode === "aiueo"}
                  onClick={() => { setRoleMode("aiueo"); setPreviewState(`aiueo-${aiueoKey}`); }}>aiueo</button>
              </div>
              {roleMode === "aiueo" && <div className="preset-aiueo-choice" role="group" aria-label="編集する口形">
                {AIUEO_KEYS.map((key) => <button key={key} type="button"
                  aria-pressed={previewState === `aiueo-${key}`}
                  onClick={() => { setAiueoKey(key); setPreviewState(`aiueo-${key}`); }}>
                  {AIUEO_LABELS[key]}
                </button>)}
              </div>}
            </>}
            {motionKind === "eyes" && <BlinkTimingEditor timing={blinkTiming}
              onSave={onBlinkTimingChange} />}
            <MotionGroupSelector groups={layers.filter((layer) => layer.kind === "group")}
              selected={selectedGroups} onChange={motionKind === "mouth"
                ? onMouthGroupsChange : onEyeGroupsChange} />
          </div>}
        </>}
        {(area === "normal" || (motionEnabled && selectedGroups.length > 0)) && <>
        {area === "motion" && <p className="preset-motion-instruction">
          {motionKind === "eyes" ? "② 閉じた目のレイヤー"
            : roleMode === "open" ? "② 開いた口のレイヤー"
              : `② 「${AIUEO_LABELS[aiueoKey]}」の口のレイヤー`}
          {!hasConfiguredMotionShape && "を選択してください"}
        </p>}
        {area === "motion" && hasConfiguredMotionShape && <button
          type="button" className="secondary preset-clear-shape"
          onClick={() => onClearMotionShape(motionKind === "eyes" ? "eyes"
            : roleMode === "open" ? "open" : aiueoKey)}>
          {motionKind === "eyes" ? "閉じ目の選択を解除"
            : roleMode === "open" ? "Openの選択を解除"
              : `「${AIUEO_LABELS[aiueoKey]}」の選択を解除`}
        </button>}
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
            const effective = editingBase ? on :
              currentMotionShape?.some((entry) => entry.path === layer.path && entry.visible) ?? false;
            const applyVisibility = (visible: boolean) => {
              if (editingBase) onToggle(layer.path, visible);
              else if (motionKind === "eyes") onEyeShapeChange(eyePose, layer.path, visible);
              else if (roleMode === "open") onOpenShapeChange("opened", layer.path, visible);
              else onAiueoChoiceChange(aiueoKey, layer.path, visible);
            };
            const selectRowVisibility = () => {
              if (isGroup || choice === "fixed") return;
              applyVisibility(choice === "radio" ? true : !(editingBase ? on : effective));
            };
            return <div key={layer.path} data-layer-path={layer.path}
              data-aiueo-role={area === "motion" && motionKind === "mouth" &&
                roleMode === "aiueo" && !isGroup && !editingBase ? role : undefined}
              data-open-role={area === "motion" && motionKind === "mouth" &&
                roleMode === "open" && !isGroup ? openLayerRole(preset, layer.path) : undefined}
              data-eye-role={area === "motion" && motionKind === "eyes" &&
                !isGroup && !editingBase ? role : undefined}
              data-selected={selectedPath === layer.path ? "true" : "false"}
              className={"layer preset-layer " + (isGroup ? "group" : "")}
              style={{ paddingLeft: 10 + layerDepth(layer.path) * 13 }}
              onClick={(event) => {
                // Native controls and the layer-name button handle their own click.
                // Blank row space edits fixed and movable layers exactly once.
                if ((event.target as HTMLElement).closest("button, input")) return;
                selectRowVisibility();
                setSelectedPath((previous) =>
                  previous === layer.path ? null : layer.path);
              }}>
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
                    applyVisibility(event.target.checked);
                    setSelectedPath(layer.path);
                  }}
                  aria-label={layer.name + " [" + layer.path + "] " +
                    (editingBase ? "固定" : motionKind === "eyes" ? "close"
                      : roleMode === "open" ? "open" : AIUEO_LABELS[aiueoKey])} />}
                <button type="button" className="preset-layer-select"
                  aria-pressed={selectedPath === layer.path}
                  aria-label={layer.name + " [" + layer.path + "] " +
                    (!isGroup && choice !== "fixed"
                      ? "を選択・切替" : "を選択")}
                  onClick={() => {
                    selectRowVisibility();
                    setSelectedPath((previous) =>
                      previous === layer.path ? null : layer.path);
                  }}>
                  <span className="preset-layer-name">{layer.name}</span>
                </button>
              </div>
            </div>;
          })}
          {activeFilter && !layers.some((layer) => eligible.has(layer.path)
            && matches.has(layer.path)) &&
            <p className="hint">該当するレイヤーがありません。</p>}
        </div>
        {area === "motion" && hiddenParents.length > 0 && !editingBase &&
          <p className="hint warning" role="status">
            {motionKind === "eyes" ? "目の対象" : "口形対象"}の親グループが非表示です。「固定レイヤー」で親グループをONにしてください。
          </p>}
        </>}
        <button type="button" className="secondary preset-delete"
          onClick={onDelete}>このプリセットを削除</button>
      </section>
      <section className="panel preset-preview">
        <h2>プレビュー</h2>
        {(area === "normal" || (motionEnabled && selectedGroups.length > 0))
          && (selectedLayer || roleMode === "open" || motionKind === "eyes")
          && <p className="hint preset-selected-summary" aria-live="polite">
          {selectedLayer
            ? "選択中: " + selectedLayer.name + " [" + selectedLayer.path + "]" +
              (selectedHasBounds ? "" : "（位置情報なし）")
            : "レイヤー名で選択し、「選択位置へ」で拡大できます。"}
        </p>}
        <PresetImagePreview image={shownPreview} alt={preset.name + " のプレビュー"}
          error={shownError} focus={area === "motion" && !motionEnabled ? undefined : focus}
          focusLabel={motionKind === "eyes" && area === "motion" ? "目元へ" : "口元へ"}
          selectedFocus={selectedFocus}
          onThumbnailSave={usingBasePreview && !sourceChanged && !previewLoading
            ? onThumbnailSave : undefined} />
        {area === "motion" && motionEnabled && selectedGroups.length > 0 &&
          motionKind === "mouth" && unconfiguredOpened &&
          preset.mouthMotionEnabled !== false
          && !sourceChanged && <p className="hint warning">口のopenを指定してください</p>}
        {(area === "normal" || motionEnabled) &&
          <p className="hint">全体表示と{area === "motion" && motionKind === "eyes" ? "目元" : "口元"}の拡大を切り替えられます。拡大時はドラッグで移動できます。</p>}
      </section>
    </div>
  </div>;
}
