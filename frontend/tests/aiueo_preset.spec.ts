import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const source = "/tmp/立ち絵 e\u0301.psd";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "閉じ口", kind: "pixel", visible: true, effective_visible: true, bbox: [10, 10, 25, 20] },
  { path: "0/1", name: "開き口", kind: "pixel", visible: false, effective_visible: false, bbox: [10, 10, 25, 20] },
  { path: "0/2", name: "差分", kind: "pixel", visible: true, effective_visible: true, bbox: [10, 10, 25, 20] },
  { path: "1", name: "体", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
];
type State = { path: string; visible: boolean };
const labels = ["あ", "い", "う", "え", "お", "ん"];
const layer = (page: Page, path: string) => page.locator(`.preset-layer[data-layer-path="${path}"]`);
const checkbox = (page: Page, path: string) => layer(page, path).getByRole("checkbox");

async function openEditor(page: Page, requests: State[][], psdLayers = layers) {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers: psdLayers,
  } }));
  await page.route("**/api/preset-preview", (route) => {
    requests.push(route.request().postDataJSON().layers);
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (element) => { (element as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
}

test("one checkbox per leaf edits each shape without changing Open or base", async ({ page }) => {
  const requests: State[][] = [];
  await openEditor(page, requests);
  await page.locator('.preset-layer-role[data-layer-path="0/0"]')
    .getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]')
    .getByRole("button", { name: "Open: 開き口" }).click();
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  const chosen = page.getByRole("group", { name: "編集する口形" });

  // No second checkbox column, per-row "表示" label, tri-state or reset button.
  await expect(page.locator(".preset-editor .preset-layer-role")).toHaveCount(0);
  await expect(page.locator(".preset-layer-list").getByRole("checkbox")).toHaveCount(4);
  await expect(page.locator(".preset-aiueo-choice").getByRole("button")).toHaveCount(7);
  await expect(page.locator(".preset-aiueo-reset")).toHaveCount(0);
  await expect(page.getByAltText("通常 のプレビュー")).toBeVisible();
  await expect(checkbox(page, "0")).toHaveCount(0);

  for (const label of labels) {
    await chosen.getByRole("button", { name: label, exact: true }).click();
    await checkbox(page, "0/1").check();
    await checkbox(page, "0/0").uncheck();
    await expect(checkbox(page, "0/1")).toBeChecked();
    await expect(checkbox(page, "0/0")).not.toBeChecked();
    await expect(layer(page, "0/1")).toHaveAttribute("data-aiueo-role", "show");
    await expect(layer(page, "0/0")).toHaveAttribute("data-aiueo-role", "hide");
    await expect.poll(() =>
      requests.at(-1)?.find((state) => state.path === "0/1")?.visible).toBe(true);
    await expect.poll(() =>
      requests.at(-1)?.find((state) => state.path === "0/0")?.visible).toBe(false);
  }
  await chosen.getByRole("button", { name: "基本", exact: true }).click();
  await expect(checkbox(page, "0")).toBeChecked();
  await expect(checkbox(page, "0/1")).not.toBeChecked();
  await expect(checkbox(page, "0/0")).toBeChecked();

  // Return a changed value to the base state: its explicit override disappears.
  await chosen.getByRole("button", { name: "あ", exact: true }).click();
  await checkbox(page, "0/1").uncheck();
  await expect(layer(page, "0/1")).toHaveAttribute("data-aiueo-role", "base");
  await expect.poll(() =>
    requests.at(-1)?.find((state) => state.path === "0/1")?.visible).toBe(false);

  // Parent groups can be changed on the Basic tab, not silently by a mouth edit.
  await chosen.getByRole("button", { name: "基本", exact: true }).click();
  await checkbox(page, "0").uncheck();
  await chosen.getByRole("button", { name: "あ", exact: true }).click();
  await expect(page.locator(".preset-editor [role=status]")).toContainText("親グループが非表示");
  await chosen.getByRole("button", { name: "基本", exact: true }).click();
  await checkbox(page, "0").check();

  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator('.preset-layer-role[data-layer-path="0/0"]'))
    .toHaveAttribute("data-open-role", "closed");
  await expect(page.locator('.preset-layer-role[data-layer-path="0/1"]'))
    .toHaveAttribute("data-open-role", "opened");
  await page.getByRole("button", { name: "開き口", exact: true }).click();
  await expect.poll(() =>
    requests.at(-1)?.find((state) => state.path === "0/1")?.visible).toBe(true);

  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  const item = saved.collection.items[0];
  expect(item.openMouth.closed).toContainEqual({ path: "0/0", visible: true });
  expect(item.aiueoMouth.a).toEqual([{ path: "0/0", visible: false }]);
  for (const key of ["i", "u", "e", "o", "n"]) {
    expect(item.aiueoMouth[key]).toEqual([
      { path: "0/0", visible: false }, { path: "0/1", visible: true },
    ]);
  }
  await page.reload();
  await expect(page.getByRole("status")).toContainText("前回の編集を復元しました");
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await chosen.getByRole("button", { name: "ん", exact: true }).click();
  await expect(checkbox(page, "0/1")).toBeChecked();
});

test("single checkbox and search follow selected mouth, unconfigured shows base", async ({ page }) => {
  await openEditor(page, []);
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  const chosen = page.getByRole("group", { name: "編集する口形" });
  await expect(checkbox(page, "0/1")).not.toBeChecked();
  await checkbox(page, "0/1").check();
  await chosen.getByRole("button", { name: "い", exact: true }).click();
  await expect(checkbox(page, "0/1")).not.toBeChecked();
  await expect(page.getByAltText("通常 のプレビュー")).toBeVisible();
  await chosen.getByRole("button", { name: "あ", exact: true }).click();
  await expect(checkbox(page, "0/1")).toBeChecked();
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("0/1");
  await expect(page.locator(".preset-layer-list").getByRole("checkbox")).toHaveCount(1);
  await expect(checkbox(page, "0/1")).toBeChecked();
});

test("group-only view persists across Open and aiueo, composes with search and restores full tree", async ({ page }) => {
  const requests: State[][] = [];
  await openEditor(page, requests);
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(5);
  const initialDraft = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));

  await page.getByRole("button", { name: "顔 [0] だけ表示" }).click();
  await expect(page.getByRole("group", { name: "表示中のグループ" })).toContainText("顔");
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(4);
  await expect(layer(page, "1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "顔 [0] だけ表示" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1")))
    .toEqual(initialDraft);

  await layer(page, "0/0").getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(4);
  await checkbox(page, "0/1").check();
  await expect(layer(page, "0/1")).toHaveAttribute("data-aiueo-role", "show");
  await page.getByRole("group", { name: "編集する口形" })
    .getByRole("button", { name: "い", exact: true }).click();
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(4);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(layer(page, "0/0").locator(".preset-layer-role")).toHaveAttribute("data-open-role", "closed");

  // Scoped search must never show a match from a different group.
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("体");
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(0);
  await expect(page.getByText("該当するレイヤーがありません。")).toBeVisible();
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("");
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(4);

  // Manual folding still works while the view is scoped.
  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(1);
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(4);

  await page.getByRole("button", { name: "全体へ戻る" }).click();
  await expect(page.getByRole("group", { name: "表示中のグループ" })).toHaveCount(0);
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(5);
  await expect(layer(page, "1")).toBeVisible();
});

