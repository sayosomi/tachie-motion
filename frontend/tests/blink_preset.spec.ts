import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const source = "/tmp/blink-test.psd";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "口", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 30, 20] },
  { path: "0/0/0", name: "口の線", kind: "pixel", visible: true, effective_visible: true, bbox: [3, 3, 20, 12] },
  { path: "0/1", name: "目", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 30, 20] },
  { path: "0/1/0", name: "*開眼", kind: "pixel", visible: true, effective_visible: true, bbox: [10, 10, 20, 18] },
  { path: "0/1/1", name: "*閉眼", kind: "pixel", visible: false, effective_visible: false, bbox: [10, 10, 20, 18] },
  { path: "0/1/2", name: "!まつ毛", kind: "pixel", visible: false, effective_visible: false, bbox: [10, 10, 20, 18] },
];
const entry = (page: Page, path: string) => page.locator(`.preset-layer[data-layer-path="${path}"]`);
const tabs = (page: Page) => page.getByRole("group", { name: "編集する目の形" });

async function openEditor(page: Page, requests: Array<{ path: string; visible: boolean }[]> = []) {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
  } }));
  await page.route("**/api/preset-preview", (route) => {
    requests.push(route.request().postDataJSON().layers);
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((node) =>
    { (node as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
}

async function setEyeGroup(page: Page) {
  await page.getByRole("group", { name: "動作の種類" })
    .getByRole("button", { name: "瞬き" }).click();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
}

test("eyes are edited independently of mouth with static preview and recoverable JSON", async ({ page }) => {
  const requests: Array<{ path: string; visible: boolean }[]> = [];
  await openEditor(page, requests);
  await setEyeGroup(page);
  await expect(entry(page, "0/1/0")).toBeVisible();
  await expect(entry(page, "0/0/0")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "目元へ" })).toBeEnabled();
  await expect(entry(page, "0/1/2").locator("input")).toHaveCount(0);
  await expect(page.locator(".preset-image-viewport img")).toHaveAttribute("src", png);

  await tabs(page).getByRole("button", { name: "閉眼" }).click();
  await entry(page, "0/1/1").getByRole("radio").check();
  await expect(entry(page, "0/1/0").getByRole("radio")).not.toBeChecked();
  await expect(entry(page, "0/1/1")).toHaveAttribute("data-eye-role", "show");
  await expect(page.locator(".preset-image-viewport img")).toBeVisible();
  // The Python fallback must receive the composed closed-eye state, not
  // merely show the identical mocked PNG for every request.
  await expect.poll(() => {
    const last = requests.at(-1);
    return last && [
      last.find((state) => state.path === "0/1/0")?.visible,
      last.find((state) => state.path === "0/1/1")?.visible,
      last.find((state) => state.path === "0/1/2")?.visible,
    ];
  }).toEqual([false, true, true]);

  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.motionGroups.eyes).toEqual(["0/1"]);
  expect(saved.collection.items[0].eyes.closed).toEqual([
    { path: "0/1/0", visible: false }, { path: "0/1/1", visible: true },
  ]);
  expect(saved.collection.items[0].openMouth).toBeUndefined();

  await tabs(page).getByRole("button", { name: "開眼" }).click();
  await expect(entry(page, "0/1/0").getByRole("radio")).toBeChecked();
  await expect(entry(page, "0/1/1").getByRole("radio")).not.toBeChecked();
  await page.getByRole("checkbox", { name: "瞬き", exact: true }).check();
  const updated = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(updated.collection.items[0].blinkEnabled).toBe(true);
  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  // The editor's ?preset= ID survives a reload, so the detail view is
  // already active; there is no "詳細を編集" button until navigating back.
  await expect(page.getByRole("heading", { name: "編集" })).toBeVisible();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await page.getByRole("group", { name: "動作の種類" })
    .getByRole("button", { name: "瞬き" }).click();
  await tabs(page).getByRole("button", { name: "閉眼" }).click();
  await expect(entry(page, "0/1/1").getByRole("radio")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "瞬き", exact: true })).toBeChecked();
  await expect(page.getByText("瞬きの動画書き出しは未実装です", { exact: false }))
    .toBeVisible();
});

test("mouth and eyes groups cannot overlap or detach assigned eye leaves", async ({ page }) => {
  await openEditor(page);
  // Assign mouth group first, then try to reuse it for eyes.
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口 [0/0]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("group", { name: "動作の種類" })
    .getByRole("button", { name: "瞬き" }).click();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口 [0/0]" }).click();
  await expect(page.getByRole("alert")).toContainText("重複するPSDグループ");
  await expect(page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口 [0/0]" })).not.toBeChecked();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await tabs(page).getByRole("button", { name: "閉眼" }).click();
  await entry(page, "0/1/1").getByRole("radio").check();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).click();
  await expect(page.getByRole("alert")).toContainText("先に開眼・閉眼の割当を解除");
  await expect(page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" })).toBeChecked();
});
