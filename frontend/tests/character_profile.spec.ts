import { expect, test } from "@playwright/test";

type SaveProbe = {
  options: unknown[];
  written: string[];
  mode: "success" | "cancel" | "write-error" | "hold";
  releaseWrite: (() => void) | null;
  aborts: number;
};

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const source = "/tmp/立ち絵 e\u0301.psd";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "0/0", name: "閉じ口", kind: "pixel", visible: true, effective_visible: true, bbox: [4,6,15,20] },
  { path: "0/1", name: "開き口", kind: "pixel", visible: false, effective_visible: false, bbox: [4,6,15,20] },
  { path: "0/2", name: "差分", kind: "pixel", visible: true, effective_visible: true, bbox: [4,6,15,20] },
];
const fingerprint = "1000:2000";

async function mockPsd(page: import("@playwright/test").Page, getFingerprint = () => fingerprint) {
  // Stub the browser Save dialog; no real disk I/O or user-owned file writes.
  await page.addInitScript(() => {
    const browser = window as Window & { __profileSaveProbe: SaveProbe };
    const probe: SaveProbe = {
      options: [], written: [], mode: "success", releaseWrite: null, aborts: 0,
    };
    browser.__profileSaveProbe = probe;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options: unknown) => {
        probe.options.push(options);
        if (probe.mode === "cancel") throw new DOMException("Cancelled", "AbortError");
        return {
          name: "user-chosen.json",
          createWritable: async () => ({
            write: async (data: string) => {
              if (probe.mode === "hold") {
                await new Promise<void>((resolve) => { probe.releaseWrite = resolve; });
              }
              if (probe.mode === "write-error") throw new DOMException("Denied", "NotAllowedError");
              probe.written.push(data);
            },
            close: async () => {},
            abort: async () => { probe.aborts += 1; },
          }),
        };
      },
    });
  });
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: getFingerprint(), preview: png, layers,
  }}));
  await page.route("**/api/preset-preview", (route) => route.fulfill({ json: { preview: png } }));
}

async function openPsd(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill(source);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
}

async function exportJson(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.locator(".character-profile-actions [role=status]")).toContainText("JSONを保存しました：user-chosen.json");
  const saved = await page.evaluate(() =>
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe);
  expect(saved.options.at(-1)).toMatchObject({
    id: "tachie-character-profile",
    suggestedName: "tachie-character.json",
    types: [{ accept: { "application/json": [".json"] } }],
  });
  return JSON.parse(saved.written.at(-1)!) as Record<string, any>;
}

async function importJson(page: import("@playwright/test").Page, data: unknown) {
  await page.locator("#character-profile-file").setInputFiles({
    name: "profile.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
}


test("native Save dialog writes one JSON and never silently downloads", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const saved = await exportJson(page);
  expect(saved.version).toBe(1);
  const probe = await page.evaluate(() =>
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe);
  expect(probe.options).toHaveLength(1);
  expect(probe.written).toHaveLength(1);
  expect(downloads).toEqual([]);
});

test("Save dialog cancellation does not write or announce success", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  await page.evaluate(() => {
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe.mode = "cancel";
  });
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存をキャンセルしました");
  const probe = await page.evaluate(() =>
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe);
  expect(probe.options).toHaveLength(1);
  expect(probe.written).toHaveLength(0);
  await expect(page.getByRole("button", { name: "JSONを保存" })).toBeEnabled();
});

test("Save write error aborts writer and reports failure", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  await page.evaluate(() => {
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe.mode = "write-error";
  });
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("alert")).toContainText("JSONを保存できませんでした");
  const probe = await page.evaluate(() =>
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe);
  expect(probe.written).toHaveLength(0);
  expect(probe.aborts).toBe(1);
});

test("unsupported browser does not create fallback downloads", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("alert")).toContainText("デスクトップ版ChromeまたはEdge");
  expect(downloads).toEqual([]);
});

