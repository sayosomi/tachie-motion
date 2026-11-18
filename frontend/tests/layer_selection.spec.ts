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

test("PSD fixed layer row, name and keyboard selection edit visibility while preserving focus", async ({ page }) => {
  await openDetail(page);
  const secondRow = page.locator('.preset-layer[data-layer-path="0/1"]');
  const secondName = page.getByRole("button", { name: "目 [0/1] を選択・切替" });
  const firstName = page.getByRole("button", { name: "目 [0/0] を選択・切替" });
  const secondCheckbox = page.getByRole("checkbox", { name: "目 [0/1] 固定" });
  const firstCheckbox = page.getByRole("checkbox", { name: "目 [0/0] 固定" });

  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();
  await secondRow.click({ position: { x: 2, y: 2 } });
  await expect(secondCheckbox).toBeChecked();
  await expect(secondRow).toHaveAttribute("data-selected", "true");
  await secondRow.click({ position: { x: 2, y: 2 } });
  await expect(secondCheckbox).not.toBeChecked();
  await secondName.click();
  await expect(secondName).toHaveAttribute("aria-pressed", "true");
  await expect(secondCheckbox).toBeChecked();
  await expect(page.locator(".preset-selected-summary")).toContainText("目 [0/1]");
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);

  await firstName.click();
  await expect(firstCheckbox).not.toBeChecked();
  await expect(firstName).toHaveAttribute("aria-pressed", "true");
  await expect(secondName).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".preset-selected-summary")).toContainText("目 [0/0]");

  await secondName.focus();
  await page.keyboard.press("Space");
  await expect(secondName).toHaveAttribute("aria-pressed", "true");
  await expect(secondCheckbox).not.toBeChecked();

  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("0/0");
  await expect(secondName).toHaveCount(0);
  await expect(page.locator(".preset-selected-summary")).toContainText("目 [0/1]");
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("");
  await expect(secondName).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(secondName).toHaveCount(0);
  await expect(page.locator(".preset-selected-summary")).toContainText("目 [0/1]");
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(secondName).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "選択位置へ" }).click();
  const img = page.locator(".preset-image-viewport img");
  await expect(img).toHaveAttribute("style", /scale\(8\)/);
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);
  await secondCheckbox.check();
  await expect(secondName).toHaveAttribute("aria-pressed", "true");

  await secondName.click();
  await expect(secondCheckbox).not.toBeChecked();
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();
});

test("empty bounding boxes disable focus; selection never persists", async ({ page }) => {
  await openDetail(page);
  await page.getByRole("button", { name: "範囲なし [1] を選択・切替" }).click();
  await expect(page.locator(".preset-selected-summary")).toContainText("位置情報なし");
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeDisabled();
  await expect(page.locator(".preset-layer[data-selected=true]")).toHaveCount(0);
});

test("tall PSD selection zooms to the layer without drawing an outline", async ({ page }) => {
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
  const image = page.locator(".preset-image-viewport img");
  await expect(image).toBeVisible();
  await page.getByRole("button", { name: "口 [0/0] を選択・切替" }).click();
  await expect(page.getByRole("button", { name: "選択位置へ" })).toBeEnabled();
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);
  await page.getByRole("button", { name: "選択位置へ" }).click();
  await expect(image).toHaveAttribute("style", /scale\(8\)/);
  await expect(image).not.toHaveAttribute("style", "transform: translate(0px, 0px) scale(8);");
  await expect(page.locator(".preset-image-selection")).toHaveCount(0);
  await page.getByRole("button", { name: "全体表示" }).click();
  await expect(image).toHaveAttribute("style", "transform: translate(0px, 0px) scale(1);");
});
