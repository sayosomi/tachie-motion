import { expect, test, type Page } from "@playwright/test";

// These browser scenarios mock MOV/OTIO completion. Reserve progress in the
// same mock transport; never create an orphan job on the real local API.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/export-progress-reserve", (route) =>
    route.fulfill({ json: { registered: true } }));
});

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
  mode: "success" | "cancel" | "hold" | "write_fail" | "close_fail";
  aborts: number;
  release: (() => void) | null;
  options: unknown[];
};
type Mock = { currentWavIdentity: string; missingWavs: Set<string>; fingerprint: string };
async function mock(page: Page): Promise<Mock> {
  const state: Mock = { currentWavIdentity: identity, missingWavs: new Set(), fingerprint: "1000:2000" };
  await page.addInitScript(() => {
    const probe: Probe = { saved: [], mode: "success", release: null, options: [], aborts: 0 };
    (window as Window & { __projectProbe: Probe }).__projectProbe = probe;
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true,
      value: async (options: unknown) => {
        probe.options.push(options);
        if (probe.mode === "cancel") throw new DOMException("cancelled", "AbortError");
        return { name: "user-project.json", createWritable: async () => ({
          write: async (value: string) => {
            if (probe.mode === "hold") await new Promise<void>((resolve) => { probe.release = resolve; });
            if (probe.mode === "write_fail") throw new Error("synthetic write failed");
            probe.saved.push(value);
          },
          close: async () => {
            if (probe.mode === "close_fail") throw new Error("synthetic close failed");
          },
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
    if (path !== psdPath) return route.fulfill({ status: 400, json: { detail: "PSDがありません" } });
    return route.fulfill({ json: {
      width: 64, height: 64, fingerprint: state.fingerprint, source_identity: identity, layers, preview: png,
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
  await page.route("**/api/preset-batch-reuse-candidate", (route) => {
    const request = route.request().postDataJSON() as { suggested_basename: string };
    return route.fulfill({ json: {
      basename: request.suggested_basename, reuse: false,
    } });
  });
  await page.route("**/api/preset-batch-check-names", (route) =>
    route.fulfill({ json: { valid: true } }));
  await page.route("**/api/preset-batch-start", (route) =>
    route.fulfill({ json: { batch_id: "test-session" } }));
  await page.route("**/api/preset-batch-cancel", (route) =>
    route.fulfill({ json: { released: true } }));
  await page.route("**/api/preset-batch-mov-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const body = route.request().postDataJSON() as { output_dir: string; basename: string };
    return route.fulfill({ json: {
      mov: body.output_dir + "/" + body.basename + ".mov",
      frames: 30, sample_count: 48000, sample_rate: 48000,
    } });
  });
  await page.route("**/api/preset-combined-otio", (route) => {
    const body = route.request().postDataJSON() as {
      output_dir: string; basename: string; entries: unknown[];
    };
    return route.fulfill({ json: {
      otio: body.output_dir + "/" + body.basename + ".otio",
      entries: body.entries.length,
    } });
  });
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
  // On reload the speech workspace asynchronously verifies the PSD; the
  // native file input is disabled until that completes. Never race that gate.
  await expect(page.getByRole("button", { name: "JSONを読み込む" })).toBeEnabled();
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
  expect(project.version).toBe(4);
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

test("clearing eyes with stored opened pose roundtrips draft, character v2 and project v4", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  // Valid current-v2 data may contain a historical opened array. The UI
  // uses fixed base for open eyes, but import still accepts this field.
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const draft = JSON.parse(localStorage.getItem(key)!);
    draft.collection.motionGroups = { mouth: [], eyes: ["0"] };
    draft.collection.items[0].eyes = {
      opened: [{ path: "0/0", visible: true }],
      closed: [{ path: "0/0", visible: true }],
    };
    localStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "可動レイヤー" }).click();
  await page.getByRole("tablist", { name: "パーツ" })
    .getByRole("tab", { name: "目" }).click();
  await page.getByRole("checkbox", { name: "目 ON" }).check();
  await expect(page.getByRole("button", { name: "閉じ目の選択を解除" })).toBeVisible();
  await page.getByRole("button", { name: "閉じ目の選択を解除" }).click();
  const afterClear = JSON.parse((await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v2")))!);
  expect(afterClear.collection.items[0].eyes).toBeUndefined();
  expect(afterClear.collection.items[0].base.find(
    (entry: { path: string; visible: boolean }) => entry.path === "0/0")?.visible).toBe(true);

  await page.reload();
  await expect(page.getByText("前回の編集を復元しました。")).toBeVisible();
  // The ?preset=<id> route restores the detail page, not the preset list.
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "JSONを保存", exact: true }).click();
  await expect(page.locator(".profile-status")).toContainText("JSONを保存しました");
  const profile = await page.evaluate(() => JSON.parse(
    (window as Window & { __projectProbe: Probe }).__projectProbe.saved.at(-1)!));
  expect(profile.version).toBe(2);
  expect(profile.collection.items[0].eyes).toBeUndefined();
  const confirmation = page.waitForEvent("dialog").then(dialog => dialog.accept());
  await page.locator("#character-profile-file").setInputFiles({
    name: "character.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(profile)),
  });
  await confirmation;
  await expect(page.locator(".profile-status")).toContainText("JSONを読み込みました");

  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await addWav(page, wavPath);
  const project = await saved(page);
  expect(project.version).toBe(4);
  expect(project.character.collection.items[0].eyes).toBeUndefined();
  await page.reload();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  page.once("dialog", dialog => { void dialog.accept(); });
  await importProject(page, project);
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  const roundtrip = await saved(page);
  expect(roundtrip.character.collection.items[0].eyes).toBeUndefined();
  expect(roundtrip.character.collection.motionGroups.eyes).toEqual(["0"]);
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
  const fieldId = "project-repair-wav-" + project.items[0].id;
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
  const storage = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"));
  const modified = structuredClone(savedProject);
  modified.items[0].presetId = "__missing__";
  await importProject(page, modified);
  await expect(page.getByRole("alert")).toContainText("WAV順序またはプリセット参照");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"))).toBe(storage);
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await importProject(page, savedProject);
  await expect(page.getByRole("status")).toContainText("読み込みをキャンセル");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"))).toBe(storage);
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
  const before = await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "tachie-motion.preset-draft.v2") throw new Error("容量不足");
      return original.call(this, key, value);
    };
  });
  await agreeToReplace(page);
  await importProject(page, project);
  await expect(page.getByRole("alert")).toContainText("容量不足");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v2"))).toBe(before);
});


test("project JSON v3 saves and restores simple batch naming settings", async ({ page }) => {
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
  expect(project.version).toBe(4);
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

test("project save holds a synchronous lock against batch export and WAV selection", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator(".utterance-item-select").first().click();
  const selectedBefore = await page.locator('[data-selected="true"]').getAttribute("data-utterance-id");
  let exportCalls = 0;
  await page.route("**/api/preset-batch-start", (route) => {
    exportCalls++;
    return route.fulfill({ json: {
      mov: "/tmp/output/generated.mov", otio: "/tmp/output/generated.otio",
      frames: 30, sample_count: 48000,
    } });
  });
  await page.getByRole("radio", { name: /全件/ }).check();
  const batchButton = page.getByRole("button", { name: "全件を書き出す" });
  await expect(batchButton).toBeEnabled();
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.mode = "hold";
  });
  await page.getByRole("button", { name: "JSONを保存" }).click();
  await expect(batchButton).toBeDisabled();
  await expect(page.locator(".utterance-item-select").last()).toBeDisabled();
  await expect(page.locator(".utterance-item-play").last()).toBeDisabled();
  await expect(page.getByRole("button", { name: "全件を連続再生" })).toBeDisabled();
  // Bypass native disabled to exercise a stale programmatic click as well.
  await batchButton.evaluate((node) => {
    node.removeAttribute("disabled");
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(exportCalls).toBe(0);
  expect(await page.locator('[data-selected="true"]').getAttribute("data-utterance-id"))
    .toBe(selectedBefore);
  await page.evaluate(() => {
    (window as Window & { __projectProbe: Probe }).__projectProbe.release?.();
  });
  await expect(page.locator(".project-controls [role=\"status\"]")).toContainText("制作プロジェクトを保存しました");
  await expect(batchButton).toBeEnabled();
  expect(exportCalls).toBe(0);
});

test("delayed project import keeps batch export disabled until confirmation finishes", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  const project = await saved(page);
  await page.getByRole("radio", { name: /全件/ }).check();
  const batchButton = page.getByRole("button", { name: "全件を書き出す" });
  await expect(batchButton).toBeEnabled();
  let releasePsd: (() => void) | undefined;
  let exportCalls = 0;
  await page.route("**/api/preset-batch-start", (route) => {
    exportCalls++;
    return route.fulfill({ status: 500, json: { detail: "unwanted export" } });
  });
  await page.route("**/api/psd", async (route) => {
    await new Promise<void>((resolve) => { releasePsd = resolve; });
    await route.fulfill({ json: {
      width: 64, height: 64, fingerprint: "1000:2000", layers, preview: png,
    } });
  });
  await importProject(page, project);
  await expect(page.locator(".project-controls [role=\"status\"]")).toContainText("プロジェクトを確認中");
  await expect(batchButton).toBeDisabled();
  await expect(page.locator(".utterance-item-select").first()).toBeDisabled();
  await expect.poll(() => Boolean(releasePsd)).toBeTruthy();
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  releasePsd?.();
  await expect(page.locator(".project-controls [role=\"status\"]")).toContainText("読み込みをキャンセル");
  await expect(batchButton).toBeEnabled();
  expect(exportCalls).toBe(0);
});

test("restored, explicitly approved WAV identity is sent to single and batch exports", async ({ page }) => {
  const state = await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  const project = await saved(page);
  const revisedIdentity = "1:2:100:4:5";
  state.currentWavIdentity = revisedIdentity;
  await importProject(page, project);
  await expect(page.locator(".project-repair")).toContainText("保存時からWAVが変更");
  await page.getByRole("checkbox", { name: /変更されたWAV/ }).check();
  await agreeToReplace(page);
  await page.getByRole("button", { name: "再確認して読み込む" }).click();
  await expect(page.locator(".project-controls [role=\"status\"]")).toContainText("制作プロジェクトを読み込みました");
  const identities: string[] = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    identities.push((route.request().postDataJSON() as { source_identity: string }).source_identity);
    return route.fulfill({ json: {
      mov: "/tmp/output/generated.mov",
      frames: 30, sample_count: 48000,
    } });
  });
  await page.route("**/api/preset-batch-start", (route) => {
    const body = route.request().postDataJSON() as { entries: { source_identity: string }[] };
    identities.push(...body.entries.map((entry) => entry.source_identity));
    return route.fulfill({ json: { batch_id: "test-session" } });
  });
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const body = route.request().postDataJSON() as {
      source_identity: string; output_dir: string; basename: string;
    };
    identities.push(body.source_identity);
    return route.fulfill({ json: {
      mov: body.output_dir + "/" + body.basename + ".mov",
      frames: 30, sample_count: 48000, sample_rate: 48000,
    } });
  });
  await page.getByRole("button", { name: "MOVを書き出す" }).click();
  await expect(page.locator(".success")).toBeVisible();
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await page.getByRole("radio", { name: /全件/ }).check();
  const batchButton = page.getByRole("button", { name: "全件を書き出す" });
  await expect(batchButton).toBeEnabled();
  await batchButton.click();
  await expect(page.locator(".export-execution .hint[role=\"status\"]")
    .filter({ hasText: "一括書き出し完了" })).toContainText("一括書き出し完了");
  expect(identities).toEqual([revisedIdentity, revisedIdentity, revisedIdentity]);
});

