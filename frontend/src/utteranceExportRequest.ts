import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset, Presets } from "./presetModel";
import { blinkFrames } from "./blinkTiming";
import { AIUEO_KEYS } from "./presetModel";
import type { LabInfo } from "./useLabStatus";
import type { UtteranceItem } from "./utteranceItems";

export type ConflictPolicy = "error" | "overwrite";

/** Both single and all-item exports must share the exact same render inputs. */
/** All six phonemes require an explicitly selected visible mouth leaf. */
export function aiueoMouthReady(preset?: UnifiedPreset): boolean {
  return Boolean(preset?.aiueoMouth &&
    AIUEO_KEYS.every((key) => preset.aiueoMouth![key].some((layer) => layer.visible)));
}

/** Explain the exact preflight guard shared by individual and batch export.
 * Keep all rejection conditions here, so diagnostics cannot diverge from the
 * boolean used by the existing enable/disable controls.
 */
export function exportReadinessError(
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
      const missing = AIUEO_KEYS.filter((key) =>
        !preset.aiueoMouth?.[key].some((layer) => layer.visible));
      return `aiueo：プリセット「${preset.name}」の口形（${missing.map((key) => labels[key]).join("・")}）が未選択です。`;
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
): string | null {
  return item.mode === "aiueo" && preset.mouthMotionEnabled !== false
    ? (sourceIdentity ?? null) : null;
}

export function exportPayload(
  draft: PresetDraft, item: UtteranceItem, preset: UnifiedPreset,
  basename: string, conflictPolicy: ConflictPolicy, labSourceIdentity?: string | null,
) {
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
    lab_source_identity: effectiveLabSourceIdentity(item, preset, labSourceIdentity),
    mode: preset.mouthMotionEnabled === false ? "none" : item.mode,
    blink_enabled: preset.blinkEnabled,
    eyes: preset.blinkEnabled ? preset.eyes ?? null : null,
    eye_groups: preset.blinkEnabled ? draft.collection.motionGroups?.eyes ?? null : null,
    blink_timing: timing,
    output_dir: item.outputDir,
    basename,
    conflict_policy: conflictPolicy,
    fps: item.fps,
  };
}
