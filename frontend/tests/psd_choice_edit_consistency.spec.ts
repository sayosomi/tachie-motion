import { expect, test, type Page } from "@playwright/test";
import type { Layer } from "../src/LayerTree";
import type { Presets } from "../src/presetModel";
import type { PresetDraft } from "../src/presetDraftStorage";
import { matchesSource } from "../src/presetDraftStorage";
import { serializeCharacterProfile } from "../src/characterProfile";
import { serializeProjectFile } from "../src/projectFile";

const source = "/tmp/radio-e2e.psd";
const fingerprint = "1000:2000";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers: Layer[] = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "*A", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 16, 16] },
  { path: "0/1", name: "*B", kind: "pixel", visible: false, effective_visible: false, bbox: [0, 0, 16, 16] },
  { path: "0/2", name: "!共通", kind: "pixel", visible: false, effective_visible: false, bbox: [0, 0, 16, 16] },
];
const collection = (): Presets => ({
  defaultId: "p1",
  items: [{
    id: "p1", name: "通常", blinkEnabled: false,
    base: [
      { path: "0", visible: true },
      { path: "0/0", visible: true },
      { path: "0/1", visible: false },
      { path: "0/2", visible: true },
    ],
    // A is explicitly ON; B inherits OFF from base. Switching base to B
    // without changing this shape would incorrectly turn both radio siblings ON.
    aiueoMouth: {
      a: [{ path: "0/0", visible: true }],
      i: [], u: [], e: [], o: [], n: [],
    },
  }],
});
const draft = (): PresetDraft => ({
  version: 1, path: source, fingerprint,
  collection: collection(), nameDrafts: {},
});

async function intercept(
  page: Page, rendered: Array<Array<{ path: string; visible: boolean }>>,
  psdLayers: Layer[] = layers,
) {
  await page.route("**/api/psd", route => route.fulfill({ json: {
    width: 64, height: 64, preview: image, fingerprint, layers: psdLayers,
  } }));
  await page.route("**/api/preset-preview", route => {
    rendered.push(route.request().postDataJSON().layers);
    return route.fulfill({ json: { preview: image } });
  });
}

async function restore(page: Page, value: PresetDraft) {
  await page.goto("/");
  const raw = JSON.stringify(value);
  await page.evaluate((text) =>
    localStorage.setItem("tachie-motion.preset-draft.v1", text), raw);
  await page.reload();
  return raw;
}

function radio(page: Page, path: string) {
  return page.locator(`.preset-layer[data-layer-path="${path}"]`).getByRole("radio");
}

test("base * switch cannot invalidate inherited aiueo shape; resolving the pose permits it", async ({ page }) => {
  const rendered: Array<Array<{ path: string; visible: boolean }>> = [];
  await intercept(page, rendered);
  const raw = await restore(page, draft());
  await expect(page.getByRole("status").filter({ hasText: "前回の編集を復元しました" })).toBeVisible();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "通常レイヤー" }).click();
  await expect(radio(page, "0/0")).toBeChecked();
  // This click is deliberately rejected, so Playwright's .check() (which
  // requires the radio to end checked) would report a false test failure.
  await radio(page, "0/1").click();
  await expect(page.getByRole("alert")).toContainText("aiueo a");
  await expect(page.getByRole("alert")).toContainText("変更は適用・保存していません");
  await expect(radio(page, "0/0")).toBeChecked();
  await expect(radio(page, "0/1")).not.toBeChecked();
  expect(await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(raw);
  // Any in-flight legitimate preview still receives the entire old base.
  for (const state of rendered) {
    expect(state.map(x => x.visible)).toEqual([true, true, false, true]);
  }

  // Explicitly resolve the existing 'あ' pose first; no old overrides are
  // silently removed, and the previously rejected base edit then succeeds.
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await page.getByRole("group", { name: "口パク方式" })
    .getByRole("button", { name: "あいうえお" }).click();
  await radio(page, "0/1").check();
  await expect(radio(page, "0/0")).not.toBeChecked();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "通常レイヤー" }).click();
  await radio(page, "0/1").check();
  await expect(radio(page, "0/1")).toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.items[0].base.map((x: { visible: boolean }) => x.visible))
    .toEqual([true, false, true, true]);
  expect(saved.collection.items[0].aiueoMouth.a).toEqual([
    { path: "0/0", visible: false }, { path: "0/1", visible: true },
  ]);
  expect(() => serializeCharacterProfile(source, fingerprint, layers, saved.collection))
    .not.toThrow();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "前回の編集を復元しました" })).toBeVisible();
  expect(await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(JSON.stringify(saved));
});

test("direct character/project JSON export refuses base changes that violate saved phonemes", () => {
  const invalid = draft();
  invalid.collection.items[0].base[1].visible = false;
  invalid.collection.items[0].base[2].visible = true;
  expect(() => serializeCharacterProfile(source, fingerprint, layers, invalid.collection))
    .toThrow("aiueo a");
  expect(() => serializeProjectFile(invalid, layers, [], null))
    .toThrow("aiueo a");
});