test("WAV ID psd does not conflate PSD and WAV repair entries", async ({ page }) => {
  const state = await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  const project = await saved(page);
  project.items[0].id = "psd";
  // Both keys must have unique input IDs, even when PSD also needs repair.
  project.items.push({
    ...structuredClone(project.items[0]), id: "wav-psd", registrationOrder: 2,
  });
  project.selectedId = "psd";
  state.fingerprint = "1000:changed";
  state.missingWavs.add(wavPath);
  await importProject(page, project);
  await expect(page.locator(".project-repair-item")).toHaveCount(3);
  await expect(page.locator("#project-repair-psd")).toBeAttached();
  await expect(page.locator("#project-repair-wav-psd")).toBeAttached();
  await expect(page.locator("#project-repair-wav-wav-psd")).toBeAttached();
  await expect(page.locator(".project-repair")).toContainText("WAVが見つかりません");
  await expect(page.locator(".project-repair")).toContainText("PSDの内容");
});

test("native project JSON write and close failures abort and preserve editing state", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  const originalId = await page.locator('[data-selected="true"]').getAttribute("data-utterance-id");
  for (const mode of ["write_fail", "close_fail"] as const) {
    await page.evaluate((m) => {
      (window as Window & { __projectProbe: Probe }).__projectProbe.mode = m;
    }, mode);
    await page.getByRole("button", { name: "JSONを保存" }).click();
    await expect(page.getByRole("alert")).toContainText("制作プロジェクトを保存できませんでした");
    await expect(page.getByRole("alert")).toContainText(
      mode === "write_fail" ? "synthetic write failed" : "synthetic close failed",
    );
    expect(await page.locator('[data-selected="true"]').getAttribute("data-utterance-id"))
      .toBe(originalId);
    await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  }
  expect(await page.evaluate(() => (window as Window & { __projectProbe: Probe })
    .__projectProbe.aborts)).toBe(2);
});