test("a nested group becomes the visible root regardless of collapsed ancestors", async ({ page }) => {
  const nested = [
    layers[0],
    ...layers.slice(1, 4),
    { path: "0/3", name: "口", kind: "group", visible: true, effective_visible: true,
      bbox: [0, 0, 64, 64] },
    { path: "0/3/0", name: "あ口", kind: "pixel", visible: false, effective_visible: false,
      bbox: [10, 10, 25, 20] },
    layers[4],
  ];
  await openEditor(page, [], nested);
  await page.getByRole("button", { name: "口 [0/3] だけ表示" }).click();
  await expect(page.locator(".preset-layer-list .preset-layer")).toHaveCount(2);
  await expect(layer(page, "0")).toHaveCount(0);
  await expect(layer(page, "0/3")).toBeVisible();
  await expect(layer(page, "0/3/0")).toBeVisible();
  await page.getByRole("button", { name: "すべて閉じる" }).click();
  await expect(layer(page, "0/3")).toBeVisible();
  await expect(layer(page, "0/3/0")).toHaveCount(0);
  await page.getByRole("button", { name: "口 [0/3] を開く" }).click();
  await expect(layer(page, "0/3/0")).toBeVisible();
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await expect(layer(page, "0/3/0")).toBeVisible();
  await checkbox(page, "0/3/0").check();
  await expect(layer(page, "0/3/0")).toHaveAttribute("data-aiueo-role", "show");
  await page.getByRole("button", { name: "全体へ戻る" }).click();
  // Root group "顔" is still manually folded; returning does not silently reopen it.
  await expect(layer(page, "0/3/0")).toHaveCount(0);
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(layer(page, "0/3/0")).toBeVisible();
});
