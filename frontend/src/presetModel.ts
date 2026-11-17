import type { Layer } from "./LayerTree";
import type { MotionGroups } from "./motionGroups";

export type Visibility = { path: string; visible: boolean };
export type Shape = Visibility[];
export type UnifiedPreset = {
  id: string;
  name: string;
  base: Visibility[];
  openMouth?: { closed: Shape; opened: Shape };
  aiueoMouth?: { a: Shape; i: Shape; u: Shape; e: Shape; o: Shape; n: Shape };
  eyes?: { opened: Shape; closed: Shape };
  blinkEnabled: boolean;
  /** Optional for backwards compatibility. Undefined means enabled. */
  mouthMotionEnabled?: boolean;
};
export type Presets = {
  items: UnifiedPreset[];
  defaultId: string | null;
  /** PSD source-group bindings shared by all presets of one character. */
  motionGroups?: MotionGroups;
};

export function createPreset(name: string, layers: Layer[]): UnifiedPreset {
  if (!name.trim()) throw new Error("プリセット名を入力してください");
  return {
    id: crypto.randomUUID(),
    name,
    base: layers.map(({ path, visible }) => ({ path, visible })),
    blinkEnabled: false,
    mouthMotionEnabled: true,
  };
}

function comparableName(name: string): string {
  return name.trim().normalize("NFC").toLocaleLowerCase();
}

function nameTaken(current: Presets, name: string, exceptId?: string): boolean {
  return current.items.some((item) =>
    item.id !== exceptId && comparableName(item.name) === comparableName(name));
}

export function availablePresetName(current: Presets, desired: string): string {
  const base = desired.trim();
  if (!base) throw new Error("プリセット名を入力してください");
  if (!nameTaken(current, base)) return base;
  let index = 2;
  while (nameTaken(current, `${base} ${index}`)) index++;
  return `${base} ${index}`;
}

export function appendPreset(current: Presets, preset: UnifiedPreset): Presets {
  if (current.items.some((item) => item.id === preset.id)) throw new Error("Duplicate preset ID");
  if (nameTaken(current, preset.name)) throw new Error("同じ名前のプリセットがあります");
  return {
    ...current,
    items: [...current.items, preset],
    defaultId: current.defaultId ?? preset.id,
  };
}

export function duplicatePreset(current: Presets, id: string): Presets {
  const index = current.items.findIndex((item) => item.id === id);
  if (index < 0) return current;
  const copy: UnifiedPreset = {
    ...structuredClone(current.items[index]),
    id: crypto.randomUUID(),
    name: availablePresetName(current, current.items[index].name + " コピー"),
  };
  return {
    ...current,
    items: [...current.items.slice(0, index + 1), copy, ...current.items.slice(index + 1)],
  };
}

export function renamePreset(current: Presets, id: string, name: string): Presets {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("プリセット名を入力してください");
  if (nameTaken(current, trimmed, id)) throw new Error("同じ名前のプリセットがあります");
  return { ...current, items: current.items.map((item) => item.id === id ? { ...item, name: trimmed } : item) };
}

export function toggleBaseLayer(current: Presets, id: string, path: string): Presets {
  return {
    ...current,
    items: current.items.map((item) => item.id === id ? {
      ...item,
      base: item.base.map((layer) => layer.path === path ? { ...layer, visible: !layer.visible } : layer),
    } : item),
  };
}

export function reorderPresets(current: Presets, sourceId: string, targetId: string): Presets {
  if (sourceId === targetId) return current;
  const from = current.items.findIndex((item) => item.id === sourceId);
  const to = current.items.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0) return current;
  const items = [...current.items];
  const [moving] = items.splice(from, 1);
  items.splice(to, 0, moving);
  return { ...current, items };
}

export function movePreset(current: Presets, id: string, direction: -1 | 1): Presets {
  const from = current.items.findIndex((item) => item.id === id);
  const target = current.items[from + direction];
  return target ? reorderPresets(current, id, target.id) : current;
}

/** Only for unsaved, in-browser collections. No saved project references exist. */
export function removeSessionPreset(current: Presets, id: string): Presets {
  const items = current.items.filter((item) => item.id !== id);
  if (items.length === current.items.length) return current;
  return { ...current, items,
    defaultId: current.defaultId === id ? (items[0]?.id ?? null) : current.defaultId };
}

/** Six independently editable phoneme mouth states; "n" also serves as rest. */
export const AIUEO_KEYS = ["a", "i", "u", "e", "o", "n"] as const;
export const AIUEO_LABELS = { a: "あ", i: "い", u: "う", e: "え", o: "お", n: "ん" } as const;
export type AiueoKey = typeof AIUEO_KEYS[number];
export type AiueoLayerRole = "base" | "show" | "hide";
export type AiueoMouth = NonNullable<UnifiedPreset["aiueoMouth"]>;

export function aiueoLayerRole(
  preset: UnifiedPreset, key: AiueoKey, path: string,
): AiueoLayerRole {
  const layer = preset.aiueoMouth?.[key].find((entry) => entry.path === path);
  return layer === undefined ? "base" : layer.visible ? "show" : "hide";
}

