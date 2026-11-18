import type { Layer } from "./LayerTree";
import type { Presets, Visibility } from "./presetModel";

/**
 * PSDTool's documented authoring conventions:
 *   * = one selected sibling within the same immediate PSD parent group
 *   ! = mandatory visible (cannot be toggled individually)
 * No classification is inferred from ordinary PSD layer names.
 */
export type PsdChoiceKind = "check" | "radio" | "fixed";

export function psdChoiceKind(name: string): PsdChoiceKind {
  if (name.startsWith("*")) return "radio";
  if (name.startsWith("!")) return "fixed";
  return "check";
}

export function psdParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

/**
 * Selection affects only starred siblings in the *same immediate PSD folder*.
 * Ordinary checkboxes, mandatory items, cousins and descendants are untouched.
 */
export function choiceChanges(layers: Layer[], path: string, visible: boolean): Visibility[] {
  const selected = layers.find((layer) => layer.path === path);
  if (!selected) throw new Error("Unknown PSD layer path");
  const kind = psdChoiceKind(selected.name);
  if (kind === "fixed") return [];
  if (kind === "check") return [{ path, visible }];
  // A radio option cannot be unchecked alone. Hide its PSD parent instead.
  if (!visible) return [];
  const parent = psdParentPath(path);
  return layers.filter((layer) =>
    psdChoiceKind(layer.name) === "radio" && psdParentPath(layer.path) === parent)
    .map((layer) => ({ path: layer.path, visible: layer.path === path }));
}

/**
 * When an explicitly selected movable *leaf shares a PSDTool radio parent
 * with a *group, the latter must be hidden in that pose as well. This is a
 * derived radio consequence, not a separately saved/group-editable target.
 * Never affect groups outside the explicitly assigned motion groups.
 */
export function derivedEyeRadioGroupHides(
  layers: Layer[], closed: Visibility[] | undefined, eyeGroups: readonly string[],
): Set<string> {
  const selectedParents = new Set(closed?.filter(({ path, visible }) =>
    visible && layers.some((layer) => layer.path === path &&
      layer.kind !== "group" && psdChoiceKind(layer.name) === "radio"))
    .map(({ path }) => psdParentPath(path)) ?? []);
  return new Set(layers.filter((layer) =>
    layer.kind === "group" && psdChoiceKind(layer.name) === "radio" &&
    selectedParents.has(psdParentPath(layer.path)) &&
    eyeGroups.some((group) => layer.path.startsWith(group + "/")))
    .map((layer) => layer.path));
}

export function applyChoice(
  current: Visibility[], layers: Layer[], path: string, visible: boolean,
): Visibility[] {
  const updates = new Map(choiceChanges(layers, path, visible)
    .map((layer) => [layer.path, layer.visible]));
  return current.map((entry) => updates.has(entry.path)
    ? { path: entry.path, visible: updates.get(entry.path)! } : entry);
}

/** Match PSDTool's default when creating a new preset from a raw PSD. */
export function initialChoiceVisibility(layers: Layer[]): Visibility[] {
  const defaults = new Map(layers.map((layer) => [layer.path,
    psdChoiceKind(layer.name) === "fixed" ? true : layer.visible]));
  const radioGroups = new Map<string, Layer[]>();
  for (const layer of layers) {
    if (psdChoiceKind(layer.name) !== "radio") continue;
    const parent = psdParentPath(layer.path);
    radioGroups.set(parent, [...(radioGroups.get(parent) ?? []), layer]);
  }
  for (const choices of radioGroups.values()) {
    // Source order is PSD stack order: the topmost saved ON wins.
    const winner = choices.find((layer) => layer.visible) ?? choices[0];
    for (const layer of choices) defaults.set(layer.path, layer.path === winner.path);
  }
  return layers.map((layer) => ({ path: layer.path, visible: defaults.get(layer.path)! }));
}


/**
 * Source-aware boundary check for legacy character JSON, project JSON and
 * browser drafts. Reject inconsistent saved states rather than silently
 * replacing a user's saved choices. This runs after reading the real PSD.
 *
 * Inactive PSD parents may hide children effectively, but each saved direct
 * child's own visibility must still obey '!' and '*' conventions.
 */
export function validatePsdChoices(
  collection: Presets, layers: Layer[], context: "restore" | "edit" = "restore",
): void {
  const failureNote = context === "edit"
    ? "変更は適用・保存していません。対象の*レイヤーを確認してください。"
    : "保存データを変更せず読み込みを中止しました。";
  const mandatory = layers.filter((layer) => psdChoiceKind(layer.name) === "fixed");
  const siblingGroups = new Map<string, string[]>();
  for (const layer of layers) {
    if (psdChoiceKind(layer.name) !== "radio") continue;
    const parent = psdParentPath(layer.path);
    const siblings = siblingGroups.get(parent) ?? [];
    siblings.push(layer.path);
    siblingGroups.set(parent, siblings);
  }
  if (!mandatory.length && !siblingGroups.size) return;

  for (const preset of collection.items) {
    const base = new Map(preset.base.map((entry) => [entry.path, entry.visible]));
    const groupLeaves = (groups: string[] = []) => new Set(layers.filter((layer) =>
      layer.kind !== "group" && psdChoiceKind(layer.name) !== "fixed" &&
      groups.some((group) => layer.path.startsWith(group + "/"))).map((layer) => layer.path));
    const mouthLeaves = groupLeaves(collection.motionGroups?.mouth);
    const eyeLeaves = groupLeaves(collection.motionGroups?.eyes);
    const check = (label: string, overrides?: Visibility[], editable?: Set<string>,
      derivedHiddenGroups: ReadonlySet<string> = new Set()) => {
      const changes = new Map(overrides?.map((entry) => [entry.path, entry.visible]) ?? []);
      for (const path of derivedHiddenGroups) changes.set(path, false);
      const visible = (path: string) => changes.get(path) ??
        (editable?.has(path) ? false : base.get(path));
      for (const layer of mandatory) {
        if (visible(layer.path) !== true) {
          throw new Error(`プリセット「${preset.name}」の${label}: !強制表示レイヤー「${layer.name}」がOFFです。${failureNote}`);
        }
      }
      for (const [parent, paths] of siblingGroups) {
        if (paths.filter((path) => visible(path) === true).length > 1) {
          const onPaths = paths.filter((path) => visible(path) === true);
          const details = onPaths.map((path) => {
            const layer = layers.find((entry) => entry.path === path);
            return `「${layer?.name ?? path}」[${path}]`;
          }).join("、");
          throw new Error(`プリセット「${preset.name}」の${label}: グループ「${parent || "最上位"}」内で*排他レイヤーが複数ONです（${details}）。動作対象グループに含まれない*レイヤーも確認してください。${failureNote}`);
        }
      }
    };
    check("基本");
    if (preset.openMouth) {
      // Legacy closed values are inactive; base defines the resting mouth.
      check("Open open", preset.openMouth.opened, mouthLeaves);
    }
    if (preset.aiueoMouth) {
      for (const key of ["a", "i", "u", "e", "o", "n"] as const) {
        check(`aiueo ${key}`, preset.aiueoMouth[key], mouthLeaves);
      }
    }
    if (preset.eyes) {
      // Legacy opened values are inactive; base defines the resting eyes.
      check("目 close", preset.eyes.closed, eyeLeaves,
        derivedEyeRadioGroupHides(layers, preset.eyes.closed, collection.motionGroups?.eyes ?? []));
    }
  }
}