test("repeated clicks during Save cannot open multiple dialogs", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  await page.evaluate(() => {
    const probe = (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe;
    probe.mode = "hold";
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent === "JSONを保存");
    if (!button) throw new Error("Save button not found");
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
  await page.evaluate(() => {
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe.releaseWrite?.();
  });
  await expect(page.getByRole("status")).toContainText("JSONを保存しました");
  const probe = await page.evaluate(() =>
    (window as Window & { __profileSaveProbe: SaveProbe }).__profileSaveProbe);
  expect(probe.options).toHaveLength(1);
  expect(probe.written).toHaveLength(1);
});

test("character JSON controls are paired buttons without duplicate native picker UI", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const section = page.locator(".character-profile-actions");
  await expect(section.getByRole("button", { name: "JSONを保存" })).toBeVisible();
  await expect(section.getByRole("button", { name: "JSONを読み込む" })).toBeVisible();
  await expect(section.locator("#character-profile-file")).toBeHidden();

  const chooserPromise = page.waitForEvent("filechooser");
  await section.getByRole("button", { name: "JSONを読み込む" }).click();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles([]);
  await expect(section.getByRole("button", { name: "JSONを読み込む" })).toBeEnabled();
});

test("character JSON roundtrip keeps ordered preset IDs, Open roles, Unicode and browser recovery", async ({ page, browser }) => {
  await mockPsd(page);
  await openPsd(page);
  const firstId = await page.locator("[data-preset-id]").first().getAttribute("data-preset-id");
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.locator("#preset-name").fill("にっこり え\u0301");
  await page.getByRole("button", { name: "名前を変更" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/0"]').getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]').getByRole("button", { name: "Open: 開き口" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.locator("[data-preset-id]").nth(1).getByRole("button", { name: "既定にする" }).click();
  await page.getByRole("button", { name: "にっこり え\u0301 を上へ移動" }).click();

  const saved = await exportJson(page);
  expect(saved.format).toBe("tachie-motion-character-profile");
  expect(saved.version).toBe(1);
  expect(saved.source.path).toBe(source);
  expect(saved.source.fingerprint).toBe(fingerprint);
  expect(saved.source.layerPaths).toEqual(layers.map((layer) => layer.path));
  expect(saved.collection.items).toHaveLength(2);
  expect(saved.collection.items[1].id).toBe(firstId);
  expect(saved.collection.defaultId).toBe(saved.collection.items[0].id);
  expect(saved.collection.items[0].openMouth.closed).toEqual([
    { path: "0/0", visible: true }, { path: "0/1", visible: false },
  ]);
  expect(saved.collection.items[0].openMouth.opened).toEqual([
    { path: "0/0", visible: false }, { path: "0/1", visible: true },
  ]);
  expect(JSON.stringify(saved)).not.toContain("data:image");
  expect(JSON.stringify(saved)).not.toContain("nameDrafts");

  const other = await browser.newContext({ baseURL: "http://127.0.0.1:8765" });
  try {
    const fresh = await other.newPage();
    await mockPsd(fresh);
    await fresh.goto("/");
    await importJson(fresh, saved);
    await expect(fresh.getByRole("status")).toContainText("キャラクター設定JSONを読み込みました");
    await expect(fresh.locator("[data-preset-id]")).toHaveCount(2);
    expect(await fresh.locator("[data-preset-id]").first().getAttribute("data-preset-id"))
      .toBe(saved.collection.items[0].id);
    await expect(fresh.locator("[data-preset-id]").first()).toContainText("既定");
    await fresh.locator("[data-preset-id]").first().getByRole("button", { name: "詳細を編集" }).click();
    await expect(fresh.locator('.preset-layer-role[data-layer-path="0/0"]'))
      .toHaveAttribute("data-open-role", "closed");
    await fresh.getByRole("button", { name: "← 一覧へ" }).click();
    await fresh.reload();
    await expect(fresh.locator("[data-preset-id]")).toHaveCount(2);
  } finally { await other.close(); }
});

test("malformed profiles and changed source reject without touching current state or recovery", async ({ page }) => {
  let currentFingerprint = fingerprint;
  await mockPsd(page, () => currentFingerprint);
  await openPsd(page);
  const saved = await exportJson(page);
  const idBefore = await page.locator("[data-preset-id]").first().getAttribute("data-preset-id");
  const originalStorage = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));

  const broken = [
    { ...saved, version: 99 },
    { ...saved, collection: { ...saved.collection, defaultId: "not-found" } },
    { ...saved, source: { ...saved.source, layerPaths: ["0", "0/0", "0/1", "0/1"] } },
    { ...saved, collection: { ...saved.collection, items: [{
      ...saved.collection.items[0], base: saved.collection.items[0].base.slice(1),
    }] } },
    { ...saved, collection: { ...saved.collection, items: [{
      ...saved.collection.items[0],
      openMouth: { closed: [{ path: "0/0", visible: true }], opened: [{ path: "9", visible: false }] },
    }] } },
    { ...saved, collection: { ...saved.collection, items: [
      saved.collection.items[0], saved.collection.items[0],
    ] } },
  ];
  for (const data of broken) {
    await importJson(page, data);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("[data-preset-id]").first()).toHaveAttribute("data-preset-id", idBefore!);
    expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(originalStorage);
  }

  await page.locator("#character-profile-file").setInputFiles({
    name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{bad"),
  });
  await expect(page.getByRole("alert")).toContainText("解析できません");
  await page.locator("#character-profile-file").setInputFiles({
    name: "oversized.json", mimeType: "application/json", buffer: Buffer.alloc(2_000_001, 32),
  });
  await expect(page.getByRole("alert")).toContainText("大きすぎます");
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(originalStorage);

  currentFingerprint = "1000:3000";
  await importJson(page, saved);
  await expect(page.getByRole("alert")).toContainText("PSDの内容またはレイヤー構造");
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(originalStorage);
});