test("same-tick batch start blocks a stale project save click", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await page.getByRole("radio", { name: /全件/ }).check();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
  let completeExport: (() => void) | undefined;
  await page.route("**/api/preset-batch-start", async (route) => {
    await new Promise<void>((resolve) => { completeExport = resolve; });
    await route.fulfill({ json: {
      batch_id: "test-session",
    } });
  });
  await page.evaluate(() => {
    const batch = [...document.querySelectorAll("button")]
      .find((node) => node.textContent?.trim() === "全件を書き出す");
    const save = [...document.querySelectorAll("button")]
      .find((node) => node.textContent?.trim() === "JSONを保存");
    batch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => Boolean(completeExport)).toBeTruthy();
  expect(await page.evaluate(() => (window as Window & { __projectProbe: Probe })
    .__projectProbe.options.length)).toBe(0);
  completeExport?.();
  await expect(page.locator(".export-execution .hint[role=\"status\"]").filter({ hasText: "一括書き出し完了" }))
    .toContainText("一括書き出し完了");
});


test("project restore invalidates LAB status for the same WAV ID/path/identity", async ({ page }) => {
  await mock(page);
  let status: "valid" | "missing" = "valid";
  let requests = 0;
  await page.route("**/api/wav-lab", (route) => {
    requests++;
    return route.fulfill({ json: status === "valid"
      ? { status: "valid", reason: null, source_identity: "9:8:7:6:5" }
      : { status: "missing", reason: null, source_identity: null } });
  });
  await openSpeech(page);
  await addWav(page, wavPath);
  const original = page.locator("[data-utterance-id]").first();
  await expect(original.locator('[data-lab-status="valid"]')).toBeVisible();
  const originalId = await original.getAttribute("data-utterance-id");
  const project = await saved(page);
  status = "missing";
  await agreeToReplace(page);
  await importProject(page, project);
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  const restored = page.locator("[data-utterance-id]").first();
  await expect(restored.locator('[data-lab-status="missing"]')).toBeVisible();
  expect(await restored.getAttribute("data-utterance-id")).toBe(originalId);
  expect(requests).toBeGreaterThanOrEqual(2);
});

