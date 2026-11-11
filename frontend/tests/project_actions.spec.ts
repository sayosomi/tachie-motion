import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const psdPath = "/tmp/立ち絵 e\u0301.psd";
const wavPath = "/tmp/音声 e\u0301.wav";
const otherWav = "/tmp/別の音声.wav";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "0/0", name: "口", kind: "pixel", visible: true, effective_visible: true, bbox: [2,2,12,12] },
];
const identity = "1:2:3:4:5";
type Probe = {
  saved: string[];
  mode: "success" | "cancel" | "hold";
  release: (() => void) | null;
  options: unknown[];
};
type Mock = { currentWavIdentity: string; missingWavs: Set<string>; fingerprint: string };
async function mock(page: Page): Promise<Mock> {
  const state: Mock = { currentWavIdentity: identity, missingWavs: new Set(), fingerprint: "1000:2000" };
  await page.addInitScript(() => {
    const probe: Probe = { saved: [], mode: "success", release: null, options: [] };
    (window as Window & { __projectProbe: Probe }).__projectProbe = probe;
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true,
      value: async (options: unknown) => {
        probe.options.push(options);
        if (probe.mode === "cancel") throw new DOMException("cancelled", "AbortError");
        return { name: "user-project.json", createWritable: async () => ({
          write: async (value: string) => {
            if (probe.mode === "hold") await new Promise<void>((resolve) => { probe.release = resolve; });
            probe.saved.push(value);
          }, close: async () => {}, abort: async () => {},
        }) };
      },
    });
  });
  await page.route("**/api/health", (route) => route.fulfill({
    json: { ok: true, default_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/psd", (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    if (path !== psdPath) return route.fulfill({ status: 400, json: { detail: "PSDがありません" } });
    return route.fulfill({ json: {
      width: 64, height: 64, fingerprint: state.fingerprint, layers, preview: png,
    } });
  });
  await page.route("**/api/wav", (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    if (state.missingWavs.has(path)) {
      return route.fulfill({ status: 400, json: { detail: "WAVが見つかりません" } });
    }
    return route.fulfill({ json: {
      samples: 48000, sample_rate: 48000, duration_seconds: 1,
      source_identity: state.currentWavIdentity,
    } });
  });
  await page.route("**/api/preset-preview", (route) => route.fulfill({ json: { preview: png } }));
  await page.route("**/api/preset-utterance-destination", (route) => route.fulfill({
    json: { state: "available", suggested_basename: "alt_002" },
  }));
  return state;
}
async function openSpeech(page: Page) {
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill(psdPath);
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("#speech-wav-path")).toBeAttached();
}
async function addWav(page: Page, path: string) {
  await page.locator("#speech-wav-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#speech-wav-path").fill(path);
  await page.getByRole("button", { name: "WAVを確認" }).click();
}
async function saved(page: Page): Promise<any> {
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "制作プロジェクトを保存しました" })).toBeVisible();
  return page.evaluate(() => {
    const p = (window as Window & { __projectProbe: Probe }).__projectProbe;
    return JSON.parse(p.saved.at(-1)!);
  });
}
async function importProject(page: Page, value: unknown) {
  await page.locator("#project-file-input").setInputFiles({
    name: "project.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
async function agreeToReplace(page: Page) {
  page.once("dialog", (dialog) => { void dialog.accept(); });
}

test("project save, reload, restore preserves ordered WAV edits and character snapshot", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator('[data-selected="true"] .utterance-row-mode select').selectOption("open");
  await page.locator("#speech-basename").fill("first");
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator("#speech-fps").selectOption("60");
  await page.getByRole("button", { name: "上へ: 2 別の音声.wav" }).click();
  const project = await saved(page);
  expect(project.format).toBe("tachie-motion-project");
  expect(project.version).toBe(2);
  expect(project.items.map((item: any) => item.wavPath)).toEqual([otherWav, wavPath]);
  expect(project.items[1].mode).toBe("open");
  expect(project.items[1].basename).toBe("first");
  expect(project.items[0].fps).toBe(60);
  expect(project.items[0].wav.source_identity).toBe(identity);
  expect(project.character.source.path).toBe(psdPath);
  expect(JSON.stringify(project)).not.toContain("result");
  await page.reload();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(0);
  await agreeToReplace(page);
  await importProject(page, project);
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator("[data-utterance-id]").first()).toContainText("別の音声.wav");
  await expect(page.locator("#speech-fps")).toHaveValue("60");
  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();
  await expect(page.locator('[data-selected="true"] .utterance-row-mode select')).toHaveValue("open");
  await expect(page.locator("#speech-basename")).toHaveValue("first");
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await expect(page.locator("[data-preset-id]")).toHaveAttribute("data-preset-id",
    project.character.collection.items[0].id);
});

test("missing WAV retains current list, permits explicit re-link and then commits", async ({ page }) => {
  const state = await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const project = await saved(page);
  const beforeId = await page.locator("[data-utterance-id]").first().getAttribute("data-utterance-id");
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  state.missingWavs.add(wavPath);
  await importProject(page, project);
  await expect(page.locator(".project-repair")).toBeVisible();
  await expect(page.locator(".project-repair")).toContainText("WAVが見つかりません");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  const fieldId = "project-repair-" + project.items[0].id;
  await page.locator("#" + fieldId + "-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#" + fieldId).fill("/tmp/再指定 e\u0301.wav");
  await agreeToReplace(page);
  await page.getByRole("button", { name: "再確認して読み込む" }).click();
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute("data-utterance-id", beforeId!);
  await expect(page.locator(".utterance-item-details")).toContainText("再指定 e\u0301.wav");
});

test("changed WAV at same path requires explicit approval before import", async ({ page }) => {
  const state = await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const project = await saved(page);
  state.currentWavIdentity = "1:2:100:4:5";
  await importProject(page, project);
  await expect(page.locator(".project-repair")).toContainText("保存時からWAVが変更");
  await expect(page.getByRole("checkbox", { name: /変更されたWAV/ })).toBeVisible();
  await page.getByRole("checkbox", { name: /変更されたWAV/ }).check();
  await agreeToReplace(page);
  await page.getByRole("button", { name: "再確認して読み込む" }).click();
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  const again = await saved(page);
  expect(again.items[0].wav.source_identity).toBe("1:2:100:4:5");
});

test("invalid JSON and rejected replacement never overwrite existing edits", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const savedProject = await saved(page);
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  const storage = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));
  const modified = structuredClone(savedProject);
  modified.items[0].presetId = "__missing__";
  await importProject(page, modified);
  await expect(page.getByRole("alert")).toContainText("WAV順序またはプリセット参照");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(storage);
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await importProject(page, savedProject);
  await expect(page.getByRole("status")).toContainText("読み込みをキャンセル");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(storage);
});