test("group Open targets reject without replacing edits; custom leaf targets remain supported", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const saved = await exportJson(page);

  // A second unsaved preset makes accidental replacement observable.
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const beforeIds = await page.locator("[data-preset-id]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-preset-id")));
  const beforeStorage = await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"));

  const invalid = structuredClone(saved);
  // Path "0" exists and passes the JSON path/set checks, but is a PSD group.
  invalid.collection.items[0].openMouth = {
    closed: [{ path: "0", visible: true }],
    opened: [{ path: "0", visible: false }],
  };
  await importJson(page, invalid);
  await expect(page.getByRole("alert")).toContainText("グループ");
  expect(await page.locator("[data-preset-id]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-preset-id")))).toEqual(beforeIds);
  expect(await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(beforeStorage);

  // Both-on is an existing custom per-leaf assignment; do not prohibit it.
  const valid = structuredClone(saved);
  valid.collection.items[0].openMouth = {
    closed: [{ path: "0/0", visible: true }, { path: "0/1", visible: true }],
    opened: [{ path: "0/0", visible: true }, { path: "0/1", visible: false }],
  };
  const confirmation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("キャラクター設定JSONで置き換えますか");
    await dialog.accept();
  });
  await importJson(page, valid);
  await confirmation;
  await expect(page.getByRole("status")).toContainText("キャラクター設定JSONを読み込みました");
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  const roundtrip = await exportJson(page);
  expect(roundtrip.collection.items[0].openMouth).toEqual(valid.collection.items[0].openMouth);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.locator('.preset-layer-role[data-layer-path="0/0"]'))
    .toHaveAttribute("data-open-role", "custom");
});

