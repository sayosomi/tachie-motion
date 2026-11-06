import { expect, test, type Page } from "@playwright/test";

const red = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=";
const blue = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHRkCAjRcHicAAAAASUVORK5CYII=";

const sourceLayers = [
  { path: "0", name: "face", kind: "group", visible: true,
    effective_visible: true, bbox: [0, 0, 2, 2] },
  { path: "0/0", name: "mouth-closed", kind: "pixel", visible: true,
    effective_visible: true, bbox: [0, 0, 2, 2] },
  { path: "0/1", name: "mouth-open", kind: "pixel", visible: false,
    effective_visible: false, bbox: [0, 0, 2, 2] },
];
const assets = {
  supported: true, width: 2, height: 2, source_width: 2, source_height: 2,
  source_identity: "stat-v1",
  layers: [
    { path: "0", kind: "group", visible: true, rect: null, png: null },
    { path: "0/0", kind: "pixel", visible: true, rect: [0, 0, 2, 2], png: red },
    { path: "0/1", kind: "pixel", visible: false, rect: [0, 0, 2, 2], png: blue },
  ],
};

async function openDetails(page: Page) {
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (element) => { (element as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/synthetic.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.locator(".preset-image-viewport img")).toBeVisible();
}

async function pixel(page: Page): Promise<number[]> {
  return page.locator(".preset-image-viewport img").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
}

test("Canvas fast path respects the parent, rapid edits and Open shapes without Python requests", async ({ page }) => {
  let pythonRequests = 0;
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 2, height: 2, fingerprint: "test-snapshot", source_identity: "stat-v1", preview: red,
    layers: sourceLayers,
  } }));
  await page.route("**/api/preview-layer-assets", (route) => route.fulfill({ json: assets }));
  let statusReads = 0;
  await page.route("**/api/preview-source-status", (route) => {
    statusReads++;
    expect(route.request().postDataJSON()).toMatchObject({
      path: "/tmp/synthetic.psd", fingerprint: "test-snapshot",
      source_identity: "stat-v1",
    });
    return route.fulfill({ json: { valid: true } });
  });
  await page.route("**/api/preset-preview", (route) => {
    pythonRequests++;
    return route.fulfill({ json: { preview: red } });
  });
  await openDetails(page);
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "canvas");
  expect(await pixel(page)).toEqual([255, 0, 0, 255]);

  const opened = page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" });
  await opened.check();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 255, 255]);
  await opened.uncheck();
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);

  await page.getByRole("checkbox", { name: "face [0] 表示" }).uncheck();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 0, 0]);
  await page.getByRole("checkbox", { name: "face [0] 表示" }).check();
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);

  await page.locator('.preset-layer-role[data-layer-path="0/0"]')
    .getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]')
    .getByRole("button", { name: "Open: 開き口" }).click();
  await page.getByRole("button", { name: "開き口", exact: true }).click();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 255, 255]);
  await page.getByRole("button", { name: "閉じ口", exact: true }).click();
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);
  expect(pythonRequests).toBe(0);
  expect(statusReads).toBeGreaterThanOrEqual(4);
});

