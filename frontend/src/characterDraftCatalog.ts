import { parsePresetDraft, type PresetDraft } from "./presetDraftStorage";

/** Separate from portable character JSON, production v5, and legacy v2 recovery. */
export const CHARACTER_DRAFT_CATALOG_KEY = "tachie-motion.character-drafts.v1";
const MAX_GROUPS = 16;
const MAX_CATALOG_CHARS = 8_000_000;

export type CharacterDraftGroup = {
  id: string;
  name: string;
  draft: PresetDraft | null;
};
export type CharacterDraftCatalog = {
  version: 1;
  selectedId: string | null;
  groups: CharacterDraftGroup[];
};
export type CatalogSnapshot = {
  raw: string | null;
  catalog: CharacterDraftCatalog;
};
type DraftStorage = Pick<Storage, "getItem" | "setItem">;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) {
    throw new Error("キャラ別プリセット保存形式が不正です");
  }
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !Object.hasOwn(Object.prototype, value) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function nameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase();
}

export function emptyCharacterDraftCatalog(): CharacterDraftCatalog {
  return { version: 1, selectedId: null, groups: [] };
}

/** Parse the entire catalog before exposing any group; never silently repair data. */
export function parseCharacterDraftCatalog(raw: string): CharacterDraftCatalog {
  if (raw.length > MAX_CATALOG_CHARS) throw new Error("キャラ別プリセットの保存容量が上限を超えています");
  const value: unknown = JSON.parse(raw);
  fields(value, ["version", "selectedId", "groups"]);
  if (value.version !== 1 || !Array.isArray(value.groups) || value.groups.length > MAX_GROUPS ||
      (value.selectedId !== null && !validId(value.selectedId))) {
    throw new Error("キャラ別プリセットのバージョンまたは登録数が不正です");
  }
  const ids = new Set<string>(), names = new Set<string>();
  const groups: CharacterDraftGroup[] = [];
  for (const rawGroup of value.groups) {
    fields(rawGroup, ["id", "name", "draft"]);
    const { id, name, draft } = rawGroup;
    if (!validId(id) || !validName(name) || ids.has(id) || names.has(nameKey(name))) {
      throw new Error("キャラIDまたは名前が不正・重複しています");
    }
    ids.add(id);
    names.add(nameKey(name));
    const parsedDraft = draft === null ? null : parsePresetDraft(JSON.stringify(draft));
    groups.push({ id, name, draft: parsedDraft });
  }
  if (value.selectedId !== null && !ids.has(value.selectedId)) {
    throw new Error("選択中のキャラが見つかりません");
  }
  return { version: 1, selectedId: value.selectedId, groups };
}

export function serializeCharacterDraftCatalog(catalog: CharacterDraftCatalog): string {
  const raw = JSON.stringify(catalog);
  parseCharacterDraftCatalog(raw);
  return raw;
}

function checked(catalog: CharacterDraftCatalog): CharacterDraftCatalog {
  return parseCharacterDraftCatalog(serializeCharacterDraftCatalog(catalog));
}
function groupById(catalog: CharacterDraftCatalog, id: string): CharacterDraftGroup {
  const group = catalog.groups.find((entry) => entry.id === id);
  if (!group) throw new Error("キャラが見つかりません");
  return group;
}

export function addCharacterDraftGroup(
  catalog: CharacterDraftCatalog, id: string, name: string, draft: PresetDraft | null = null,
): CharacterDraftCatalog {
  return checked({ ...catalog, selectedId: id,
    groups: [...catalog.groups, { id, name: name.trim(), draft }] });
}

export function selectCharacterDraftGroup(
  catalog: CharacterDraftCatalog, id: string,
): CharacterDraftCatalog {
  groupById(catalog, id);
  return checked({ ...catalog, selectedId: id });
}

export function renameCharacterDraftGroup(
  catalog: CharacterDraftCatalog, id: string, name: string,
): CharacterDraftCatalog {
  groupById(catalog, id);
  return checked({ ...catalog, groups: catalog.groups.map((group) =>
    group.id === id ? { ...group, name: name.trim() } : group) });
}

/** Normal edits cannot implicitly replace the group's PSD identity. */
export function updateCharacterDraftGroup(
  catalog: CharacterDraftCatalog, id: string, draft: PresetDraft,
): CharacterDraftCatalog {
  const current = groupById(catalog, id).draft;
  if (current && (current.path !== draft.path || current.fingerprint !== draft.fingerprint)) {
    throw new Error("別のPSDは新しいキャラとして登録してください");
  }
  return checked({ ...catalog, groups: catalog.groups.map((group) =>
    group.id === id ? { ...group, draft } : group) });
}

/** A read never migrates, deletes, or updates the legacy single-character draft. */
export function readCharacterDraftCatalog(storage: DraftStorage): CatalogSnapshot {
  const raw = storage.getItem(CHARACTER_DRAFT_CATALOG_KEY);
  return { raw, catalog: raw === null ? emptyCharacterDraftCatalog() : parseCharacterDraftCatalog(raw) };
}

/**
 * A single storage write publishes all groups and selection together. Failed
 * validation/quota writes do not publish UI state. The expected raw snapshot
 * rejects known stale edits; localStorage is not a cross-tab atomic CAS.
 */
export function commitCharacterDraftCatalog(
  storage: DraftStorage, expectedRaw: string | null, catalog: CharacterDraftCatalog,
): CatalogSnapshot {
  const raw = serializeCharacterDraftCatalog(catalog);
  if (storage.getItem(CHARACTER_DRAFT_CATALOG_KEY) !== expectedRaw) {
    throw new Error("別の画面でキャラ設定が更新されました。最新の内容を読み込んでください");
  }
  storage.setItem(CHARACTER_DRAFT_CATALOG_KEY, raw);
  return { raw, catalog: parseCharacterDraftCatalog(raw) };
}