/** Override exactly one layer in one mouth; other five mouths and Open survive. */
export function assignAiueoLayerRole(
  current: Presets, id: string, key: AiueoKey, path: string, role: AiueoLayerRole,
): Presets {
  if (!AIUEO_KEYS.includes(key) || !["base", "show", "hide"].includes(role)) {
    throw new Error("Invalid aiueo mouth key or role");
  }
  const preset = current.items.find((item) => item.id === id);
  if (!preset || !preset.base.some((entry) => entry.path === path)) {
    throw new Error("Unknown preset or source layer path");
  }
  const overrides = new Map(preset.aiueoMouth?.[key].map((entry) => [entry.path, entry.visible]));
  overrides.delete(path);
  if (role !== "base") overrides.set(path, role === "show");
  const shape = preset.base.filter((entry) => overrides.has(entry.path)).map((entry) => ({
    path: entry.path, visible: overrides.get(entry.path)!,
  }));
  const next = Object.fromEntries(AIUEO_KEYS.map((name) => [
    name, name === key ? shape : [...(preset.aiueoMouth?.[name] ?? [])],
  ])) as AiueoMouth;
  const aiueoMouth = AIUEO_KEYS.some((name) => next[name].length) ? next : undefined;
  return { ...current, items: current.items.map((item) =>
    item.id === id ? { ...item, aiueoMouth } : item) };
}

export type OpenMouth = NonNullable<UnifiedPreset["openMouth"]>;

/** Optional multi-layer overrides. Stable preset identity and base remain unchanged. */
export function setOpenMouth(current: Presets, id: string, mouth?: OpenMouth): Presets {
  return { ...current, items: current.items.map((item) =>
    item.id === id ? { ...item, openMouth: mouth } : item) };
}


/** A compact UI role for one PSD leaf; 'custom' preserves earlier complex pairs. */
export type OpenLayerRole = "none" | "closed" | "opened" | "custom";
export type EditableOpenLayerRole = Exclude<OpenLayerRole, "custom">;

export function openLayerRole(preset: UnifiedPreset, path: string): OpenLayerRole {
  const closed = preset.openMouth?.closed.find((item) => item.path === path);
  const opened = preset.openMouth?.opened.find((item) => item.path === path);
  if (!closed && !opened) return "none";
  if (!closed || !opened) return "custom";
  if (closed.visible && !opened.visible) return "closed";
  if (!closed.visible && opened.visible) return "opened";
  // Preserve previous shared/fully-hidden overrides until explicitly changed.
  return "custom";
}

/** Set one role without changing other target layers, base ON/OFF, or preset IDs. */
export function assignOpenLayerRole(
  current: Presets, id: string, path: string, role: EditableOpenLayerRole,
): Presets {
  if (!["none", "closed", "opened"].includes(role)) {
    throw new Error("Invalid Open mouth layer role");
  }
  const preset = current.items.find((item) => item.id === id);
  if (!preset || !preset.base.some((layer) => layer.path === path)) {
    throw new Error("Unknown preset or source layer path");
  }
  const mouth = preset.openMouth;
  const closed = (mouth?.closed ?? []).filter((item) => item.path !== path);
  const opened = (mouth?.opened ?? []).filter((item) => item.path !== path);
  if (role !== "none") {
    closed.push({ path, visible: role === "closed" });
    opened.push({ path, visible: role === "opened" });
  }
  // Only remove the set when completely empty; other custom entries survive.
  return setOpenMouth(current, id, closed.length || opened.length
    ? { closed, opened } : undefined);
}

/** Preset-specific motion switch. A disabled mouth retains all shape settings. */
export function setMouthMotionEnabled(current: Presets, id: string, enabled: boolean): Presets {
  return { ...current, items: current.items.map((item) =>
    item.id === id ? { ...item, mouthMotionEnabled: enabled } : item) };
}

/**
 * Edit one Open shape as a real visibility checkbox. The opposite shape keeps
 * its previous visibility (or the base value when it has no override).
 * Open's paired-target invariant is preserved for JSON and the renderer.
 */
export function setOpenShapeVisibility(
  current: Presets, id: string, shape: "closed" | "opened", path: string, visible: boolean,
): Presets {
  const preset = current.items.find((item) => item.id === id);
  const base = preset?.base.find((layer) => layer.path === path);
  if (!preset || !base) throw new Error("Unknown preset or layer");
  const oldClosed = preset.openMouth?.closed.find((layer) => layer.path === path);
  const oldOpened = preset.openMouth?.opened.find((layer) => layer.path === path);
  const nextClosed = shape === "closed" ? visible : (oldClosed?.visible ?? base.visible);
  const nextOpened = shape === "opened" ? visible : (oldOpened?.visible ?? base.visible);
  const closedMap = new Map(preset.openMouth?.closed.map((layer) => [layer.path, layer.visible]));
  const openedMap = new Map(preset.openMouth?.opened.map((layer) => [layer.path, layer.visible]));
  // Clearing both deviations removes the target altogether.
  if (nextClosed === base.visible && nextOpened === base.visible) {
    closedMap.delete(path);
    openedMap.delete(path);
  } else {
    closedMap.set(path, nextClosed);
    openedMap.set(path, nextOpened);
  }
  const closed = preset.base.filter((layer) => closedMap.has(layer.path))
    .map((layer) => ({ path: layer.path, visible: closedMap.get(layer.path)! }));
  const opened = preset.base.filter((layer) => openedMap.has(layer.path))
    .map((layer) => ({ path: layer.path, visible: openedMap.get(layer.path)! }));
  return setOpenMouth(current, id, closed.length ? { closed, opened } : undefined);
}