test("Save dialog cancel does not claim success; held writer locks conflicting edits", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.mode = "cancel";
  });
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存をキャンセル");
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.mode = "hold";
  });
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("button", { name: "プリセット", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "削除: 1 音声 e\u0301.wav" })).toBeDisabled();
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.release?.();
  });
  await expect(page.getByRole("status").filter({ hasText: "制作プロジェクトを保存しました" })).toBeVisible();
  expect(await page.evaluate(() =>
    (window as Window & { __projectProbe: Probe }).__projectProbe.saved.length)).toBe(1);
});


test("changed PSD rejects restoration without replacing current state", async ({ page }) => {
  const state = await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const project = await saved(page);
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  state.fingerprint = "1000:3000";
  await importProject(page, project);
  await expect(page.locator(".project-repair")).toContainText("PSDの内容またはレイヤー構造");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "読み込みを取り消す" }).click();
  await expect(page.locator(".project-repair")).toHaveCount(0);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
});

test("failed browser recovery write is non-destructive after user confirms", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const project = await saved(page);
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  const before = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "tachie-motion.preset-draft.v1") throw new Error("容量不足");
      return original.call(this, key, value);
    };
  });
  await agreeToReplace(page);
  await importProject(page, project);
  await expect(page.getByRole("alert")).toContainText("容量不足");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(before);
});


test("project JSON v2 saves and restores simple batch naming settings", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.route("**/api/preset-batch-mov-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.locator("#batch-project-name").fill("ずんだもん動画");
  await page.locator("#batch-character-name").fill("あんこもん");
  await page.locator("#batch-mov-template").fill("{番号}_{キャラ名}_{WAV名}");
  await page.locator("#batch-otio-template").fill("{プロジェクト名}");
  await expect(page.locator(".export-plan-items li").first())
    .toContainText("001_あんこもん_音声 e\u0301.mov");
  const project = await saved(page);
  expect(project.version).toBe(2);
  expect(project.naming.projectName).toBe("ずんだもん動画");
  expect(project.naming.characterName).toBe("あんこもん");
  expect(project.naming.otioTemplate).toBe("{プロジェクト名}");
  await page.reload();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("#project-file-input")).toBeAttached();
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await importProject(page, project);
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.locator("#batch-project-name")).toHaveValue("ずんだもん動画");
  await expect(page.locator("#batch-character-name")).toHaveValue("あんこもん");
  await expect(page.locator("#batch-mov-template")).toHaveValue("{番号}_{キャラ名}_{WAV名}");
  await expect(page.locator(".batch-timeline-plan")).toContainText("ずんだもん動画.otio");
});

test("project saving locks batch execution controls until the writer completes", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.route("**/api/preset-batch-mov-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.mode = "hold";
  });
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeDisabled();
  await expect(page.locator("#batch-mov-template")).toBeDisabled();
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.release?.();
  });
  await expect(page.getByRole("status").filter({ hasText: "制作プロジェクトを保存しました" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
});
