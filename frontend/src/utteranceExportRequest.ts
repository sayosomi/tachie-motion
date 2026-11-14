import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import type { UtteranceItem } from "./utteranceItems";

export type ConflictPolicy = "error" | "overwrite";

/** Both single and all-item exports must share the exact same render inputs. */
export function exportReady(preset: UnifiedPreset | undefined, item: UtteranceItem): boolean {
  if (!preset || preset.blinkEnabled) return false;
  if (item.mode === "none") return true;
  const mouth = preset.openMouth;
  return item.mode === "open" && Boolean(
    mouth && mouth.closed.length > 0 &&
    mouth.closed.length === mouth.opened.length &&
    JSON.stringify(mouth.closed) !== JSON.stringify(mouth.opened),
  );
}

export function exportPayload(
  draft: PresetDraft, item: UtteranceItem, preset: UnifiedPreset,
  basename: string, conflictPolicy: ConflictPolicy,
) {
  return {
    psd: draft.path,
    wav: item.wavPath,
    source_identity: item.wav.source_identity,
    fingerprint: draft.fingerprint,
    layers: preset.base,
    mouth: preset.openMouth ?? null,
    mode: item.mode,
    blink_enabled: preset.blinkEnabled,
    output_dir: item.outputDir,
    basename,
    conflict_policy: conflictPolicy,
    fps: item.fps,
  };
}
