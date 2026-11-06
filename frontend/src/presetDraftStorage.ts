import type { Layer } from "./LayerTree";
import type { Presets } from "./presetModel";

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
  if (typeof collection.defaultId !== "string" && collection.defaultId !== null) {
    throw new Error("既定プリセットのIDが不正です");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of collection.items) {
    if (!object(item) || typeof item.id !== "string" || !item.id
      || Object.hasOwn(Object.prototype, item.id)
      || typeof item.name !== "string" || !item.name.trim()
      || !Array.isArray(item.base) || typeof item.blinkEnabled !== "boolean") {
      throw new Error("保存済みプリセットの内容が不正です");
    }
    const name = item.name.trim().normalize("NFC").toLocaleLowerCase();
    if (ids.has(item.id) || names.has(name)) {
      throw new Error("保存済みプリセットのIDまたは名前が重複しています");
    }
    ids.add(item.id);
    names.add(name);
    for (const layer of item.base) {
      if (!object(layer) || typeof layer.path !== "string" || typeof layer.visible !== "boolean") {
        throw new Error("保存済みレイヤー設定が不正です");
      }
    }
  }
  // Optional mouth overrides are stored with the same preset draft. Reject
  // malformed mappings rather than crash the editor or publish stale output.
  for (const item of collection.items) {
    if (item.openMouth === undefined) continue;
    const mouth: unknown = item.openMouth;
    if (!object(mouth) || !Array.isArray(mouth.closed) || !Array.isArray(mouth.opened)) {
      throw new Error("保存済み口形設定が不正です");
    }
    const basePaths = new Set(item.base.map((layer) => layer.path));
    const parseShape = (value: unknown[]): Set<string> => {
      const paths = new Set<string>();
      for (const layer of value) {
        if (!object(layer) || typeof layer.path !== "string" ||
            typeof layer.visible !== "boolean" ||
            !basePaths.has(layer.path) || paths.has(layer.path)) {
          throw new Error("保存済み口形レイヤーが不正です");
        }
        paths.add(layer.path);
      }
      return paths;
    };
    const closed = parseShape(mouth.closed);
    const opened = parseShape(mouth.opened);
    if (!closed.size || closed.size !== opened.size ||
        [...closed].some((path) => !opened.has(path))) {
      throw new Error("保存済み口形の対象レイヤーが一致しません");
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
  return draft.collection.items.every((item) => {
    const savedPaths = new Set(item.base.map((layer) => layer.path));
    return savedPaths.size === paths.size
      && item.base.length === paths.size
      && [...savedPaths].every((path) => paths.has(path));
  });
}

export function writePresetDraft(draft: PresetDraft): void {
  // Do not store base64 image data, PSD bytes, WAVs or exports.
  localStorage.setItem(KEY, JSON.stringify(draft));
}
