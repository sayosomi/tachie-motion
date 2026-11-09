import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "face", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "mouth", kind: "pixel", visible: true, effective_visible: true, bbox: [2, 2, 8, 8] },
];

async function openSpeech(page: Page) {
  await page.route("**/api/psd", (route) => route.fulfill({
    json: { width: 64, height: 64, fingerprint: "snapshot", preview: png, layers },
  }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, default_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-utterance-destination", (route) =>
    route.fulfill({ json: { state: "available", suggested_basename: "alternate_002" } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toBeVisible();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("#speech-wav-path")).toBeAttached();
}

async function addWav(page: Page, path: string) {
  await page.locator("#speech-wav-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill(path);
  await page.getByRole("button", { name: "WAVを確認" }).click();
}

test("per-WAV editing survives reorder, duplicate registration and screen switching", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 2000, sample_rate: 1000, duration_seconds: 2 },
  }));
  await openSpeech(page);

  const first = "/Volumes/A/あんこもん だんもん.wav";
  const sameNameElsewhere = "/Volumes/B/あんこもん だんもん.wav";
  await addWav(page, first);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator("#speech-lip-mode").selectOption("open");
  await page.locator("#speech-basename").fill("first_line");
  await addWav(page, sameNameElsewhere);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator("#speech-fps").selectOption("60");
  await page.locator("#speech-basename").fill("second_line");
  const registeredIds = await page.locator("[data-utterance-id]").evaluateAll(
    (nodes) => nodes.map((el) => el.getAttribute("data-utterance-id")));
  expect(new Set(registeredIds).size).toBe(2);
  await page.getByRole("button", { name: "上へ: 2 あんこもん だんもん.wav" }).click();
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute(
    "data-utterance-id", registeredIds[1]);

  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();
  await expect(page.locator("#speech-lip-mode")).toHaveValue("open");
  await expect(page.locator("#speech-basename")).toHaveValue("first_line");
  await expect(page.locator("#speech-fps")).toHaveValue("30");
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await expect(page.locator("#speech-lip-mode")).toHaveValue("none");
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
  await expect(page.locator("#speech-fps")).toHaveValue("60");

  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
  await page.getByRole("button", { name: "削除: 2 あんこもん だんもん.wav" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute(
    "data-utterance-id", registeredIds[1]);
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
  await expect(page.locator("[data-utterance-id]").first().locator("small").first()).toHaveText(sameNameElsewhere);
  // The exact same WAV path may be registered again as a separate item.
  await addWav(page, sameNameElsewhere);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  const duplicateIds = await page.locator("[data-utterance-id]").evaluateAll(
    (nodes) => nodes.map((el) => el.getAttribute("data-utterance-id")));
  expect(duplicateIds[0]).not.toBe(duplicateIds[1]);
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
});

test("out-of-order WAV inspection cannot select the wrong item or reorder registrations", async ({ page }) => {
  let releaseSlow: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    if (path.endsWith("slow.wav")) {
      await new Promise<void>((resolve) => { releaseSlow = resolve; });
    }
    await route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  const slow = page.waitForRequest("**/api/wav");
  await addWav(page, "/tmp/slow.wav");
  await slow;
  const fast = page.waitForRequest("**/api/wav");
  await addWav(page, "/tmp/fast.wav");
  await fast;
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("fast.wav");
  expect(releaseSlow).toBeDefined();
  releaseSlow!();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator("[data-utterance-id]").first()).toContainText("slow.wav");
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("fast.wav");
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("fast.wav");
});

test("earlier concurrent WAV failure remains visible after a newer WAV succeeds", async ({ page }) => {
  const olderPath = "/Volumes/A/先行 だんもん.wav";
  const newerPath = "/Volumes/B/後行.wav";
  let releaseOlder: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    if (path === olderPath) {
      await new Promise<void>((resolve) => { releaseOlder = resolve; });
      return route.fulfill({ status: 422, json: { detail: "WAV解析に失敗しました" } });
    }
    return route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  await addWav(page, olderPath);
  await expect.poll(() => Boolean(releaseOlder)).toBe(true);
  await addWav(page, newerPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("後行.wav");
  releaseOlder!();
  const alert = page.getByRole("alert").filter({ hasText: olderPath });
  await expect(alert).toContainText("WAV解析に失敗しました");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first().locator("small").first())
    .toHaveText(newerPath);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("後行.wav");
  await expect(page.locator("#speech-basename")).toHaveValue("speech_002");
});

