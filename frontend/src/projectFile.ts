import type { Layer } from "./LayerTree";
import {
  parseCharacterProfile, serializeCharacterProfile, type CharacterProfile,
} from "./characterProfile";
import type { PresetDraft } from "./presetDraftStorage";
import type { UtteranceItem, WavData } from "./utteranceItems";

export const PROJECT_FORMAT = "tachie-motion-project";
export const PROJECT_VERSION = 1;
export const MAX_PROJECT_BYTES = 4_000_000;
const MAX_UTTERANCES = 2000;
const MAX_PATH_LENGTH = 8192;

export type ProjectUtterance = Pick<UtteranceItem,
  "id" | "registrationOrder" | "wavPath" | "presetId" | "mode" |
  "fps" | "outputDir" | "basename" | "conflictChoice" | "saveAsName"> & {
  wav: WavData;
};
export type ProjectFile = {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  character: CharacterProfile;
  items: ProjectUtterance[];
  selectedId: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("制作プロジェクトJSONの項目が不正です");
  }
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PATH_LENGTH && !value.includes("\0") &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"));
}

function item(value: unknown, ids: Set<string>): ProjectUtterance {
  fields(value, ["id", "registrationOrder", "wavPath", "wav", "presetId",
    "mode", "fps", "outputDir", "basename", "conflictChoice", "saveAsName"]);
  if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 256 ||
      Object.hasOwn(Object.prototype, value.id) || ids.has(value.id) ||
      typeof value.registrationOrder !== "number" || !Number.isSafeInteger(value.registrationOrder) ||
      (value.registrationOrder as number) < 1 ||
      !absolutePath(value.wavPath) ||
      typeof value.presetId !== "string" ||
      (value.mode !== "none" && value.mode !== "open") ||
      ![24, 30, 60].includes(value.fps as number) ||
      !absolutePath(value.outputDir) ||
      typeof value.basename !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.basename) ||
      (value.conflictChoice !== "overwrite" && value.conflictChoice !== "rename") ||
      (value.saveAsName !== null &&
        (typeof value.saveAsName !== "string" ||
         !/^[A-Za-z0-9_-]{1,64}$/.test(value.saveAsName)))) {
    throw new Error("制作プロジェクトJSONのWAV設定が不正です");
  }
  fields(value.wav, ["samples", "sample_rate", "duration_seconds", "source_identity"]);
  const w = value.wav;
  if (typeof w.samples !== "number" || !Number.isSafeInteger(w.samples) || (w.samples as number) < 1 ||
      typeof w.sample_rate !== "number" || !Number.isSafeInteger(w.sample_rate) || (w.sample_rate as number) < 1 ||
      typeof w.duration_seconds !== "number" || !Number.isFinite(w.duration_seconds) ||
      Math.abs(w.duration_seconds - (w.samples as number) / (w.sample_rate as number)) > 0.001 ||
      typeof w.source_identity !== "string" ||
      !/^[0-9]+(:[0-9]+){4}$/.test(w.source_identity)) {
    throw new Error("制作プロジェクトJSONのWAV参照情報が不正です");
  }
  ids.add(value.id);
  return value as unknown as ProjectUtterance;
}

export function parseProjectFile(text: string): ProjectFile {
  if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) {
    throw new Error("制作プロジェクトJSONが大きすぎます");
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error("制作プロジェクトJSONを解析できません"); }
  fields(value, ["format", "version", "character", "items", "selectedId"]);
  if (value.format !== PROJECT_FORMAT || value.version !== PROJECT_VERSION) {
    throw new Error("未対応の制作プロジェクトJSON形式・バージョンです");
  }
  const character = parseCharacterProfile(JSON.stringify(value.character));
  if (!Array.isArray(value.items) || value.items.length > MAX_UTTERANCES) {
    throw new Error("制作プロジェクトJSONのWAV件数が不正です");
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  const allowedPresets = new Set(character.collection.items.map((preset) => preset.id));
  const items = value.items.map((entry: unknown) => {
    const parsed = item(entry, ids);
    if (orders.has(parsed.registrationOrder) || !allowedPresets.has(parsed.presetId)) {
      throw new Error("制作プロジェクトJSONのWAV順序またはプリセット参照が不正です");
    }
    orders.add(parsed.registrationOrder);
    return parsed;
  });
  if (value.selectedId !== null &&
    (typeof value.selectedId !== "string" || !ids.has(value.selectedId))) {
    throw new Error("制作プロジェクトJSONの選択項目が不正です");
  }
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, character, items,
    selectedId: value.selectedId as string | null };
}

/** Save settings only. Audio, PSD bytes, thumbnails and prior render results never enter JSON. */
export function serializeProjectFile(
  draft: PresetDraft, layers: Layer[], items: UtteranceItem[], selectedId: string | null,
): string {
  const character = parseCharacterProfile(
    serializeCharacterProfile(draft.path, draft.fingerprint, layers, draft.collection));
  const project: ProjectFile = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, character,
    items: items.map((value) => ({
      id: value.id, registrationOrder: value.registrationOrder,
      wavPath: value.wavPath, wav: {
        samples: value.wav.samples, sample_rate: value.wav.sample_rate,
        duration_seconds: value.wav.duration_seconds,
        source_identity: value.wav.source_identity,
      },
      presetId: value.presetId, mode: value.mode, fps: value.fps,
      outputDir: value.outputDir, basename: value.basename,
      conflictChoice: value.conflictChoice, saveAsName: value.saveAsName,
    })), selectedId,
  };
  const text = JSON.stringify(project, null, 2) + "\n";
  parseProjectFile(text);
  return text;
}

export function projectPresetDraft(project: ProjectFile, psdPath = project.character.source.path): PresetDraft {
  return {
    version: 1, path: psdPath,
    fingerprint: project.character.source.fingerprint,
    collection: structuredClone(project.character.collection),
    nameDrafts: {},
  };
}