test("project JSON retains shared auto MOV names and individually pinned Unicode overrides", async ({ page }) => {
  await mock(page);
  await openSpeech(page);
  await addWav(page, wavPath);
  await addWav(page, otherWav);
  await page.locator("#speech-basename").fill("手動 セリフ");
  await page.locator("#batch-character-name").fill("ずんだもん");
  await page.locator("#batch-mov-template").fill("{番号}-{キャラ名}-{WAV名}");
  const project = await saved(page);
  expect(project.items.map((item: any) => item.basenameEdited)).toEqual([false, true]);
  expect(project.items[0].basename).toBe("001-ずんだもん-音声 e\u0301");
  expect(project.items[1].basename).toBe("手動 セリフ");
  await page.reload();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await agreeToReplace(page);
  await importProject(page, project);
  await expect(page.getByRole("status")).toContainText("制作プロジェクトを読み込みました");
  await expect(page.locator("#speech-basename")).toHaveValue("手動 セリフ");
  await page.locator("[data-utterance-id]").first()
    .locator(".utterance-item-select").click();
  await expect(page.locator("#speech-basename")).toHaveValue("001-ずんだもん-音声 e\u0301");
  await page.locator("#batch-mov-template").fill("{番号}_{キャラ名}_{WAV名}");
  await expect(page.locator("#speech-basename")).toHaveValue("001_ずんだもん_音声 e\u0301");
  await page.locator("[data-utterance-id]").nth(1)
    .locator(".utterance-item-select").click();
  await expect(page.locator("#speech-basename")).toHaveValue("手動 セリフ");
});

