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
const motionTabs = (page: Page) => page.getByRole("tablist", { name: "パーツ" });
const saved = async (page: Page) => JSON.parse((await page.evaluate(() =>
  localStorage.getItem("tachie-motion.preset-draft.v2")))!);

async function openEditor(page: Page, requests: Array<{ path: string; visible: boolean }[]> = [], sourceLayers = layers) {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers: sourceLayers,
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
    .getByRole("button", { name: "可動レイヤー" }).click();
}

async function selectEye(page: Page) {
  await motionTabs(page).getByRole("tab", { name: "目" }).click();
}

async function enableEye(page: Page) {
  await selectEye(page);
  await page.getByRole("checkbox", { name: "目 ON" }).check();
}

async function setEyeGroup(page: Page) {
  await enableEye(page);
  await page.getByRole("button", { name: "グループを選択", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
}

test("unselected closed eye is hidden and selecting the fixed eye is explicit", async ({ page }) => {
  const requests: Array<{ path: string; visible: boolean }[]> = [];
  await openEditor(page, requests);
  await setEyeGroup(page);
  await expect(entry(page, "0/1/0").getByRole("radio")).not.toBeChecked();
  await expect(entry(page, "0/1/1").getByRole("radio")).not.toBeChecked();
  await expect.poll(() => requests.some((states) =>
    states.find((x) => x.path === "0/1/0")?.visible === false)).toBe(true);
  await expect.poll(() => requests.some((states) =>
    states.find((x) => x.path === "0/1/2")?.visible === true)).toBe(true);
  // Fixed already shows the open eye, but selecting it for closed eyes is valid.
  const beforeSelection = requests.length;
  await entry(page, "0/1/0").click({ position: { x: 2, y: 2 } });
  await expect(entry(page, "0/1/0").getByRole("radio")).toBeChecked();
  const selected = (await saved(page)).collection.items[0].eyes.closed;
  expect(selected).toEqual([
    { path: "0/1/0", visible: true }, { path: "0/1/1", visible: false },
  ]);
  await expect.poll(() => requests.slice(beforeSelection).some((states) =>
    states.find((x) => x.path === "0/1/0")?.visible === true)).toBe(true);
});

test("eyes remain independent of mouth and restore their configured pose", async ({ page }) => {
  const requests: Array<{ path: string; visible: boolean }[]> = [];
  await openEditor(page, requests);
  await setEyeGroup(page);
  await expect(entry(page, "0/1/0")).toBeVisible();
  await expect(entry(page, "0/0/0")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "目元へ" })).toBeEnabled();
  await expect(entry(page, "0/1/2").locator("input")).toHaveCount(0);
  await expect(page.locator(".preset-image-viewport img")).toHaveAttribute("src", png);
  await expect(page.getByRole("heading", { name: "目を閉じたときの表示" })).toHaveCount(0);

  await entry(page, "0/1/1").click({ position: { x: 2, y: 2 } });
  await expect(entry(page, "0/1/1").getByRole("radio")).toBeChecked();
  await expect(entry(page, "0/1/0").getByRole("radio")).not.toBeChecked();
  await expect(entry(page, "0/1/1")).toHaveAttribute("data-eye-role", "show");
  await expect.poll(() => {
    const last = requests.at(-1);
    return last && [
      last.find((state) => state.path === "0/1/0")?.visible,
      last.find((state) => state.path === "0/1/1")?.visible,
      last.find((state) => state.path === "0/1/2")?.visible,
    ];
  }).toEqual([false, true, true]);
  expect((await saved(page)).collection.motionGroups.eyes).toEqual(["0/1"]);

  // Open eyes come only from the fixed layer state.
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "固定レイヤー" }).click();
  await expect(entry(page, "0/1/0").getByRole("radio")).toBeChecked();
  await expect(entry(page, "0/1/1").getByRole("radio")).not.toBeChecked();

  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "可動レイヤー" }).click();
  await selectEye(page);
  await expect(entry(page, "0/1/1").getByRole("radio")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "目 ON" })).toBeChecked();
});

