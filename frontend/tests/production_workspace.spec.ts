import { expect, test, type Page } from "@playwright/test";

const psdLayers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "口", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 32, 32] },
];
const wavPath = "/tmp/音声 e\u0301.wav";
const firstPsd = "/tmp/あんこ.psd";
const secondPsd = "/tmp/ぼぶ.psd";
const identity = "1:2:3:4:5";

function profile(path: string, prefix: string) {
  return {
    format: "tachie-motion-character-profile", version: 2,
    source: { path, fingerprint: "1000:2000", layerPaths: ["0", "0/0"] },
    collection: {
      defaultId: prefix + "-normal",
      motionGroups: { mouth: [] },
      items: [
        { id: prefix + "-normal", name: "通常", blinkEnabled: false,
          base: psdLayers.map(({ path, visible }) => ({ path, visible })) },
        { id: prefix + "-happy", name: "笑顔", blinkEnabled: false,
          base: psdLayers.map(({ path, visible }) => ({ path, visible })) },
      ],
    },
  };
}

type Probe = { saved: string[]; mode: "ok" | "fail" | "cancel"; aborts: number };
type Mock = { identity: string; missingPsd: string | null; psdFingerprint: string };

async function setup(page: Page): Promise<Mock> {
  const state: Mock = { identity, missingPsd: null, psdFingerprint: "1000:2000" };
  await page.addInitScript(() => {
    const probe: Probe = { saved: [], mode: "ok", aborts: 0 };
    (window as Window & { __productionProbe: Probe }).__productionProbe = probe;
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true,
      value: async () => {
        if (probe.mode === "cancel") throw new DOMException("cancelled", "AbortError");
        return { name: "production.json", createWritable: async () => ({
          write: async (text: string) => {
            if (probe.mode === "fail") throw new Error("synthetic write failure");
            probe.saved.push(text);
          },
          close: async () => {},
          abort: async () => { probe.aborts++; },
        }) };
      },
    });
  });
  await page.route("**/api/health", (route) => route.fulfill({
    json: { ok: true, default_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/psd", (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    if (path === state.missingPsd || ![firstPsd, secondPsd].includes(path)) {
      return route.fulfill({ status: 400, json: { detail: "PSDが見つかりません" } });
    }
    return route.fulfill({ json: {
      fingerprint: state.psdFingerprint, layers: psdLayers,
      width: 64, height: 64,
    } });
  });
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 48000, sample_rate: 48000, duration_seconds: 1,
    source_identity: state.identity,
  } }));
  return state;
}

async function start(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "制作（試作）" }).click();
  await expect(page.getByRole("heading", { name: "制作プロジェクト（試作）" })).toBeVisible();
}

async function addCharacter(page: Page, path: string, prefix: string, name: string) {
  await page.getByRole("textbox", { name: "追加するキャラ名" }).fill(name);
  await page.locator("#production-character-input").setInputFiles({
    name: "キャラ設定.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(profile(path, prefix))),
  });
  await expect(page.locator("[data-production-character]")).toHaveCount(prefix === "a" ? 1 : 2);
}

