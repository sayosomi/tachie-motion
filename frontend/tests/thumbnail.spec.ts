import { expect, test, type Locator, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
// An asymmetric 40x30 PNG: colored quadrants and a small white mark.
// Unlike the usual 1x1 fixture, wrong crop offsets can be distinguished.
const asymmetricPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAAX0lEQVR42mP8KCr6n4GKQHEJHzWNY2BiGORg1IHD3oEs2ATZHj3CqviXnNxoCI46cNSBQyIXD0RuHY3ikZsGNcRPUtXAc3yao1E86sBRB446cNSBow4cdeCoA0cdCAcAszMJchkKDcUAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "face", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "mouth", kind: "pixel", visible: true, effective_visible: true, bbox: [2, 2, 8, 8] },
];
const source = "/tmp/立ち絵 あんこもん.psd";
const draftKey = "tachie-motion.preset-draft.v2";

async function start(page: Page, image = png) {
  await page.route("**/api/psd", (route) => route.fulfill({
    json: { width: 64, height: 64, fingerprint: "1000:2000", preview: image, layers },
  }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: image } }));
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

// Visible image coordinates relative to the source, measured from actual DOM
// geometry instead of calling the shared thumbnailLayout implementation.
async function visibleCrop(frame: Locator) {
  return frame.evaluate((node) => {
    const img = node.querySelector("img");
    if (!(img instanceof HTMLImageElement) || img.naturalWidth <= 0) {
      throw new Error("Thumbnail image has not loaded");
    }
    const frame = node.getBoundingClientRect();
    const image = img.getBoundingClientRect();
    if (image.width <= 0 || image.height <= 0) {
      throw new Error("Thumbnail image geometry is unavailable");
    }
    // Compare the actual content viewport, excluding its border. One pixel
    // matters in the 40x30 WAV picker and must not masquerade as crop drift.
    const left = frame.left + (node as HTMLElement).clientLeft;
    const top = frame.top + (node as HTMLElement).clientTop;
    const right = left + (node as HTMLElement).clientWidth;
    const bottom = top + (node as HTMLElement).clientHeight;
    return {
      left: (left - image.left) / image.width,
      top: (top - image.top) / image.height,
      right: (right - image.left) / image.width,
      bottom: (bottom - image.top) / image.height,
    };
  });
}

function previewPan(transform: string): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform);
  if (!match) throw new Error("Preview transform missing pan: " + transform);
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function wheelBurst(frame: Locator, deltas: number[], offsetX: number, offsetY: number) {
  // Compute cursor coordinates and dispatch all events in one browser task:
  // no React render or browser scroll can change the anchor between events.
  await frame.evaluate((node, args) => {
    const rect = node.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + args.offsetX;
    const clientY = rect.top + rect.height / 2 + args.offsetY;
    for (const deltaY of args.deltas) {
      node.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, clientX, clientY, deltaY,
      }));
    }
  }, { deltas, offsetX, offsetY });
}

async function editAndSave(page: Page) {
  const stage = page.locator(".preset-image-viewport");
  await expect(stage.locator("img")).toBeVisible();
  const controls = page.locator(".preset-image-controls");
  await controls.getByRole("button", { name: "拡大" }).click();
  await controls.getByRole("button", { name: "拡大" }).click();
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("2×");

  // Ensure the stage itself is in the viewport before using raw mouse
  // coordinates. Its position can be below the fold even when zoom controls
  // are visible, because the layer editor is long.
  await stage.hover();
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width / box!.height - 4 / 3)).toBeLessThan(0.01);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 35,
    box!.y + box!.height / 2 + 18, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => stage.locator("img").evaluate(
    (img) => (img as HTMLImageElement).style.transform))
    .not.toContain("translate(0px, 0px)");
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

