import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const source = "/tmp/立ち絵 e\u0301.psd";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "0/0", name: "口１", kind: "group", visible: true, effective_visible: true, bbox: [0,0,30,20] },
  { path: "0/0/0", name: "閉じ口", kind: "pixel", visible: true, effective_visible: true, bbox: [10,10,25,20] },
  { path: "0/1", name: "口２", kind: "group", visible: true, effective_visible: true, bbox: [0,0,30,20] },
  { path: "0/1/0", name: "開き口", kind: "pixel", visible: false, effective_visible: false, bbox: [10,10,25,20] },
  { path: "0/2", name: "目", kind: "group", visible: true, effective_visible: true, bbox: [0,0,30,20] },
  { path: "0/2/0", name: "通常の目", kind: "pixel", visible: true, effective_visible: true, bbox: [10,10,25,20] },
  { path: "1", name: "体", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,64,64] },
];
type State = { path: string; visible: boolean };
const layer = (page: Page, path: string) => page.locator(`.preset-layer[data-layer-path="${path}"]`);
const checkbox = (page: Page, path: string) => layer(page, path).getByRole("checkbox");
const shapes = (page: Page) => page.getByRole("group", { name: "編集する口形" });
const shape = (page: Page, name: string) => shapes(page).getByRole("button", { name, exact: true });

async function openEditor(page: Page, requests: State[][] = []) {
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

async function chooseMouthGroups(page: Page) {
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口１ [0/0]" }).check();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口２ [0/1]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
}

test("Open closed mouth inherits the base preview without needing a duplicate mouth assignment", async ({ page }) => {
  const requests: State[][] = [];
  await openEditor(page, requests);
  const portrait = page.locator(".preset-image-viewport img");
  await expect(portrait).toBeVisible();
  const baseSource = await portrait.getAttribute("src");
  expect(baseSource).toBe(png);

  await chooseMouthGroups(page); // Opens the closed-mouth editing state.
  await expect(shape(page, "閉じ口")).toHaveAttribute("aria-pressed", "true");
  await expect(portrait).toHaveAttribute("src", baseSource!);
  await expect(page.getByText("口形を指定してください")).toHaveCount(0);
  await expect(page.locator(".preview-empty")).toHaveCount(0);
  expect(requests).toHaveLength(0); // Inherited state needs no extra preview render.

  await shape(page, "開き口").click();
  await expect(page.getByText("開き口を指定してください")).toBeVisible();
  await shape(page, "閉じ口").click();
  await expect(portrait).toHaveAttribute("src", baseSource!);
  await expect(page.getByText("開き口を指定してください")).toHaveCount(0);

  // Only the opened mouth is edited; the closed state is inherited and stored
  // as the paired base values for the targeted layers when Open is configured.
  await shape(page, "開き口").click();
  await checkbox(page, "0/0/0").uncheck();
  await checkbox(page, "0/1/0").check();
  await shape(page, "閉じ口").click();
  await expect(checkbox(page, "0/0/0")).toBeChecked();
  await expect(checkbox(page, "0/1/0")).not.toBeChecked();
  await expect(portrait).toBeVisible();
  await expect(page.locator(".preview-empty")).toHaveCount(0);

  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.items[0].openMouth.closed).toEqual([
    { path: "0/0/0", visible: true }, { path: "0/1/0", visible: false },
  ]);
  expect(saved.collection.items[0].openMouth.opened).toEqual([
    { path: "0/0/0", visible: false }, { path: "0/1/0", visible: true },
  ]);
  await shape(page, "基本").click();
  await expect(checkbox(page, "0/0/0")).toBeChecked();
  await expect(checkbox(page, "0/1/0")).not.toBeChecked();
});

