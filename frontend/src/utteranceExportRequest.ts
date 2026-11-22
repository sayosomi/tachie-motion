import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset, Presets } from "./presetModel";
import { blinkFrames } from "./blinkTiming";
import { AIUEO_KEYS } from "./presetModel";
import type { LabInfo } from "./useLabStatus";
import type { UtteranceItem } from "./utteranceItems";
import { assertPresetChangePoints } from "./presetChangePoints";

export type ConflictPolicy = "error" | "overwrite";

/** Mirror the saved-layer shape contract without requiring another PSD HTTP read. */
function validAiueoShape(value: unknown, sourcePaths: ReadonlySet<string>): boolean {
  if (!Array.isArray(value) || !value.length || value.length > sourcePaths.size) return false;
  const seen = new Set<string>();
  let selected = false;
  for (const layer of value) {
    if (!layer || typeof layer !== "object" || Array.isArray(layer) ||
        Object.keys(layer).length !== 2 ||
        !Object.hasOwn(layer, "path") || !Object.hasOwn(layer, "visible")) return false;
    const { path, visible } = layer as Record<string, unknown>;
    if (typeof path !== "string" || path.length > 256 ||
        !/^(0|[1-9][0-9]*)(\/(0|[1-9][0-9]*))*$/.test(path) ||
        !sourcePaths.has(path) || seen.has(path) || typeof visible !== "boolean") return false;
    seen.add(path);
    selected ||= visible;
  }
  return selected;
}

function aiueoShapeProblems(preset?: UnifiedPreset): {
  missing: Array<(typeof AIUEO_KEYS)[number]>; unknownKeys: string[];
} {
  const value: unknown = preset?.aiueoMouth;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { missing: [...AIUEO_KEYS], unknownKeys: [] };
  }
  // All saved shape paths must belong to the same source snapshot as base.
  const base: unknown = preset?.base;
  const sourcePaths = new Set<string>();
  if (Array.isArray(base)) {
    for (const layer of base) {
      if (!layer || typeof layer !== "object" || typeof layer.path !== "string") {
        sourcePaths.clear();
        break;
      }
      sourcePaths.add(layer.path);
    }
  }
  const shapes = value as Record<string, unknown>;
  return {
    missing: AIUEO_KEYS.filter((key) => !validAiueoShape(shapes[key], sourcePaths)),
    unknownKeys: Object.keys(shapes).filter((key) =>
      !AIUEO_KEYS.includes(key as typeof AIUEO_KEYS[number])),
  };
}

/** Both single and batch exports require six explicit, valid visible leaves. */
export function aiueoMouthReady(preset?: UnifiedPreset): boolean {
  const { missing, unknownKeys } = aiueoShapeProblems(preset);
  return missing.length === 0 && unknownKeys.length === 0;
}

/** Explain the exact preflight guard shared by individual and batch export.
 * Keep all rejection conditions here, so diagnostics cannot diverge from the
 * boolean used by the existing enable/disable controls.
 */
function singlePresetReadinessError(
  preset: UnifiedPreset | undefined, item: UtteranceItem, lab?: LabInfo,
  collection?: Presets,
): string | null {
  if (!preset) return "割り当てられたプリセットが存在しません。WAV一覧で選び直してください。";
  if (preset.blinkEnabled) {
    if (!collection?.motionGroups?.eyes?.length)
      return "瞬きON：目の動作対象グループが未設定です。プリセットで指定してください。";
    if (!preset.eyes?.closed.some((entry) => entry.visible))
      return "瞬きON：閉じ目レイヤーが未選択です。プリセットで指定してください。";
    if (!blinkFrames(collection.blinkTiming, item.fps))
      return collection?.blinkTiming
        ? `瞬きON：時間設定が${item.fps}fpsでは無効です。プリセットで閉眼時間・間隔・揺らぎを調整してください。`
        : "瞬きON：キャラクター共通の瞬き時間を保存してください。";
  }
  if (item.mode === "none" || preset.mouthMotionEnabled === false) return null;
  if (item.mode === "aiueo") {
    if (lab?.status !== "valid" || !lab.source_identity) {
      if (lab?.status === "missing") return "aiueo：WAVと同名のLABファイルが見つかりません。「なし」または「open」ならLAB不要です。";
      if (lab?.status === "invalid") return "aiueo：LABの内容が不正です。WAV一覧でLABの状態を確認してください。";
      if (lab?.status === "unavailable") return "aiueo：LABの確認に失敗しました。「LABを再確認」を実行してください。";
      return "aiueo：LABを確認中、または有効なLABの同一性情報がありません。「LABを再確認」を実行してください。";
    }
    if (!aiueoMouthReady(preset)) {
      const labels = { a: "あ", i: "い", u: "う", e: "え", o: "お", n: "ん" };
      const { missing, unknownKeys } = aiueoShapeProblems(preset);
      if (missing.length) {
        return `aiueo：プリセット「${preset.name}」の口形（${missing.map((key) => labels[key]).join("・")}）が未選択または不正です。`;
      }
      if (unknownKeys.length) {
        const shown = unknownKeys.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 64))).join("・");
        return `aiueo：プリセット「${preset.name}」の口形に不明なキー（${shown}）があります。`;
      }
    }
    return null;
  }
  if (item.mode !== "open") return "口パク方式が不正です。WAV一覧で選び直してください。";
  const mouth = preset.openMouth;
  if (!mouth || !mouth.opened.length || mouth.closed.length !== mouth.opened.length)
    return `open：プリセット「${preset.name}」の開いた口レイヤーが未設定です。`;
  const base = new Map(preset.base.map((layer) => [layer.path, layer.visible]));
  // The resting mouth is the preset's fixed visibility; the active open
  // pose needs an explicit positive leaf even if that leaf matches the base.
  return mouth.opened.some((layer) => base.has(layer.path) && layer.visible)
    ? null : `open：プリセット「${preset.name}」の開いた口レイヤーが未選択です。`;
}