test("failed addition preserves selected export and the PCM MOV endpoint receives that WAV once", async ({ page }) => {
  const path = "/tmp/voice 日本語.wav";
  const exports: Array<Record<string, unknown>> = [];
  await page.route("**/api/wav", (route) => {
    const payload = route.request().postDataJSON() as { path: string };
    if (payload.path.includes("missing")) {
      return route.fulfill({ status: 422, json: { detail: "WAVが見つかりません" } });
    }
    return route.fulfill({ json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 } });
  });
  await page.route("**/api/preset-utterance-export", (route) => {
    exports.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: {
      mov: "/tmp/output/speech_001.mov", otio: "/tmp/output/speech_001.otio",
      frames: 30, sample_count: 1000,
    } });
  });
  await openSpeech(page);
  await addWav(page, path);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/missing.wav");
  await expect(page.getByRole("alert").filter({ hasText: "WAVが見つかりません" })).toBeVisible();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first().locator("small").first()).toHaveText(path);
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeEnabled();
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect(page.getByText("書き出し完了・30フレーム")).toBeVisible();
  expect(exports).toHaveLength(1);
  expect(exports[0].wav).toBe(path);
  expect(exports[0].mode).toBe("none");
  expect(exports[0].basename).toBe("speech_001");
  expect(exports[0].conflict_policy).toBe("error");
});


test("Finder multi-select registers multiple NFD paths in one dialog", async ({ page }) => {
  const origin = "http://127.0.0.1:8765";
  const paths = ["/Volumes/A/あんこもん だんもん.wav", "/Volumes/B/あんこもん だんもん.wav"];
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": origin } }));
  const picks: Array<Record<string, unknown>> = [];
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    picks.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { status: "selected", paths },
      headers: { "access-control-allow-origin": origin } });
  });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1200, sample_rate: 1000, duration_seconds: 1.2 },
  }));
  await openSpeech(page);
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(picks).toHaveLength(1);
  expect(picks[0]).toMatchObject({ kind: "wav", multiple: true });
  const displayed = await page.locator("[data-utterance-id] .utterance-item-details small:first-of-type")
    .allTextContents();
  expect(displayed).toEqual(paths);
});

test("drag handle reorders WAV rows without changing their edit state", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 },
  }));
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("first.wav");
  await page.locator("#speech-basename").fill("first");
  await addWav(page, "/tmp/second.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("second.wav");
  await page.locator("#speech-basename").fill("second");
  const ids = await page.locator("[data-utterance-id]").evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-utterance-id")));
  const grip = await page.locator(".utterance-item").first()
    .locator(".utterance-drag-handle").boundingBox();
  const play = await page.locator(".utterance-item").first()
    .locator(".utterance-item-play").boundingBox();
  const name = await page.locator(".utterance-item").first()
    .locator(".utterance-item-select").boundingBox();
  expect(grip && play && name).toBeTruthy();
  expect(grip!.x).toBeLessThan(play!.x);
  expect(play!.x).toBeLessThan(name!.x);
  await page.getByRole("button", { name: "ドラッグで移動: 2 second.wav" })
    .dragTo(page.locator("[data-utterance-id]").first(), {
      targetPosition: { x: 20, y: 5 },
    });
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute(
    "data-utterance-id", ids[1]);
  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();
  await expect(page.locator("#speech-basename")).toHaveValue("first");
});

test("browser WAV controls read through bounded POST API for single and all playback", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 4000, sample_rate: 8000, duration_seconds: 0.5 },
  }));
  const audio = Buffer.alloc(44 + 8000);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(8000, 40);
  const requested: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    requested.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ status: 200, body: audio, contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/a.wav");
  await addWav(page, "/tmp/b.wav");
  await page.locator(".utterance-item-play").nth(1).click();
  await expect.poll(() => requested.length).toBe(1);
  expect(requested[0]).toBe("/tmp/b.wav");
  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect.poll(() => requested.length, { timeout: 10000 }).toBe(3);
  expect(requested).toEqual(["/tmp/b.wav", "/tmp/a.wav", "/tmp/b.wav"]);
});