test("wheel zoom anchors at cursor, stays in preview and saves only on explicit click", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const stage = page.locator(".preset-image-viewport");
  const controls = page.locator(".preset-image-controls");
  await expect(stage.locator("img")).toBeVisible();
  await stage.hover(); // scroll the preview itself into view
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  // Off-center cursor: image content beneath it must not jump on zoom.
  const x = box!.x + box!.width / 2 + 32;
  const y = box!.y + box!.height / 2 + 24;
  await page.mouse.move(x, y);
  const initialScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, -40);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.2×");
  await page.mouse.wheel(0, -60);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.5×");
  expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
  const transform = await stage.locator("img").evaluate(
    (img) => (img as HTMLImageElement).style.transform);
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(1\.5\)/.exec(transform);
  expect(match).not.toBeNull();
  // The fixture is 1:1 inside a 4:3 stage. At intermediate 1.2×
  // magnification, the image still has horizontal letterboxing, so its
  // horizontal pan is clamped to zero. The final 1.2×→1.5× step therefore
  // contributes about -8px, not the -16px of a single 1×→1.5× jump.
  // Vertical pan has no letterboxing and retains the full cursor anchor.
  expect(Number(match![1])).toBeCloseTo(-8, 0);
  expect(Number(match![2])).toBeCloseTo(-12, 0);
  expect((await savedDraft(page)).collection.items[0].thumbnail).toBeUndefined();

  await controls.getByRole("button", { name: "サムネにする" }).click();
  const saved = (await savedDraft(page)).collection.items[0].thumbnail;
  expect(saved?.zoom).toBe(1.5);
  await stage.hover();
  await page.mouse.wheel(0, -100);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("2×");
  expect((await savedDraft(page)).collection.items[0].thumbnail).toEqual(saved);
  await page.mouse.wheel(0, 100);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.5×");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.5×");
  await stage.hover();
  await page.mouse.wheel(0, -1400);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("8×");
  await page.mouse.wheel(0, 1400);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1×");
  expect((await savedDraft(page)).collection.items[0].thumbnail).toEqual(saved);
});

test("rapid wheel bursts, reversal and drag use the latest synchronous view", async ({ page }) => {
  await start(page, asymmetricPng);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const stage = page.locator(".preset-image-viewport");
  const controls = page.locator(".preset-image-controls");
  await expect(stage.locator("img")).toBeVisible();
  await stage.hover();
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2 + 32;
  const y = box!.y + box!.height / 2 + 24;
  await wheelBurst(stage, [-100, -100], 32, 24);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("2×");
  const center = await visibleCrop(stage);
  expect((center.left + center.right) / 2).toBeCloseTo(0.5 + 32 / (box!.width * 2), 2);
  const firstTransform = await stage.locator("img").evaluate((img) => img.style.transform);
  const firstPan = previewPan(firstTransform);
  // WheelEventInit quantizes clientX/Y to integer CSS pixels, while the
  // viewport's center may be fractional (e.g. X.59375). Compare the true
  // anchor-invariant ratio rather than assuming exact -32px/-24px.
  expect(firstPan.x).toBeLessThan(-30);
  expect(firstPan.y).toBeLessThan(-22);

  await wheelBurst(stage, [-40, 30, 70], 32, 24);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.7×");
  const reverseTransform = await stage.locator("img").evaluate((img) => img.style.transform);
  const reversedPan = previewPan(reverseTransform);
  expect(reversedPan.x).toBeCloseTo(firstPan.x * 0.7, 2);
  expect(reversedPan.y).toBeCloseTo(firstPan.y * 0.7, 2);

  // A wheel event while the left button is held terminates the old drag.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 15, { steps: 2 });
  await wheelBurst(stage, [-100], 52, 39);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("2.2×");
  const afterZoom = await stage.locator("img").evaluate((img) => img.style.transform);
  await page.mouse.move(x + 45, y + 30, { steps: 2 });
  expect(await stage.locator("img").evaluate((img) => img.style.transform)).toBe(afterZoom);
  await page.mouse.up();
  expect((await savedDraft(page)).collection.items[0].thumbnail).toBeUndefined();

  await controls.getByRole("button", { name: "サムネにする" }).click();
  expect((await savedDraft(page)).collection.items[0].thumbnail?.zoom).toBeCloseTo(2.2, 8);
});

test("tiny wheel events accumulate linearly and zoom buttons snap to the next step", async ({ page }) => {
  await start(page, asymmetricPng);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const stage = page.locator(".preset-image-viewport");
  const controls = page.locator(".preset-image-controls");
  await expect(stage.locator("img")).toBeVisible();
  // Tiny deltas in one JS turn must move the image, not wait for a full step.
  await wheelBurst(stage, [-10, -10], 16, 12);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.1×");
  const transform = await stage.locator("img").evaluate((img) => img.style.transform);
  expect(transform).toContain("scale(1.1)");
  expect((await savedDraft(page)).collection.items[0].thumbnail).toBeUndefined();
  await controls.getByRole("button", { name: "拡大" }).click();
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.5×");
  await controls.getByRole("button", { name: "縮小" }).click();
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1×");
  await stage.hover();
  await wheelBurst(stage, [-1, -1, -1, -1], 16, 12);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.02×");
  await controls.getByRole("button", { name: "サムネにする" }).click();
  expect((await savedDraft(page)).collection.items[0].thumbnail?.zoom).toBeCloseTo(1.02, 8);
});

