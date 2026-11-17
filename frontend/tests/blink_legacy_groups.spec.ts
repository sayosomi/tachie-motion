import { expect, test, type Page } from "@playwright/test";
import type { Layer } from "../src/LayerTree";
import type { Presets } from "../src/presetModel";
import { validMotionGroups } from "../src/motionGroups";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const path = "/tmp/blink-legacy.psd";
const fingerprint = "1000:2000";
const nodes: Layer[] = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "口", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 32, 32] },
  { path: "0/0/0", name: "口", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 8, 8] },
  { path: "0/0/1", name: "旧PSDの目", kind: "pixel", visible: false, effective_visible: false, bbox: [9, 0, 17, 8] },
  { path: "0/0/2", name: "内側", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 32, 32] },
  { path: "0/0/2/0", name: "内側の目", kind: "pixel", visible: false, effective_visible: false, bbox: [9, 0, 17, 8] },
  { path: "0/1", name: "目", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 32, 32] },
  { path: "0/1/0", name: "別グループの目", kind: "pixel", visible: false, effective_visible: false, bbox: [9, 0, 17, 8] },
];

type GroupMetadata = Presets["motionGroups"];

function collection(eyePath: string, motionGroups?: GroupMetadata): Presets {
  const preset = {
    id: "legacy-preset", name: "旧プリセット",
    base: nodes.map((node) => ({ path: node.path, visible: node.visible })),
    blinkEnabled: false,
    openMouth: {
      closed: [{ path: "0/0/0", visible: true }],
      opened: [{ path: "0/0/0", visible: false }],
    },
    eyes: {
      opened: [{ path: eyePath, visible: true }],
      closed: [{ path: eyePath, visible: false }],
    },
  };
  return { items: [preset], defaultId: preset.id,
    ...(motionGroups === undefined ? {} : { motionGroups }) };
}

const cases: Array<{ name: string; eye: string; groups?: GroupMetadata; valid: boolean }> = [
  { name: "legacy mouth only, same group", eye: "0/0/1", groups: { mouth: ["0/0"] }, valid: false },
  { name: "legacy no metadata, same group", eye: "0/0/1", valid: false },
  { name: "legacy mouth parent of inferred eyes", eye: "0/1/0", groups: { mouth: ["0"] }, valid: false },
  { name: "explicit eye ancestor of mouth", eye: "0/1/0", groups: { mouth: ["0/0"], eyes: ["0"] }, valid: false },
  { name: "legacy inferred nested eye group", eye: "0/0/2/0", groups: { mouth: ["0/0"] }, valid: false },
  { name: "legacy separate eye and mouth", eye: "0/1/0", groups: { mouth: ["0/0"] }, valid: true },
  { name: "legacy no metadata, separate groups", eye: "0/1/0", valid: true },
  { name: "both explicit separate groups", eye: "0/1/0", groups: { mouth: ["0/0"], eyes: ["0/1"] }, valid: true },
];

for (const fixture of cases) {
  test(`legacy group validation: ${fixture.name}`, () => {
    expect(validMotionGroups(collection(fixture.eye, fixture.groups), nodes))
      .toBe(fixture.valid);
  });
}

function characterProfile(value: Presets) {
  return {
    format: "tachie-motion-character-profile", version: 1,
    source: { path, fingerprint, layerPaths: nodes.map((node) => node.path) },
    collection: value,
  };
}

async function mockPsd(page: Page) {
  await page.route("**/api/psd", (route) => route.fulfill({
    json: { width: 64, height: 64, fingerprint, preview: png, layers: nodes },
  }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
}

async function loadPsd(page: Page) {
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill(path);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
}

async function importProfile(page: Page, data: unknown) {
  await page.locator("#character-profile-file").setInputFiles({
    name: "legacy.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
}

test("legacy conflicting character JSON rejects without overwriting the current browser draft", async ({ page }) => {
  await mockPsd(page);
  await loadPsd(page);
  const original = await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"));
  expect(original).not.toBeNull();

  for (const groups of [{ mouth: ["0/0"] }, undefined, { mouth: ["0"] }]) {
    const profile = characterProfile(collection(
      groups?.mouth[0] === "0" ? "0/1/0" : "0/0/1", groups));
    await importProfile(page, profile);
    await expect(page.getByRole("alert")).toContainText("動作対象グループが不正");
    expect(await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(original);
    await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  }

  // An old JSON without explicit eye group metadata still restores normally
  // when mouth and eye references occupy separate original PSD groups.
  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await importProfile(page, characterProfile(collection("0/1/0", { mouth: ["0/0"] })));
  await expect(page.getByRole("status")).toContainText("キャラクター設定JSONを読み込みました");
  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.motionGroups).toEqual({ mouth: ["0/0"] });
  expect(saved.collection.items[0].eyes.opened).toEqual([
    { path: "0/1/0", visible: true },
  ]);
});

test("browser draft recovery rejects conflicting legacy groups and preserves bytes", async ({ page }) => {
  await mockPsd(page);
  await loadPsd(page);
  const makeDraft = (groups?: GroupMetadata, eye = "0/0/1") => ({
    version: 1, path, fingerprint,
    collection: collection(eye, groups), nameDrafts: {},
  });
  for (const groups of [{ mouth: ["0/0"] }, undefined]) {
    const invalid = JSON.stringify(makeDraft(groups));
    await page.evaluate((value) =>
      localStorage.setItem("tachie-motion.preset-draft.v1", value), invalid);
    await page.reload();
    await expect(page.getByRole("status")).toContainText("動作対象グループが競合");
    expect(await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(invalid);
    await expect(page.locator("[data-preset-id]")).toHaveCount(0);
  }

  const valid = JSON.stringify(makeDraft(undefined, "0/1/0"));
  await page.evaluate((value) =>
    localStorage.setItem("tachie-motion.preset-draft.v1", value), valid);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("前回の編集を復元しました");
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  expect(await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(valid);
});