test("batch exports every WAV in list order and retains individual failures", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(payload);
    if (payload.wav === "/tmp/b.wav") {
      return route.fulfill({ status: 400, json: { detail: "synthetic failed" } });
    }
    return route.fulfill({ json: {
      mov: "/tmp/output/" + payload.basename + ".mov",
      otio: "/tmp/output/" + payload.basename + ".otio",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/a.wav");
  await addWav(page, "/tmp/b.wav");
  await addWav(page, "/tmp/c.wav");
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByRole("heading", { name: "書き出し", exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "一括書き出し", exact: true })).toHaveCount(0);
  await expect(page.getByText("口パク「なし」が3件", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("一括書き出し完了：成功 2 件／失敗 1 件", { exact: false }))
    .toBeVisible();
  expect(requests.map((r) => r.wav)).toEqual(["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav"]);
  expect(requests.map((r) => r.basename)).toEqual(["speech_001", "speech_002", "speech_003"]);
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("書き出し失敗");
  await expect(page.locator("[data-utterance-id]").nth(2)).toContainText("書き出し済み");
});

test("batch preflight blocks colliding output filenames before generating MOVs", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 },
  }));
  let calls = 0;
  await page.route("**/api/preset-utterance-export", (route) => {
    calls++;
    return route.fulfill({ status: 500, json: { detail: "should not export" } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/second.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("second.wav");
  await page.locator("#speech-basename").fill("speech_001");
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByText("複数のセリフが同じ出力先", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeDisabled();
  expect(calls).toBe(0);
});

test("batch export requires confirmation before overwriting existing output pairs", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let exports = 0;
  await page.route("**/api/preset-utterance-export", (route) => {
    exports++;
    return route.fulfill({ status: 500, json: { detail: "unexpected export" } });
  });
  await openSpeech(page);
  // Last registered route wins in Playwright; override openSpeech's available default.
  await page.route("**/api/preset-utterance-destination", (route) => route.fulfill({
    json: { state: "complete", suggested_basename: "speech_001_002",
      canonical_output_dir: "/tmp/output" },
  }));
  await addWav(page, "/tmp/voice.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const dialog = page.waitForEvent("dialog").then(async (shown) => {
    expect(shown.message()).toContain("既存のMOVとOTIOを1組上書き");
    await shown.dismiss();
  });
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await dialog;
  await expect(page.getByText("一括書き出しをキャンセルしました")).toBeVisible();
  expect(exports).toBe(0);
});

test("batch locks the preset selector throughout an in-progress render", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let releaseFirst: (() => void) | undefined;
  const payloads: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-utterance-export", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    payloads.push(payload);
    if (payload.wav === "/tmp/a.wav") {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    await route.fulfill({ json: {
      mov: "/tmp/output/" + payload.basename + ".mov",
      otio: "/tmp/output/" + payload.basename + ".otio",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await expect(page.getByRole("heading", { name: "編集" })).toBeVisible();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("#speech-wav-path")).toBeAttached();
  await addWav(page, "/tmp/a.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/b.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator("#speech-preset option")).toHaveCount(2);
  const assignedPreset = await page.locator("#speech-preset").inputValue();

  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect.poll(() => Boolean(releaseFirst)).toBe(true);
  await page.locator("[data-utterance-id]").nth(1)
    .locator(".utterance-item-select").click();
  await expect(page.locator("#speech-preset")).toBeDisabled();
  await expect(page.locator("#speech-preset")).toHaveValue(assignedPreset);
  releaseFirst!();
  await expect(page.getByText("一括書き出し完了：成功 2 件／失敗 0 件", { exact: false }))
    .toBeVisible();
  await expect(page.locator("#speech-preset")).toBeEnabled();
  expect(payloads.map((item) => item.wav)).toEqual(["/tmp/a.wav", "/tmp/b.wav"]);
});

test("media error stops the playlist and releases Blob URLs on error and on normal completion", async ({ page }) => {
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL;
    const target = window as Window & { __revokedBlobUrls: string[] };
    target.__revokedBlobUrls = [];
    URL.revokeObjectURL = (url: string) => {
      target.__revokedBlobUrls.push(url);
      original.call(URL, url);
    };
  });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 16000, sample_rate: 8000, duration_seconds: 2 },
  }));
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  const requests: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    requests.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ body: wav, contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/one.wav");
  await addWav(page, "/tmp/two.wav");
  const player = page.locator(".utterance-playback audio");

  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect(player).toHaveAttribute("src", /^blob:/);
  const brokenUrl = await player.getAttribute("src");
  await player.evaluate((node) => node.dispatchEvent(new Event("error")));
  await expect(page.getByText("音声の再生に失敗:", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect.poll(async () => player.evaluate((node) => node.hasAttribute("src"))).toBe(false);
  const firstRevoked = await page.evaluate(
    () => (window as Window & { __revokedBlobUrls: string[] }).__revokedBlobUrls);
  expect(firstRevoked).toContain(brokenUrl);
  expect(requests).toEqual(["/tmp/one.wav"]);

  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect.poll(async () => {
    const src = await player.getAttribute("src");
    return Boolean(src?.startsWith("blob:"));
  }).toBe(true);
  const firstUrl = await player.getAttribute("src");
  await player.evaluate((node) => node.dispatchEvent(new Event("ended")));
  await expect.poll(() => requests.length).toBe(3);
  await expect.poll(async () => {
    const src = await player.getAttribute("src");
    return Boolean(src?.startsWith("blob:") && src !== firstUrl);
  }).toBe(true);
  const secondUrl = await player.getAttribute("src");
  await player.evaluate((node) => node.dispatchEvent(new Event("ended")));
  await expect(page.getByText("再生が終了しました")).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect.poll(async () => player.evaluate((node) => node.hasAttribute("src"))).toBe(false);
  const revoked = await page.evaluate(
    () => (window as Window & { __revokedBlobUrls: string[] }).__revokedBlobUrls);
  expect(revoked).toContain(firstUrl);
  expect(revoked).toContain(secondUrl);
});

