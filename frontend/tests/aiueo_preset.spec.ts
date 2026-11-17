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

async function openEditor(page: Page, requests: State[][]) {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
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

const roleCheckbox = (page: Page, path: string, label: string) =>
  page.locator(`.preset-layer-role[data-layer-path="${path}"]`)
    .getByRole("checkbox", { name: new RegExp(label + "で表示$") });
const roleReset = (page: Page, path: string, label: string) =>
  page.locator(`.preset-layer-role[data-layer-path="${path}"]`)
    .getByRole("button", { name: new RegExp(label + "を基本に戻す$") });

test("six mouth shapes keep independent per-layer overrides, Open roles and base states", async ({ page }) => {
  const requests: State[][] = [];
  await openEditor(page, requests);
  await page.locator('.preset-layer-role[data-layer-path="0/0"]')
    .getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]')
    .getByRole("button", { name: "Open: 開き口" }).click();

  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await expect(page.getByText("この口形は未設定です。", { exact: false })).toBeVisible();
  await expect(page.getByAltText("通常 のプレビュー")).toBeVisible();
  const baseBefore = await page.getByRole("checkbox", { name: "開き口 [0/1] 表示" }).isChecked();
  expect(baseBefore).toBe(false);
  const chosen = page.getByRole("group", { name: "編集するaiueo口形" });

  for (const label of labels) {
    await chosen.getByRole("button", { name: label, exact: true }).click();
    await roleCheckbox(page, "0/1", label).check();
    await roleCheckbox(page, "0/0", label).uncheck();
    await expect(roleCheckbox(page, "0/1", label)).toBeChecked();
    await expect(roleCheckbox(page, "0/0", label)).not.toBeChecked();
    await expect(page.locator('.preset-layer-role[data-layer-path="0/1"]'))
      .toHaveAttribute("data-aiueo-role", "show");
    await expect(page.locator('.preset-layer-role[data-layer-path="0/0"]'))
      .toHaveAttribute("data-aiueo-role", "hide");
    await expect.poll(() => {
      const last = requests.at(-1);
      return last?.find((row) => row.path === "0/1")?.visible;
    }).toBe(true);
    await expect.poll(() =>
      requests.at(-1)?.find((row) => row.path === "0/0")?.visible).toBe(false);
  }
  await expect(page.getByRole("checkbox", { name: "開き口 [0/1] 表示" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "閉じ口 [0/0] 表示" })).toBeChecked();

  await chosen.getByRole("button", { name: "あ", exact: true }).click();
  await roleReset(page, "0/1", "あ").click();
  await expect(page.locator('.preset-layer-role[data-layer-path="0/1"]'))
    .toHaveAttribute("data-aiueo-role", "base");
  await expect(roleCheckbox(page, "0/1", "あ")).not.toBeChecked();
  await expect.poll(() =>
    requests.at(-1)?.find((row) => row.path === "0/1")?.visible).toBe(false);

  await page.getByRole("checkbox", { name: "顔 [0] 表示" }).uncheck();
  await expect(page.locator(".preset-editor [role=status]")).toContainText("親グループが非表示");
  await page.getByRole("checkbox", { name: "顔 [0] 表示" }).check();

  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator('.preset-layer-role[data-layer-path="0/0"]'))
    .toHaveAttribute("data-open-role", "closed");
  await expect(page.locator('.preset-layer-role[data-layer-path="0/1"]'))
    .toHaveAttribute("data-open-role", "opened");

  await page.getByRole("button", { name: "開き口", exact: true }).click();
  await expect.poll(() =>
    requests.at(-1)?.find((row) => row.path === "0/1")?.visible).toBe(true);
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await chosen.getByRole("button", { name: "い", exact: true }).click();
  await expect(roleCheckbox(page, "0/1", "い")).toBeChecked();

  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const drafts = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));
  const saved = JSON.parse(drafts!);
  const item = saved.collection.items[0];
  expect(item.openMouth.closed).toContainEqual({ path: "0/0", visible: true });
  expect(item.openMouth.opened).toContainEqual({ path: "0/1", visible: true });
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
  await expect(roleCheckbox(page, "0/1", "ん")).toBeChecked();
});

test("assigned-only list follows current mouth and unconfigured shape shows the base portrait", async ({ page }) => {
  await openEditor(page, []);
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await roleCheckbox(page, "0/1", "あ").check();
  await page.getByRole("checkbox", { name: "割当済みのみ" }).check();
  await expect(page.locator(".preset-layer-role")).toHaveCount(1);
  await page.getByRole("group", { name: "編集するaiueo口形" })
    .getByRole("button", { name: "い", exact: true }).click();
  await expect(page.locator(".preset-layer-role")).toHaveCount(0);
  await expect(page.getByText("この口形は未設定です。", { exact: false })).toBeVisible();
  await expect(page.getByAltText("通常 のプレビュー")).toBeVisible();
  await page.getByRole("checkbox", { name: "割当済みのみ" }).uncheck();
  await expect(page.locator(".preset-layer-role")).toHaveCount(4);
  await expect(page.getByText("LAB口パクのMOV出力と目・瞬きは未対応です。", { exact: false })).toBeVisible();
});