test("inline idle gap saves in project and batch sends speech-idle-speech with no PCM idle", async ({ page }) => {
  await mock(page);
  const ordered: string[] = [];
  let startEntries: any[] = [];
  let otioEntries: any[] = [];
  await page.route("**/api/preset-batch-start", (route) => {
    startEntries = (route.request().postDataJSON() as { entries: any[] }).entries;
    return route.fulfill({ json: { batch_id: "test-session" } });
  });
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const body = route.request().postDataJSON() as {
      output_dir: string; basename: string; batch_index: number;
    };
    ordered.push("speech:" + body.batch_index);
    return route.fulfill({ json: {
      mov: body.output_dir + "/" + body.basename + ".mov",
      frames: 30, sample_count: 48000, sample_rate: 48000,
    } });
  });
  await page.route("**/api/preset-batch-idle-export", (route) => {
    const body = route.request().postDataJSON() as {
      output_dir: string; basename: string; batch_index: number;
      frame_count: number; fps: number; blink_enabled: boolean;
    };
    expect(body.frame_count).toBe(60);
    expect(body.fps).toBe(30);
    expect(body.blink_enabled).toBe(false);
    ordered.push("idle:" + body.batch_index);
    return route.fulfill({ json: {
      mov: body.output_dir + "/" + body.basename + ".mov",
      frames: body.frame_count, fps: body.fps, audio: false, staged: true,
    } });
  });
  await page.route("**/api/preset-combined-otio", (route) => {
    const body = route.request().postDataJSON() as {
      output_dir: string; basename: string; entries: any[];
    };
    otioEntries = body.entries;
    return route.fulfill({ json: {
      otio: body.output_dir + "/" + body.basename + ".otio",
      entries: body.entries.length,
    } });
  });
  await openSpeech(page);
  await addWav(page, wavPath);
  await addWav(page, otherWav);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "＋ このセリフの後に待機を挿入" }).click();
  await expect(page.locator(".idle-segment-editor")).toHaveCount(1);
  await page.getByRole("spinbutton", { name: "待機フレーム: 音声 e\u0301.wav" }).fill("60");
  const savedProject = await saved(page);
  expect(savedProject.items[0].idleAfter.frames).toBe(60);
  expect(savedProject.items[0].idleAfter.presetId).toBe(savedProject.items[0].presetId);
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.locator(".export-execution .hint[role=\"status\"]")
    .filter({ hasText: "一括書き出し完了" })).toContainText("一括書き出し完了");
  expect(startEntries.map((x) => x.kind ?? "speech")).toEqual(["speech", "idle", "speech"]);
  expect(startEntries[1]).toMatchObject({
    frames: 60, fps: 30, fingerprint: "1000:2000", source_identity: identity,
  });
  expect(ordered).toEqual(["speech:0", "idle:1", "speech:2"]);
  expect(otioEntries.map((x) => x.kind ?? "speech")).toEqual(["speech", "idle", "speech"]);
  expect(otioEntries[1]).not.toHaveProperty("samples");
  expect(otioEntries[1]).not.toHaveProperty("sample_rate");
});