test("Finder multi-WAV partial failure preserves successful selection and reports the failed path", async ({ page }) => {
  const origin = "http://127.0.0.1:8765";
  const okPath = "/tmp/good だんもん.wav";
  const badPath = "/tmp/bad.wav";
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": origin } }));
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    return route.fulfill({ json: { status: "selected", paths: [okPath, badPath] },
      headers: { "access-control-allow-origin": origin } });
  });
  await page.route("**/api/wav", (route) =>
    (route.request().postDataJSON() as { path: string }).path === badPath
      ? route.fulfill({ status: 422, json: { detail: "invalid PCM" } })
      : route.fulfill({ json: {
        samples: 800, sample_rate: 8000, duration_seconds: 0.1,
      } }));
  await openSpeech(page);
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first()).toContainText(okPath);
  await expect(page.getByRole("alert").filter({ hasText: badPath }))
    .toContainText("invalid PCM");
});



test("cancelled Finder multi-select leaves all registered WAVs untouched", async ({ page }) => {
  const origin = "http://127.0.0.1:8765";
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": origin } }));
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    return route.fulfill({ json: { status: "cancelled" },
      headers: { "access-control-allow-origin": origin } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/existing.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator("#speech-basename").fill("keep_settings");
  const initialId = await page.locator("[data-utterance-id]").first()
    .getAttribute("data-utterance-id");
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first())
    .toHaveAttribute("data-utterance-id", initialId!);
  await expect(page.locator("#speech-basename")).toHaveValue("keep_settings");
});

test("batch export sends unsafe, partial and recovery_required original outputs only to safe alternate names", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  const outputs: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    outputs.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: {
      mov: "/tmp/output/alternate.mov", otio: "/tmp/output/alternate.otio",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  // Override the generic destination mock after openSpeech has installed it.
  await page.route("**/api/preset-utterance-destination", (route) => {
    const { basename } = route.request().postDataJSON() as { basename: string };
    const status: Record<string, string> = {
      speech_001: "unsafe", speech_002: "partial", speech_003: "recovery_required",
    };
    return route.fulfill({ json: status[basename] ? {
      state: status[basename], suggested_basename: "alternate_" + basename,
      canonical_output_dir: "/tmp/output",
    } : { state: "available", suggested_basename: "unused", canonical_output_dir: "/tmp/output" } });
  });
  await addWav(page, "/tmp/unsafe.wav");
  await addWav(page, "/tmp/partial.wav");
  await addWav(page, "/tmp/recovery.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(3);
  await page.getByRole("radio", { name: /^全件/ }).check();
  const plans = page.locator(".export-plan-items li");
  await expect(plans).toHaveCount(3);
  for (const [index, name] of ["alternate_speech_001", "alternate_speech_002",
    "alternate_speech_003"].entries()) {
    await expect(plans.nth(index)).toContainText(name + ".mov");
    await expect(plans.nth(index)).toContainText("出力先: /tmp/output");
    await expect(plans.nth(index)).toContainText("プリセット: 通常");
    await expect(plans.nth(index)).toContainText("口パク: なし ／ 30 fps");
    await expect(plans.nth(index)).toContainText("新規保存");
    await expect(plans.nth(index).locator("span").nth(4))
      .toHaveText(name + ".mov ＋ " + name + ".otio");
  }
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("一括書き出し完了：成功 3 件／失敗 0 件", { exact: false }))
    .toBeVisible();
  expect(outputs.map((x) => x.basename)).toEqual([
    "alternate_speech_001", "alternate_speech_002", "alternate_speech_003",
  ]);
  expect(outputs.every((x) => x.conflict_policy === "error")).toBe(true);
});


test("single export locks every WAV's edits and new additions when selection changes", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let release: (() => void) | undefined;
  let exported = 0;
  await page.route("**/api/preset-utterance-export", async (route) => {
    exported++;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: {
      mov: "/tmp/output/speech_001.mov", otio: "/tmp/output/speech_001.otio",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/a.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/b.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();
  await expect(page.locator("#speech-preset")).toBeDisabled();
  await expect(page.locator("#speech-lip-mode")).toBeDisabled();
  await expect(page.locator("#speech-fps")).toBeDisabled();
  await expect(page.locator("#speech-basename")).toBeDisabled();
  await expect(page.locator("#speech-wav-path")).toBeDisabled();
  await expect(page.getByRole("button", { name: "WAVを確認" })).toBeDisabled();
  await expect(page.locator("[data-utterance-id]").nth(1)
    .getByRole("button", { name: /削除:/ })).toBeDisabled();
  await expect(page.locator("[data-utterance-id]").nth(1)
    .getByRole("button", { name: /ドラッグで移動:/ })).toBeDisabled();
  release!();
  await expect(page.locator("#speech-preset")).toBeEnabled();
  await expect(page.locator("#speech-wav-path")).toBeEnabled();
  expect(exported).toBe(1);
});

test("batch preview is invalidated when the actual destination changes before export", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let outputExists = false;
  let submitted = 0;
  await openSpeech(page);
  await page.route("**/api/preset-utterance-destination", (route) => route.fulfill({
    json: outputExists ? {
      state: "complete", suggested_basename: "speech_001_002",
      canonical_output_dir: "/tmp/output",
    } : { state: "available", suggested_basename: "speech_001_002",
      canonical_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/preset-utterance-export", (route) => {
    submitted++;
    return route.fulfill({ status: 500, json: { detail: "unexpected export" } });
  });
  await addWav(page, "/tmp/a.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.getByRole("radio", { name: /^全件/ }).check();
  const plan = page.locator(".export-plan-items li").first();
  await expect(plan).toContainText("speech_001.mov");
  await expect(plan).toContainText("新規保存");
  outputExists = true;
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("出力予定が変更されました", { exact: false })).toBeVisible();
  expect(submitted).toBe(0);
  await expect(plan).toContainText("上書き");
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
});

test("clicking the loading WAV row cancels its fetch instead of starting a second request", async ({ page }) => {
  let release: (() => void) | undefined;
  let requests = 0;
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 8000, sample_rate: 8000, duration_seconds: 1 },
  }));
  await page.route("**/api/wav-playback", async (route) => {
    requests++;
    await new Promise<void>((resolve) => { release = resolve; });
    try { await route.abort(); } catch { /* The browser already aborted it. */ }
  });
  await openSpeech(page);
  await addWav(page, "/tmp/loading.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator(".utterance-item-play").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByRole("button", { name: /読み込み中止:/ })).toBeVisible();
  await expect(page.locator(".utterance-loading-label")).toBeVisible();
  await expect(page.locator(".utterance-loading-label")).toContainText("読み込み中止");
  await page.getByRole("button", { name: /読み込み中止:/ }).click();
  await expect(page.locator(".utterance-loading-label")).toHaveCount(0);
  release!();
  await expect(page.locator(".utterance-item-play")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /再生: 1 loading.wav/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect(page.getByText("音声の再生に失敗:", { exact: false })).toHaveCount(0);
  await expect.poll(() => requests).toBe(1);
});

test("inline WAV pause, resume and seeking operate on the currently loaded audio", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 96000, sample_rate: 8000, duration_seconds: 12 },
  }));
  const wav = Buffer.alloc(44 + 96000 * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(96000 * 2, 40);
  const requests: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    requests.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ body: wav, contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/long.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator(".utterance-item-play").click();
  const player = page.locator(".utterance-playback audio");
  await expect(page.getByRole("button", { name: /一時停止:/ })).toBeVisible();
  await expect(player).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: /一時停止:/ }).click();
  await expect(page.getByRole("button", { name: /再生: 1 long.wav/ })).toBeVisible();
  await expect.poll(() => player.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(true);
  const seek = page.getByRole("slider", { name: /再生位置: long.wav/ });
  const rect = await seek.boundingBox();
  expect(rect).not.toBeNull();
  await seek.click({ position: { x: rect!.width * 0.6, y: rect!.height / 2 } });
  await expect.poll(() => player.evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBeGreaterThan(4);
  await page.getByRole("button", { name: /再生: 1 long.wav/ }).click();
  await expect(page.getByRole("button", { name: /一時停止:/ })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => player.evaluate((el) => el.hasAttribute("src"))).toBe(false);
  expect(requests).toEqual(["/tmp/long.wav"]);
});


