import { expect, test, type Page } from "@playwright/test";
import type { Layer } from "../src/LayerTree";
import type { Presets } from "../src/presetModel";
import type { PresetDraft } from "../src/presetDraftStorage";
import { matchesSource } from "../src/presetDraftStorage";
import { validatePsdChoices } from "../src/psdChoice";
import {
  parseCharacterProfile, validateCharacterProfileOpenTargets,
  type CharacterProfile,
} from "../src/characterProfile";
import { parseProjectFile, serializeProjectFile } from "../src/projectFile";
import { inspectProjectSources } from "../src/projectRestore";

const source = "/tmp/旧 PSD レイヤー.psd";
const fingerprint = "1000:2000";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers: Layer[] = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "*通常", kind: "pixel", visible: true, effective_visible: true, bbox: [5, 5, 25, 25] },
  { path: "0/1", name: "*笑顔", kind: "pixel", visible: true, effective_visible: true, bbox: [5, 5, 25, 25] },
  { path: "0/2", name: "!共通", kind: "pixel", visible: false, effective_visible: false, bbox: [5, 5, 25, 25] },
  { path: "1", name: "体", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
];
const validBase = [
  { path: "0", visible: true },
  { path: "0/0", visible: true },
  { path: "0/1", visible: false },
  { path: "0/2", visible: true },
  { path: "1", visible: true },
];
const openShape = {
  closed: [{ path: "0/0", visible: true }, { path: "0/1", visible: false }],
  opened: [{ path: "0/0", visible: false }, { path: "0/1", visible: true }],
};
const validCollection: Presets = {
  defaultId: "p1", motionGroups: { mouth: ["0"] },
  items: [{ id: "p1", name: "通常", base: validBase, blinkEnabled: false, openMouth: openShape }],
};
const profile = (): CharacterProfile => ({
  format: "tachie-motion-character-profile", version: 2,
  source: { path: source, fingerprint, layerPaths: layers.map((layer) => layer.path) },
  collection: structuredClone(validCollection),
});
const draft = (): PresetDraft => ({
  version: 2, path: source, fingerprint,
  collection: structuredClone(validCollection), nameDrafts: {},
});

test("source PSD validates fixed and active shapes but preserves inert legacy close overrides", () => {
  const safe = profile();
  const parsed = parseCharacterProfile(JSON.stringify(safe));
  expect(() => validateCharacterProfileOpenTargets(parsed, layers)).not.toThrow();
  expect(matchesSource(draft(), fingerprint, layers)).toBe(true);

  const multiStar = profile();
  multiStar.collection.items[0].base[2].visible = true;
  expect(() => validateCharacterProfileOpenTargets(
    parseCharacterProfile(JSON.stringify(multiStar)), layers)).toThrow("*排他");
  expect(() => validatePsdChoices(multiStar.collection, layers)).toThrow("*排他");

  const mandatoryHidden = profile();
  mandatoryHidden.collection.items[0].base[3].visible = false;
  expect(() => validateCharacterProfileOpenTargets(
    parseCharacterProfile(JSON.stringify(mandatoryHidden)), layers)).toThrow("!強制");
  const mandatoryDraft = draft();
  mandatoryDraft.collection.items[0].base[3].visible = false;
  expect(matchesSource(mandatoryDraft, fingerprint, layers)).toBe(false);

  const legacyClosed = profile();
  legacyClosed.collection.items[0].openMouth!.closed[1].visible = true;
  // Inert historical close cannot override or block the fixed-layer baseline.
  expect(() => validateCharacterProfileOpenTargets(legacyClosed, layers)).not.toThrow();
  const saved = JSON.stringify(legacyClosed);
  expect(parseCharacterProfile(saved).collection.items[0].openMouth!.closed[1].visible).toBe(true);

  const invalidOpen = profile();
  invalidOpen.collection.items[0].openMouth!.opened[2] = { path: "0/2", visible: false };
  expect(() => validateCharacterProfileOpenTargets(invalidOpen, layers)).toThrow("!強制");

  const invalidAiueo = profile();
  invalidAiueo.collection.items[0].aiueoMouth = {
    a: [{ path: "0/0", visible: false }, { path: "0/1", visible: true }],
    i: [{ path: "0/0", visible: true }, { path: "0/1", visible: true }],
    u: [], e: [], o: [], n: [],
  };
  expect(() => validateCharacterProfileOpenTargets(invalidAiueo, layers)).toThrow("aiueo i");

  // Ancestor visibility is separate from direct child PSDTool constraints.
  const hiddenParent = profile();
  hiddenParent.collection.items[0].base[0].visible = false;
  expect(() => validateCharacterProfileOpenTargets(hiddenParent, layers)).not.toThrow();
});

