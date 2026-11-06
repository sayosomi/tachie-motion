import { expect, test } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "0/0", name: "目", kind: "pixel", visible: true, effective_visible: true, bbox: [4,6,15,20] },
  { path: "0/1", name: "目", kind: "pixel", visible: false, effective_visible: false, bbox: [4,6,15,20] },
  { path: "1", name: "body", kind: "pixel", visible: true, effective_visible: true, bbox: [0,0,64,64] },
];

test("preset-first list, detail ON/OFF, copy, reorder and refresh recovery", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
  }}));
  const previews: Array<{ fingerprint: string; layers: Array<{path: string;visible: boolean}> }> = [];
  await page.route("**/api/preset-preview", (route) => {
    previews.push(route.request().postDataJSON());
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "プリセット" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("このブラウザに自動保存");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/キャラ.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("heading", { name: "一覧" })).toBeVisible();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  const firstId = await page.locator("[data-preset-id]").first().getAttribute("data-preset-id");
  await expect(page.getByAltText("通常 のプレビュー")).toBeVisible();

  await page.getByRole("button", { name: "＋ 作成" }).click();
  await expect(page.getByRole("heading", { name: "編集" })).toBeVisible();
  await expect(page).toHaveURL(/\?preset=/);
  await page.locator("#preset-name").fill("にっこり");
  await page.getByRole("button", { name: "名前を変更" }).click();
  await page.getByRole("checkbox", { name: "目 [0/1] 表示" }).check();
  await expect(page.getByRole("checkbox", { name: "目 [0/1] 表示" })).toBeChecked();
  await expect.poll(() => previews.at(-1)?.layers.find((x) => x.path === "0/1")?.visible).toBe(true);
  expect(previews.at(-1)?.fingerprint).toBe("1000:2000");
  await expect(page.getByAltText("にっこり のプレビュー")).toBeVisible();

  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(page.getByRole("checkbox", { name: "目 [0/1] 表示" })).toHaveCount(0);
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(page.getByRole("checkbox", { name: "目 [0/1] 表示" })).toBeChecked();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.getByText("にっこり")).toBeVisible();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);

  const secondId = await page.locator("[data-preset-id]").nth(1).getAttribute("data-preset-id");
  expect(secondId).not.toBe(firstId);
  await page.locator("[data-preset-id]").nth(1).getByRole("button", { name: "複製" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(3);
  const ids = await page.locator("[data-preset-id]").evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-preset-id")),
  );
  expect(new Set(ids).size).toBe(3);
  await page.locator("[data-preset-id]").nth(1).getByRole("button", { name: "既定にする" }).click();
  await expect(page.locator("[data-preset-id]").nth(1)).toContainText("既定");
  await page.getByRole("button", { name: "にっこり を上へ移動" }).first().click();
  expect(await page.locator("[data-preset-id]").first().getAttribute("data-preset-id")).toBe(secondId);

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("[data-preset-id]").first().getByRole("button", { name: "削除" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(3);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-preset-id]").first().getByRole("button", { name: "削除" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  await expect(page.locator("[data-preset-id]").first()).toContainText("既定");
  await page.reload();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  await expect(page.getByRole("status")).toContainText("前回の編集を復元しました");
  await expect(page.locator("[data-preset-id]").first()).toContainText("既定");
});

test("small-screen preset navigation uses touch-safe up/down, utterances kept separate", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
  }}));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "プリセット" })).toBeVisible();
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/キャラ.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "新しいプリセット を上へ移動" }).click();
  await expect(page.locator("[data-preset-id]").first()).toContainText("新しいプリセット");
  await page.route("**/api/health", (route) => route.fulfill({ json: {
    ok: true, default_output_dir: "/tmp",
  } }));
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "セリフ" })).toBeVisible();
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
});

test("drafting a different PSD path cannot silently discard unsaved preset edits", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
  }}));
  const paths: string[] = [];
  await page.route("**/api/preset-preview", (route) => {
    paths.push(route.request().postDataJSON().path);
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/original.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("checkbox", { name: "目 [0/1] 表示" }).check();
  await expect.poll(() => paths.length).toBeGreaterThan(0);
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/other.psd");
  await expect(page.getByText("新しいPSDパスを入力中です。")).toBeVisible();
  await page.getByRole("checkbox", { name: "目 [0/1] 表示" }).uncheck();
  await expect.poll(() => paths.length).toBeGreaterThan(1);
  expect(paths.every((path) => path === "/tmp/original.psd")).toBe(true);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "目 [0/1] 表示" })).not.toBeChecked();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
});

