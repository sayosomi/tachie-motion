import type { Layer } from "./LayerTree";
import type { Presets, UnifiedPreset, Visibility } from "./presetModel";

// Portable, explicit character settings. Never a project snapshot or reload draft.
export const CHARACTER_PROFILE_FORMAT = "tachie-motion-character-profile";
export const CHARACTER_PROFILE_VERSION = 1;
export const MAX_PROFILE_SIZE = 2_000_000;
const MAX_LAYERS = 50_000;
const MAX_PRESETS = 1_000;

export type CharacterProfile = {
  format: typeof CHARACTER_PROFILE_FORMAT;
  version: typeof CHARACTER_PROFILE_VERSION;
  source: { path: string; fingerprint: string; layerPaths: string[] };
  collection: Presets;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("キャラクター設定JSONの項目が不正です");
  }
}
function validPath(path: unknown): path is string {
  return typeof path === "string" && /^(0|[1-9][0-9]*)(\/(0|[1-9][0-9]*))*$/.test(path)
    && path.length <= 256;
}
function paths(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > MAX_LAYERS || (!allowEmpty && !value.length) ||
      !value.every(validPath) || new Set(value).size !== value.length) {
    throw new Error("キャラクター設定JSONのレイヤーパスが不正です");
  }
  return value;
}

function state(value: unknown, allowed: Set<string>, full = false): Visibility[] {
  if (!Array.isArray(value) || value.length > allowed.size) {
    throw new Error("キャラクター設定JSONのレイヤー状態が不正です");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    fields(entry, ["path", "visible"]);
    if (!validPath(entry.path) || !allowed.has(entry.path) ||
        typeof entry.visible !== "boolean" || seen.has(entry.path)) {
      throw new Error("キャラクター設定JSONのレイヤー状態が不正です");
    }
    seen.add(entry.path);
  }
  if (full && seen.size !== allowed.size) {
    throw new Error("キャラクター設定JSONの全レイヤー設定が揃っていません");
  }
  return value as Visibility[];
}

function paired(value: unknown, keys: string[], allowed: Set<string>): Record<string, Visibility[]> {
  fields(value, keys);
  const shape: Record<string, Visibility[]> = {};
  for (const key of keys) shape[key] = state(value[key], allowed);
  return shape;
}

function preset(value: unknown, allowed: Set<string>): UnifiedPreset {
  fields(value, ["id", "name", "base", "blinkEnabled"], ["openMouth", "aiueoMouth", "eyes"]);
  // Preset IDs are opaque stable identifiers, not necessarily UUIDs.
  // Reject Object.prototype property names because UI state indexes drafts
  // and previews by ID using ordinary JavaScript records.
  if (typeof value.id !== "string" || !value.id.trim() ||
      Object.hasOwn(Object.prototype, value.id) ||
      typeof value.name !== "string" || !value.name.trim() ||
      typeof value.blinkEnabled !== "boolean") {
    throw new Error("キャラクター設定JSONのプリセットが不正です");
  }
  state(value.base, allowed, true);
  if (Object.hasOwn(value, "openMouth")) {
    const mouth = paired(value.openMouth, ["closed", "opened"], allowed);
    const closed = new Set(mouth.closed.map((x) => x.path));
    const opened = new Set(mouth.opened.map((x) => x.path));
    if (!closed.size || closed.size !== opened.size ||
        [...closed].some((path) => !opened.has(path))) {
      throw new Error("キャラクター設定JSONのOpen口形が不正です");
    }
  }
  if (Object.hasOwn(value, "aiueoMouth")) {
    paired(value.aiueoMouth, ["a", "i", "u", "e", "o", "n"], allowed);
  }
  if (Object.hasOwn(value, "eyes")) {
    paired(value.eyes, ["opened", "closed"], allowed);
  }
  return value as unknown as UnifiedPreset;
}

export function parseCharacterProfile(text: string): CharacterProfile {
  if (text.length > MAX_PROFILE_SIZE) throw new Error("キャラクター設定JSONが大きすぎます");
  let data: unknown;
  try { data = JSON.parse(text) as unknown; }
  catch { throw new Error("キャラクター設定JSONを解析できません"); }
  fields(data, ["format", "version", "source", "collection"]);
  if (data.format !== CHARACTER_PROFILE_FORMAT || data.version !== CHARACTER_PROFILE_VERSION) {
    throw new Error("未対応のキャラクター設定JSON形式・バージョンです");
  }
  fields(data.source, ["path", "fingerprint", "layerPaths"]);
  const source = data.source;
  if (typeof source.path !== "string" || !source.path.trim() || source.path.length > 8192 ||
      typeof source.fingerprint !== "string" || !/^[0-9]+:[0-9]+$/.test(source.fingerprint)) {
    throw new Error("キャラクター設定JSONのPSD参照が不正です");
  }
  const allPaths = paths(source.layerPaths, false);
  const allowed = new Set(allPaths);
  fields(data.collection, ["items", "defaultId"]);
  const collection = data.collection;
  if (!Array.isArray(collection.items) || collection.items.length > MAX_PRESETS) {
    throw new Error("キャラクター設定JSONのプリセット数が不正です");
  }
  const items: UnifiedPreset[] = collection.items.map((item: unknown) => preset(item, allowed));
  const ids = items.map((item) => item.id);
  const names = items.map((item) => item.name.trim().normalize("NFC").toLocaleLowerCase());
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
    throw new Error("キャラクター設定JSONに重複したプリセットID・名前があります");
  }
  if ((collection.defaultId !== null && typeof collection.defaultId !== "string") ||
      (collection.defaultId !== null && !ids.includes(collection.defaultId)) ||
      (items.length > 0 && collection.defaultId === null)) {
    throw new Error("キャラクター設定JSONの既定プリセットが不正です");
  }
  return data as unknown as CharacterProfile;
}

export function serializeCharacterProfile(
  path: string, fingerprint: string, layers: Layer[], collection: Presets,
): string {
  const data: CharacterProfile = {
    format: CHARACTER_PROFILE_FORMAT,
    version: CHARACTER_PROFILE_VERSION,
    source: { path, fingerprint, layerPaths: layers.map((layer) => layer.path) },
    collection,
  };
  const text = JSON.stringify(data, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_PROFILE_SIZE) {
    throw new Error("キャラクター設定JSONが大きすぎます");
  }
  parseCharacterProfile(text);
  return text;
}

/**
 * JSON index paths are structurally valid before PSD I/O, but the real layer
 * kinds only become available after /api/psd re-reads the source. A group is
 * allowed in the base visibility map, never as an Open mouth target.
 */
export function validateCharacterProfileOpenTargets(profile: CharacterProfile, layers: Layer[]): void {
  const leafPaths = new Set(layers.filter((layer) => layer.kind !== "group")
    .map((layer) => layer.path));
  for (const preset of profile.collection.items) {
    if (!preset.openMouth) continue;
    for (const shape of [preset.openMouth.closed, preset.openMouth.opened]) {
      if (shape.some(({ path }) => !leafPaths.has(path))) {
        throw new Error("キャラクター設定JSONのOpen口形にグループまたは存在しないレイヤーが指定されています。編集内容は保持しています。");
      }
    }
  }
}

export function matchesCharacterProfileSource(
  profile: CharacterProfile, path: string, fingerprint: string, layers: Layer[],
): boolean {
  return profile.source.path === path &&
    profile.source.fingerprint === fingerprint &&
    profile.source.layerPaths.length === layers.length &&
    profile.source.layerPaths.every((saved, index) => saved === layers[index].path);
}
