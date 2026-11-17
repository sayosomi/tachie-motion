import type { Layer } from "./LayerTree";
import type { Visibility } from "./presetModel";

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