test("a delayed PSD response cannot discard an edit made while it was loading", async ({ page }) => {
  let release!: () => void;
  const holdSecond = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route("**/api/psd", async (route) => {
    reads += 1;
    if (reads === 2) await holdSecond;
    await route.fulfill({ json: {
      width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
    } });
  });
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/first.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();

  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/second.psd");
  // A different PSD requires explicit approval; Playwright otherwise
  // auto-dismisses the native confirm and the delayed request never starts.
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("保存済みのプリセットを破棄");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("button", { name: "読み込み中…" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "目 [0/0] 表示" }).uncheck();
  release();

  await expect(page.getByRole("alert")).toContainText("読み込み結果を破棄しました");
  await expect(page.getByRole("checkbox", { name: "目 [0/0] 表示" })).not.toBeChecked();
  await expect(page.getByRole("note")).toContainText("このブラウザに自動保存");
  await expect(page.getByRole("heading", { name: "編集" })).toBeVisible();
});

test("uncommitted rename draft survives history and requires confirmation before replacing PSD", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "1000:2000", preview: png, layers,
  } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/first.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.locator("#preset-name").fill("未確定の名前");
  await expect(page.getByRole("note")).toContainText("このブラウザに自動保存");

  // Browser Back detaches the detail view but must not destroy its name draft.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "一覧" })).toBeVisible();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.locator("#preset-name")).toHaveValue("未確定の名前");

  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/second.psd");
  let prompts = 0;
  page.once("dialog", async (dialog) => { prompts += 1; await dialog.dismiss(); });
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  expect(prompts).toBe(1);
  await expect(page.locator("#preset-name")).toHaveValue("未確定の名前");

  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.locator("#preset-name")).toHaveValue("未確定の名前");
  await page.getByRole("button", { name: "名前を変更" }).click();
  await expect(page.getByRole("note")).toContainText("このブラウザに自動保存");
  await expect(page.locator("#preset-name")).toHaveValue("未確定の名前");
});


test("unique names on create, duplicate and rename, with preserved stable IDs", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "stable-source", preview: png, layers,
  } }));
  await page.route("**/api/preset-preview", (route) => route.fulfill({ json: { preview: png } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/unique.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await expect(page.locator("#preset-name")).toHaveValue("新しいプリセット 2");
  await page.locator("#preset-name").fill("通常");
  await page.getByRole("button", { name: "名前を変更" }).click();
  await expect(page.getByRole("alert")).toContainText("同じ名前のプリセットがあります");
  await page.locator("#preset-name").fill("通常 ");
  await page.getByRole("button", { name: "名前を変更" }).click();
  await expect(page.getByRole("alert")).toContainText("同じ名前のプリセットがあります");
  await page.getByRole("button", { name: "← 一覧へ" }).click();

  const originalId = await page.locator("[data-preset-id]").first().getAttribute("data-preset-id");
  await page.locator("[data-preset-id]").first().getByRole("button", { name: "複製" }).click();
  await expect(page.locator("#preset-name")).toHaveValue("通常 コピー");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.locator("[data-preset-id]").first().getByRole("button", { name: "複製" }).click();
  await expect(page.locator("#preset-name")).toHaveValue("通常 コピー 2");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(5);
  const ids = await page.locator("[data-preset-id]").evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-preset-id")));
  expect(new Set(ids).size).toBe(5);
  expect(ids).toContain(originalId);
  const names = await page.locator(".preset-card-title strong").allTextContents();
  expect(new Set(names).size).toBe(names.length);
  await page.reload();
  await expect(page.locator("[data-preset-id]")).toHaveCount(5);
  expect(await page.locator("[data-preset-id]").evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-preset-id")))).toEqual(ids);
});

test("refresh restores an unfinished name edit and modified ON/OFF states", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "source-A", preview: png, layers,
  } }));
  await page.route("**/api/preset-preview", (route) => route.fulfill({ json: { preview: png } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/リロード.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("checkbox", { name: "目 [0/1] 表示" }).check();
  await page.locator("#preset-name").fill("編集中の名前");
  await page.reload();
  await expect(page.getByRole("heading", { name: "編集" })).toBeVisible();
  await expect(page.locator("#preset-name")).toHaveValue("編集中の名前");
  await expect(page.getByRole("checkbox", { name: "目 [0/1] 表示" })).toBeChecked();
});

test("changed PSD fingerprint fails closed without erasing the stored draft", async ({ page }) => {
  let fingerprint = "source-A";
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint, preview: png, layers,
  } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/changed.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  const stored = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));
  expect(stored).toContain("source-A");
  fingerprint = "source-B";
  await page.reload();
  await expect(page.getByRole("status")).toContainText("PSDが変更されています");
  await expect(page.locator("[data-preset-id]")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(stored);
  await expect(page.getByRole("button", { name: "保存済みを破棄して新規" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "保存済みを破棄して新規" }).click();
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(stored);
});

