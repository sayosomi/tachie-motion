import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const key = "tachie-motion.character-drafts.v1";
const legacyKey = "tachie-motion.preset-draft.v2";
const aPath = "/tmp/キャラ A e\u0301/立ち絵.psd";
const bPath = "/tmp/キャラ B/立ち絵.psd";
const layersA = [
  { path: "0", name: "顔A", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "1", name: "差分A", kind: "pixel", visible: false, effective_visible: false, bbox: [0,0,64,64] },
];
const layersB = [
  { path: "0", name: "顔B", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,64,64] },
];
function response(path: string) {
  return { width: 64, height: 64, fingerprint: path === aPath ? "1000:2000" : "3000:4000",
    preview: png, layers: path === aPath ? layersA : layersB };
}
async function mocks(page: Page) {
  await page.route("**/api/psd", (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    return route.fulfill({ json: response(path) });
  });
  await page.route("**/api/preset-preview", (route) => route.fulfill({ json: { preview: png } }));
}
async function loadPsd(page: Page, path: string) {
  await page.locator("#preset-psd-path-advanced").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill(path);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
}
async function createGroup(page: Page, name: string, copy = false) {
  await page.getByRole("button", { name: copy ? "従来のプリセットをキャラ登録" : "＋ キャラ追加", exact: true }).click();
  await page.getByRole("textbox", { name: "キャラ管理の名前" }).fill(name);
  await page.getByRole("button", { name: "確定", exact: true }).click();
  await expect(page.getByRole("group", { name: "編集するキャラ" })
    .getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
}
async function selectGroup(page: Page, name: string) {
  await page.getByRole("group", { name: "編集するキャラ" })
    .getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("group", { name: "編集するキャラ" })
    .getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
}
async function catalog(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

test("two named PSD groups preserve all presets, stable IDs and legacy draft across switching and reload", async ({ page }) => {
  await mocks(page);
  await page.goto("/");
  await loadPsd(page, aPath);
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.locator("#preset-name").fill("笑顔A");
  await page.locator("#preset-name").press("Tab");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  const legacy = await page.evaluate((k) => localStorage.getItem(k), legacyKey);
  await createGroup(page, "あんこ", true);
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  const first = (await catalog(page)).groups[0];
  expect(first.draft.path).toBe(aPath);

  await createGroup(page, "ぼぶ");
  await expect(page.locator("[data-preset-id]")).toHaveCount(0);
  await loadPsd(page, bPath);
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.locator("#preset-name").fill("笑顔B");
  await page.locator("#preset-name").press("Tab");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  const second = (await catalog(page)).groups[1];
  expect(second.draft.path).toBe(bPath);

  await selectGroup(page, "あんこ");
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  await expect(page.getByText("笑顔A", { exact: true })).toBeVisible();
  await expect(page.getByText("笑顔B", { exact: true })).toHaveCount(0);
  expect((await catalog(page)).groups).toEqual([first, second]);

  await page.reload();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  await expect(page.getByText("笑顔A", { exact: true })).toBeVisible();
  await selectGroup(page, "ぼぶ");
  await expect(page.getByText("笑顔B", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "キャラ名変更", exact: true }).click();
  await page.getByRole("textbox", { name: "キャラ管理の名前" }).fill("ぼぶ改名");
  await page.getByRole("button", { name: "確定", exact: true }).click();
  expect((await catalog(page)).groups[1]).toEqual({ ...second, name: "ぼぶ改名" });
  expect(await page.evaluate((k) => localStorage.getItem(k), legacyKey)).toBe(legacy);
});

test("failed or late PSD loads do not replace other character drafts", async ({ page }) => {
  await mocks(page);
  await page.goto("/");
  await createGroup(page, "A");
  await loadPsd(page, aPath);
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  const a = (await catalog(page)).groups[0];
  await loadPsd(page, bPath);
  await expect(page.getByRole("alert").filter({ hasText: "新しいキャラを追加" })).toBeVisible();
  expect((await catalog(page)).groups[0]).toEqual(a);

  await createGroup(page, "B");
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/psd", async (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    if (path === bPath) { started(); await hold; }
    await route.fulfill({ json: response(path) });
  });
  await loadPsd(page, bPath);
  await pending;
  try {
    await selectGroup(page, "A");
    await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  } finally {
    release();
  }
  // Allow the stale request to finish, then verify the stored data.
  await expect.poll(async () => (await catalog(page)).groups[0]).toEqual(a);
  await selectGroup(page, "B");
  await expect(page.locator("[data-preset-id]")).toHaveCount(0);
  expect((await catalog(page)).groups[1].draft).toBeNull();
});

test("a second tab waits for the character catalog lock and opens the latest committed groups", async ({ page }) => {
  await mocks(page);
  await page.goto("/");
  await createGroup(page, "A");
  await loadPsd(page, aPath);
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  const second = await page.context().newPage();
  try {
    await mocks(second);
    await second.goto("/");
    await expect(second.getByRole("button", { name: "＋ キャラ追加" })).toBeDisabled();
    await createGroup(page, "B");
    await loadPsd(page, bPath);
    await expect(page.locator("[data-preset-id]")).toHaveCount(1);
    const before = await catalog(page);
    await page.getByRole("button", { name: "制作（試作）" }).click();
    await expect(second.getByRole("button", { name: "＋ キャラ追加" })).toBeEnabled();
    await expect(second.getByRole("group", { name: "編集するキャラ" })
      .getByRole("button", { name: "B", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(second.locator("[data-preset-id]")).toHaveCount(1);
    expect(await catalog(second)).toEqual(before);
  } finally {
    await second.close();
  }
});
