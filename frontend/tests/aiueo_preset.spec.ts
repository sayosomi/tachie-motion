import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
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

const roleButton = (page: Page, path: string, label: string, role: string) =>
  page.locator(`.preset-layer-role[data-layer-path="${path}"]`)
    .getByRole("button", { name: `aiueo ${label}: ${role}` });

test("six mouth shapes keep independent per-layer overrides, Open roles and base states", async ({ page }) => {
  const requests: State[][] = [];
  await openEditor(page, requests);
  await page.locator('.preset-layer-role[data-layer-path="0/0"]')
    .getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]')
    .getByRole("button", { name: "Open: 開き口" }).click();

  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await expect(page.getByText("口形を指定してください")).toBeVisible();
  const baseBefore = await page.getByRole("checkbox", { name: "開き口 [0/1] 表示" }).isChecked();
  expect(baseBefore).toBe(false);
  const chosen = page.getByRole("group", { name: "編集するaiueo口形" });

  for (const [index, label] of labels.entries()) {
    await chosen.getByRole("button", { name: label, exact: true }).click();
    await roleButton(page, "0/1", label, "表示").click();
    await roleButton(page, "0/0", label, "非表示").click();
    await expect(roleButton(page, "0/1", label, "表示")).toHaveAttribute("aria-pressed", "true");
    await expect(roleButton(page, "0/0", label, "非表示")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => {
      const last = requests.at(-1);
      return last?.find((row) => row.path === "0/1")?.visible;
    }).toBe(true);
    await expect.poll(() =>
      requests.at(-1)?.find((row) => row.path === "0/0")?.visible).toBe(false);
    expect(index).toBeLessThan(6);
  }
  await expect(page.getByRole("checkbox", { name: "開き口 [0/1] 表示" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "閉じ口 [0/0] 表示" })).toBeChecked();

  await chosen.getByRole("button", { name: "あ", exact: true }).click();
  await roleButton(page, "0/1", "あ", "基本").click();
  await expect(roleButton(page, "0/1", "あ", "基本")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() =>
    requests.at(-1)?.find((row) => row.path === "0/1")?.visible).toBe(false);

  await page.getByRole("checkbox", { name: "顔 [0] 表示" }).uncheck();
  await expect(page.getByRole("status")).toContainText("親グループが非表示");
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
  await expect(roleButton(page, "0/1", "い", "表示")).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "選択位置へ" }).isDisabled();
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
  await expect(roleButton(page, "0/1", "ん", "表示")).toHaveAttribute("aria-pressed", "true");
});

test("assigned-only list follows currently chosen mouth, and unconfigured mouth is not previewed", async ({ page }) => {
  await openEditor(page, []);
  await page.getByRole("button", { name: "aiueo", exact: true }).click();
  await roleButton(page, "0/1", "あ", "表示").click();
  await page.getByRole("checkbox", { name: "割当済みのみ" }).check();
  await expect(page.locator(".preset-layer-role")).toHaveCount(1);
  await page.getByRole("group", { name: "編集するaiueo口形" })
    .getByRole("button", { name: "い", exact: true }).click();
  await expect(page.locator(".preset-layer-role")).toHaveCount(0);
  await expect(page.getByText("口形を指定してください")).toBeVisible();
  await page.getByRole("checkbox", { name: "割当済みのみ" }).uncheck();
  await expect(page.locator(".preset-layer-role")).toHaveCount(4);
  await expect(page.getByText("LAB口パクのMOV出力と目・瞬きは未対応です。", { exact: false })).toBeVisible();
});
