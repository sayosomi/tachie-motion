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
  const lateResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/psd") &&
    (response.request().postDataJSON() as { path: string }).path === bPath);
  try {
    await selectGroup(page, "A");
    await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  } finally {
    release();
  }
  await (await lateResponse).finished();
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

test("character profile exports feed the v5 project without mixing presets or linking later edits", async ({ page }) => {
  await mocks(page);
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 48000, sample_rate: 48000, duration_seconds: 1, source_identity: "1:2:3:4:5",
  } }));
  await page.addInitScript(() => {
    const written: string[] = [];
    (window as Window & { __groupExports: string[] }).__groupExports = written;
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true,
      value: async () => ({ name: "test.json", createWritable: async () => ({
        write: async (text: string) => { written.push(text); },
        close: async () => {},
      }) }),
    });
  });
  const lastSave = () => page.evaluate(() => JSON.parse(
    (window as Window & { __groupExports: string[] }).__groupExports.at(-1)!));
  await page.goto("/");
  const profiles: any[] = [];
  for (const [name, path, preset] of [["A", aPath, "笑顔A"], ["B", bPath, "笑顔B"]]) {
    await createGroup(page, name);
    await loadPsd(page, path);
    await expect(page.locator("[data-preset-id]")).toHaveCount(1);
    await page.getByRole("button", { name: "＋ 作成" }).click();
    await page.locator("#preset-name").fill(preset);
    await page.locator("#preset-name").press("Tab");
    await page.getByRole("button", { name: "← 一覧へ" }).click();
    await page.getByRole("button", { name: "JSONを保存", exact: true }).click();
    await expect(page.locator(".character-profile-actions [role=status]")).toContainText("JSONを保存しました");
    profiles.push(await lastSave());
  }
  expect(profiles[0].source.path).toBe(aPath);
  expect(profiles[1].source.path).toBe(bPath);

  await page.getByRole("button", { name: "制作（試作）" }).click();
  for (const [i, name] of ["A", "B"].entries()) {
    await page.getByRole("textbox", { name: "追加するキャラ名" }).fill(name);
    await page.locator("#production-character-input").setInputFiles({
      name: "profile.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(profiles[i])),
    });
    await expect(page.locator("[data-production-character]")).toHaveCount(i + 1);
  }
  await page.locator("#production-wav-path-advanced").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await page.locator("#production-wav-path").fill("/tmp/音声.wav");
  await page.getByRole("button", { name: "WAVを登録", exact: true }).click();
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(1);
  const ids = await page.locator("[data-production-character]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-production-character")!));
  const initialA = page.getByRole("combobox", { name: "初期プリセット: " + ids[0], exact: true });
  const initialB = page.getByRole("combobox", { name: "初期プリセット: " + ids[1], exact: true });
  await expect(initialA.locator("option")).toHaveText(["通常", "笑顔A"]);
  await expect(initialB.locator("option")).toHaveText(["通常", "笑顔B"]);
  await initialA.selectOption(profiles[0].collection.items[1].id);
  await initialB.selectOption(profiles[1].collection.items[1].id);
  await page.getByRole("button", { name: "制作JSONを保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "複数キャラ制作プロジェクトを保存しました" })).toBeVisible();
  const project = await lastSave();
  expect(project.characters.map((character: any) => character.profile)).toEqual(profiles);

  // Editing a library character is not an implicit mutation of a saved v5 snapshot.
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await selectGroup(page, "A");
  await expect(page.getByText("笑顔A", { exact: true })).toBeVisible();
  await page.locator("[data-preset-id]").nth(1).getByRole("button", { name: "詳細を編集" }).click();
  await page.locator("#preset-name").fill("変更後A");
  await page.locator("#preset-name").press("Tab");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.getByText("変更後A", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "制作（試作）" }).click();
  await expect(initialA.locator("option")).toHaveText(["通常", "笑顔A"]);
  await page.getByRole("button", { name: "制作JSONを保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "複数キャラ制作プロジェクトを保存しました" })).toBeVisible();
  expect((await lastSave()).characters).toEqual(project.characters);
});
