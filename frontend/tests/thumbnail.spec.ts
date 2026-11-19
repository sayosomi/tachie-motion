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
  const stage = page.locator(".preset-image-viewport");
  await expect(stage.locator("img")).toBeVisible();
  const controls = page.locator(".preset-image-controls");
  await controls.getByRole("button", { name: "拡大" }).click();
  await controls.getByRole("button", { name: "拡大" }).click();
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("2×");

  // Obtain viewport coordinates AFTER clicking zoom controls: Playwright can
  // scroll the page to those buttons, invalidating earlier bounding boxes.
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width / box!.height - 4 / 3)).toBeLessThan(0.01);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 35,
    box!.y + box!.height / 2 + 18, { steps: 3 });
  await page.mouse.up();
  await expect(stage.locator("img")).not.toHaveAttribute("style", /translate\\(0px, 0px\\)/);
  await controls.getByRole("button", { name: "サムネにする" }).click();
  await expect(page.locator(".preset-preview [role=status]"))
    .toContainText("この表示範囲をサムネイルに保存しました");
}

test("preview and thumbnail frames keep 4:3 through responsive sizing", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const preview = page.locator(".preset-image-viewport");
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const frame = await preview.boundingBox();
    expect(frame).not.toBeNull();
    expect(Math.abs(frame!.width / frame!.height - 4 / 3)).toBeLessThan(0.01);
    if (width === 390) expect(frame!.width).toBeLessThan(480);
  }
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const card = await page.locator(".preset-card-image").first().boundingBox();
  expect(card).not.toBeNull();
  expect(Math.abs(card!.width / card!.height - 4 / 3)).toBeLessThan(0.02);
});

test("thumbnail crop is persisted and reused by the preset list without changing PSD base", async ({ page }) => {
  await start(page);
  const before = await savedDraft(page);
  expect(before.collection.items[0].thumbnail).toBeUndefined();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const controls = page.locator(".preset-image-controls");
  await expect(controls.getByRole("button", { name: "サムネにする" })).toBeEnabled();
  await editAndSave(page);
  await expect.poll(async () => (await savedDraft(page)).collection.items[0].thumbnail?.zoom).toBe(2);
  const after = (await savedDraft(page)).collection.items[0];
  expect(after.thumbnail?.centerX).toBeLessThan(0.5);
  expect(after.thumbnail?.centerY).toBeLessThan(0.5);
  const savedThumbnail = after.thumbnail;
  await page.locator(".preset-image-controls").getByRole("button", { name: "拡大" }).click();
  expect((await savedDraft(page)).collection.items[0].thumbnail).toEqual(savedThumbnail);
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const card = page.locator(".preset-card").first();
  // The data-URL image's natural dimensions arrive after the card first mounts.
  // Wait for thumbnail layout rather than inspecting the initial 0px style.
  await expect.poll(async () => {
    const width = await card.locator("img").evaluate(
      (img) => parseFloat((img as HTMLImageElement).style.width));
    const stageWidth = await card.locator(".preset-card-image").evaluate(
      (node) => node.clientWidth);
    return width - stageWidth;
  }).toBeGreaterThan(0);
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
  const thumb = await choices.first().locator(".preset-picker-thumb").boundingBox();
  expect(thumb).not.toBeNull();
  expect(Math.abs(thumb!.width / thumb!.height - 4 / 3)).toBeLessThan(0.02);
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


test("character profile round-trip keeps the crop and rejects malformed imported metadata", async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as Window & { __savedProfile?: string };
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => ({
        name: "character.json",
        createWritable: async () => ({
          write: async (data: string) => { target.__savedProfile = data; },
          close: async () => {},
          abort: async () => {},
        }),
      }),
    });
  });
  await start(page);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await editAndSave(page);
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.locator(".character-profile-actions [role=status]"))
    .toContainText("JSONを保存しました");
  const json = await page.evaluate(() =>
    (window as Window & { __savedProfile?: string }).__savedProfile!);
  const saved = JSON.parse(json);
  expect(saved.collection.items[0].thumbnail.zoom).toBe(2);
  expect(JSON.stringify(saved)).not.toContain("data:image/png");
  const before = await savedDraft(page);
  const corrupt = structuredClone(saved);
  corrupt.collection.items[0].thumbnail.zoom = 9;
  await page.locator("#character-profile-file").setInputFiles({
    name: "invalid.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(corrupt)),
  });
  await expect(page.getByRole("alert")).toContainText("サムネイル設定が不正");
  expect((await savedDraft(page)).collection.items).toEqual(before.collection.items);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#character-profile-file").setInputFiles({
    name: "valid.json", mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(page.locator(".character-profile-actions [role=status]"))
    .toContainText("キャラクター設定JSONを読み込みました");
  expect((await savedDraft(page)).collection.items[0].thumbnail)
    .toEqual(saved.collection.items[0].thumbnail);
});