test("normal layers edit the resting eye independently of the blink state", async ({ page }) => {
  await openEditor(page);
  await setEyeGroup(page);
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "固定レイヤー" }).click();
  await expect(entry(page, "0/1/0").getByRole("radio")).toBeChecked();
  await entry(page, "0/1/1").click({ position: { x: 2, y: 2 } });
  await expect(entry(page, "0/1/1").getByRole("radio")).toBeChecked();
  await expect(entry(page, "0/1/0").getByRole("radio")).not.toBeChecked();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "可動レイヤー" }).click();
  await expect(entry(page, "0/1/1").getByRole("radio")).not.toBeChecked();
  // A fixed eye change never implicitly selects the moving closed-eye pose.
  await entry(page, "0/1/1").getByRole("radio").check();
  await expect(entry(page, "0/1/1").getByRole("radio")).toBeChecked();
  expect((await saved(page)).collection.items[0].base.find(
    (x: { path: string; visible: boolean }) => x.path === "0/1/1")?.visible).toBe(true);
});

test("mouth/eye PSD groups cannot overlap or detach assigned leaves", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "グループを選択", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口 [0/0]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();

  await enableEye(page);
  await page.getByRole("button", { name: "グループを選択", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口 [0/0]" }).click();
  await expect(page.getByRole("alert")).toContainText("重複するPSDグループ");
  await expect(page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "口 [0/0]" })).not.toBeChecked();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await entry(page, "0/1/1").getByRole("radio").check();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).click();
  await expect(page.getByRole("alert")).toContainText("先に割当を解除");
});

test("checkbox toggles retain eye and mouth shapes without duplicating controls", async ({ page }) => {
  await openEditor(page);
  const tabs = motionTabs(page);
  await expect(tabs.getByRole("tab", { name: "口" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("checkbox", { name: "口 ON" })).toBeChecked();
  await selectEye(page);
  await expect(tabs.getByRole("tab", { name: "目" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("checkbox", { name: "目 ON" })).not.toBeChecked();
  await expect(page.locator(".preset-layer-list")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "目 ON" }).check();
  await page.getByRole("button", { name: "グループを選択", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await entry(page, "0/1/1").getByRole("radio").check();
  const savedShape = (await saved(page)).collection.items[0].eyes.closed;
  await page.getByRole("checkbox", { name: "目 ON" }).uncheck();
  await expect(page.locator(".preset-layer-list")).toHaveCount(0);
  expect((await saved(page)).collection.items[0].eyes.closed).toEqual(savedShape);
  await page.getByRole("checkbox", { name: "目 ON" }).check();
  await expect(entry(page, "0/1/1").getByRole("radio")).toBeChecked();
  await tabs.getByRole("tab", { name: "口" }).click();
  await page.getByRole("checkbox", { name: "口 ON" }).uncheck();
  await expect(page.locator(".preset-layer-list")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "口 ON" }).check();
  await expect(page.getByRole("group", { name: "口の方式" })
    .getByRole("button", { name: "Open" })).toBeVisible();
});

test("clearing starred closed eyes permits reassignment and restores blank state", async ({ page }) => {
  await openEditor(page);
  await setEyeGroup(page);
  await entry(page, "0/1/1").getByRole("radio").check();
  await page.getByRole("button", { name: "閉じ目の選択を解除" }).click();
  await expect(entry(page, "0/1/0").getByRole("radio")).not.toBeChecked();
  await expect(entry(page, "0/1/1").getByRole("radio")).not.toBeChecked();
  const restored = await saved(page);
  expect(restored.collection.items[0].eyes).toBeUndefined();
  expect(restored.collection.items[0].base.find(
    (item: { path: string; visible: boolean }) => item.path === "0/1/0")?.visible).toBe(true);
  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "可動レイヤー" }).click();
  await selectEye(page);
  await expect(entry(page, "0/1/1").getByRole("radio")).not.toBeChecked();
  await page.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "目 [0/1]" }).uncheck();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  expect((await saved(page)).collection.motionGroups.eyes).toEqual([]);
});