async function addWav(page: Page, path = wavPath) {
  await page.locator("#production-wav-path-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await page.locator("#production-wav-path").fill(path);
  await page.getByRole("button", { name: "WAVを登録", exact: true }).click();
  await expect(page.getByText("WAVを登録しました。")).toBeVisible();
}

async function save(page: Page): Promise<any> {
  await page.getByRole("button", { name: "制作JSONを保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "複数キャラ制作プロジェクトを保存しました" }))
    .toBeVisible();
  return page.evaluate(() => JSON.parse(
    (window as Window & { __productionProbe: Probe }).__productionProbe.saved.at(-1)!));
}

async function load(page: Page, data: unknown) {
  await page.locator("#production-project-input").setInputFiles({
    name: "project.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
}

test("production UI saves and restores two characters with shared ordered WAVs and presets", async ({ page }) => {
  await setup(page);
  await start(page);
  await addCharacter(page, firstPsd, "a", "あんこ");
  await addCharacter(page, secondPsd, "b", "ぼぶ");
  await addWav(page);
  await addWav(page);
  await page.getByRole("textbox", { name: "制作プロジェクト名" }).fill("作品");
  await page.getByRole("textbox", { name: "共通待機秒数" }).fill("1.25");
  await page.getByRole("combobox", { name: "制作FPS" }).selectOption("60");

  const ids = await page.locator("[data-production-wav-id]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-production-wav-id")!));
  const charIds = await page.locator("[data-production-character]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-production-character")!));

  await page.getByRole("combobox", { name: "話者: " + ids[0] }).selectOption(charIds[0]);
  await page.getByRole("button", { name: "1 音声 e\u0301.wav" }).click();
  await page.getByRole("combobox", { name: "口パク: " + charIds[0] }).selectOption("open");
  await expect(page.getByRole("combobox", { name: "口パク: " + charIds[1] })).toBeDisabled();
  await page.getByRole("combobox", { name: "初期プリセット: " + charIds[1] }).selectOption("b-happy");
  await page.getByRole("button", { name: "＋ 変更点" }).first().click();
  await page.getByRole("combobox", { name: "変更先: " + charIds[0] + ":24000" })
    .selectOption("a-happy");
  await page.getByRole("combobox", { name: "待機プリセット: " + charIds[0] })
    .selectOption("a-happy");
  await page.getByRole("checkbox", { name: "待機あり: " + ids[1] }).uncheck();
  await page.getByRole("button", { name: "WAVを上へ: 音声 e\u0301.wav" }).last().click();

  const snapshot = await save(page);
  expect(snapshot.version).toBe(5);
  expect(snapshot.fps).toBe(60);
  expect(snapshot.waitSeconds).toBe("1.25");
  expect(snapshot.naming.projectName).toBe("作品");
  expect(snapshot.wavs.map((item: { id: string }) => item.id)).toEqual([ids[1], ids[0]]);
  expect(snapshot.wavs[1].speakerId).toBe(charIds[0]);
  expect(snapshot.wavs[0].speakerId).toBeNull();
  expect(snapshot.wavs[0].waitAfter).toBe(false);
  expect(snapshot.characters[0].animations.find((item: { wavId: string }) =>
    item.wavId === ids[0]).presetChanges).toEqual([{ sample: 24000, presetId: "a-happy" }]);
  expect(snapshot.characters[0].waitOverrides).toEqual([
    { wavId: ids[0], presetId: "a-happy" },
  ]);

  await page.reload();
  await page.getByRole("button", { name: "制作（試作）" }).click();
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(0);
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await load(page, snapshot);
  await expect(page.getByRole("status").filter({ hasText: "複数キャラ制作プロジェクトを読み込みました" }))
    .toBeVisible();
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(2);
  await expect(page.locator("[data-production-character]")).toHaveCount(2);
  await expect(page.getByRole("combobox", { name: "制作FPS" })).toHaveValue("60");
  const roundtrip = await save(page);
  expect(roundtrip.wavs).toEqual(snapshot.wavs);
  expect(roundtrip.characters).toEqual(snapshot.characters);
  // v4 editing screen remains separate.
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(0);
});

test("production import with a missing PSD keeps previous state until repaired or canceled", async ({ page }) => {
  const state = await setup(page);
  await start(page);
  await addCharacter(page, firstPsd, "a", "あんこ");
  await addWav(page);
  const saved = await save(page);
  await addWav(page);
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(2);

  state.missingPsd = firstPsd;
  await load(page, saved);
  await expect(page.locator(".project-repair")).toContainText("PSDが見つかりません");
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(2);
  state.missingPsd = null;
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "再確認して読み込む" }).click();
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(1);
});

test("WAV modification requires explicit consent; rejected replacement preserves edits", async ({ page }) => {
  const state = await setup(page);
  await start(page);
  await addCharacter(page, firstPsd, "a", "あんこ");
  await addWav(page);
  const original = await save(page);
  await addWav(page);
  state.identity = "1:2:7:4:5";
  await load(page, original);
  await expect(page.locator(".project-repair")).toContainText("保存時からWAVが変更");
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "読み込みを取り消す" }).click();
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(2);
  await load(page, original);
  await page.getByRole("checkbox", { name: "このWAVの変更を明示的に承認する" }).check();
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "再確認して読み込む" }).click();
  const updated = await save(page);
  expect(updated.wavs[0].wav.source_identity).toBe(state.identity);
});

test("v4 and malformed JSON do not overwrite a valid production project", async ({ page }) => {
  await setup(page);
  await start(page);
  await addWav(page);
  const before = await save(page);
  await load(page, { ...before, version: 4 });
  await expect(page.getByRole("alert")).toContainText("未対応");
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(1);
  const probe = page.evaluate(() => {
    const p = (window as Window & { __productionProbe: Probe }).__productionProbe;
    p.mode = "fail";
  });
  await probe;
  await page.getByRole("button", { name: "制作JSONを保存" }).click();
  await expect(page.getByRole("alert")).toContainText("synthetic write failure");
  await expect(page.locator("[data-production-wav-id]")).toHaveCount(1);
  expect(await page.evaluate(() =>
    (window as Window & { __productionProbe: Probe }).__productionProbe.aborts)).toBe(1);
});
