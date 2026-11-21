import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import { blinkFrames } from "./blinkTiming";

export const MAX_IDLE_FRAMES = 216_000;
export type IdleFps = 24 | 30 | 60;

/** Keep the exact frame count as the editable source of truth. */
export function parseIdleFrames(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const frames = Number(value);
  return Number.isSafeInteger(frames) && frames <= MAX_IDLE_FRAMES ? frames : null;
}

export function idleReadinessError(
  draft: PresetDraft | null, preset: UnifiedPreset | undefined,
  sourceIdentity: string | null, frames: string, fps: IdleFps,
): string | null {
  if (!draft || !sourceIdentity) return "保存済みPSDの確認が必要です。プリセット画面で素材を登録してください。";
  if (!preset) return "書き出し用プリセットを選んでください。";
  if (parseIdleFrames(frames) === null) return "フレーム数は1～216000の整数で入力してください。";
  if (preset.blinkEnabled) {
    if (!draft.collection.motionGroups?.eyes?.length)
      return "瞬きON：目の動作対象グループをプリセットで指定してください。";
    if (!preset.eyes?.closed.some((entry) => entry.visible))
      return "瞬きON：閉じ目レイヤーをプリセットで明示選択してください。";
    if (!blinkFrames(draft.collection.blinkTiming, fps))
      return "瞬きON：共通の瞬き時間がこのfpsでは無効です。プリセットで確認してください。";
  }
  return null;
}

/** Backend independently revalidates every field before media publication. */
export function idleExportPayload(
  draft: PresetDraft, preset: UnifiedPreset, sourceIdentity: string,
  frameCount: number, fps: IdleFps, outputDir: string, basename: string,
  conflictPolicy: "error" | "overwrite", progressId: string,
) {
  const timing = preset.blinkEnabled ? blinkFrames(draft.collection.blinkTiming, fps) : null;
  if (idleReadinessError(draft, preset, sourceIdentity, String(frameCount), fps)) {
    throw new Error("プリセットまたは待機MOVの設定が不正です");
  }
  return {
    psd: draft.path,
    fingerprint: draft.fingerprint,
    source_identity: sourceIdentity,
    layers: preset.base,
    frame_count: frameCount,
    fps,
    blink_enabled: preset.blinkEnabled,
    eyes: preset.blinkEnabled ? preset.eyes ?? null : null,
    eye_groups: preset.blinkEnabled ? draft.collection.motionGroups?.eyes ?? null : null,
    blink_timing: timing,
    output_dir: outputDir,
    basename,
    conflict_policy: conflictPolicy,
    progress_id: progressId,
  };
}