test("saved blink defaults are shown on first load and custom edits survive reload", async ({ page }) => {
  await openEditor(page);
  await setEyeGroup(page);
  // The initial values are already in durable browser storage.
  await expect(page.getByRole("spinbutton", { name: "間隔（秒）" })).toHaveValue("3");
  await expect(page.getByRole("spinbutton", { name: "閉眼時間（秒）" })).toHaveValue("0.12");
  await expect(page.getByRole("spinbutton", { name: "間隔の揺らぎ（±秒）" })).toHaveValue("0.5");
  await expect(page.getByRole("spinbutton", { name: "最初の瞬きまで（秒）" })).toHaveValue("0.7");
  await expect(page.getByRole("spinbutton", { name: "再現用シード（整数）" })).toHaveValue("0");
  expect((await saved(page)).collection.blinkTiming).toEqual({
    intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
  });
  await expect(page.getByText("初期値または変更済みの保存設定")).toBeVisible();

  await page.getByRole("spinbutton", { name: "間隔（秒）" }).fill("5");
  await page.getByRole("spinbutton", { name: "閉眼時間（秒）" }).fill("0.1");
  await page.getByRole("spinbutton", { name: "間隔の揺らぎ（±秒）" }).fill("6");
  await page.getByRole("spinbutton", { name: "最初の瞬きまで（秒）" }).fill("1");
  await page.getByRole("spinbutton", { name: "再現用シード（整数）" }).fill("1234");
  await page.getByRole("button", { name: "瞬き時間を保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "数値が不正" })).toBeVisible();

  await page.getByRole("spinbutton", { name: "間隔の揺らぎ（±秒）" }).fill("1");
  await page.getByRole("button", { name: "瞬き時間を保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  expect((await saved(page)).collection.blinkTiming).toEqual({
    intervalMs: 5000, closedMs: 100, jitterMs: 1000, phaseMs: 1000, seed: 1234,
  });

  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "可動レイヤー" }).click();
  await selectEye(page);
  await expect(page.getByRole("spinbutton", { name: "間隔（秒）" })).toHaveValue("5");
  await expect(page.getByRole("spinbutton", { name: "再現用シード（整数）" })).toHaveValue("1234");
});


test("blink export uses saved initial timing without pressing the timing save button", async ({ page }) => {
  const submissions: Array<Record<string, unknown>> = [];
  await page.route("**/api/health", (route) => route.fulfill({
    json: { ok: true, default_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000,
      duration_seconds: 1, source_identity: "1:2:3:4:5" },
  }));
  await page.route("**/api/preset-utterance-destination", (route) => route.fulfill({
    json: { state: "available", suggested_basename: "blink_002" },
  }));
  await page.route("**/api/preset-utterance-export", (route) => {
    submissions.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: {
      mov: "/tmp/output/blink_001.mov",
      otio: "/tmp/output/blink_001.otio",
      frames: 30, sample_count: 1000,
    } });
  });
  await openEditor(page);
  await setEyeGroup(page);
  await entry(page, "0/1/1").getByRole("radio").check();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#speech-wav-path").fill("/tmp/声 だんもん.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  await expect(page.getByText("瞬きの閉じ目レイヤーとキャラクター共通の時間設定")).toHaveCount(0);
  // No manual timing edit/save is needed after selecting the closed eye.
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeEnabled();
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].blink_enabled).toBe(true);
  expect(submissions[0].eye_groups).toEqual(["0/1"]);
  expect(submissions[0].eyes).toMatchObject({
    opened: [], closed: [
      { path: "0/1/0", visible: false },
      { path: "0/1/1", visible: true },
    ],
  });
  expect(submissions[0].blink_timing).toEqual({
    interval_frames: 90, closed_frames: 4,
    jitter_frames: 15, phase_frames: 21, seed: 0,
  });
  expect(submissions[0].mode).toBe("none");
});