test("mouth motion scopes original PSD groups and Open/aiueo each have independent leaf checkboxes", async ({ page }) => {
  const requests: State[][] = [];
  await openEditor(page, requests);
  await expect(layer(page, "0/2")).toBeVisible();
  await chooseMouthGroups(page);
  await expect(layer(page, "0")).toHaveCount(0);
  await expect(layer(page, "0/2")).toHaveCount(0);
  await expect(layer(page, "0/0/0")).toBeVisible();
  await expect(layer(page, "0/1/0")).toBeVisible();
  await expect(page.locator(".preset-editor .preset-layer-role")).toHaveCount(0);
  await expect(checkbox(page, "0/0")).toHaveCount(0);

  // One Open action, but closed and open shapes can come from separate PSD groups.
  await shape(page, "開き口").click();
  await checkbox(page, "0/0/0").uncheck();
  await checkbox(page, "0/1/0").check();
  await expect.poll(() => requests.at(-1)?.find((entry) => entry.path === "0/1/0")?.visible)
    .toBe(true);
  await shape(page, "閉じ口").click();
  await expect(checkbox(page, "0/0/0")).toBeChecked();
  await expect(checkbox(page, "0/1/0")).not.toBeChecked();

  await page.getByRole("group", { name: "口パク方式" })
    .getByRole("button", { name: "aiueo" }).click();
  for (const name of ["あ", "い", "う", "え", "お", "ん"]) {
    await shape(page, name).click();
    await checkbox(page, "0/0/0").uncheck();
    await checkbox(page, "0/1/0").check();
    await expect(layer(page, "0/1/0")).toHaveAttribute("data-aiueo-role", "show");
  }

  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "通常レイヤー" }).click();
  await expect(layer(page, "0")).toBeVisible();
  await expect(layer(page, "0/2/0")).toBeVisible();
  await expect(layer(page, "0/0")).toHaveCount(0);
  await expect(layer(page, "0/1/0")).toHaveCount(0);

  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.motionGroups.mouth).toEqual(["0/0", "0/1"]);
  expect(saved.collection.items[0].openMouth.closed).toEqual([
    { path: "0/0/0", visible: true }, { path: "0/1/0", visible: false },
  ]);
  expect(saved.collection.items[0].openMouth.opened).toEqual([
    { path: "0/0/0", visible: false }, { path: "0/1/0", visible: true },
  ]);
  for (const key of ["a", "i", "u", "e", "o", "n"]) {
    expect(saved.collection.items[0].aiueoMouth[key]).toEqual([
      { path: "0/0/0", visible: false }, { path: "0/1/0", visible: true },
    ]);
  }

  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await expect(layer(page, "0/1/0")).toBeVisible();
  await expect(layer(page, "0/2/0")).toHaveCount(0);
});

test("parent visibility remains authoritative, presets can disable mouth without deleting shapes", async ({ page }) => {
  await openEditor(page);
  await chooseMouthGroups(page);
  await shape(page, "開き口").click();
  await checkbox(page, "0/0/0").uncheck();
  await checkbox(page, "0/1/0").check();
  await page.getByRole("checkbox", { name: "口パク", exact: true }).uncheck();
  let saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.items[0].mouthMotionEnabled).toBe(false);
  expect(saved.collection.items[0].openMouth.opened).toHaveLength(2);

  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "通常レイヤー" }).click();
  await checkbox(page, "0").uncheck();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await expect(page.locator(".preset-editor [role=status]"))
    .toContainText("親グループが非表示");
  await page.getByRole("checkbox", { name: "口パク", exact: true }).check();
  saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.items[0].mouthMotionEnabled).toBe(true);
  expect(saved.collection.items[0].openMouth.opened).toHaveLength(2);
});

test("configured group cannot be detached until its leaf targets are cleared", async ({ page }) => {
  await openEditor(page);
  await chooseMouthGroups(page);
  await shape(page, "開き口").click();
  await checkbox(page, "0/1/0").check();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口２ [0/1]" }).click();
  await expect(page.getByRole("alert"))
    .toContainText("先に口形の割当を解除");
  await expect(page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口２ [0/1]" })).toBeChecked();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();

  // Restore the Open shape to the base value in both states and detach.
  await checkbox(page, "0/1/0").uncheck();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口２ [0/1]" }).uncheck();
  await expect(layer(page, "0/1/0")).toHaveCount(0);
});

test("nested groups stay independent and searching never leaks other PSD groups", async ({ page }) => {
  await openEditor(page);
  await chooseMouthGroups(page);
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("目");
  await expect(layer(page, "0/2/0")).toHaveCount(0);
  await expect(page.getByText("該当するレイヤーがありません。")).toBeVisible();
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("");
  await page.getByRole("button", { name: "口１ [0/0] を閉じる" }).click();
  await expect(layer(page, "0/0/0")).toHaveCount(0);
  await expect(layer(page, "0/1/0")).toBeVisible();
  await page.getByRole("button", { name: "口１ [0/0] を開く" }).click();
  await expect(layer(page, "0/0/0")).toBeVisible();
});

test("PSDTool * radios are exclusive only among immediate siblings, ! is not editable", async ({ page }) => {
  const sourceLayers = [
    { path: "0", name: "!顔", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
    { path: "0/0", name: "!くち", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
    { path: "0/0/0", name: "*普通", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,8,8] },
    { path: "0/0/1", name: "*笑顔", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,8,8] },
    { path: "0/0/2", name: "!共通線", kind: "pixel", visible: false, effective_visible: false, bbox: [0,0,8,8] },
    { path: "0/0/3", name: "影", kind: "pixel", visible: false, effective_visible: false, bbox: [0,0,8,8] },
    { path: "0/1", name: "目", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
    { path: "0/1/0", name: "*通常", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,8,8] },
    { path: "0/1/1", name: "*細目", kind: "pixel", visible: false, effective_visible: false, bbox: [0,0,8,8] },
  ];
  const rendered: State[][] = [];
  await page.route("**/api/psd", route => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000",
    preview: png, layers: sourceLayers,
  } }));
  await page.route("**/api/preset-preview", route => {
    rendered.push(route.request().postDataJSON().layers);
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();

  const ordinary = layer(page, "0/0/0").getByRole("radio");
  const smile = layer(page, "0/0/1").getByRole("radio");
  const eye = layer(page, "0/1/0").getByRole("radio");
  await expect(ordinary).toBeChecked();
  await expect(smile).not.toBeChecked();
  await expect(eye).toBeChecked();
  await expect(checkbox(page, "0/0/2")).toHaveCount(0);
  await expect(checkbox(page, "0/0/3")).not.toBeChecked();

  await smile.check();
  await expect(ordinary).not.toBeChecked();
  await expect(eye).toBeChecked(); // cousin group is independent
  await expect(checkbox(page, "0/0/3")).not.toBeChecked();
  await expect.poll(() => rendered.at(-1)?.find(x => x.path === "0/0/2")?.visible)
    .toBe(true); // exclamation item was hidden in the source PSD
  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  expect(saved.collection.items[0].base.find((x: State) => x.path === "0/0/0").visible).toBe(false);
  expect(saved.collection.items[0].base.find((x: State) => x.path === "0/0/1").visible).toBe(true);
  expect(saved.collection.items[0].base.find((x: State) => x.path === "0/0/2").visible).toBe(true);
});