export function exportReadinessError(
  preset: UnifiedPreset | undefined, item: UtteranceItem, lab?: LabInfo,
  collection?: Presets,
): string | null {
  const initialError = singlePresetReadinessError(preset, item, lab, collection);
  if (initialError) return initialError;
  const changes = item.presetChanges ?? [];
  try {
    assertPresetChangePoints(changes, item.wav.samples,
      new Set(collection?.items.map((value) => value.id) ?? []));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  for (const point of changes) {
    const next = collection?.items.find((value) => value.id === point.presetId);
    const error = singlePresetReadinessError(next, item, lab, collection);
    if (error) return `変更点 ${(point.sample / item.wav.sample_rate).toFixed(3)}秒：${error}`;
  }
  return null;
}

export function exportReady(
  preset: UnifiedPreset | undefined, item: UtteranceItem, lab?: LabInfo,
  collection?: Presets,
): boolean {
  return exportReadinessError(preset, item, lab, collection) === null;
}

/** Only a LAB-driven, enabled aiueo movie may reserve a LAB identity. */
export function effectiveLabSourceIdentity(
  item: Pick<UtteranceItem, "mode">,
  preset: Pick<UnifiedPreset, "mouthMotionEnabled">,
  sourceIdentity?: string | null,
  timelinePresets: readonly Pick<UnifiedPreset, "mouthMotionEnabled">[] = [],
): string | null {
  return item.mode === "aiueo" &&
    [preset, ...timelinePresets].some((entry) => entry.mouthMotionEnabled !== false)
    ? (sourceIdentity ?? null) : null;
}

export function exportPayload(
  draft: PresetDraft, item: UtteranceItem, preset: UnifiedPreset,
  basename: string, conflictPolicy: ConflictPolicy, labSourceIdentity?: string | null,
) {
  const changes = item.presetChanges ?? [];
  const ids = new Set(draft.collection.items.map((value) => value.id));
  assertPresetChangePoints(changes, item.wav.samples, ids);
  const timelinePresets = changes.map((point) => {
    const next = draft.collection.items.find((value) => value.id === point.presetId);
    if (!next) throw new Error("変更点に存在しないプリセットが含まれています");
    const error = singlePresetReadinessError(next, item,
      labSourceIdentity ? { status: "valid", source_identity: labSourceIdentity } as LabInfo : undefined,
      draft.collection);
    if (error) throw new Error("変更点のプリセットが書き出せません：" + error);
    return { sample: point.sample, presetId: point.presetId, preset: next };
  });
  // PSD eye-group bindings belong to the entire WAV timeline. A later
  // preset may enable blinking even when the initial preset disables it.
  const usesBlink = preset.blinkEnabled ||
    timelinePresets.some(({ preset: next }) => next.blinkEnabled);
  const timing = preset.blinkEnabled
    ? blinkFrames(draft.collection.blinkTiming, item.fps) : null;
  if (preset.blinkEnabled && (
      !timing || !draft.collection.motionGroups?.eyes?.length ||
      !preset.eyes?.closed.some((entry) => entry.visible))) {
    throw new Error("瞬き時間・目のレイヤー設定が未完了です");
  }
  return {
    psd: draft.path,
    wav: item.wavPath,
    source_identity: item.wav.source_identity,
    fingerprint: draft.fingerprint,
    layers: preset.base,
    mouth: preset.mouthMotionEnabled === false ? null : (preset.openMouth ?? null),
    aiueo_mouth: preset.mouthMotionEnabled === false ? null : (preset.aiueoMouth ?? null),
    mouth_groups: draft.collection.motionGroups?.mouth ?? null,
    lab_source_identity: effectiveLabSourceIdentity(item, preset, labSourceIdentity,
      timelinePresets.map((value) => value.preset)),
    mode: preset.mouthMotionEnabled === false ? "none" : item.mode,
    blink_enabled: preset.blinkEnabled,
    eyes: preset.blinkEnabled ? preset.eyes ?? null : null,
    eye_groups: usesBlink ? draft.collection.motionGroups?.eyes ?? null : null,
    blink_timing: timing,
    output_dir: item.outputDir,
    basename,
    conflict_policy: conflictPolicy,
    fps: item.fps,
    ...(timelinePresets.length ? { timeline_changes: timelinePresets.map(({ sample, presetId, preset: next }) => ({
      sample, preset_id: presetId,
      layers: next.base,
      mouth: next.mouthMotionEnabled === false ? null : (next.openMouth ?? null),
      aiueo_mouth: next.mouthMotionEnabled === false ? null : (next.aiueoMouth ?? null),
      mode: next.mouthMotionEnabled === false ? "none" : item.mode,
      blink_enabled: next.blinkEnabled,
      eyes: next.blinkEnabled ? (next.eyes ?? null) : null,
      blink_timing: next.blinkEnabled
        ? blinkFrames(draft.collection.blinkTiming, item.fps) : null,
    })) } : {}),
  };
}