test("starred eye group next to starred closed leaf is hidden only for the closed pose", async ({ page }) => {
  const requests: Array<{ path: string; visible: boolean }[]> = [];
  const sourceLayers = [
    { path: "7", name: "顔／目", kind: "group", visible: true,
      effective_visible: true, bbox: [0, 0, 64, 64] },
    { path: "7/0", name: "*開いた目グループ", kind: "group", visible: true,
      effective_visible: true, bbox: [10, 10, 30, 20] },
    { path: "7/0/0", name: "虹彩", kind: "pixel", visible: true,
      effective_visible: true, bbox: [10, 10, 30, 20] },
    { path: "7/1", name: "*閉じ目", kind: "pixel", visible: false,
      effective_visible: false, bbox: [10, 10, 30, 20] },
  ];
  await openEditor(page, requests, sourceLayers);
  await page.getByRole("tablist", { name: "パーツ" })
    .getByRole("tab", { name: "目" }).click();
  await page.getByRole("checkbox", { name: "目 ON" }).check();
  await page.getByRole("button", { name: "グループを選択", exact: true }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: "顔／目 [7]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await entry(page, "7/1").getByRole("radio").check();
  await expect(entry(page, "7/1").getByRole("radio")).toBeChecked();
  await expect(page.locator(".preset-error-toast")).toHaveCount(0);

  const draft = await saved(page);
  expect(draft.collection.items[0].base.find(
    (state: { path: string; visible: boolean }) => state.path === "7/0"
  )?.visible).toBe(true);
  expect(draft.collection.items[0].eyes.closed.find(
    (state: { path: string; visible: boolean }) => state.path === "7/1"
  )?.visible).toBe(true);
  expect(draft.collection.items[0].eyes.closed.some(
    (state: { path: string }) => state.path === "7/0"
  )).toBe(false);
  await expect.poll(() => requests.some((states) =>
    states.find((state) => state.path === "7/0")?.visible === false &&
    states.find((state) => state.path === "7/1")?.visible === true)).toBe(true);
});

test("failed blink timing persistence has visible viewport error and no false success", async ({ page }) => {
  await openEditor(page);
  await setEyeGroup(page);
  // Fail only the timing save; the following unrelated edit must succeed.
  // This reproduces accidental persistence of a failed in-memory blink edit.
  await page.getByRole("spinbutton", { name: "間隔（秒）" }).fill("4.2");
  expect((await saved(page)).collection.blinkTiming).toEqual({
    intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
  });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failNextDraftWrite = true;
    Storage.prototype.setItem = function (key, value) {
      if (failNextDraftWrite && key === "tachie-motion.preset-draft.v2") {
        failNextDraftWrite = false;
        throw new DOMException("Storage denied", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "瞬き時間を保存" }).click();
  await expect(page.locator(".preset-error-toast")).toContainText("ブラウザに自動保存できません");
  await expect(page.getByRole("status").filter({
    hasText: "保存できませんでした",
  })).toBeVisible();
  await expect(page.getByRole("status").filter({
    hasText: "キャラクター共通の瞬き設定を保存しました",
  })).toHaveCount(0);
  await expect.poll(() => page.locator(".preset-error-toast").evaluate((node) =>
    getComputedStyle(node).position === "fixed" &&
      node.getBoundingClientRect().top >= 0 &&
      node.getBoundingClientRect().top < window.innerHeight / 2
  )).toBe(true);
  await page.getByRole("button", { name: "エラーを閉じる" }).click();
  await expect(page.locator(".preset-error-toast")).toHaveCount(0);
  // Failed storage writes must not reach React collection or a later
  // successful save. Otherwise the later edit silently saves blink timing.
  await expect(page.getByText("初期値または変更済みの保存設定", { exact: false })).toBeVisible();
  await page.getByRole("checkbox", { name: "目 ON" }).uncheck();
  const afterOtherEdit = await saved(page);
  expect(afterOtherEdit.collection.items[0].blinkEnabled).toBe(false);
  expect(afterOtherEdit.collection.blinkTiming).toEqual({
    intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
  });
  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  expect((await saved(page)).collection.blinkTiming).toEqual({
    intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
  });
});

test("existing same-source browser draft without blink timing is durably initialized on restore", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const previous = JSON.parse(localStorage.getItem(key)!);
    delete previous.collection.blinkTiming;
    localStorage.setItem(key, JSON.stringify(previous));
  });
  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  expect((await saved(page)).collection.blinkTiming).toEqual({
    intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
  });
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "可動レイヤー" }).click();
  await enableEye(page);
  await expect(page.getByRole("spinbutton", { name: "間隔（秒）" })).toHaveValue("3");
});

