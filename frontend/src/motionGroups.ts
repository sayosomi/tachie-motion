import type { Layer } from "./LayerTree";
import type { Presets } from "./presetModel";
import { AIUEO_KEYS } from "./presetModel";

/**
 * The source PSD groups, not app-created groups, are the motion assignment
 * units. Open and aiueo share the same mouth motion group selection.
 */
export type MotionGroups = { mouth: string[]; eyes?: string[] };

export function withinGroup(path: string, groupPath: string): boolean {
  return path === groupPath || path.startsWith(groupPath + "/");
}

export function assignedEyePaths(collection: Presets): Set<string> {
  const assigned = new Set<string>();
  for (const preset of collection.items) {
    for (const shape of [preset.eyes?.opened, preset.eyes?.closed]) {
      for (const layer of shape ?? []) assigned.add(layer.path);
    }
  }
  return assigned;
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

/** Legacy eye shapes did not have group metadata; infer only from source paths. */
export function effectiveEyeGroups(collection: Presets, layers: Layer[]): string[] {
  if (collection.motionGroups?.eyes) return collection.motionGroups.eyes;
  const groupPaths = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  const inferred = new Set<string>();
  for (const path of assignedEyePaths(collection)) {
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

function groupsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((one) => b.some((two) =>
    withinGroup(one, two) || withinGroup(two, one)));
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
  if (groupsOverlap(groups, effectiveEyeGroups(collection, layers))) {
    throw new Error("目の動作対象と重複するPSDグループは口形に割り当てられません。");
  }
  return { ...collection, motionGroups: {
    ...collection.motionGroups,
    mouth: layers.filter((layer) => groups.includes(layer.path)).map((layer) => layer.path),
  } };
}

/** Eye and mouth motion may never claim the same original PSD group. */
export function setEyeGroups(
  collection: Presets, layers: Layer[], groups: string[],
): Presets {
  const allowed = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  if (new Set(groups).size !== groups.length || groups.some((path) => !allowed.has(path))) {
    throw new Error("PSDのレイヤーグループを選んでください");
  }
  if ([...assignedEyePaths(collection)].some((path) => !isMouthLayer(path, groups))) {
    throw new Error("目に登録済みのレイヤーがあります。先に開眼・閉眼の割当を解除してください。");
  }
  const mouth = effectiveMouthGroups(collection, layers);
  if (groupsOverlap(groups, mouth)) {
    throw new Error("口の動作対象と重複するPSDグループは目に割り当てられません。");
  }
  return { ...collection, motionGroups: {
    ...collection.motionGroups,
    mouth,
    eyes: layers.filter((layer) => groups.includes(layer.path)).map((layer) => layer.path),
  } };
}

/**
 * Validate restored motion bindings against the *actual* PSD group tree.
 * Legacy profiles may omit motionGroups or just motionGroups.eyes. The
 * omitted bindings are inferred for collision checks, never written back.
 */
export function validMotionGroups(collection: Presets, layers: Layer[]): boolean {
  const known = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  const mouth = effectiveMouthGroups(collection, layers);
  const eyes = effectiveEyeGroups(collection, layers);
  const validGroups = (groups: readonly string[]) =>
    new Set(groups).size === groups.length && groups.every((path) => known.has(path));

  // Explicit bindings must contain every assigned leaf. Older profiles
  // without bindings retain their previous source-compatible semantics.
  const explicitMouth = collection.motionGroups !== undefined;
  const explicitEyes = collection.motionGroups?.eyes !== undefined;
  return validGroups(mouth) && validGroups(eyes)
    && (!explicitMouth || [...assignedMouthPaths(collection)]
      .every((path) => isMouthLayer(path, mouth)))
    && (!explicitEyes || [...assignedEyePaths(collection)]
      .every((path) => isMouthLayer(path, eyes)))
    && !groupsOverlap(mouth, eyes);
}
