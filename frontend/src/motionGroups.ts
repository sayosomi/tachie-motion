import type { Layer } from "./LayerTree";
import type { Presets, Shape } from "./presetModel";
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
    for (const layer of preset.eyes?.closed ?? []) if (layer.visible) assigned.add(layer.path);
  }
  return assigned;
}

export function assignedMouthPaths(collection: Presets): Set<string> {
  const assigned = new Set<string>();
  for (const preset of collection.items) {
    for (const layer of preset.openMouth?.opened ?? []) if (layer.visible) assigned.add(layer.path);
    for (const key of AIUEO_KEYS) {
      for (const layer of preset.aiueoMouth?.[key] ?? []) if (layer.visible) assigned.add(layer.path);
    }
  }
  return assigned;
}

/** No inference from obsolete profiles: groups are manually assigned. */
export function effectiveMouthGroups(collection: Presets, _layers: Layer[]): string[] {
  return collection.motionGroups?.mouth ?? [];
}

export function effectiveEyeGroups(collection: Presets, _layers: Layer[]): string[] {
  return collection.motionGroups?.eyes ?? [];
}

function groupsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((one) => b.some((two) =>
    withinGroup(one, two) || withinGroup(two, one)));
}

export function isMouthLayer(path: string, groupPaths: readonly string[]): boolean {
  return groupPaths.some((group) => withinGroup(path, group));
}

/** Rebuild complete true/false target visibility after a group is added or removed. */
function rebuildSelection(
  shape: Shape | undefined, layers: Layer[], groups: readonly string[],
): Shape {
  const selected = new Set(shape?.filter((entry) => entry.visible
    && isMouthLayer(entry.path, groups)).map((entry) => entry.path) ?? []);
  if (!selected.size) return [];
  return layers.filter((layer) => layer.kind !== "group"
    && !layer.name.startsWith("!") && isMouthLayer(layer.path, groups))
    .map((layer) => ({ path: layer.path, visible: selected.has(layer.path) }));
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
  const items = collection.items.map((item) => {
    const opened = rebuildSelection(item.openMouth?.opened, layers, groups);
    const closed = opened.map((entry) => ({
      path: entry.path,
      visible: item.base.find((fixed) => fixed.path === entry.path)?.visible ?? false,
    }));
    const openMouth = opened.length ? { closed, opened } : undefined;
    const aiueoMouth = item.aiueoMouth &&
      Object.fromEntries(AIUEO_KEYS.map((key) =>
        [key, rebuildSelection(item.aiueoMouth?.[key], layers, groups)])) as typeof item.aiueoMouth;
    return { ...item, openMouth, aiueoMouth:
      aiueoMouth && AIUEO_KEYS.some((key) => aiueoMouth[key].some((entry) => entry.visible))
        ? aiueoMouth : undefined };
  });
  return { ...collection, items, motionGroups: {
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
    throw new Error("目のcloseに登録済みのレイヤーがあります。先に割当を解除してください。");
  }
  const mouth = effectiveMouthGroups(collection, layers);
  if (groupsOverlap(groups, mouth)) {
    throw new Error("口の動作対象と重複するPSDグループは目に割り当てられません。");
  }
  const items = collection.items.map((item) => {
    const closed = rebuildSelection(item.eyes?.closed, layers, groups);
    return { ...item, eyes: closed.length ? { opened: [], closed } : undefined };
  });
  return { ...collection, items, motionGroups: {
    ...collection.motionGroups,
    mouth,
    eyes: layers.filter((layer) => groups.includes(layer.path)).map((layer) => layer.path),
  } };
}

/** Validate explicit binding groups against the actual PSD tree; no migration. */
export function validMotionGroups(collection: Presets, layers: Layer[]): boolean {
  const known = new Set(layers.filter((layer) => layer.kind === "group")
    .map((layer) => layer.path));
  const mouth = effectiveMouthGroups(collection, layers);
  const eyes = effectiveEyeGroups(collection, layers);
  const validGroups = (groups: readonly string[]) =>
    new Set(groups).size === groups.length && groups.every((path) => known.has(path));

  return validGroups(mouth) && validGroups(eyes)
    && [...assignedMouthPaths(collection)].every((path) => isMouthLayer(path, mouth))
    && [...assignedEyePaths(collection)].every((path) => isMouthLayer(path, eyes))
    && !groupsOverlap(mouth, eyes);
}
