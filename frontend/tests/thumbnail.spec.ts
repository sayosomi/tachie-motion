import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "face", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "mouth", kind: "pixel", visible: true, effective_visible: true, bbox: [2, 2, 8, 8] },
];
const source = "/tmp/立ち絵 あんこもん.psd";
const draftKey = "tachie-motion.preset-draft.v2";

async function start(page: Page) {
  await page.route("**/api/psd", (route) => route.fulfill({
    json: { width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers },
  }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.route("**/api/health", (route) => route.fulfill({
    json: { ok: true, default_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 8000, sample_rate: 8000, duration_seconds: 1, source_identity: "wav-1" },
  }));
  await page.route("**/api/preset-utterance-destination", (route) => route.fulfill({
    json: { state: "available", suggested_basename: "unused" },
  }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (node) => { (node as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.locator(".preset-card")).toHaveCount(1);
}

async function savedDraft(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as {
    collection: { items: Array<{
      id: string; name: string; thumbnail?: { zoom: number; centerX: number; centerY: number };
    }> };
  }, draftKey);
}

async function editAndSave(page: Page) {
  await page.getByRole("button", { name: "サムネイルを編集" }).click();
  const editor = page.locator(".thumbnail-editor");
  await expect(editor.locator("img")).toBeVisible();
  const range = page.getByRole("slider", { name: "サムネイル倍率" });
  await range.focus();
  await range.press("ArrowRight");
  await range.press("ArrowRight");
  await range.press("ArrowRight");
  await range.press("ArrowRight");
  await expect(editor.locator("output")).toHaveText("2.00×");
  const bounds = await editor.locator(".thumbnail-edit-stage").boundingBox();
  expect(bounds).not.toBeNull();
  const box = bounds!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 18, { steps: 3 });
  await page.mouse.up();
  await page.getByRole("button", { name: "サムネイルを保存" }).click();
}

test("thumbnail crop is persisted and reused by the preset list without changing PSD base", async ({ page }) => {
  await start(page);
  const before = await savedDraft(page);
  expect(before.collection.items[0].thumbnail).toBeUndefined();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await editAndSave(page);
  await expect.poll(async () => (await savedDraft(page)).collection.items[0].thumbnail?.zoom).toBe(2);
  const after = (await savedDraft(page)).collection.items[0];
  expect(after.thumbnail?.centerX).toBeLessThan(0.5);
  expect(after.thumbnail?.centerY).toBeLessThan(0.5);
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const card = page.locator(".preset-card").first();
  const width = await card.locator("img").evaluate((img) => parseFloat((img as HTMLImageElement).style.width));
  const stageWidth = await card.locator(".preset-card-image").evaluate((node) => node.clientWidth);
  expect(width).toBeGreaterThan(stageWidth);
  await page.reload();
  await expect(page.locator(".preset-card")).toHaveCount(1);
  expect((await savedDraft(page)).collection.items[0].thumbnail).toEqual(after.thumbnail);
  await card.getByRole("button", { name: "複製" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const copied = (await savedDraft(page)).collection.items;
  expect(copied).toHaveLength(2);
  expect(copied[1].id).not.toBe(copied[0].id);
  expect(copied[1].thumbnail).toEqual(copied[0].thumbnail);
});

test("WAV choices display per-preset thumbnails and assign by stable ID", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.locator("#preset-name").fill("にっこり");
  await page.getByRole("button", { name: "名前を変更" }).click();
  await editAndSave(page);
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const items = (await savedDraft(page)).collection.items;
  const selectedId = items[1].id;
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate(
    (node) => { (node as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/音声 が.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  const row = page.locator("[data-utterance-id]").first();
  await expect(row).toBeVisible();
  const trigger = row.locator(".preset-picker-trigger");
  await expect(trigger).toHaveAttribute("data-selected-preset-id", items[0].id);
  await trigger.click();
  const choices = row.locator(".preset-picker-option");
  await expect(choices).toHaveCount(2);
  await expect(choices.locator("img")).toHaveCount(2);
  await expect(choices).toContainText(["通常", "にっこり"]);
  await choices.filter({ hasText: "にっこり" }).click();
  await expect(trigger).toHaveAttribute("data-selected-preset-id", selectedId);
  await expect(trigger).toContainText("にっこり");
  await expect(trigger.locator("img")).toBeVisible();
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(row.locator(".preset-picker-trigger"))
    .toHaveAttribute("data-selected-preset-id", selectedId);
});

test("invalid saved thumbnail metadata blocks recovery rather than normalizing silently", async ({ page }) => {
  await start(page);
  const original = await page.evaluate((key) => localStorage.getItem(key)!, draftKey);
  for (const bad of [
    { zoom: 9, centerX: 0.5, centerY: 0.5 },
    { zoom: 2, centerX: -0.1, centerY: 0.5 },
    { zoom: "2", centerX: 0.5, centerY: 0.5 },
    { zoom: 2, centerX: 0.5, centerY: 0.5, untrusted: true },
  ]) {
    await page.evaluate(({ key, raw, bad }) => {
      const value = JSON.parse(raw);
      value.collection.items[0].thumbnail = bad;
      localStorage.setItem(key, JSON.stringify(value));
    }, { key: draftKey, raw: original, bad });
    await page.reload();
    await expect(page.getByRole("status")).toContainText("保存済みプリセットの内容が不正");
    await expect(page.locator(".preset-card")).toHaveCount(0);
  }
});