test("eyes recovery validates structure, duplicate/missing paths, and PSD leaf kinds", async ({ page }) => {
  const rendered: Array<Array<{ path: string; visible: boolean }>> = [];
  // Legacy eye and mouth poses must reside in distinct original PSD groups.
  // The prior "valid" fixture reused 0 for both, masking the regression.
  const eyeLayers: Layer[] = [
    ...layers,
    { path: "1", name: "目", kind: "group", visible: true,
      effective_visible: true, bbox: [0, 0, 64, 64] },
    { path: "1/0", name: "開眼", kind: "pixel", visible: true,
      effective_visible: true, bbox: [0, 0, 16, 16] },
    { path: "1/1", name: "閉眼", kind: "pixel", visible: false,
      effective_visible: false, bbox: [0, 0, 16, 16] },
  ];
  await intercept(page, rendered, eyeLayers);
  const valid = draft();
  valid.collection.items[0].base.push(
    { path: "1", visible: true }, { path: "1/0", visible: true },
    { path: "1/1", visible: false },
  );
  valid.collection.items[0].eyes = {
    opened: [{ path: "1/0", visible: true }],
    closed: [{ path: "1/0", visible: false }, { path: "1/1", visible: true }],
  };
  // No motionGroups metadata: infer the two distinct source PSD groups.
  expect(matchesSource(valid, fingerprint, eyeLayers)).toBe(true);
  expect(() => serializeCharacterProfile(source, fingerprint, eyeLayers, valid.collection))
    .not.toThrow();
  await restore(page, valid);
  await expect(page.getByRole("status").filter({ hasText: "前回の編集を復元しました" })).toBeVisible();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);

  const cases = [
    { name: "missing", eyes: { opened: [{ path: "9", visible: true }], closed: [] } },
    { name: "duplicate", eyes: { opened: [
      { path: "0/0", visible: true }, { path: "0/0", visible: false },
    ], closed: [] } },
    { name: "group", eyes: { opened: [{ path: "0", visible: true }], closed: [] } },
    { name: "malformed", eyes: { opened: [], closed: [], extra: [] } },
    { name: "unknown entry field", eyes: { opened: [
      { path: "0/0", visible: true, unexpected: 123 },
    ], closed: [] } },
  ];
  for (const item of cases) {
    const invalid = draft();
    // Intentionally malformed legacy storage; preserve its exact original bytes.
    (invalid.collection.items[0] as unknown as { eyes: unknown }).eyes = item.eyes;
    const raw = JSON.stringify(invalid);
    await page.evaluate((text) =>
      localStorage.setItem("tachie-motion.preset-draft.v1", text), raw);
    const before = rendered.length;
    await page.reload();
    await expect(page.locator("[data-preset-id]")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("保存データ");
    expect(await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(raw);
    expect(rendered.length).toBe(before);
    if (item.name === "group") {
      expect(matchesSource(invalid, fingerprint, layers)).toBe(false);
      expect(() => serializeCharacterProfile(source, fingerprint, layers, invalid.collection))
        .toThrow("瞬き設定");
    }
    if (item.name === "unknown entry field") {
      expect(() => serializeCharacterProfile(source, fingerprint, layers, invalid.collection))
        .toThrow("項目が不正");
    }
  }
});

test("browser recovery rejects extra layer fields in base, Open and aiueo without rewriting draft", async ({ page }) => {
  const rendered: Array<Array<{ path: string; visible: boolean }>> = [];
  await intercept(page, rendered);
  await page.goto("/");

  const variants: Array<{ name: string; mutate: (value: PresetDraft) => void }> = [
    { name: "base", mutate: value => {
      (value.collection.items[0].base[1] as unknown as Record<string, unknown>).unexpected = 123;
    } },
    { name: "Open", mutate: value => {
      (value.collection.items[0] as unknown as Record<string, unknown>).openMouth = {
        closed: [{ path: "0/0", visible: true, unexpected: 123 }],
        opened: [{ path: "0/0", visible: false }],
      };
    } },
    { name: "あいうえお", mutate: value => {
      (value.collection.items[0].aiueoMouth!.a[0] as unknown as Record<string, unknown>).unexpected = 123;
    } },
  ];
  for (const variant of variants) {
    const invalid = draft();
    variant.mutate(invalid);
    expect(() => serializeCharacterProfile(source, fingerprint, layers, invalid.collection))
      .toThrow("項目が不正");
    const raw = JSON.stringify(invalid);
    await page.evaluate((text) =>
      localStorage.setItem("tachie-motion.preset-draft.v1", text), raw);
    const before = rendered.length;
    await page.reload();
    await expect(page.locator("[data-preset-id]")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("保存データ");
    expect(await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(raw);
    expect(rendered.length).toBe(before);
  }
});
