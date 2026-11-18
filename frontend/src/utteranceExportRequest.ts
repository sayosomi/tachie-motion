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

export function exportReady(
  preset: UnifiedPreset | undefined, item: UtteranceItem, lab?: LabInfo,
  collection?: Presets,
): boolean {
  if (!preset) return false;
  if (preset.blinkEnabled && (
      !collection?.motionGroups?.eyes?.length ||
      !preset.eyes?.closed.some((entry) => entry.visible) ||
      !blinkFrames(collection.blinkTiming, item.fps))) return false;
  if (item.mode === "none" || preset.mouthMotionEnabled === false) return true;
  if (item.mode === "aiueo") return lab?.status === "valid" && !!lab.source_identity && aiueoMouthReady(preset);
  const mouth = preset.openMouth;
  if (item.mode !== "open" || !mouth || !mouth.opened.length ||
      mouth.closed.length !== mouth.opened.length) return false;
  const base = new Map(preset.base.map((layer) => [layer.path, layer.visible]));
  // The resting mouth is always the current fixed-layer visibility.
  // The active pose is explicitly selected, even if a selected leaf matches base.
  return mouth.opened.some((layer) => base.has(layer.path) && layer.visible);
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