for (const reservedId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
  test(`prototype-colliding preset ID ${reservedId} is rejected without overwriting draft`, async ({ page }) => {
    await mockPsd(page);
    await openPsd(page);
    const saved = await exportJson(page);
    await page.getByRole("button", { name: "＋ 作成" }).click();
    await page.getByRole("button", { name: "← 一覧へ" }).click();

    const idsBefore = await page.locator("[data-preset-id]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-preset-id")));
    const draftBefore = await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v1"));

    const invalid = structuredClone(saved);
    invalid.collection.items[0].id = reservedId;
    invalid.collection.defaultId = reservedId;
    await importJson(page, invalid);
    await expect(page.getByRole("alert")).toContainText("プリセットが不正です");
    expect(await page.locator("[data-preset-id]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-preset-id")))).toEqual(idsBefore);
    expect(await page.evaluate(() =>
      localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(draftBefore);
  });
}

test("safe legacy opaque preset ID imports and opens detail without a name draft", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const saved = await exportJson(page);
  const legacyId = "legacy-safe-identifier";
  saved.collection.items[0].id = legacyId;
  saved.collection.defaultId = legacyId;

  const confirmation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("キャラクター設定JSONで置き換えますか");
    await dialog.accept();
  });
  await importJson(page, saved);
  await confirmation;
  await expect(page.getByRole("status")).toContainText("キャラクター設定JSONを読み込みました");
  await expect(page.locator("[data-preset-id]")).toHaveAttribute("data-preset-id", legacyId);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.locator("#preset-name")).toHaveValue("通常");
  const again = await exportJson(page);
  expect(again.collection.defaultId).toBe(legacyId);
});

test("browser recovery refuses persisted prototype-colliding ID without altering saved data", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const original = await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"));
  expect(original).not.toBeNull();
  const savedDraft = JSON.parse(original!);
  savedDraft.collection.items[0].id = "__proto__";
  savedDraft.collection.defaultId = "__proto__";
  const poisoned = JSON.stringify(savedDraft);
  await page.evaluate((text) => localStorage.setItem("tachie-motion.preset-draft.v1", text), poisoned);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("保存済みプリセットの内容が不正です");
  await expect(page.getByRole("button", { name: "保存済みを破棄して新規" })).toBeVisible();
  await expect(page.locator("[data-preset-id]")).toHaveCount(0);
  expect(await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(poisoned);
});

test("import cancel and storage write failure do not mutate the current profile", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const saved = await exportJson(page);
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const previous = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));
  // setInputFiles resolves before the async import has completed. Wait for
  // the actual confirmation and for the UI to leave its busy state before
  // attempting a second import; otherwise both dialog handlers can overlap.
  const cancelDialog = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("キャラクター設定JSONで置き換えますか");
    await dialog.dismiss();
  });
  await importJson(page, saved);
  await cancelDialog;
  await expect(page.locator("#character-profile-file")).toBeEnabled();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(previous);

  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Denied", "QuotaExceededError"); };
  });
  const acceptDialog = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("キャラクター設定JSONで置き換えますか");
    await dialog.accept();
  });
  await importJson(page, saved);
  await acceptDialog;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("[data-preset-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(previous);
});

test("pending editing during async profile read prevents a stale import", async ({ page }) => {
  await mockPsd(page);
  await openPsd(page);
  const saved = await exportJson(page);
  let unblock!: () => void;
  const pause = new Promise<void>((resolve) => { unblock = resolve; });
  let reads = 0;
  await page.unroute("**/api/psd");
  await page.route("**/api/psd", async (route) => {
    reads += 1;
    if (reads === 1) await pause;
    await route.fulfill({ json: { width: 64, height: 64, fingerprint, preview: png, layers } });
  });
  await importJson(page, saved);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("checkbox", { name: "開き口 [0/1] 表示" }).check();
  unblock();
  await expect(page.getByRole("alert")).toContainText("読込み中に編集内容が変更");
  await expect(page.getByRole("checkbox", { name: "開き口 [0/1] 表示" })).toBeChecked();
});
