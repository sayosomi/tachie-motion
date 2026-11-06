import { expect, test } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "目", kind: "pixel", visible: true, effective_visible: true, bbox: [4, 6, 15, 20] },
  { path: "0/1", name: "目", kind: "pixel", visible: false, effective_visible: false, bbox: [22, 28, 42, 48] },
  { path: "1", name: "範囲なし", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 0, 0] },
];

async function openDetail(page: import("@playwright/test").Page) {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "layer-selection", preview: png, layers,
  } }));
  let previewRequests = 0;
  await page.route("**/api/preset-preview", (route) => {
    previewRequests += 1;
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/selection.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.getByAltText("通常 のプレビュー")).toBeVisible();
  return () => previewRequests;
}

test("PSD name selection uses unique paths without toggling base or Open roles", async ({ page }) => {
  const previewRequestCount = await openDetail(page);
  const secondName = page.getByRole("button", { name: "目 [0/1] を選択" });
  const firstName = page.getByRole("button", { name: "目 [0/0] を選択" });
  const secondCheckbox = page.getByRole("checkbox", { name: "目 [0/1] 表示" });
  const secondRole = page.locator('.preset-layer-role[data-layer-path="0/1"]');
  const overlay = page.locator(".preset-image-selection");

  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();
  const originalSaved = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));
  expect(originalSaved).not.toBeNull();
  const previousCalls = previewRequestCount();
  await secondName.click();
  await expect(secondName).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.preset-layer[data-layer-path="0/1"]')).toHaveAttribute("data-selected", "true");
  await expect(secondCheckbox).not.toBeChecked();
  await expect(secondRole).toHaveAttribute("data-open-role", "none");
  await expect(page.locator(".preset-selected-summary")).toContainText("目 [0/1]");
  await expect(overlay).toHaveAttribute("viewBox", "0 0 64 64");
  await expect(overlay.locator("rect")).toHaveAttribute("x", "22");
  await expect(overlay.locator("rect")).toHaveAttribute("y", "28");
  await expect(overlay.locator("rect")).toHaveAttribute("width", "20");
  await expect(overlay.locator("rect")).toHaveAttribute("height", "20");
  expect(previewRequestCount()).toBe(previousCalls);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(originalSaved);

  await firstName.click();
  await expect(firstName).toHaveAttribute("aria-pressed", "true");
  await expect(secondName).toHaveAttribute("aria-pressed", "false");
  await expect(overlay.locator("rect")).toHaveAttribute("x", "4");
  await expect(overlay.locator("rect")).toHaveAttribute("y", "6");

  await secondName.focus();
  await page.keyboard.press("Space");
  await expect(secondName).toHaveAttribute("aria-pressed", "true");
  await expect(secondCheckbox).not.toBeChecked();

  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("0/0");
  await expect(secondName).toHaveCount(0);
  await expect(overlay.locator("rect")).toHaveAttribute("x", "22");
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("");
  await expect(secondName).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(secondName).toHaveCount(0);
  await expect(overlay.locator("rect")).toHaveAttribute("x", "22");
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(secondName).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "選択位置へ" }).click();
  const img = page.locator(".preset-image-viewport img");
  await expect(img).toHaveAttribute("style", /scale\(8\)/);
  await expect(overlay).toHaveAttribute("style", await img.getAttribute("style") ?? "");
  await secondCheckbox.check();
  await expect(secondName).toHaveAttribute("aria-pressed", "true");
  await expect(secondRole).toHaveAttribute("data-open-role", "none");

  await secondName.click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();
});

test("empty bounding boxes omit misleading preview overlays; selection never persists", async ({ page }) => {
  await openDetail(page);
  await page.getByRole("button", { name: "範囲なし [1] を選択" }).click();
  await expect(page.locator(".preset-selected-summary")).toContainText("位置情報なし");
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();
  await expect(page.locator(".preset-layer[data-selected=true]")).toHaveCount(0);
});

test("tall PSD overlay aligns with the image's contained canvas rather than viewport edges", async ({ page }) => {
  const tall = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="3300">' +
    '<rect width="1500" height="3300" fill="#406080" /></svg>');
  const tallLayers = [
    { path: "0", name: "顔", kind: "group", visible: true,
      effective_visible: true, bbox: [0, 0, 1500, 3300] },
    { path: "0/0", name: "口", kind: "pixel", visible: true,
      effective_visible: true, bbox: [650, 1100, 850, 1160] },
  ];
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 1500, height: 3300, fingerprint: "tall-selection",
    preview: tall, layers: tallLayers,
  } }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: tall } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/tall-selection.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.locator(".preset-image-viewport img")).toBeVisible();
  await page.getByRole("button", { name: "口 [0/0] を選択" }).click();

  const position = await page.locator(".preset-image-viewport").evaluate((stage) => {
    const rect = stage.querySelector(".preset-image-selection rect");
    if (!rect) throw new Error("Missing selected PSD overlay");
    const actual = rect.getBoundingClientRect();
    const container = stage.getBoundingClientRect();
    const scale = Math.min(stage.clientWidth / 1500, stage.clientHeight / 3300);
    const letterboxX = (stage.clientWidth - 1500 * scale) / 2;
    const letterboxY = (stage.clientHeight - 3300 * scale) / 2;
    return {
      x: actual.x - container.x, y: actual.y - container.y,
      w: actual.width, h: actual.height,
      expectedX: letterboxX + 650 * scale,
      expectedY: letterboxY + 1100 * scale,
      expectedW: 200 * scale, expectedH: 60 * scale,
    };
  });
  expect(Math.abs(position.x - position.expectedX)).toBeLessThan(2);
  expect(Math.abs(position.y - position.expectedY)).toBeLessThan(2);
  expect(Math.abs(position.w - position.expectedW)).toBeLessThan(2);
  expect(Math.abs(position.h - position.expectedH)).toBeLessThan(2);
});
