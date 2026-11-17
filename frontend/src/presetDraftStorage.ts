import type { Layer } from "./LayerTree";
import type { Presets } from "./presetModel";
import { AIUEO_KEYS } from "./presetModel";
import { validMotionGroups } from "./motionGroups";
import { validatePsdChoices } from "./psdChoice";

// Crash/reload recovery for this one browser and exact site origin only.
// Not the versioned, portable character-profile format in PRODUCT_SPEC §7.
const KEY = "tachie-motion.preset-draft.v1";

export type PresetDraft = {
  version: 1;
  path: string;
  fingerprint: string;
  collection: Presets;
  nameDrafts: Record<string, string>;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readPresetDraft(): PresetDraft | null {
  const text = localStorage.getItem(KEY);
  if (text === null) return null;
  if (text.length > 2_000_000) throw new Error("保存済みプリセットのサイズが大きすぎます");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("保存済みプリセットの形式が壊れています"); }
  if (!object(value) || value.version !== 1
    || typeof value.path !== "string" || !value.path.trim()
    || typeof value.fingerprint !== "string" || !value.fingerprint
    || !object(value.collection) || !Array.isArray(value.collection.items)
    || !object(value.nameDrafts)) {
    throw new Error("保存済みプリセットの形式が不正です");
  }
  const collection = value.collection as unknown as Presets;
  if (collection.motionGroups !== undefined) {
    const motion: unknown = collection.motionGroups;
    const validGroupPaths = (value: unknown) =>
      Array.isArray(value) && value.length <= 50_000 &&
      new Set(value).size === value.length &&
      value.every((path: unknown) =>
        typeof path === "string" && /^(0|[1-9][0-9]*)(\/(0|[1-9][0-9]*))*$/.test(path)
        && path.length <= 256);
    if (!object(motion) ||
        Object.keys(motion).some((key) => key !== "mouth" && key !== "eyes") ||
        !validGroupPaths(motion.mouth) ||
        (Object.hasOwn(motion, "eyes") && !validGroupPaths(motion.eyes))) {
      throw new Error("保存済み動作対象グループが不正です");
    }
  }
  if (typeof collection.defaultId !== "string" && collection.defaultId !== null) {
    throw new Error("既定プリセットのIDが不正です");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of collection.items) {
    if (!object(item) || typeof item.id !== "string" || !item.id
      || Object.hasOwn(Object.prototype, item.id)
      || typeof item.name !== "string" || !item.name.trim()
      || !Array.isArray(item.base) || typeof item.blinkEnabled !== "boolean"
      || (item.mouthMotionEnabled !== undefined && typeof item.mouthMotionEnabled !== "boolean")) {
      throw new Error("保存済みプリセットの内容が不正です");
    }
    const name = item.name.trim().normalize("NFC").toLocaleLowerCase();
    if (ids.has(item.id) || names.has(name)) {
      throw new Error("保存済みプリセットのIDまたは名前が重複しています");
    }
    ids.add(item.id);
    names.add(name);
    for (const layer of item.base) {
      if (!object(layer) || Object.keys(layer).length !== 2 ||
          typeof layer.path !== "string" || typeof layer.visible !== "boolean") {
        throw new Error("保存済みレイヤー設定が不正です");
      }
    }
  }
  // Stored edits must be safe to render after a reload, including aiueo
  // mappings that are not yet used for video export.
  for (const item of collection.items) {
    if (item.openMouth === undefined && item.aiueoMouth === undefined && item.eyes === undefined) continue;
    const basePaths = new Set(item.base.map((layer) => layer.path));
    const parseShape = (value: unknown): Set<string> => {
      if (!Array.isArray(value) || value.length > basePaths.size) {
        throw new Error("保存済み口形レイヤーが不正です");
      }
      const paths = new Set<string>();
      for (const layer of value) {
        if (!object(layer) || Object.keys(layer).length !== 2 ||
            typeof layer.path !== "string" || typeof layer.visible !== "boolean" ||
            !basePaths.has(layer.path) || paths.has(layer.path)) {
          throw new Error("保存済み口形レイヤーが不正です");
        }
        paths.add(layer.path);
      }
      return paths;
    };
    if (item.openMouth !== undefined) {
      const mouth: unknown = item.openMouth;
      if (!object(mouth)) throw new Error("保存済み口形設定が不正です");
      const closed = parseShape(mouth.closed);
      const opened = parseShape(mouth.opened);
      if (!closed.size || closed.size !== opened.size ||
          [...closed].some((path) => !opened.has(path))) {
        throw new Error("保存済み口形の対象レイヤーが一致しません");
      }
    }
    if (item.aiueoMouth !== undefined) {
      const mouth: unknown = item.aiueoMouth;
      if (!object(mouth) || Object.keys(mouth).length !== AIUEO_KEYS.length ||
          AIUEO_KEYS.some((key) => !Object.hasOwn(mouth, key))) {
        throw new Error("保存済みaiueo口形設定が不正です");
      }
      for (const key of AIUEO_KEYS) parseShape(mouth[key]);
    }
    if (item.eyes !== undefined) {
      const eyes: unknown = item.eyes;
      if (!object(eyes) || Object.keys(eyes).length !== 2 ||
          !Object.hasOwn(eyes, "opened") || !Object.hasOwn(eyes, "closed")) {
        throw new Error("保存済み瞬き設定が不正です");
      }
      parseShape(eyes.opened);
      parseShape(eyes.closed);
    }
  }
  if (collection.defaultId !== null && !ids.has(collection.defaultId)) {
    throw new Error("既定プリセットが見つかりません");
  }
  for (const [id, draft] of Object.entries(value.nameDrafts)) {
    if (!ids.has(id) || typeof draft !== "string") {
      throw new Error("保存済みの名前編集が不正です");
    }
  }
  return value as unknown as PresetDraft;
}

export function matchesSource(draft: PresetDraft, fingerprint: string, layers: Layer[]): boolean {
  if (draft.fingerprint !== fingerprint) return false;
  const paths = new Set(layers.map((layer) => layer.path));
  if (paths.size !== layers.length) return false;
  const leafPaths = new Set(layers.filter((layer) => layer.kind !== "group")
    .map((layer) => layer.path));
  const sourceMatches = validMotionGroups(draft.collection, layers)
    && draft.collection.items.every((item) => {
      const savedPaths = new Set(item.base.map((layer) => layer.path));
      const openPathsValid = !item.openMouth ||
        [item.openMouth.closed, item.openMouth.opened].every((shape) =>
          shape.every(({ path }) => leafPaths.has(path)));
      const aiueoPathsValid = !item.aiueoMouth ||
        AIUEO_KEYS.every((key) => item.aiueoMouth![key].every(({ path }) =>
          leafPaths.has(path)));
      const eyePathsValid = !item.eyes ||
        [item.eyes.opened, item.eyes.closed].every((shape) =>
          shape.every(({ path }) => leafPaths.has(path)));
      return savedPaths.size === paths.size
        && item.base.length === paths.size
        && [...savedPaths].every((path) => paths.has(path))
        && openPathsValid && aiueoPathsValid && eyePathsValid;
    });
  if (!sourceMatches) return false;
  try {
    validatePsdChoices(draft.collection, layers);
    return true;
  } catch {
    // A corrupt/legacy draft stays in localStorage for explicit recovery;
    // never auto-normalize or render from conflicting saved layer states.
    return false;
  }
}

export function writePresetDraft(draft: PresetDraft): void {
  // Do not store base64 image data, PSD bytes, WAVs or exports.
  localStorage.setItem(KEY, JSON.stringify(draft));
}
