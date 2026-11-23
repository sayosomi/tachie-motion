import { parseCharacterProfile, type CharacterProfile } from "./characterProfile";
import { validateBatchNaming, type BatchNaming } from "./nameTemplate";
import { assertPresetChangePoints, type PresetChangePoint } from "./presetChangePoints";
import { PROJECT_FORMAT } from "./projectFile";
import type { Fps, LipMode, WavData } from "./utteranceItems";

/**
 * Candidate multi-character project data contract (Issue #67).
 * This does not change the active v4 editor import/export path.
 * The version and v4 migration policy remain pending product approval.
 */
export const NEXT_PROJECT_VERSION = 5;
export const MAX_NEXT_PROJECT_BYTES = 16_000_000;
const MAX_WAVS = 2000;
const MAX_CHARACTERS = 16;
const MAX_PATH_LENGTH = 8192;

export type SharedProjectWav = {
  id: string;
  wavPath: string;
  wav: WavData;
  speakerId: string | null;
  waitAfter: boolean;
};

export type CharacterWavAnimation = {
  wavId: string;
  presetId: string;
  presetChanges: PresetChangePoint[];
  lipMode: LipMode;
};

export type CharacterWaitOverride = { wavId: string; presetId: string };

export type ProductionCharacter = {
  id: string;
  name: string;
  profile: CharacterProfile;
  animations: CharacterWavAnimation[];
  /** Missing entry means follow the character's default preset live. */
  waitOverrides: CharacterWaitOverride[];
};

export type ProductionNaming = Omit<BatchNaming, "characterName">;

export type NextProjectFile = {
  format: typeof PROJECT_FORMAT;
  version: typeof NEXT_PROJECT_VERSION;
  fps: Fps;
  /** Exact nonnegative decimal seconds, not a floating-point frame count. */
  waitSeconds: string;
  /** Array position is the current order; every reference uses the stable ID. */
  wavs: SharedProjectWav[];
  characters: ProductionCharacter[];
  selectedWavId: string | null;
  naming: ProductionNaming;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key))) {
    throw new Error("制作プロジェクトJSONの項目が不正です");
  }
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim().length > 0 && !Object.hasOwn(Object.prototype, value) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PATH_LENGTH && !value.includes("\0") &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"));
}

function assertWavData(value: unknown): asserts value is WavData {
  fields(value, ["samples", "sample_rate", "duration_seconds", "source_identity"]);
  if (!Number.isSafeInteger(value.samples) || (value.samples as number) < 1 ||
      !Number.isSafeInteger(value.sample_rate) || (value.sample_rate as number) < 1 ||
      typeof value.duration_seconds !== "number" || !Number.isFinite(value.duration_seconds) ||
      Math.abs(value.duration_seconds - (value.samples as number) / (value.sample_rate as number)) > 0.001 ||
      typeof value.source_identity !== "string" ||
      !/^[0-9]+(:[0-9]+){4}$/.test(value.source_identity)) {
    throw new Error("制作プロジェクトJSONのWAV参照情報が不正です");
  }
}

/** Decimal string permits exact frame rounding by a later integer/rational renderer. */
function assertWaitSeconds(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) {
    throw new Error("共通待機秒数が不正です");
  }
  const [integer, fraction = ""] = value.split(".");
  if (BigInt(integer) > 3600n || (BigInt(integer) === 3600n && /[1-9]/.test(fraction))) {
    throw new Error("共通待機秒数が上限を超えています");
  }
}

function assertNaming(value: unknown): asserts value is ProductionNaming {
  fields(value, ["projectName", "movTemplate", "otioTemplate", "outputDir"]);
  validateBatchNaming({ ...value, characterName: "character" });
}

