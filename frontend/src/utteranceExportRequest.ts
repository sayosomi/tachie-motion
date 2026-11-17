import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import { AIUEO_KEYS } from "./presetModel";
import type { LabInfo } from "./useLabStatus";
import type { UtteranceItem } from "./utteranceItems";

export type ConflictPolicy = "error" | "overwrite";

/** Both single and all-item exports must share the exact same render inputs. */
export function aiueoMouthReady(preset?: UnifiedPreset): boolean {
  return Boolean(preset?.aiueoMouth &&
    AIUEO_KEYS.every((key) => preset.aiueoMouth![key].length > 0));
}

export function exportReady(
  preset: UnifiedPreset | undefined, item: UtteranceItem, lab?: LabInfo,
): boolean {
  if (!preset || preset.blinkEnabled) return false;
  if (item.mode === "none" || preset.mouthMotionEnabled === false) return true;
  if (item.mode === "aiueo") return lab?.status === "valid" && !!lab.source_identity && aiueoMouthReady(preset);
  const mouth = preset.openMouth;
  return item.mode === "open" && Boolean(
    mouth && mouth.closed.length > 0 &&
    mouth.closed.length === mouth.opened.length &&
    JSON.stringify(mouth.closed) !== JSON.stringify(mouth.opened),
  );
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
    output_dir: item.outputDir,
    basename,
    conflict_policy: conflictPolicy,
    fps: item.fps,
  };
}
