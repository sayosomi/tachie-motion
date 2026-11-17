import type { Layer } from "./LayerTree";
import type { Presets } from "./presetModel";
import { AIUEO_KEYS } from "./presetModel";

/**
 * The source PSD groups, not app-created groups, are the motion assignment
 * units. Open and aiueo share the same mouth motion group selection.
 */
export type MotionGroups = { mouth: string[] };

export function withinGroup(path: string, groupPath: string): boolean {
  return path === groupPath || path.startsWith(groupPath + "/");
}

export function assignedMouthPaths(collection: Presets): Set<string> {
  const assigned = new Set<string>();
  for (const preset of collection.items) {
    for (const shape of [preset.openMouth?.closed, preset.openMouth?.opened]) {
      for (const layer of shape ?? []) assigned.add(layer.path);
    }
    for (const key of AIUEO_KEYS) {
      for (const layer of preset.aiueoMouth?.[key] ?? []) assigned.add(layer.path);
    }
  }
  return assigned;
}

/**
 * V1 profiles had no group binding. Infer only the nearest existing parent
 * PSD groups of explicitly assigned mouth layers; never guess from names.
 */
export function effectiveMouthGroups(collection: Presets, layers: Layer[]): string[] {
  if (collection.motionGroups) return collection.motionGroups.mouth;
  const groupPaths = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  const inferred = new Set<string>();
  for (const path of assignedMouthPaths(collection)) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      const parent = parts.join("/");
      if (groupPaths.has(parent)) {
        inferred.add(parent);
        break;
      }
    }
  }
  return layers.filter((layer) => inferred.has(layer.path)).map((layer) => layer.path);
}

export function isMouthLayer(path: string, groupPaths: readonly string[]): boolean {
  return groupPaths.some((group) => withinGroup(path, group));
}

/**
 * A group can only be detached after every saved mouth shape referring to
 * its leaves has been cleared. Never silently lose/hide active overrides.
 */
export function setMouthGroups(
  collection: Presets, layers: Layer[], groups: string[],
): Presets {
  const allowed = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  if (new Set(groups).size !== groups.length || groups.some((path) => !allowed.has(path))) {
    throw new Error("PSDのレイヤーグループを選んでください");
  }
  if ([...assignedMouthPaths(collection)].some((path) => !isMouthLayer(path, groups))) {
    throw new Error("口形に登録済みのレイヤーがあります。先に口形の割当を解除してください。");
  }
  return { ...collection, motionGroups: {
    mouth: layers.filter((layer) => groups.includes(layer.path)).map((layer) => layer.path),
  } };
}

export function validMotionGroups(collection: Presets, layers: Layer[]): boolean {
  if (!collection.motionGroups) return true;
  const groups = collection.motionGroups.mouth;
  const known = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  return new Set(groups).size === groups.length
    && groups.every((path) => known.has(path))
    && [...assignedMouthPaths(collection)].every((path) => isMouthLayer(path, groups));
}