test("failed rename persistence preserves the visible error and unchanged preset name", async ({ page }) => {
  await openEditor(page);
  await page.locator("#preset-name").fill("保存失敗テスト");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failNextDraftWrite = true;
    Storage.prototype.setItem = function (key, value) {
      if (failNextDraftWrite && key === "tachie-motion.preset-draft.v2") {
        failNextDraftWrite = false;
        throw new DOMException("Storage denied", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "名前を変更" }).click();
  await expect(page.locator(".preset-error-toast")).toContainText("ブラウザに自動保存できません");
  expect((await saved(page)).collection.items[0].name).toBe("通常");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.getByText("通常", { exact: true })).toBeVisible();
});

const initialTiming = {
  intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
};

/** Reproduce a tab switch while the Presets view is still validating PSD.
 * The Speech view must handle the missing timing independently.
 */
async function switchSpeechDuringHeldPresetRestore(page: Page, failSpeechWrite: boolean) {
  await openEditor(page);
  await setEyeGroup(page);
  await entry(page, "0/1/1").getByRole("radio").check();
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const draft = JSON.parse(localStorage.getItem(key)!);
    delete draft.collection.blinkTiming;
    localStorage.setItem(key, JSON.stringify(draft));
  });
  if (failSpeechWrite) {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "tachie-motion.preset-draft.v2")
          throw new DOMException("Storage denied", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
  }
  await page.unroute("**/api/psd");
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstSeen!: () => void;
  const firstRequested = new Promise<void>((resolve) => { firstSeen = resolve; });
  let requestCount = 0;
  await page.route("**/api/psd", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      firstSeen();
      await holdFirst;
    }
    // The first browser request may already be aborted by tab unmount.
    try {
      await route.fulfill({ json: {
        width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
      } });
    } catch { /* A cancelled Presets request is expected. */ }
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: {
    ok: true, default_output_dir: "/tmp/output",
  } }));
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  } }));
  await page.route("**/api/preset-utterance-destination", (route) =>
    route.fulfill({ json: { state: "available", suggested_basename: "blink_002" } }));
  await page.reload();
  await firstRequested;
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  releaseFirst();
  await expect(page.getByRole("heading", { name: "セリフ" })).toBeVisible();
}

test("switching to Speech during old-draft PSD restore persists blink defaults before export", async ({ page }) => {
  await switchSpeechDuringHeldPresetRestore(page, false);
  await expect.poll(async () => (await saved(page)).collection.blinkTiming).toEqual(initialTiming);
  await page.locator("#speech-wav-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#speech-wav-path").fill("/tmp/011_あんこもん.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeEnabled();
});

test("Speech restore write failure preserves the old draft and blocks export", async ({ page }) => {
  await switchSpeechDuringHeldPresetRestore(page, true);
  await expect(page.getByRole("alert")).toContainText("瞬き初期値をブラウザへ保存できません");
  expect((await saved(page)).collection.blinkTiming).toBeUndefined();
  await expect(page.getByRole("button", { name: "WAVを確認" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeDisabled();
});

test("new PSD initialization write failure leaves no phantom saved timing", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "tachie-motion.preset-draft.v2")
        throw new DOMException("Storage denied", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
  } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.locator(".preset-error-toast")).toContainText("ブラウザに自動保存できません");
  await expect(page.getByRole("button", { name: "詳細を編集" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"))).toBeNull();
});

test("old-draft restore write failure never publishes unsaved blink defaults", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const draft = JSON.parse(localStorage.getItem(key)!);
    delete draft.collection.blinkTiming;
    localStorage.setItem(key, JSON.stringify(draft));
  });
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "tachie-motion.preset-draft.v2")
        throw new DOMException("Storage denied", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.reload();
  await expect(page.getByText("初期の瞬き時間を保存できないため復元を中止しました。", { exact: false })).toBeVisible();
  expect((await saved(page)).collection.blinkTiming).toBeUndefined();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toHaveCount(0);
});