test("browser draft refuses group-target Open and missing motion group bindings", () => {
  const malformed = draft();
  malformed.collection.items[0].openMouth = {
    closed: [{ path: "0", visible: true }],
    opened: [{ path: "0", visible: false }],
  };
  expect(matchesSource(malformed, fingerprint, layers)).toBe(false);
  const unbound = draft();
  delete unbound.collection.motionGroups;
  expect(matchesSource(unbound, fingerprint, layers)).toBe(false);
  expect(matchesSource(draft(), fingerprint, layers)).toBe(true);
});

test("project restore checks old PSDTool constraints after PSD inspection and before committing", async () => {
  const original = parseProjectFile(serializeProjectFile(draft(), layers, [], null));
  const broken = structuredClone(original);
  broken.character.collection.items[0].base[2].visible = true;
  const inspected = await inspectProjectSources(broken, source, {}, new Set(),
    async <T>(kind: "psd" | "wav") => {
      if (kind !== "psd") throw new Error("Unexpected WAV read");
      return { fingerprint, layers } as T;
    });
  expect(inspected.psd).toBeNull();
  expect(inspected.problems).toHaveLength(1);
  expect(inspected.problems[0].message).toContain("*排他");

  const recovered = await inspectProjectSources(original, source, {}, new Set(),
    async <T>(kind: "psd" | "wav") => {
      if (kind !== "psd") throw new Error("Unexpected WAV read");
      return { fingerprint, layers } as T;
    });
  expect(recovered.psd).not.toBeNull();
  expect(recovered.problems).toEqual([]);
});

async function mockPsd(page: Page, rendering: Array<Array<{ path: string; visible: boolean }>>) {
  await page.route("**/api/psd", route => route.fulfill({ json: {
    width: 64, height: 64, preview: png, fingerprint, layers,
  } }));
  await page.route("**/api/preset-preview", route => {
    rendering.push(route.request().postDataJSON().layers);
    return route.fulfill({ json: { preview: png } });
  });
}

async function openPsd(page: Page) {
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
}

test("browser recovery rejects bad old PSDTool layer data without rewriting localStorage or rendering", async ({ page }) => {
  const renderRequests: Array<{ path: string; visible: boolean }[]> = [];
  await mockPsd(page, renderRequests);
  await openPsd(page);
  const initial = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v2")))!);
  expect(initial.collection.items[0].base).toEqual(validBase);

  const variants: Array<{ label: string; make: (data: PresetDraft) => void }> = [
    { label: "*", make: data => { data.collection.items[0].base[2].visible = true; } },
    { label: "!", make: data => { data.collection.items[0].base[3].visible = false; } },
    { label: "Open group", make: data => {
      data.collection.items[0].openMouth = {
        closed: [{ path: "0", visible: true }],
        opened: [{ path: "0", visible: false }],
      };
    } },
  ];
  for (const variant of variants) {
    const bad = draft();
    variant.make(bad);
    const raw = JSON.stringify(bad);
    await page.evaluate((value) => localStorage.setItem("tachie-motion.preset-draft.v2", value), raw);
    const countBefore = renderRequests.length;
    await page.reload();
    await expect(page.getByRole("status")).toContainText("保存データは保持しています");
    await expect(page.locator("[data-preset-id]")).toHaveCount(0);
    expect(await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v2"))).toBe(raw);
    expect(renderRequests.length).toBe(countBefore);
  }
});

test("character JSON import rejects old conflicting states but keeps current draft and render inputs", async ({ page }) => {
  const renderRequests: Array<{ path: string; visible: boolean }[]> = [];
  await mockPsd(page, renderRequests);
  await openPsd(page);
  const original = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"));
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const before = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"));
  const malformed = profile();
  malformed.collection.items[0].base[2].visible = true;
  await page.locator("#character-profile-file").setInputFiles({
    name: "legacy.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.getByRole("alert")).toContainText("*排他");
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"))).toBe(before);
  // An in-flight render of the legitimate second preset may finish after
  // the rejected import. Check the full renderer inputs, not call timing.
  for (const states of renderRequests) {
    expect(states).toHaveLength(layers.length);
    expect(states.find(x => x.path === "0/0")?.visible).toBe(true);
    expect(states.find(x => x.path === "0/1")?.visible).toBe(false);
    expect(states.find(x => x.path === "0/2")?.visible).toBe(true);
  }
  expect(original).not.toBe(before);
});
