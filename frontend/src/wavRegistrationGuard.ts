import type { Layer } from "./LayerTree";
import { matchesSource, readPresetDraft, type PresetDraft } from "./presetDraftStorage";

const CHANGED_MESSAGE = "登録開始時のプリセットが変更または削除されました。現在のプリセットを確認してWAVを登録し直してください";

/** Pin the preset actually offered when WAV registration starts. The latest
 * browser storage is checked both before and after the asynchronous WAV API.
 * Do not treat a surviving preset ID as proof that its PSD choices are valid.
 */
export function guardWavRegistrationPreset(
  draft: PresetDraft, presetId: string, psdLayers: Layer[],
): () => void {
  const snapshot = (source: PresetDraft) => {
    const preset = source.collection.items.find((item) => item.id === presetId);
    return preset ? JSON.stringify({ preset, motionGroups: source.collection.motionGroups,
      blinkTiming: source.collection.blinkTiming }) : null;
  };
  const expected = snapshot(draft);
  const verify = () => {
    const latest = readPresetDraft();
    if (!expected || !latest || latest.path !== draft.path ||
        !matchesSource(latest, draft.fingerprint, psdLayers) ||
        snapshot(latest) !== expected) {
      throw new Error(CHANGED_MESSAGE);
    }
  };
  verify();
  return verify;
}