for (const mode of [
  "unsupported", "broken PNG", "server failure", "mismatched layer paths",
  "missing in-canvas PNG", "group with bitmap",
]) {
  test("uses real Python preview fallback: " + mode, async ({ page }) => {
    let pythonRequests = 0;
    await page.route("**/api/psd", (route) => route.fulfill({ json: {
      width: 2, height: 2, fingerprint: "test-snapshot", source_identity: "stat-v1", preview: red,
      layers: sourceLayers,
    } }));
    await page.route("**/api/preview-source-status", (route) =>
      route.fulfill({ json: { valid: true } }));
    await page.route("**/api/preview-layer-assets", (route) => {
      if (mode === "server failure") return route.fulfill({
        status: 500, json: { detail: "asset extraction failed" },
      });
      if (mode === "unsupported") return route.fulfill({
        json: { supported: false },
      });
      if (mode === "missing in-canvas PNG") return route.fulfill({
        json: { ...assets, layers: assets.layers.map((row) =>
          row.path === "0/0" ? { ...row, png: null, rect: null } : row) },
      });
      if (mode === "group with bitmap") return route.fulfill({
        json: { ...assets, layers: assets.layers.map((row) =>
          row.path === "0" ? { ...row, png: red, rect: [0, 0, 2, 2] } : row) },
      });
      if (mode === "broken PNG") return route.fulfill({
        json: { ...assets, layers: assets.layers.map((row) =>
          row.path === "0/0" ? { ...row, png: "data:image/png;base64,!!" } : row) },
      });
      return route.fulfill({ json: { ...assets, layers: assets.layers.map((row) =>
        row.path === "0/0" ? { ...row, path: "9/9" } : row) } });
    });
    await page.route("**/api/preset-preview", (route) => {
      pythonRequests++;
      return route.fulfill({ json: { preview: blue } });
    });
    await openDetails(page);
    await expect(page.locator("main.preset-workspace")).toHaveAttribute(
      "data-preview-renderer", "python");
    await page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" }).check();
    await expect.poll(() => pythonRequests).toBeGreaterThan(0);
    await expect.poll(() => pixel(page)).toEqual([0, 0, 255, 255]);
  });
}


test("external save after Canvas preparation blocks old images and requires explicit reload", async ({ page }) => {
  let valid = true, pythonRequests = 0, statusReads = 0;
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 2, height: 2, fingerprint: "test-snapshot",
    source_identity: "stat-v1", preview: red, layers: sourceLayers,
  } }));
  await page.route("**/api/preview-layer-assets",
    (route) => route.fulfill({ json: assets }));
  await page.route("**/api/preview-source-status", (route) => {
    statusReads++;
    return route.fulfill({ json: { valid } });
  });
  await page.route("**/api/preset-preview", (route) => {
    pythonRequests++;
    return route.fulfill({ json: { preview: blue } });
  });
  await openDetails(page);
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "canvas");
  const opened = page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" });
  await opened.check();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 255, 255]);
  valid = false;  // Synthetic PSD changed on disk while browser still has old bitmaps.
  await opened.uncheck();
  await expect(page.getByRole("alert")).toContainText("PSDの外部変更または同一性確認の失敗");
  await expect(page.locator(".preset-image-viewport img")).toHaveCount(0);
  await expect(page.locator(".preset-image-viewport")).toContainText("再読み込み");
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "stale");
  await opened.click();
  await expect(opened).not.toBeChecked(); // Old index-path edits are blocked.
  expect(pythonRequests).toBe(0); // Never apply old state to modified PSD.
  expect(statusReads).toBeGreaterThanOrEqual(2);
});

test("valid off-canvas pixel layer without a PNG keeps Canvas active", async ({ page }) => {
  const extended = [
    ...sourceLayers,
    { path: "1", name: "off canvas", kind: "pixel", visible: true,
      effective_visible: false, bbox: [10, 10, 20, 20] },
  ];
  const extendedAssets = { ...assets, layers: [
    ...assets.layers,
    { path: "1", kind: "pixel", visible: true, png: null, rect: null },
  ] };
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 2, height: 2, fingerprint: "test-snapshot",
    source_identity: "stat-v1", preview: red, layers: extended,
  } }));
  await page.route("**/api/preview-layer-assets",
    (route) => route.fulfill({ json: extendedAssets }));
  await page.route("**/api/preview-source-status",
    (route) => route.fulfill({ json: { valid: true } }));
  let pythonRequests = 0;
  await page.route("**/api/preset-preview", (route) => {
    pythonRequests++;
    return route.fulfill({ json: { preview: red } });
  });
  await openDetails(page);
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "canvas");
  await page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" }).check();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 255, 255]);
  expect(pythonRequests).toBe(0);
});


