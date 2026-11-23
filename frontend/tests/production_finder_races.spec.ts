import { expect, test, type Page } from "@playwright/test";

const wavPath = "/tmp/音声 e\u0301.wav";
const psdPath = "/tmp/キャラ.psd";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true,
    effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "口", kind: "pixel", visible: true,
    effective_visible: true, bbox: [0, 0, 32, 32] },
];

type Probe = { saved: string[] };
type PickReply = { status: "selected"; path: string } | { status: "cancelled" };

async function setup(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { saved: [] };
    (window as Window & { __finderProductionProbe: Probe }).__finderProductionProbe = probe;
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true,
      value: async () => ({ name: "production.json", createWritable: async () => ({
        write: async (value: string) => { probe.saved.push(value); },
        close: async () => {},
        abort: async () => {},
      }) }),
    });
  });
  await page.route("**/api/health", (route) => route.fulfill({
    json: { ok: true, default_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 48000, sample_rate: 48000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  } }));
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    fingerprint: "1000:2000", width: 64, height: 64, layers,
  } }));
}

async function delayedFinder(page: Page) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Tachie-Picker",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  let signalStart!: (kind: string) => void;
  let release!: (reply: PickReply) => void;
  const started = new Promise<string>((resolve) => { signalStart = resolve; });
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { ready: true, picker: "mac-local" }, headers: cors }));
  await page.route("http://127.0.0.1:8766/pick", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors, body: "" });
    }
    const kind = (route.request().postDataJSON() as { kind: string }).kind;
    signalStart(kind);
    const reply = await new Promise<PickReply>((resolve) => { release = resolve; });
    await route.fulfill({ json: reply, headers: cors });
  });
  return { started, release: (reply: PickReply) => release(reply) };
}

async function openProduction(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "制作（試作）" }).click();
  await expect(page.getByRole("heading", { name: "制作プロジェクト（試作）" })).toBeVisible();
}

async function addWavDirect(page: Page) {
  await page.locator("#production-wav-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#production-wav-path").fill(wavPath);
  await page.getByRole("button", { name: "WAVを登録", exact: true }).click();
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(1);
}

async function save(page: Page): Promise<any> {
  await page.getByRole("button", { name: "制作JSONを保存" }).click();
  await expect(page.getByRole("status")
    .filter({ hasText: "複数キャラ制作プロジェクトを保存しました" })).toBeVisible();
  return page.evaluate(() => JSON.parse(
    (window as Window & { __finderProductionProbe: Probe })
      .__finderProductionProbe.saved.at(-1)!));
}

async function load(page: Page, value: unknown) {
  await page.locator("#production-project-input").setInputFiles({
    name: "project.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
}

test("delayed Finder WAV response locks project edits and preserves preexisting fields", async ({ page }) => {
  await setup(page);
  const finder = await delayedFinder(page);
  await openProduction(page);
  await addWavDirect(page);
  await page.getByRole("textbox", { name: "制作プロジェクト名" }).fill("編集済み作品");
  await page.getByRole("combobox", { name: "制作FPS" }).selectOption("60");
  await page.getByRole("textbox", { name: "共通待機秒数" }).fill("1.25");

  const choose = page.locator('section[aria-label="WAV登録"] button.picker-choose');
  await expect(choose).toBeEnabled();
  await choose.click();
  expect(await finder.started).toBe("wav");
  await expect(page.getByRole("textbox", { name: "制作プロジェクト名" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "制作FPS" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "共通待機秒数" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "制作JSONを読み込む" })).toBeDisabled();
  await expect(page.locator("#production-project-input")).toBeDisabled();
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeDisabled();

  finder.release({ status: "selected", path: "/tmp/選択された.wav" });
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "制作JSONを読み込む" })).toBeEnabled();
  const result = await save(page);
  expect(result.naming.projectName).toBe("編集済み作品");
  expect(result.fps).toBe(60);
  expect(result.waitSeconds).toBe("1.25");
  expect(result.wavs.map((wav: { wavPath: string }) => wav.wavPath)).toEqual([
    wavPath, "/tmp/選択された.wav",
  ]);
});

test("delayed output-folder Finder prevents replacing project before its reply", async ({ page }) => {
  await setup(page);
  const finder = await delayedFinder(page);
  await openProduction(page);
  await addWavDirect(page);
  await page.getByRole("textbox", { name: "制作プロジェクト名" }).fill("旧作品");
  const original = await save(page);
  const newProject = { ...original, naming: { ...original.naming,
    projectName: "読み込んだ作品", outputDir: "/tmp/imported-output" } };
  const choose = page.locator("#production-output-dir-advanced")
    .locator("xpath=..").getByRole("button", { name: "フォルダを選ぶ" });
  await expect(choose).toBeEnabled();
  await choose.click();
  expect(await finder.started).toBe("output_dir");
  await expect(page.getByRole("button", { name: "制作JSONを読み込む" })).toBeDisabled();
  await expect(page.locator("#production-project-input")).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "制作プロジェクト名" })).toBeDisabled();
  finder.release({ status: "selected", path: "/tmp/selected-output" });
  await expect(page.getByRole("button", { name: "制作JSONを読み込む" })).toBeEnabled();

  page.once("dialog", (dialog) => { void dialog.accept(); });
  await load(page, newProject);
  await expect(page.getByRole("status")
    .filter({ hasText: "複数キャラ制作プロジェクトを読み込みました" })).toBeVisible();
  const after = await save(page);
  expect(after.naming).toEqual(newProject.naming);
});

test("Finder cancellation releases the edit lock without changing the output directory", async ({ page }) => {
  await setup(page);
  const finder = await delayedFinder(page);
  await openProduction(page);
  const output = page.locator(".production-workspace button.picker-choose").first();
  await expect(output).toBeEnabled();
  await output.click();
  expect(await finder.started).toBe("output_dir");
  await expect(page.getByRole("button", { name: "制作JSONを保存" })).toBeDisabled();
  finder.release({ status: "cancelled" });
  await expect(page.getByRole("button", { name: "制作JSONを保存" })).toBeEnabled();
  const saved = await save(page);
  expect(saved.naming.outputDir).toBe("");
});

test("change-point add button is disabled at the shared 2048-point limit", async ({ page }) => {
  await setup(page);
  await openProduction(page);
  const profile = {
    format: "tachie-motion-character-profile", version: 2,
    source: { path: psdPath, fingerprint: "1000:2000", layerPaths: ["0", "0/0"] },
    collection: { defaultId: "normal", motionGroups: { mouth: [] }, items: [{
      id: "normal", name: "通常", blinkEnabled: false,
      base: layers.map(({ path, visible }) => ({ path, visible })),
    }] },
  };
  await page.locator("#production-character-input").setInputFiles({
    name: "character.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(profile)),
  });
  await expect(page.locator("[data-production-character]")).toHaveCount(1);
  await addWavDirect(page);
  const snapshot = await save(page);
  snapshot.characters[0].animations[0].presetChanges =
    Array.from({ length: 2048 }, (_, i) => ({ sample: i + 1, presetId: "normal" }));
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await load(page, snapshot);
  await expect(page.getByRole("status")
    .filter({ hasText: "複数キャラ制作プロジェクトを読み込みました" })).toBeVisible();
  await expect(page.getByRole("button", { name: "＋ 変更点" })).toBeDisabled();
  const restored = await save(page);
  expect(restored.characters[0].animations[0].presetChanges).toHaveLength(2048);
});
