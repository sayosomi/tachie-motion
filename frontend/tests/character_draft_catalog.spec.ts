import { expect, test } from "@playwright/test";
import {
  CHARACTER_DRAFT_CATALOG_KEY, addCharacterDraftGroup, commitCharacterDraftCatalog,
  emptyCharacterDraftCatalog, parseCharacterDraftCatalog, readCharacterDraftCatalog,
  renameCharacterDraftGroup, selectCharacterDraftGroup, updateCharacterDraftGroup,
} from "../src/characterDraftCatalog";
import type { PresetDraft } from "../src/presetDraftStorage";

const legacyKey = "tachie-motion.preset-draft.v2";
function draft(path: string, prefix: string): PresetDraft {
  return {
    version: 2, path, fingerprint: "1000:2000",
    collection: { defaultId: prefix + "-normal", items: [
      { id: prefix + "-normal", name: "通常", blinkEnabled: false,
        base: [{ path: "0", visible: true }] },
      { id: prefix + "-happy", name: "笑顔", blinkEnabled: false,
        base: [{ path: "0", visible: false }] },
    ] },
    nameDrafts: { [prefix + "-happy"]: "編集中" },
  };
}
function memoryStorage() {
  const entries = new Map<string, string>();
  let failWrite = false;
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrite) throw new Error("QuotaExceededError");
      entries.set(key, value);
    },
  };
  return { storage, fail: () => { failWrite = true; } };
}

test("character draft groups survive add, switch, edit, rename and reload independently", () => {
  const { storage } = memoryStorage();
  const a = draft("/tmp/立ち絵 e\u0301/A.psd", "a");
  const b = draft("/tmp/別フォルダ/A.psd", "b");
  const legacy = JSON.stringify(a);
  storage.setItem(legacyKey, legacy);

  let snapshot = readCharacterDraftCatalog(storage);
  expect(snapshot.catalog).toEqual(emptyCharacterDraftCatalog());
  snapshot = commitCharacterDraftCatalog(storage, snapshot.raw,
    addCharacterDraftGroup(snapshot.catalog, "a", "あんこ", a));
  snapshot = commitCharacterDraftCatalog(storage, snapshot.raw,
    addCharacterDraftGroup(snapshot.catalog, "b", "ぼぶ", b));
  expect(snapshot.catalog.selectedId).toBe("b");

  const changedB = { ...b, collection: { ...b.collection, defaultId: "b-happy" } };
  snapshot = commitCharacterDraftCatalog(storage, snapshot.raw,
    updateCharacterDraftGroup(snapshot.catalog, "b", changedB));
  snapshot = commitCharacterDraftCatalog(storage, snapshot.raw,
    renameCharacterDraftGroup(snapshot.catalog, "b", "ぼぶ改名"));
  snapshot = commitCharacterDraftCatalog(storage, snapshot.raw,
    selectCharacterDraftGroup(snapshot.catalog, "a"));

  const restored = readCharacterDraftCatalog(storage);
  expect(restored).toEqual(snapshot);
  expect(restored.catalog.selectedId).toBe("a");
  expect(restored.catalog.groups).toEqual([
    { id: "a", name: "あんこ", draft: a },
    { id: "b", name: "ぼぶ改名", draft: changedB },
  ]);
  expect(storage.getItem(legacyKey)).toBe(legacy);
});

test("invalid groups, duplicate normalized names and source replacement fail closed", () => {
  const a = draft("/tmp/A.psd", "a");
  const initial = addCharacterDraftGroup(emptyCharacterDraftCatalog(), "a", "Cafe\u0301", a);
  expect(() => addCharacterDraftGroup(initial, "a", "別名")).toThrow();
  expect(() => addCharacterDraftGroup(initial, "b", "CAFÉ")).toThrow();
  expect(() => addCharacterDraftGroup(initial, "b", " ")).toThrow();
  expect(() => addCharacterDraftGroup(initial, "__proto__", "別名")).toThrow();
  expect(() => selectCharacterDraftGroup(initial, "missing")).toThrow();
  expect(() => renameCharacterDraftGroup(initial, "missing", "名前")).toThrow();
  expect(() => updateCharacterDraftGroup(initial, "a", { ...a, path: "/tmp/B.psd" })).toThrow();
  expect(() => updateCharacterDraftGroup(initial, "a", { ...a, fingerprint: "new" })).toThrow();
  expect(() => updateCharacterDraftGroup(initial, "a", {
    ...a, collection: { ...a.collection, defaultId: "missing" },
  })).toThrow();
  expect(() => parseCharacterDraftCatalog(JSON.stringify({
    ...initial, selectedId: "missing",
  }))).toThrow();
  expect(initial.groups[0].draft).toEqual(a);
});

test("failed persistence and known stale snapshots preserve the last committed catalog", () => {
  const { storage, fail } = memoryStorage();
  const initial = readCharacterDraftCatalog(storage);
  const a = commitCharacterDraftCatalog(storage, initial.raw,
    addCharacterDraftGroup(initial.catalog, "a", "A", draft("/tmp/A.psd", "a")));
  const b = commitCharacterDraftCatalog(storage, a.raw,
    addCharacterDraftGroup(a.catalog, "b", "B", draft("/tmp/B.psd", "b")));
  expect(() => commitCharacterDraftCatalog(storage, a.raw,
    renameCharacterDraftGroup(a.catalog, "a", "stale"))).toThrow();
  expect(storage.getItem(CHARACTER_DRAFT_CATALOG_KEY)).toBe(b.raw);
  fail();
  expect(() => commitCharacterDraftCatalog(storage, b.raw,
    renameCharacterDraftGroup(b.catalog, "a", "new"))).toThrow("QuotaExceededError");
  expect(readCharacterDraftCatalog(storage)).toEqual(b);
});

test("malformed catalog reads never reset or overwrite existing storage", () => {
  const { storage } = memoryStorage();
  const invalid = '{"version":1,"groups":[]}';
  storage.setItem(CHARACTER_DRAFT_CATALOG_KEY, invalid);
  expect(() => readCharacterDraftCatalog(storage)).toThrow();
  expect(storage.getItem(CHARACTER_DRAFT_CATALOG_KEY)).toBe(invalid);
  expect(() => commitCharacterDraftCatalog(storage, null, emptyCharacterDraftCatalog())).toThrow();
  expect(storage.getItem(CHARACTER_DRAFT_CATALOG_KEY)).toBe(invalid);
});