test("invalid cached draft cannot be silently replaced by reading PSD", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "source-A", preview: png, layers,
  } }));
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("tachie-motion.preset-draft.v1", "{broken"));
  await page.reload();
  await expect(page.getByRole("status")).toContainText("形式が壊れています");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/recovery.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("上書きしません");
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe("{broken");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "保存済みを破棄して新規" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toContain("source-A");
});

test("the reorder target is visible and arrow move works without a touch drag", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "source-A", preview: png, layers,
  } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/reorder.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.getByRole("button", { name: "通常 をドラッグして並び替え" })).toHaveCount(1);
  await expect(page.getByText("順番").first()).toBeVisible();
  await page.getByRole("button", { name: "新しいプリセット を上へ移動" }).click();
  await expect(page.locator("[data-preset-id]").first()).toContainText("新しいプリセット");
  await page.reload();
  await expect(page.locator("[data-preset-id]").first()).toContainText("新しいプリセット");
});

/** Regression #35: a wide desktop must not shrink presets to narrow overlapping tiles. */
test("desktop preset cards keep all controls beside, never on top of, the image", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "desktop-layout", preview: png, layers,
  }}));
  await page.route("**/api/preset-preview", (route) => route.fulfill({ json: { preview: png } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/layout.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();

  for (const width of [1100, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const card = page.locator(".preset-card").first();
    const area = await card.boundingBox();
    const image = await card.locator(".preset-card-image").boundingBox();
    const body = await card.locator(".preset-card-body").boundingBox();
    expect(area && image && body).toBeTruthy();
    if (!area || !image || !body) continue;
    expect(area.width).toBeGreaterThan(600);
    expect(image.x + image.width).toBeLessThanOrEqual(body.x + 1);
    expect(body.x + body.width).toBeLessThanOrEqual(area.x + area.width + 1);
    const controls = card.locator(".preset-card-body button");
    for (let i = 0; i < await controls.count(); i++) {
      const control = await controls.nth(i).boundingBox();
      expect(control).not.toBeNull();
      if (!control) continue;
      expect(control.x).toBeGreaterThanOrEqual(body.x - 1);
      expect(control.x + control.width).toBeLessThanOrEqual(body.x + body.width + 1);
      expect(control.y).toBeGreaterThanOrEqual(body.y - 1);
      expect(control.y + control.height).toBeLessThanOrEqual(body.y + body.height + 1);
    }
    const thumbnail = await card.locator(".preset-card-image img").boundingBox();
    expect(thumbnail).not.toBeNull();
    if (thumbnail) {
      expect(thumbnail.y + thumbnail.height).toBeLessThanOrEqual(image.y + image.height + 1);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator(".preset-card")).toHaveCount(2);
  const pair = await page.locator(".preset-card").evaluateAll((nodes) =>
    nodes.map((node) => ({ outer: node.getBoundingClientRect().width,
      image: node.querySelector(".preset-card-image")?.getBoundingClientRect().width ?? 0 })));
  expect(pair.every(({ outer, image }) => outer > 600 && image <= 226)).toBe(true);
});


test("Open roles belong to the original PSD tree, retain base visibility and preview two shapes", async ({ page }) => {
  const manyLayers = [
    { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
    ...Array.from({ length: 85 }, (_, i) => ({
      path: "0/" + i, name: i === 0 ? "口閉じ" : i === 1 ? "口開き" : "そのほか " + i,
      kind: "pixel", visible: i !== 1, effective_visible: i !== 1, bbox: [2,2,16,16],
    })),
  ];
  const previews: Array<{ layers: Array<{ path: string; visible: boolean }> }> = [];
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "large-psd", preview: png, layers: manyLayers,
  }}));
  await page.route("**/api/preset-preview", (route) => {
    previews.push(route.request().postDataJSON());
    return route.fulfill({ json: { preview: png } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill("/tmp/85-layers.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();

  const closed = page.locator('.preset-layer-role[data-layer-path="0/0"]');
  const opened = page.locator('.preset-layer-role[data-layer-path="0/1"]');
  await expect(closed).toHaveAttribute("data-open-role", "none");
  await expect(page.getByRole("button", { name: "aiueo（未対応）" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "目・瞬き（未対応）" })).toBeDisabled();
  await closed.getByRole("button", { name: "Open: 閉じ口" }).click();
  await opened.getByRole("button", { name: "Open: 開き口" }).click();
  await expect(closed.getByRole("button", { name: "Open: 閉じ口" }))
    .toHaveAttribute("aria-pressed", "true");
  await closed.getByRole("button", { name: "Open: なし" }).click();
  await expect(closed).toHaveAttribute("data-open-role", "none");
  await closed.getByRole("button", { name: "Open: 閉じ口" }).focus();
  await page.keyboard.press("Enter");
  await expect(closed).toHaveAttribute("data-open-role", "closed");
  // Assigning a role must not turn the preset's base PSD leaf visibility on/off.
  await expect(page.getByRole("checkbox", { name: "口閉じ [0/0] 表示" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "口開き [0/1] 表示" })).not.toBeChecked();

  await page.getByRole("button", { name: "開き口", exact: true }).click();
  await expect.poll(() => previews.at(-1)?.layers.find((item) => item.path === "0/0")?.visible).toBe(false);
  await expect.poll(() => previews.at(-1)?.layers.find((item) => item.path === "0/1")?.visible).toBe(true);
  await page.getByRole("button", { name: "閉じ口", exact: true }).click();
  await expect.poll(() => previews.at(-1)?.layers.find((item) => item.path === "0/0")?.visible).toBe(true);
  await expect.poll(() => previews.at(-1)?.layers.find((item) => item.path === "0/1")?.visible).toBe(false);

  // Filtering reveals matching ancestors, but a subsequent manual fold wins.
  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(closed).toHaveCount(0);
  await page.getByRole("checkbox", { name: "割当済みのみ" }).check();
  await expect(closed).toBeVisible();
  await expect(page.locator(".preset-layer-role")).toHaveCount(2);
  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(closed).toHaveCount(0);
  await expect(opened).toHaveCount(0);
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(closed).toBeVisible();
  await expect(opened).toBeVisible();
  await page.getByRole("button", { name: "すべて閉じる" }).click();
  await expect(page.locator(".preset-layer-role")).toHaveCount(0);
  await page.getByRole("button", { name: "すべて開く" }).click();
  await expect(page.locator(".preset-layer-role")).toHaveCount(2);

  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("口閉じ");
  await expect(page.locator(".preset-layer-role")).toHaveCount(1);
  // Searching a parent group must find its assigned descendants too.
  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(closed).toHaveCount(0);
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("顔");
  await expect(page.locator(".preset-layer-role")).toHaveCount(2);
  await page.getByRole("button", { name: "顔 [0] を閉じる" }).click();
  await expect(page.locator(".preset-layer-role")).toHaveCount(0);
  await page.getByRole("button", { name: "顔 [0] を開く" }).click();
  await expect(page.locator(".preset-layer-role")).toHaveCount(2);
  await page.getByRole("textbox", { name: "レイヤー検索" }).fill("");

  await page.reload();
  await expect(closed).toHaveAttribute("data-open-role", "closed");
  await expect(opened).toHaveAttribute("data-open-role", "opened");
  await expect(page.getByRole("checkbox", { name: "口開き [0/1] 表示" })).not.toBeChecked();
});

test("older custom mouth overrides are preserved until explicitly changed", async ({ page }) => {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "legacy-shape", preview: png, layers,
  }}));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill("/tmp/legacy.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).not.toBeNull();
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v1";
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.collection.items[0].openMouth = {
      closed: [{ path: "0/0", visible: true }],
      opened: [{ path: "0/0", visible: true }],
    };
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const legacy = page.locator('.preset-layer-role[data-layer-path="0/0"]');
  const second = page.locator('.preset-layer-role[data-layer-path="0/1"]');
  await expect(legacy).toHaveAttribute("data-open-role", "custom");
  await second.getByRole("button", { name: "Open: 開き口" }).click();
  const value = await page.evaluate(() => JSON.parse(localStorage.getItem("tachie-motion.preset-draft.v1")!));
  expect(value.collection.items[0].openMouth.closed).toContainEqual({ path: "0/0", visible: true });
  expect(value.collection.items[0].openMouth.opened).toContainEqual({ path: "0/0", visible: true });
  await legacy.getByRole("button", { name: "Open: 閉じ口" }).click();
  await expect(legacy).toHaveAttribute("data-open-role", "closed");
});

test("tall PSD preview fits its whole canvas and supports mouth focus, pan and state changes", async ({ page }) => {
  const tall = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="3300">' +
    '<rect x="0" y="0" width="1500" height="3300" fill="#8a465a" /></svg>');
  const realistic = [
    { path: "0", name: "顔", kind: "group", visible: true,
      effective_visible: true, bbox: [0,0,1500,3300] },
    { path: "0/0", name: "口閉じ", kind: "pixel", visible: true,
      effective_visible: true, bbox: [650,1100,850,1160] },
    { path: "0/1", name: "口開き", kind: "pixel", visible: false,
      effective_visible: false, bbox: [650,1100,850,1160] },
  ];
  await page.route("**/api/psd", route => route.fulfill({ json: {
    width: 1500, height: 3300, fingerprint: "tall", preview: tall, layers: realistic,
  } }));
  await page.route("**/api/preset-preview", route =>
    route.fulfill({ json: { preview: tall } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/tall.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();

  const stage = page.locator(".preset-image-viewport");
  const image = stage.locator("img");
  await expect(image).toBeVisible();
  const geometry = await image.evaluate((el: HTMLImageElement) => {
    const container = el.parentElement!;
    const width = container.clientWidth, height = container.clientHeight;
    const fitted = Math.min(width / el.naturalWidth, height / el.naturalHeight);
    return { naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight,
      cssPosition: getComputedStyle(el).position,
      objectFit: getComputedStyle(el).objectFit,
      scaledWidth: el.naturalWidth * fitted, scaledHeight: el.naturalHeight * fitted,
      width, height };
  });
  expect(geometry.naturalHeight).toBe(3300);
  expect(geometry.naturalWidth).toBe(1500);
  expect(geometry.cssPosition).toBe("absolute");
  expect(geometry.objectFit).toBe("contain");
  expect(geometry.scaledWidth).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.scaledHeight).toBeLessThanOrEqual(geometry.height + 1);

  await expect(page.getByRole("button", { name: "口元へ" })).toBeDisabled();
  await page.locator('.preset-layer-role[data-layer-path="0/0"]').getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]').getByRole("button", { name: "Open: 開き口" }).click();
  await page.getByRole("button", { name: "口元へ" }).click();
  // HTML <output> has the implicit ARIA role 'status', not 'output'.
  await expect(page.locator('output[aria-label="プレビュー倍率"]')).toHaveText("8×");
  const first = await image.getAttribute("style");
  expect(first).toMatch(/scale\(8\)/);
  expect(first).not.toContain("translate(0px, 0px)");

  await page.getByRole("button", { name: "開き口", exact: true }).click();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("style", first!);
  // The preset editor sits below the source picker and may be outside the
  // default 720px CI viewport; mouse coordinates alone do not scroll it.
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toBeInViewport();
  const rect = await stage.boundingBox();
  expect(rect).not.toBeNull();
  if (rect) {
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + 40, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => image.getAttribute("style")).not.toBe(first);
  }
  await page.getByRole("button", { name: "全体表示" }).click();
  await expect(image).toHaveAttribute("style", "transform: translate(0px, 0px) scale(1);");
});