test("a drag started before single export cannot reorder after the export lock engages", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let releaseExport: (() => void) | undefined;
  await page.route("**/api/preset-utterance-export", async (route) => {
    await new Promise<void>((resolve) => { releaseExport = resolve; });
    await route.fulfill({ json: {
      mov: "/tmp/output/speech_001.mov", otio: "/tmp/output/speech_001.otio",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(2);
  const ids = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-utterance-id")));

  // Keep an actual React dragStart active, rather than completing dragTo first.
  await rows.nth(1).locator(".utterance-drag-handle").evaluate((node) => {
    const dataTransfer = new DataTransfer();
    node.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true, cancelable: true, dataTransfer,
    }));
  });
  await rows.first().evaluate((node) => {
    node.dispatchEvent(new DragEvent("dragover", {
      bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
    }));
  });
  await expect(rows.first()).toHaveAttribute("data-drop-target", "true");
  await rows.first().locator(".utterance-item-select").click();
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect.poll(() => Boolean(releaseExport)).toBe(true);
  await expect(rows.nth(1).locator(".utterance-drag-handle")).toBeDisabled();
  await expect(rows.first()).toHaveAttribute("data-drop-target", "false");

  // Deliver the drop event even though the export has invalidated the drag.
  const dispatched = await rows.first().evaluate((node) => {
    return node.dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true,
      clientY: node.getBoundingClientRect().top + 3,
      dataTransfer: new DataTransfer(),
    }));
  });
  expect(dispatched).toBe(false); // onDrop received the event and prevented default.
  await expect(rows.first()).toHaveAttribute("data-utterance-id", ids[0]!);
  await expect(rows.nth(1)).toHaveAttribute("data-utterance-id", ids[1]!);

  releaseExport!();
  await expect(page.locator(".utterance-drag-handle").first()).toBeEnabled();
  await expect(rows.first()).toHaveAttribute("data-utterance-id", ids[0]!);
  await expect(rows.nth(1)).toHaveAttribute("data-utterance-id", ids[1]!);
});