function assertProject(value: unknown): asserts value is NextProjectFile {
  // Check the discriminant before shape validation so actual legacy v4 files
  // receive a clear unsupported-version error rather than a generic field error.
  if (!record(value) || value.format !== PROJECT_FORMAT ||
      value.version !== NEXT_PROJECT_VERSION) {
    throw new Error("未対応の制作プロジェクトJSON形式・バージョンです");
  }
  fields(value, ["format", "version", "fps", "waitSeconds", "wavs",
    "characters", "selectedWavId", "naming"]);
  if (value.fps !== 24 && value.fps !== 30 && value.fps !== 60) {
    throw new Error("プロジェクト共通FPSが不正です");
  }
  assertWaitSeconds(value.waitSeconds);
  assertNaming(value.naming);
  if (!Array.isArray(value.wavs) || value.wavs.length > MAX_WAVS ||
      !Array.isArray(value.characters) || value.characters.length > MAX_CHARACTERS) {
    throw new Error("制作プロジェクトのWAV数・キャラクター数が不正です");
  }

  const wavIds = new Set<string>();
  for (const raw of value.wavs) {
    fields(raw, ["id", "wavPath", "wav", "speakerId", "waitAfter"]);
    if (!stableId(raw.id) || wavIds.has(raw.id) || !absolutePath(raw.wavPath) ||
        typeof raw.waitAfter !== "boolean" ||
        (raw.speakerId !== null && !stableId(raw.speakerId))) {
      throw new Error("共通WAVのID・参照・待機設定が不正です");
    }
    assertWavData(raw.wav);
    wavIds.add(raw.id);
  }

  const wavById = new Map((value.wavs as SharedProjectWav[]).map((wav) => [wav.id, wav]));
  const characterIds = new Set<string>();
  const names = new Set<string>();
  for (const raw of value.characters) {
    fields(raw, ["id", "name", "profile", "animations", "waitOverrides"]);
    if (!stableId(raw.id) || characterIds.has(raw.id) ||
        typeof raw.name !== "string" || !raw.name.trim() ||
        raw.name.length > 256 ||
        !Array.isArray(raw.animations) || !Array.isArray(raw.waitOverrides)) {
      throw new Error("キャラクターのID・名前・設定が不正です");
    }
    // The exported filename's character token must be safe and unambiguous.
    const naming = { ...(value.naming as ProductionNaming), characterName: raw.name };
    validateBatchNaming(naming);
    const nameKey = raw.name.trim().normalize("NFC").toLocaleLowerCase();
    if (names.has(nameKey)) throw new Error("重複したキャラクター名があります");
    names.add(nameKey);
    characterIds.add(raw.id);

    const profile = parseCharacterProfile(JSON.stringify(raw.profile));
    if (!absolutePath(profile.source.path)) {
      throw new Error("キャラクターのPSD参照パスが不正です");
    }
    const presetIds = new Set(profile.collection.items.map((preset) => preset.id));
    if (raw.animations.length !== wavIds.size || raw.waitOverrides.length > wavIds.size) {
      throw new Error("キャラクターのWAV設定件数が不正です");
    }
    const editedWavs = new Set<string>();
    for (const animation of raw.animations) {
      fields(animation, ["wavId", "presetId", "presetChanges", "lipMode"]);
      if (!stableId(animation.wavId) || !wavIds.has(animation.wavId) ||
          editedWavs.has(animation.wavId) ||
          typeof animation.presetId !== "string" ||
          !presetIds.has(animation.presetId) ||
          !["none", "open", "aiueo"].includes(animation.lipMode as string)) {
        throw new Error("キャラクターのWAV設定・プリセット参照が不正です");
      }
      const wav = wavById.get(animation.wavId)!;
      if (wav.speakerId !== raw.id && animation.lipMode !== "none") {
        throw new Error("話者以外のキャラクターには口パクを設定できません");
      }
      assertPresetChangePoints(animation.presetChanges, wav.wav.samples, presetIds);
      editedWavs.add(animation.wavId);
    }

    const overrideWavs = new Set<string>();
    for (const entry of raw.waitOverrides) {
      fields(entry, ["wavId", "presetId"]);
      if (!stableId(entry.wavId) || overrideWavs.has(entry.wavId) ||
          !wavIds.has(entry.wavId) || typeof entry.presetId !== "string" ||
          !presetIds.has(entry.presetId) ||
          !wavById.get(entry.wavId)?.waitAfter) {
        throw new Error("待機プリセットoverrideの参照が不正です");
      }
      overrideWavs.add(entry.wavId);
    }
    if ((value.wavs as SharedProjectWav[]).some((wav) => wav.waitAfter) &&
        !profile.collection.defaultId) {
      throw new Error("待機用の既定プリセットが見つかりません");
    }
  }
  for (const wav of value.wavs as SharedProjectWav[]) {
    if (wav.speakerId !== null && !characterIds.has(wav.speakerId)) {
      throw new Error("共通WAVの話者参照先が見つかりません");
    }
  }
  if (value.selectedWavId !== null &&
      (typeof value.selectedWavId !== "string" || !wavIds.has(value.selectedWavId))) {
    throw new Error("制作プロジェクトの選択WAV参照が不正です");
  }
}

/** Validation does not sort, migrate, repair or modify the supplied data. */
export function parseNextProjectFile(text: string): NextProjectFile {
  if (new TextEncoder().encode(text).byteLength > MAX_NEXT_PROJECT_BYTES) {
    throw new Error("制作プロジェクトJSONが大きすぎます");
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error("制作プロジェクトJSONを解析できません"); }
  assertProject(value);
  return value;
}

/** No media bytes, prior render history or browser UI drafts enter the project file. */
export function serializeNextProjectFile(value: NextProjectFile): string {
  const text = JSON.stringify(value, null, 2) + "\n";
  return JSON.stringify(parseNextProjectFile(text), null, 2) + "\n";
}

export function resolveWaitPreset(
  project: NextProjectFile, characterId: string, wavId: string,
): string | null {
  const wav = project.wavs.find((entry) => entry.id === wavId);
  const character = project.characters.find((entry) => entry.id === characterId);
  if (!wav || !character) throw new Error("待機のWAVまたはキャラクターが見つかりません");
  if (!wav.waitAfter) return null;
  return character.waitOverrides.find((entry) => entry.wavId === wavId)?.presetId ??
    character.profile.collection.defaultId;
}

/** Reordering never transfers animation, speaker or waiting overrides to another WAV. */
export function reorderProjectWavs(
  project: NextProjectFile, sourceId: string, targetId: string, after: boolean,
): NextProjectFile {
  if (sourceId === targetId) return project;
  const original = project.wavs.findIndex((entry) => entry.id === sourceId);
  if (original < 0 || !project.wavs.some((entry) => entry.id === targetId)) return project;
  const wavs = [...project.wavs];
  const [moving] = wavs.splice(original, 1);
  const target = wavs.findIndex((entry) => entry.id === targetId);
  wavs.splice(target + (after ? 1 : 0), 0, moving);
  return { ...project, wavs };
}