test("Open and aiueo have separate PSDTool sibling radio selections and a shared mandatory leaf", async ({ page }) => {
  const psdLayers = [
    { path: "0", name: "!口", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
    { path: "0/0", name: "*あ", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,8,8] },
    { path: "0/1", name: "*い", kind: "pixel", visible: false, effective_visible: false, bbox: [0,0,8,8] },
    { path: "0/2", name: "!輪郭", kind: "pixel", visible: false, effective_visible: false, bbox: [0,0,8,8] },
    { path: "0/3", name: "陰影", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,8,8] },
  ];
  await page.route("**/api/psd", route => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000",
    preview: png, layers: psdLayers,
  } }));
  await page.route("**/api/preset-preview", route =>
    route.fulfill({ json: { preview: png } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "!口 [0]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();

  // Repro: the selected '*あ' matches the base pose. The empty Open closed
  // overrides must render the base portrait rather than the missing-shape UI.
  await expect(layer(page, "0/0").getByRole("radio")).toBeChecked();
  await expect(page.locator(".preset-image-viewport img")).toBeVisible();
  await expect(page.getByText("口形を指定してください")).toHaveCount(0);
  await expect(page.locator(".preview-empty")).toHaveCount(0);

  await shape(page, "開き口").click();
  await layer(page, "0/1").getByRole("radio").check();
  await expect(layer(page, "0/0").getByRole("radio")).not.toBeChecked();
  await expect(layer(page, "0/1").getByRole("radio")).toBeChecked();
  await expect(layer(page, "0/2").locator('input')).toHaveCount(0);
  await shape(page, "閉じ口").click();
  await expect(layer(page, "0/0").getByRole("radio")).toBeChecked();
  await expect(layer(page, "0/1").getByRole("radio")).not.toBeChecked();

  await page.getByRole("group", { name: "口パク方式" })
    .getByRole("button", { name: "aiueo" }).click();
  await shape(page, "あ").click();
  await layer(page, "0/1").getByRole("radio").check();
  await shape(page, "い").click();
  await expect(layer(page, "0/0").getByRole("radio")).toBeChecked();
  await shape(page, "あ").click();
  await expect(layer(page, "0/1").getByRole("radio")).toBeChecked();
  await expect(layer(page, "0/3").getByRole("checkbox")).toBeChecked();

  const saved = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1")))!);
  const preset = saved.collection.items[0];
  expect(preset.base.find((x: State) => x.path === "0/0")?.visible).toBe(true);
  expect(preset.openMouth.opened).toEqual([
    { path: "0/0", visible: false }, { path: "0/1", visible: true },
  ]);
  expect(preset.openMouth.closed).toEqual([
    { path: "0/0", visible: true }, { path: "0/1", visible: false },
  ]);
  expect(preset.aiueoMouth.a).toEqual([
    { path: "0/0", visible: false }, { path: "0/1", visible: true },
  ]);
  expect(preset.aiueoMouth.i).toEqual([]);
});