test("status API unavailable after Canvas readiness never applies stale index paths", async ({ page }) => {
  let statusFailure = false, pythonRequests = 0;
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 2, height: 2, fingerprint: "test-snapshot",
    source_identity: "stat-v1", preview: red, layers: sourceLayers,
  } }));
  await page.route("**/api/preview-layer-assets",
    (route) => route.fulfill({ json: assets }));
  await page.route("**/api/preview-source-status", (route) =>
    statusFailure
      ? route.fulfill({ status: 503, json: { detail: "unavailable" } })
      : route.fulfill({ json: { valid: true } }));
  await page.route("**/api/preset-preview", (route) => {
    pythonRequests++;
    return route.fulfill({ json: { preview: blue } });
  });
  await openDetails(page);
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "canvas");
  await page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" }).check();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 255, 255]);
  statusFailure = true;
  await page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" }).uncheck();
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "stale");
  await expect(page.locator(".preset-image-viewport img")).toHaveCount(0);
  expect(pythonRequests).toBe(0);
});

test("source replacement during Canvas extraction fails closed before a Python request", async ({ page }) => {
  let entered!: () => void;
  let release!: () => void;
  const requestArrived = new Promise<void>((resolve) => { entered = resolve; });
  const allowFailure = new Promise<void>((resolve) => { release = resolve; });
  let pythonRequests = 0;
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 2, height: 2, fingerprint: "test-snapshot",
    source_identity: "stat-v1", preview: red, layers: sourceLayers,
  } }));
  await page.route("**/api/preview-layer-assets", async (route) => {
    entered();
    await allowFailure;
    await route.fulfill({ status: 400, json: { detail: "PSD changed during layer extraction" } });
  });
  await page.route("**/api/preview-source-status", (route) =>
    route.fulfill({ json: { valid: false } }));
  await page.route("**/api/preset-preview", (route) => {
    pythonRequests++;
    return route.fulfill({ json: { preview: blue } });
  });
  await openDetails(page);
  await requestArrived;
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "loading");
  await page.getByRole("checkbox", { name: "mouth-open [0/1] 表示" }).check();
  expect(pythonRequests).toBe(0);
  release();
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "stale");
  await expect(page.locator(".preset-image-viewport img")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("PSDの外部変更または同一性確認の失敗");
  expect(pythonRequests).toBe(0);
});

test("half-pixel rounding keeps a valid 900px asset on the Canvas fast path", async ({ page }) => {
  const layerPng = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 9; canvas.height = 9;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 9, 9);
    return canvas.toDataURL("image/png");
  });
  let pythonRequests = 0;
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 1000, height: 1000, fingerprint: "test-snapshot",
    source_identity: "stat-v1", preview: red,
    layers: [
      { path: "0", name: "face", kind: "group", visible: true,
        effective_visible: true, bbox: [0, 0, 1000, 1000] },
      { path: "0/0", name: "boundary", kind: "pixel", visible: true,
        effective_visible: true, bbox: [5, 0, 15, 10] },
    ],
  } }));
  await page.route("**/api/preview-layer-assets", (route) => route.fulfill({ json: {
    supported: true, width: 900, height: 900, source_width: 1000,
    source_height: 1000, source_identity: "stat-v1",
    layers: [
      { path: "0", kind: "group", visible: true, rect: null, png: null },
      { path: "0/0", kind: "pixel", visible: true, rect: [5, 0, 9, 9], png: layerPng },
    ],
  } }));
  await page.route("**/api/preview-source-status", (route) =>
    route.fulfill({ json: { valid: true } }));
  await page.route("**/api/preset-preview", (route) => {
    pythonRequests++;
    return route.fulfill({ json: { preview: blue } });
  });
  await openDetails(page);
  await expect(page.locator("main.preset-workspace")).toHaveAttribute(
    "data-preview-renderer", "canvas");
  await page.getByRole("checkbox", { name: "boundary [0/0] 表示" }).uncheck();
  await expect.poll(() => page.locator(".preset-image-viewport img")
    .getAttribute("src")).toMatch(/^data:image\/png/);
  expect(pythonRequests).toBe(0);
});