test("asymmetric crop matches detail preview, preset list and WAV choices", async ({ page }) => {
  await start(page, asymmetricPng);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const stage = page.locator(".preset-image-viewport");
  expect(await stage.locator("img").evaluate((img) => img.naturalWidth)).toBe(40);
  await editAndSave(page);
  const expected = await visibleCrop(stage);
  const saved = (await savedDraft(page)).collection.items[0].thumbnail!;
  expect((expected.left + expected.right) / 2).toBeCloseTo(saved.centerX, 2);
  expect((expected.top + expected.bottom) / 2).toBeCloseTo(saved.centerY, 2);

  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const listFrame = page.locator(".preset-card-image.thumbnail-frame").first();
  await expect(listFrame.locator("img")).toBeVisible();
  const listCrop = await visibleCrop(listFrame);

  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate(
    (node) => { (node as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/test.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  const row = page.locator("[data-utterance-id]").first();
  await expect(row).toBeVisible();
  await row.locator(".preset-picker-trigger").click();
  const wavFrame = row.locator(".preset-picker-option .preset-picker-thumb").first();
  await expect(wavFrame.locator("img")).toBeVisible();
  const wavCrop = await visibleCrop(wavFrame);

  for (const key of ["left", "top", "right", "bottom"] as const) {
    expect(Math.abs(listCrop[key] - expected[key])).toBeLessThan(0.012);
    expect(Math.abs(wavCrop[key] - expected[key])).toBeLessThan(0.025);
  }
});

test("non-step wheel crop survives reload and matches preset list and WAV picker", async ({ page }) => {
  await start(page, asymmetricPng);
  await page.getByRole("button", { name: "詳細を編集" }).click();

  const stage = page.locator(".preset-image-viewport");
  const controls = page.locator(".preset-image-controls");
  await expect(stage.locator("img")).toBeVisible();
  expect((await savedDraft(page)).collection.items[0].thumbnail).toBeUndefined();

  // 100px of wheel input changes zoom by 0.5x: 140px yields 1.7x.
  // The off-center anchor gives a real pan on both axes, without touching
  // any of the discrete + / - buttons.
  await wheelBurst(stage, [-80, -60], 28, 18);
  await expect(controls.getByLabel("プレビュー倍率")).toHaveText("1.7×");
  const pan = previewPan(await stage.locator("img").evaluate((img) => img.style.transform));
  expect(pan.x).toBeLessThan(-10);
  expect(pan.y).toBeLessThan(-5);
  expect((await savedDraft(page)).collection.items[0].thumbnail).toBeUndefined();

  await controls.getByRole("button", { name: "サムネにする" }).click();
  const expected = await visibleCrop(stage);
  const saved = (await savedDraft(page)).collection.items[0].thumbnail!;
  expect(saved.zoom).toBeCloseTo(1.7, 8);
  expect(saved.centerX).toBeGreaterThan(0.5);
  expect(saved.centerY).toBeGreaterThan(0.5);
  expect((expected.left + expected.right) / 2).toBeCloseTo(saved.centerX, 2);
  expect((expected.top + expected.bottom) / 2).toBeCloseTo(saved.centerY, 2);

  const assertCrop = async (frame: Locator, tolerance: number) => {
    await expect(frame.locator("img")).toBeVisible();
    await expect.poll(async () => frame.locator("img").evaluate(
      (img) => (img as HTMLImageElement).getBoundingClientRect().width)).toBeGreaterThan(0);
    const actual = await visibleCrop(frame);
    for (const edge of ["left", "top", "right", "bottom"] as const) {
      expect(Math.abs(actual[edge] - expected[edge])).toBeLessThan(tolerance);
    }
  };

  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const listFrame = page.locator(".preset-card-image.thumbnail-frame").first();
  await assertCrop(listFrame, 0.012);

  await page.reload();
  await expect(page.locator(".preset-card")).toHaveCount(1);
  expect((await savedDraft(page)).collection.items[0].thumbnail).toEqual(saved);
  await assertCrop(page.locator(".preset-card-image.thumbnail-frame").first(), 0.012);

  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate(
    (node) => { (node as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/non-step.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  const row = page.locator("[data-utterance-id]").first();
  await expect(row).toBeVisible();
  await row.locator(".preset-picker-trigger").click();
  const wavFrame = row.locator(".preset-picker-option .preset-picker-thumb").first();
  await assertCrop(wavFrame, 0.025);
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
